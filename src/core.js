/**
 * 核心逻辑模块：相机媒体提取
 * 遍历相机媒体目录，保持目录结构把媒体文件处理到目标目录中。
 * 照片原样拷贝，视频压缩转码。
 * 通过回调函数与 UI 层通信。
 *
 * 本模块只负责核心功能定义，不包含任何参数定义（环境变量/默认值）。
 * 所有参数通过 runProcessing(handlers, scanOptions, processOptions) 传入。
 * 所有 ffmpeg / 媒体强相关方法均来自 jiaffmpeg。
 */

import fs from 'fs';
import path from 'path';
import jiaffmpeg from 'jiaffmpeg';

const fsp = fs.promises;

// 调试日志：写入 debug.log 文件，避免被 vue 渲染覆盖
function debugLog(...args) {
	try {
		fs.appendFileSync(path.join(process.cwd(), 'debug.log'), args.join(' ') + '\n');
	} catch (e) { /* 忽略写入错误 */ }
}

// ==================== 工具函数 ====================

// 人类可读文件大小
export function humanSize(bytes) {
	if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let size = bytes;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${size.toFixed(size >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// 设置文件时间戳（创建时间 + 修改时间），与源文件一致
async function setFileTimes(targetPath, sourcePath) {
	try {
		const stat = await fsp.stat(sourcePath);
		await fsp.utimes(targetPath, stat.atime, stat.mtime);
		// Windows 下创建时间无法通过 utimes 设置，使用 fs 原生接口
		try {
			const handle = await fsp.open(targetPath, 'r+');
			await handle.utimes(stat.atime, stat.mtime);
			await handle.close();
		} catch (e) {
			// 忽略创建时间设置失败
		}
		return true;
	} catch (e) {
		return false;
	}
}

// 复制文件（保持目录结构）
async function copyFile(src, dest) {
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	await fsp.copyFile(src, dest);
	await setFileTimes(dest, src);
}

// 移动文件到已处理目录（保持相对结构）
async function moveToProcessed(src, relPath, processedDir) {
	const dest = path.join(processedDir, relPath);
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	await fsp.rename(src, dest);
}

// 移动错误源文件到错误目录（保持相对结构）
async function moveToErrorDir(src, relPath, errorDir) {
	const dest = path.join(errorDir, relPath);
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	await fsp.rename(src, dest);
}

// 递归删除空目录（不删除根目录）
async function removeEmptyDirs(dir, root) {
	let names;
	try {
		names = await fsp.readdir(dir);
	} catch (e) {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		// 单独获取类型，避免 withFileTypes 因无权限条目导致 readdir 报错
		let st;
		try {
			st = await fsp.stat(full);
		} catch (e) {
			continue; // 无权限等，跳过
		}
		if (st.isDirectory()) {
			await removeEmptyDirs(full, root);
		}
	}
	// 重新读取，因为子目录可能已被删除
	try {
		names = await fsp.readdir(dir);
	} catch (e) {
		return;
	}
	if (names.length === 0 && path.resolve(dir) !== path.resolve(root)) {
		try {
			await fsp.rmdir(dir);
		} catch (e) {
			// 忽略删除失败
		}
	}
}

// 忽略的特殊文件/目录
function isIgnored(name) {
	return name.startsWith('$') || name === 'System Volume Information' || name === '.DS_Store';
}

// 媒体文件扩展名
const PHOTO_EXTENSIONS = new Set([
	'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp',
	'.heic', '.heif', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2'
]);
const VIDEO_EXTENSIONS = new Set([
	'.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.webm', '.ts', '.mts', '.m2ts', '.3gp'
]);

// ==================== 任务队列 ====================

// 转码任务队列（并发控制）
class TaskQueue {
	constructor(concurrency) {
		this.concurrency = concurrency;
		this.running = 0;
		this.queue = [];
		this.done = 0;
		this.total = 0;
		this.error = null; // 记录第一个错误，用于停止
		this.activeDests = new Set(); // 正在处理任务的 dest 路径（统一小写，Windows 文件系统不区分大小写）
		this.destWaiters = new Map(); // destPath(小写) -> 等待该 dest 释放的任务数组
	}

	// 统一 dest 路径大小写，避免同名不同大小写（如 video.mp4 / video.MP4）被当成不同路径
	_normDest(p) {
		return p ? p.toLowerCase() : p;
	}

	push(task, fn) {
		this.total++;
		return new Promise((resolve, reject) => {
			this.queue.push({ task, fn, resolve, reject });
			this._next();
		});
	}

	_next() {
		while (this.running < this.concurrency && this.queue.length > 0) {
			const entry = this.queue.shift();
			const destPath = this._normDest(entry.task && entry.task.destPath);
			// dest 路径冲突：该 dest 正在被其它任务处理，进入等待状态
			if (destPath && this.activeDests.has(destPath)) {
				debugLog(`[DEBUG] dest冲突 task=${entry.task && entry.task.num} dest=${destPath} 等待`);
				if (!this.destWaiters.has(destPath)) {
					this.destWaiters.set(destPath, []);
				}
				this.destWaiters.get(destPath).push(entry);
				continue;
			}
			debugLog(`[DEBUG] dest无冲突 task=${entry.task && entry.task.num} dest=${destPath} activeDests=[${[...this.activeDests].join(',')}]`);
			this._run(entry);
		}
	}

	_run(entry) {
		const { task, fn, resolve, reject } = entry;
		const destPath = this._normDest(task && task.destPath);
		if (destPath) this.activeDests.add(destPath);
		this.running++;
		fn()
			.then(resolve)
			.catch((err) => {
				// 记录第一个错误，用于停止
				if (!this.error) this.error = err;
				reject(err);
			})
			.finally(() => {
				this.running--;
				this.done++;
				if (destPath) {
					this.activeDests.delete(destPath);
					// 唤醒等待该 dest 的任务，重新加入队列
					const waiters = this.destWaiters.get(destPath) || [];
					this.destWaiters.delete(destPath);
					for (const w of waiters) {
						this.queue.unshift(w);
					}
				}
				this._next();
			});
	}

	async wait() {
		while (this.running > 0 || this.queue.length > 0) {
			await new Promise((r) => setTimeout(r, 100));
		}
		// 等待结束后，如果有错误则抛出
		if (this.error) {
			throw this.error;
		}
	}
}

// ==================== 过滤器 ====================

// 将 glob 模式转换为正则表达式
// 支持 * 匹配单个路径段内的任意字符（不含 /），** 匹配多级未知目录（含 /）
function globToRegExp(pattern) {
	// 统一分隔符为 /
	const p = pattern.replace(/\\/g, '/');
	let re = '';
	for (let i = 0; i < p.length; i++) {
		const ch = p[i];
		if (ch === '*') {
			// 连续两个 * 表示多级目录
			if (p[i + 1] === '*') {
				// 跳过下一个 *
				i++;
				// ** 匹配任意多级目录（含零级）
				// 若 ** 后紧跟 /，则把 **/ 一起消费，避免多出一个斜杠
				if (p[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				// 单个 * 匹配单个路径段内的任意字符（不含 /）
				re += '[^/]*';
			}
		} else if (ch === '?') {
			re += '[^/]';
		} else if (ch === '/') {
			re += '/';
		} else {
			// 转义正则特殊字符
			re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp('^' + re + '$');
}

// 判断文件相对路径是否匹配过滤器
// filter 可以是返回 bool 的函数，或包含 glob 字符串的数组
function matchesFilter(relPath, filter) {
	if (typeof filter === 'function') {
		return !!filter(relPath);
	}
	if (Array.isArray(filter) && filter.length > 0) {
		const normalized = relPath.replace(/\\/g, '/');
		return filter.some((pattern) => globToRegExp(pattern).test(normalized));
	}
	// 无过滤器时匹配所有
	return true;
}

// ==================== 主流程 ====================

let taskCounter = 0;

// 处理单个文件
// skipped 为 true 时表示因过滤器规则不匹配而跳过（不处理，仅记录日志）
async function processFile(filePath, relPath, taskQueue, handlers, scanOptions, processOptions, skipped = false) {
	const ext = path.extname(filePath).toLowerCase();
	taskCounter++;
	const task = { num: taskCounter, relPath, srcPath: filePath, method: '忽略', size: 0, reasons: [] };

	// 因规则跳过：不处理，留在原地，标记原因"规则跳过"
	if (skipped) {
		task.method = '忽略';
		task.reasons.push('规则跳过');
		try {
			const st = await fsp.stat(filePath);
			task.size = st.size;
		} catch (e) { }
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 非媒体文件不处理，留在原地
	if (!PHOTO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) {
		task.method = '忽略';
		try {
			const st = await fsp.stat(filePath);
			task.size = st.size;
		} catch (e) { }
		handlers.onLog(formatTaskLine(task));
		return;
	}

	const dest = path.join(scanOptions.targetDir, relPath);
	task.destPath = dest;

	// 照片：原样拷贝
	if (PHOTO_EXTENSIONS.has(ext)) {
		task.method = '复制';
		task.reasons.push('图片');
		try {
			const st = await fsp.stat(filePath);
			task.size = st.size;
		} catch (e) { }
		handlers.onLog(formatTaskLine(task));
		await copyFile(filePath, dest);
		await moveToProcessed(filePath, relPath, scanOptions.processedDir);
		task.status = 'done';
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 视频：判断是否需要压缩
	task.method = '转码';
	try {
		const st = await fsp.stat(filePath);
		task.size = st.size;
	} catch (e) { }

	// 使用 ffprobe 获取媒体信息
	let info;
	try {
		info = await jiaffmpeg.probeMedia(filePath);
	} catch (e) {
		// 区分错误类型：
		// ENOENT 表示找不到 ffprobe 二进制文件（环境问题），应报错终止，不能把正常文件误判为坏文件
		if (e && e.code === 'ENOENT') {
			throw new Error(`无法运行 ffprobe（找不到 ffprobe 二进制文件），请检查 FFPROBE_PATH 配置: ${e.message}`);
		}
		// 其它错误表示媒体文件本身无法被 ffprobe 解析：跳过处理，不转码也不复制
		task.method = '忽略';
		task.reasons.push('无法解析');
		handlers.onLog(formatTaskLine(task));
		// 若提供了 errorSourceDir，把错误源文件移动到该目录
		if (scanOptions.errorSourceDir) {
			await moveToErrorDir(filePath, relPath, scanOptions.errorSourceDir);
		}
		return;
	}

	const streams = info.streams || [];
	const videoStream = jiaffmpeg.getLargestVideoStream(streams);
	const audioStream = jiaffmpeg.getFirstAudioStream(streams);

	// 没有视频流，按复制处理
	if (!videoStream) {
		task.method = '复制';
		task.reasons.push('无视频流');
		handlers.onLog(formatTaskLine(task));
		await copyFile(filePath, dest);
		await moveToProcessed(filePath, relPath, scanOptions.processedDir);
		task.status = 'done';
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 判断是否需要压缩
	// 目标编码为 h265 时判断是否已是 hevc；目标编码为 h264 时判断是否已是 h264
	const tv = processOptions.transcodeVideo || {};
	const ta = processOptions.transcodeAudio || {};
	const targetCodec = tv.targetCodec;
	const targetCodecName = targetCodec === 'h264' ? 'h264' : 'hevc';
	const densityThreshold = tv.densityThreshold;
	const transcodeReasons = [];
	if (targetCodec && videoStream.codec_name !== targetCodecName) {
		transcodeReasons.push(`编码非${targetCodecName}`);
	}
	if (densityThreshold != null && jiaffmpeg.calcDataDensity(videoStream) > densityThreshold) {
		transcodeReasons.push('密度不达标');
	}
	if (audioStream && ta.targetCodec && audioStream.codec_name !== ta.targetCodec) {
		transcodeReasons.push('音频须转码');
	}

	if (transcodeReasons.length === 0) {
		// 不需要压缩，复制
		task.method = '复制';
		task.reasons.push('密度达标');
		handlers.onLog(formatTaskLine(task));
		await copyFile(filePath, dest);
		await moveToProcessed(filePath, relPath, scanOptions.processedDir);
		task.status = 'done';
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 需要转码，加入任务队列
	task.method = '转码';
	task.reasons = transcodeReasons;
	task.duration = parseFloat(videoStream.duration) || 0;
	task.totalFrames = parseInt(videoStream.nb_frames, 10) || 0;

	// 容器格式：未指定时使用源文件的扩展名
	const container = tv.container || path.extname(filePath).replace('.', '') || 'mp4';
	// 最终目标文件路径：转码输出使用容器扩展名（与源扩展名不同时替换，如源 .AVI + 容器 mp4 → 目标 .mp4）
	const srcExt = path.extname(dest);
	const finalDest = (srcExt && srcExt.slice(1).toLowerCase() !== container.toLowerCase())
		? dest.slice(0, -srcExt.length) + '.' + container
		: dest;
	task.destPath = finalDest;
	debugLog(`[DEBUG] push task ${task.num} destPath=${task.destPath} relPath=${relPath}`);

	// 加入任务队列但不等待，让 walkDir 能继续遍历其它文件，由队列并发执行转码
	taskQueue.push(task, async () => {
		// 选择编码器
		const videoEncoder = await jiaffmpeg.selectVideoEncoder(targetCodec);
		if (!videoEncoder) {
			// 没有可用编码器，改为复制
			task.method = '复制';
			task.reasons = ['无可用编码器'];
			handlers.onLog(formatTaskLine(task));
			await copyFile(filePath, dest);
			await moveToProcessed(filePath, relPath, scanOptions.processedDir);
			task.status = 'done';
			handlers.onLog(formatTaskLine(task));
			return;
		}
		task.videoEncoder = videoEncoder;
		const useHardware = tv.hardwareEncoder !== false && !videoEncoder.startsWith('libx');
		// 检测目标文件是否已存在，存在则记录其大小（用于转码后比较决定是否替换）
		let existingSize = null;
		try {
			const destSt = await fsp.stat(finalDest);
			if (destSt.isFile()) existingSize = destSt.size;
		} catch (e) { /* 目标文件不存在 */ }
		// 转码目标文件：目标文件已存在时使用 .processing 临时后缀（加在扩展名之前，保留原扩展名以便 ffmpeg 识别容器格式），否则直接转码到目标
		const tmpDest = existingSize != null
			? finalDest.replace(/(\.[^./\\]+)$/, '.processing$1')
			: finalDest;

		try {
			// 确保目标目录存在
			await fsp.mkdir(path.dirname(finalDest), { recursive: true });
			// 任务真正开始转码时加入进度区（只显示正在转码的任务）
			handlers.onProgressAdd(task);
			await jiaffmpeg.transcodeVideo(
				filePath, tmpDest, videoStream, audioStream, videoEncoder, tv, ta, useHardware,
				(data) => handlers.onProgress(task, data),
				({ command }) => { task.ffmpegCommand = command; }
			);

			// 校验转码目标：能被 ffprobe 正确解析且至少有一个音频或视频轨道
			const valid = await jiaffmpeg.verifyTranscodedFile(tmpDest);
			if (!valid) {
				// 校验失败：删除生成文件，忽略处理（不复制不移动，留在原地）
				await fsp.unlink(tmpDest).catch(() => { });
				task.method = '忽略';
				task.reasons = ['转码结果无效'];
				handlers.onProgressRemove(task);
				handlers.onLog(formatTaskLine(task));
				// 若提供了 errorSourceDir，把错误源文件移动到该目录
				if (scanOptions.errorSourceDir) {
					await moveToErrorDir(filePath, relPath, scanOptions.errorSourceDir);
				}
				return;
			}

			// 检查转码后文件是否比源文件小
			const srcSize = (await fsp.stat(filePath)).size;
			const outSize = (await fsp.stat(tmpDest)).size;

			// 目标文件已存在时的处理
			if (existingSize != null) {
				// 转码结果比已存在的目标文件大
				if (outSize > existingSize) {
					// 源文件比已存在的目标文件小 → 改为复制源文件覆盖目标文件
					if (srcSize < existingSize) {
						await fsp.unlink(tmpDest).catch(() => { });
						task.method = '复制';
						task.reasons = [`源文件更小(源:${humanSize(srcSize)} -> 存在目标:${humanSize(existingSize)})`];
						handlers.onProgressRemove(task);
						handlers.onLog(formatTaskLine(task));
						await copyFile(filePath, finalDest);
						await moveToProcessed(filePath, relPath, scanOptions.processedDir);
						task.status = 'done';
						handlers.onLog(formatTaskLine(task));
						return;
					}
					// 否则删除转码结果，忽略任务（已处理过，源文件移到已处理目录）
					await fsp.unlink(tmpDest).catch(() => { });
					task.method = '忽略';
					task.reasons = [`转码后更大(存在目标:${humanSize(existingSize)} -> 转码:${humanSize(outSize)})`];
					handlers.onProgressRemove(task);
					handlers.onLog(formatTaskLine(task));
					await moveToProcessed(filePath, relPath, scanOptions.processedDir);
					task.status = 'done';
					handlers.onLog(formatTaskLine(task));
					return;
				}

				// 转码结果和源文件都比已存在的目标文件小 → 用更小的那个替换，理由更明确
				if (srcSize <= existingSize) {
					const smallerSize = Math.min(outSize, srcSize);
					const reason = `存在更小的目标文件(min(转码:${humanSize(outSize)},源:${humanSize(srcSize)}) -> 存在目标:${humanSize(existingSize)})`;
					if (outSize <= srcSize) {
						// 转码结果更小或相等，用转码结果替换
						await fsp.rename(tmpDest, finalDest);
						await setFileTimes(finalDest, filePath);
						await moveToProcessed(filePath, relPath, scanOptions.processedDir);
						task.status = 'done';
						task.outSize = outSize; // 记录转码后大小，用于日志显示"原大小 -> 转码后大小"
						task.reasons = [reason];
						handlers.onProgressRemove(task);
						handlers.onLog(formatTaskLine(task));
						return;
					}
					// 源文件更小，复制源文件替换
					await fsp.unlink(tmpDest).catch(() => { });
					task.method = '复制';
					task.reasons = [reason];
					handlers.onProgressRemove(task);
					handlers.onLog(formatTaskLine(task));
					await copyFile(filePath, finalDest);
					await moveToProcessed(filePath, relPath, scanOptions.processedDir);
					task.status = 'done';
					handlers.onLog(formatTaskLine(task));
					return;
				}

				// 转码结果比目标小但源文件比目标大 → 用转码结果替换
				await fsp.rename(tmpDest, finalDest);
				await setFileTimes(finalDest, filePath);
				await moveToProcessed(filePath, relPath, scanOptions.processedDir);
				task.status = 'done';
				task.outSize = outSize; // 记录转码后大小，用于日志显示"原大小 -> 转码后大小"
				handlers.onProgressRemove(task);
				handlers.onLog(formatTaskLine(task));
				return;
			}

			// 目标文件不存在：按 copyIfBigger 判断是否改为复制
			if (outSize >= srcSize && processOptions.copyIfBigger !== false) {
				// 转码后更大且 copyIfBigger 为 true（默认）：删除生成文件，改为复制源文件
				await fsp.unlink(tmpDest).catch(() => { });
				task.method = '复制';
				// 把原大小和转码后大小追加在理由后面
				task.reasons = [`转码后更大(源:${humanSize(srcSize)} -> 转码:${humanSize(outSize)})`];
				handlers.onProgressRemove(task);
				handlers.onLog(formatTaskLine(task));
				await copyFile(filePath, finalDest);
				await moveToProcessed(filePath, relPath, scanOptions.processedDir);
				task.status = 'done';
				handlers.onLog(formatTaskLine(task));
				return;
			}
			// copyIfBigger 为 false 时，即使转码后更大也保留转码结果（继续走下方重命名逻辑）

			// 转码成功且更小，重命名为目标文件并设置时间戳
			await fsp.rename(tmpDest, finalDest);
			await setFileTimes(finalDest, filePath);
			await moveToProcessed(filePath, relPath, scanOptions.processedDir);
			task.status = 'done';
			task.outSize = outSize; // 记录转码后大小，用于日志显示"原大小 -> 转码后大小"
			handlers.onProgressRemove(task);
			handlers.onLog(formatTaskLine(task));
		} catch (e) {
			// 转码出错：停止，不改为复制，抛出错误让主流程终止
			handlers.onProgressRemove(task);
			// 删除临时文件
			await fsp.unlink(tmpDest).catch(() => { });
			// ENOENT 表示找不到 ffprobe 二进制（环境问题），给出明确提示
			if (e && e.code === 'ENOENT') {
				const err = new Error(`[${task.num}] 无法运行 ffprobe（找不到 ffprobe 二进制文件），请检查 FFPROBE_PATH 配置: ${e.message}`);
				err.task = task;
				throw err;
			}
			// 提取错误信息：优先用 e.message，为空时从 ffmpeg 日志（e.log）或命令（e.cmd）中提取
			let msg = (e && e.message) || '';
			if (!msg && e && e.log) {
				// 取 ffmpeg 日志中最后几行非空内容
				const lines = String(e.log).split('\n').map((l) => l.trim()).filter(Boolean);
				msg = lines.slice(-3).join(' | ');
			}
			if (!msg && e && e.cmd) {
				msg = `命令: ${e.cmd}`;
			}
			const err = new Error(`[${task.num}] 转码出错: ${msg || '未知错误'}`);
			err.task = task;
			throw err;
		}
	});
}

// 格式化任务行
export function formatTaskLine(task) {
	const num = task.num;
	const method = task.method; // 复制|转码|忽略
	const size = task.size !== undefined ? `源:${humanSize(task.size)}` : '';
	// 原因跟在方法后面，用冒号隔开（多个原因用逗号连接）
	let line = `[${num}] ${method}`;
	if (task.reasons && task.reasons.length > 0) {
		line += `:${task.reasons.join(',')}`;
	}
	line += ` ${task.relPath}`;
	// 转码完成时显示"源大小 -> 转码后大小"，其它情况显示源大小
	if (task.outSize !== undefined) {
		line += ` (${size} -> 转码:${humanSize(task.outSize)})`;
	} else if (size) {
		line += ` (${size})`;
	}
	if (task.status === 'done') {
		line += ' ✓';
	}
	return line;
}

// 生成转码进度行文本
export function buildProgressLine(task, data) {
	// 进度：优先用帧数计算，否则用时间计算
	const totalFrames = task.totalFrames || 0;
	const frame = parseInt(data.frame, 10) || 0;
	let pct = 0;
	if (totalFrames > 0) {
		pct = Math.min(100, (frame / totalFrames) * 100);
	} else {
		// out_time_us 在 ffmpeg 刚开始时可能是 "N/A"，用 parseFloat 避免 NaN
		const outTimeUs = parseFloat(data.out_time_us) || 0;
		const outTimeSec = outTimeUs / 1000000;
		const duration = task.duration || 0;
		pct = duration > 0 ? Math.min(100, (outTimeSec / duration) * 100) : 0;
	}

	// 剩余时间
	const outTimeSec = parseFloat(data.out_time_us) || 0;
	const duration = task.duration || 0;
	let timeLeft = '';
	if (duration > 0 && outTimeSec > 0) {
		const remain = Math.max(0, duration - outTimeSec / 1000000);
		const m = Math.floor(remain / 60);
		const s = Math.floor(remain % 60);
		timeLeft = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	const time = data.out_time ? String(data.out_time).substr(0, 8) : '';
	const bitrate = data.bitrate ? String(data.bitrate) : '';
	const fps = data.fps ? String(data.fps) : '';
	const speed = data.speed ? String(data.speed) : '';
	const encoder = task.videoEncoder ? `编码器:${task.videoEncoder}` : '';

	return {
		pct,
		timeLeft,
		time,
		frame,
		bitrate,
		fps,
		speed,
		encoder
	};
}

// 递归遍历目录
async function walkDir(dir, relDir, taskQueue, handlers, scanOptions, processOptions) {
	let names;
	try {
		names = await fsp.readdir(dir);
	} catch (e) {
		return;
	}

	// 进入目录时回调（扫描文件目录前调用，用于对文件进行预处理）
	if (typeof scanOptions.onEnterDir === 'function') {
		await scanOptions.onEnterDir(dir, relDir);
	}

	for (const name of names) {
		// 忽略特殊文件和目录
		if (isIgnored(name)) continue;

		const fullPath = path.join(dir, name);
		const relPath = relDir ? path.join(relDir, name) : name;

		// 单独获取是文件还是目录（避免 withFileTypes 因无权限条目导致 readdir 报错）
		let st;
		try {
			st = await fsp.stat(fullPath);
		} catch (e) {
			continue; // 无权限等，跳过
		}

		if (st.isDirectory()) {
			// 排除已处理目录和错误源文件目录（避免再次处理其中的文件）
			const full = path.resolve(fullPath);
			if (scanOptions.processedDir && full === path.resolve(scanOptions.processedDir)) continue;
			if (scanOptions.errorSourceDir && full === path.resolve(scanOptions.errorSourceDir)) continue;
			// 默认进入所有目录，在处理文件时再按过滤器过滤
			await walkDir(fullPath, relPath, taskQueue, handlers, scanOptions, processOptions);
		} else if (st.isFile()) {
			// 处理过滤器：设置了过滤器时，仅处理匹配的文件，不匹配的标记为"规则跳过"
			if (!matchesFilter(relPath, scanOptions.filter)) {
				await processFile(fullPath, relPath, taskQueue, handlers, scanOptions, processOptions, true);
				continue;
			}
			await processFile(fullPath, relPath, taskQueue, handlers, scanOptions, processOptions);
		}
	}
}

// 主处理函数
// scanOptions: { filter, onEnterDir, sourceDir, targetDir, processedDir }
// processOptions: { transcodeVideo, transcodeAudio }
export async function runProcessing(handlers, scanOptions, processOptions) {
	// 校验必要参数
	if (!scanOptions || !scanOptions.sourceDir) {
		throw new Error('缺少必要参数 scanOptions.sourceDir');
	}
	if (!scanOptions || !scanOptions.targetDir) {
		throw new Error('缺少必要参数 scanOptions.targetDir');
	}

	// 已处理目录：非绝对路径则相对 sourceDir 获取
	let processedDir = scanOptions.processedDir;
	if (!processedDir) {
		throw new Error('缺少必要参数 scanOptions.processedDir');
	}
	if (!path.isAbsolute(processedDir)) {
		processedDir = path.join(scanOptions.sourceDir, processedDir);
	}
	scanOptions.processedDir = processedDir;

	// 确保已处理目录存在
	await fsp.mkdir(processedDir, { recursive: true });

	// 错误源文件目录：非绝对路径则相对 sourceDir 获取（目录由 moveToErrorDir 内部创建）
	if (scanOptions.errorSourceDir && !path.isAbsolute(scanOptions.errorSourceDir)) {
		scanOptions.errorSourceDir = path.join(scanOptions.sourceDir, scanOptions.errorSourceDir);
	}

	const concurrency = processOptions.concurrency != null ? processOptions.concurrency : 1;
	const taskQueue = new TaskQueue(concurrency);

	// 遍历源目录
	await walkDir(scanOptions.sourceDir, '', taskQueue, handlers, scanOptions, processOptions);

	// 等待所有转码任务完成
	await taskQueue.wait();

	// 清理空目录（不删除源目录本身）
	await removeEmptyDirs(scanOptions.sourceDir, scanOptions.sourceDir);
}

// 导出配置信息（供 UI 显示）
export function getConfig(scanOptions, processOptions) {
	return {
		sourceDir: scanOptions ? scanOptions.sourceDir : undefined,
		targetDir: scanOptions ? scanOptions.targetDir : undefined,
		processedDir: scanOptions ? scanOptions.processedDir : undefined,
		targetVideoCodec: processOptions && processOptions.transcodeVideo ? processOptions.transcodeVideo.targetCodec : undefined,
		videoTranscodeConcurrency: processOptions ? processOptions.concurrency : undefined,
		processFilter: scanOptions && Array.isArray(scanOptions.filter) ? scanOptions.filter : undefined
	};
}
