/**
 * 核心逻辑模块：相机媒体提取
 * 遍历相机媒体目录，保持目录结构把媒体文件处理到目标目录中。
 * 照片原样拷贝，视频压缩转码。
 * 通过回调函数与 UI 层通信。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import jiaffmpeg from 'jiaffmpeg';

const fsp = fs.promises;

// ==================== 全局变量 ====================

// 相机媒体目录（必须通过环境变量 CAMERA_MEDIA_DIR 设置，无默认值）
const CAMERA_MEDIA_DIR = process.env.CAMERA_MEDIA_DIR;
// 目标目录（必须通过环境变量 TARGET_DIR 设置，无默认值）
const TARGET_DIR = process.env.TARGET_DIR;
// 已处理目录（位于相机媒体目录下）
const PROCESSED_DIR_NAME = '已处理';
const PROCESSED_DIR = CAMERA_MEDIA_DIR ? path.join(CAMERA_MEDIA_DIR, PROCESSED_DIR_NAME) : '';

// 目标视频编码：'h265' 或 'h264'，默认 h265
let TARGET_VIDEO_CODEC = process.env.TARGET_VIDEO_CODEC || 'h265';
if (TARGET_VIDEO_CODEC !== 'h264' && TARGET_VIDEO_CODEC !== 'h265') {
	TARGET_VIDEO_CODEC = 'h265';
}

// 视频并发转码任务数，默认 1，可通过环境变量 VIDEO_TRANSCODE_CONCURRENCY 设置
let VIDEO_TRANSCODE_CONCURRENCY = parseInt(process.env.VIDEO_TRANSCODE_CONCURRENCY || '1', 10);
if (isNaN(VIDEO_TRANSCODE_CONCURRENCY) || VIDEO_TRANSCODE_CONCURRENCY < 1) {
	VIDEO_TRANSCODE_CONCURRENCY = 1;
}

// ==================== 必要配置检查 ====================

// 通用脚本：源目录与目标目录必须通过环境变量显式设置，未设置时报错并退出
function checkRequiredConfig() {
	const missing = [];
	if (!CAMERA_MEDIA_DIR) missing.push('CAMERA_MEDIA_DIR');
	if (!TARGET_DIR) missing.push('TARGET_DIR');
	if (missing.length > 0) {
		console.error(`[配置错误] 缺少必要环境变量: ${missing.join(', ')}`);
		console.error('请在启动前设置这些环境变量（可参考 run_sample.bat）。');
		process.exit(1);
	}
}

checkRequiredConfig();

// 视频编码器候选列表
const VIDEO_ENCODERS = {
	h265: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'libx265'],
	h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264']
};
// 音频编码器默认
const AUDIO_ENCODER = 'aac';

// 转码参数
const CRF_BEST = 23;   // 最好量化质量
const CRF_WORST = 36;  // 最差量化质量
const KEYINT_MIN = 150; // 最短关键帧间隔
const SC_THRESHOLD = '96%'; // 场景切换敏感度
const PRESET = 'slow';  // 速度预设
const ME_METHOD = 'full'; // me_method
const MAX_MUXING_QUEUE_SIZE = 1024;
const FPS_MODE = 'passthrough';

// 数据密度阈值
const DATA_DENSITY_THRESHOLD = 0.053;

// 强行转码所有视频（测试用），可通过环境变量 FORCE_TRANSCODE 设置
const FORCE_TRANSCODE = process.env.FORCE_TRANSCODE === '1' || process.env.FORCE_TRANSCODE === 'true';

// 处理过滤器：只处理匹配的文件/目录（逗号分隔的 glob 模式列表）
// 支持 * 匹配单个路径段内的任意字符，** 匹配多级未知目录
// 为空/未设置时处理所有文件；设置后仅处理匹配的文件，不匹配的文件标记为"规则跳过"
const PROCESS_FILTER = (process.env.PROCESS_FILTER || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

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

// 解析 ffprobe 的帧率字符串，如 "30000/1001" -> 29.97
function evalFrameRate(rateStr) {
	if (!rateStr) return 0;
	const parts = String(rateStr).split('/');
	const num = parseFloat(parts[0]);
	const den = parts.length > 1 ? parseFloat(parts[1]) : 1;
	if (!den) return 0;
	return num / den;
}

// 计算视频流数据密度
function calcDataDensity(stream) {
	if (!stream || !stream.bit_rate) return 0;
	const fps = evalFrameRate(stream.avg_frame_rate);
	const w = stream.width || 0;
	const h = stream.height || 0;
	if (!fps || !w || !h) return 0;
	// bit_rate 可能是字符串，用 parseFloat 转数字
	return parseFloat(stream.bit_rate) / (fps * w * h);
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
async function moveToProcessed(src, relPath) {
	const dest = path.join(PROCESSED_DIR, relPath);
	await fsp.mkdir(path.dirname(dest), { recursive: true });
	await fsp.rename(src, dest);
}

// 递归删除空目录（不删除根目录）
async function removeEmptyDirs(dir, root) {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch (e) {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const full = path.join(dir, entry.name);
			await removeEmptyDirs(full, root);
		}
	}
	// 重新读取，因为子目录可能已被删除
	try {
		entries = await fsp.readdir(dir);
	} catch (e) {
		return;
	}
	if (entries.length === 0 && path.resolve(dir) !== path.resolve(root)) {
		try {
			await fsp.rmdir(dir);
		} catch (e) {
			// 忽略删除失败
		}
	}
}

// ==================== 视频转码 ====================

// 选择可用的视频编码器
async function selectVideoEncoder(codecType) {
	const candidates = VIDEO_ENCODERS[codecType] || VIDEO_ENCODERS.h265;
	for (const enc of candidates) {
		try {
			const ok = await jiaffmpeg.checkVideoEncoder(enc);
			if (ok) return enc;
		} catch (e) {
			// 继续尝试下一个
		}
	}
	return null;
}

// 获取视频中最大的视频流
function getLargestVideoStream(streams) {
	let largest = null;
	for (const s of streams) {
		if (s.codec_type !== 'video') continue;
		if (!largest) {
			largest = s;
			continue;
		}
		const cur = (s.width || 0) * (s.height || 0);
		const best = (largest.width || 0) * (largest.height || 0);
		if (cur > best) largest = s;
	}
	return largest;
}

// 获取第一个音频流
function getFirstAudioStream(streams) {
	return streams.find((s) => s.codec_type === 'audio') || null;
}

// 构建转码输出选项
function buildOutputOptions(videoStream, audioStream, videoEncoder, audioEncoder, useHardware) {
	const opts = new Map();

	// 视频编码
	opts.set('c:v', videoEncoder);
	opts.set('crf', String(CRF_BEST));
	opts.set('keyint_min', String(KEYINT_MIN));
	opts.set('sc_threshold', SC_THRESHOLD);
	opts.set('preset', PRESET);
	opts.set('me_method', ME_METHOD);
	// 非硬件加速编码时设置线程数为 CPU 核心数
	if (!useHardware) {
		opts.set('threads', String(os.cpus().length));
	}

	// 音频处理
	if (audioStream) {
		if (audioStream.codec_name === 'aac') {
			// aac 直接复制轨道
			opts.set('c:a', 'copy');
		} else {
			// 非 aac 转换为 aac，quality:1
			opts.set('c:a', audioEncoder || AUDIO_ENCODER);
			opts.set('q:a', '1');
		}
	}

	// 其它参数
	opts.set('max_muxing_queue_size', String(MAX_MUXING_QUEUE_SIZE));
	opts.set('fps_mode', FPS_MODE);

	return opts;
}

// 记录最近一次转码命令，出错时打印
let lastCommand = '';

// 执行视频转码
async function transcodeVideo(src, dest, videoStream, audioStream, videoEncoder, audioEncoder, useHardware, onProgress) {
	const outputOptions = buildOutputOptions(videoStream, audioStream, videoEncoder, audioEncoder, useHardware);

	// 流映射：视频流 + 音频流
	const maps = [`0:${videoStream.index}`];
	if (audioStream) {
		maps.push(`0:${audioStream.index}`);
	}
	// 使用 map 选项（会生成 -map 0:x）
	outputOptions.set('map', maps);

	await jiaffmpeg.transcode(
		src,
		{},
		dest,
		outputOptions,
		{
			update: (data) => {
				if (onProgress) onProgress(data);
			},
			spawn: ({ command }) => {
				// 记录命令，出错时打印
				lastCommand = command;
			}
		}
	);
}

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
	}

	push(task) {
		this.total++;
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this._next();
		});
	}

	_next() {
		while (this.running < this.concurrency && this.queue.length > 0) {
			const { task, resolve, reject } = this.queue.shift();
			this.running++;
			task()
				.then(resolve)
				.catch((err) => {
					// 记录第一个错误，用于停止
					if (!this.error) this.error = err;
					reject(err);
				})
				.finally(() => {
					this.running--;
					this.done++;
					this._next();
				});
		}
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

// ==================== 主流程 ====================

let taskCounter = 0;

// 处理单个文件
// skipped 为 true 时表示因 PROCESS_FILTER 规则不匹配而跳过（不处理，仅记录日志）
async function processFile(filePath, relPath, taskQueue, handlers, skipped = false) {
	const ext = path.extname(filePath).toLowerCase();
	taskCounter++;
	const task = { num: taskCounter, relPath, method: '忽略', size: 0, reasons: [] };

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

	const dest = path.join(TARGET_DIR, relPath);

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
		await moveToProcessed(filePath, relPath);
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
		info = await jiaffmpeg.ffprobe(filePath);
	} catch (e) {
		// ffprobe 失败，必须退出，防止后续失败继续放大错误影响
		console.error(e);
		process.exit(1);
		return;
	}

	const streams = info.streams || [];
	const videoStream = getLargestVideoStream(streams);
	const audioStream = getFirstAudioStream(streams);

	// 没有视频流，按复制处理
	if (!videoStream) {
		task.method = '复制';
		task.reasons.push('无视频流');
		handlers.onLog(formatTaskLine(task));
		await copyFile(filePath, dest);
		await moveToProcessed(filePath, relPath);
		task.status = 'done';
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 判断是否需要压缩（FORCE_TRANSCODE 时强制转码）
	// 收集转码/复制原因
	// 目标编码为 h265 时判断是否已是 hevc；目标编码为 h264 时判断是否已是 h264
	const targetCodecName = TARGET_VIDEO_CODEC === 'h264' ? 'h264' : 'hevc';
	const transcodeReasons = [];
	if (videoStream.codec_name !== targetCodecName) {
		transcodeReasons.push(`编码非${targetCodecName}`);
	}
	if (calcDataDensity(videoStream) > DATA_DENSITY_THRESHOLD) {
		transcodeReasons.push('密度不达标');
	}
	if (audioStream && audioStream.codec_name !== 'aac') {
		transcodeReasons.push('音频须转码');
	}

	if (!FORCE_TRANSCODE && transcodeReasons.length === 0) {
		// 不需要压缩，复制
		task.method = '复制';
		task.reasons.push('密度达标');
		handlers.onLog(formatTaskLine(task));
		await copyFile(filePath, dest);
		await moveToProcessed(filePath, relPath);
		task.status = 'done';
		handlers.onLog(formatTaskLine(task));
		return;
	}

	// 需要转码，加入任务队列
	task.method = '转码';
	task.reasons = transcodeReasons;
	task.duration = parseFloat(videoStream.duration) || 0;
	task.totalFrames = parseInt(videoStream.nb_frames, 10) || 0;

	// 加入任务队列但不等待，让 walkDir 能继续遍历其它文件，由队列并发执行转码
	taskQueue.push(async () => {
		// 选择编码器
		const videoEncoder = await selectVideoEncoder(TARGET_VIDEO_CODEC);
		if (!videoEncoder) {
			// 没有可用编码器，改为复制
			task.method = '复制';
			task.reasons = ['无可用编码器'];
			handlers.onLog(formatTaskLine(task));
			await copyFile(filePath, dest);
			await moveToProcessed(filePath, relPath);
			task.status = 'done';
			handlers.onLog(formatTaskLine(task));
			return;
		}
		task.videoEncoder = videoEncoder;
		const useHardware = !videoEncoder.startsWith('libx');
		const tmpDest = dest + '.tmp.mp4';

		try {
			// 确保目标目录存在
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			// 任务真正开始转码时加入进度区（只显示正在转码的任务）
			handlers.onProgressAdd(task);
			await transcodeVideo(
				filePath, tmpDest, videoStream, audioStream, videoEncoder, AUDIO_ENCODER, useHardware,
				(data) => handlers.onProgress(task, data)
			);

			// 检查转码后文件是否比源文件小
			const srcSize = (await fsp.stat(filePath)).size;
			const outSize = (await fsp.stat(tmpDest)).size;
			if (outSize >= srcSize) {
				// 比源文件大，删除生成文件，改为复制
				await fsp.unlink(tmpDest).catch(() => { });
				task.method = '复制';
				task.reasons = ['转码后更大'];
				handlers.onProgressRemove(task);
				handlers.onLog(formatTaskLine(task));
				await copyFile(filePath, dest);
				await moveToProcessed(filePath, relPath);
				task.status = 'done';
				handlers.onLog(formatTaskLine(task));
				return;
			}

			// 转码成功且更小，重命名为目标文件并设置时间戳
			await fsp.rename(tmpDest, dest);
			await setFileTimes(dest, filePath);
			await moveToProcessed(filePath, relPath);
			task.status = 'done';
			handlers.onProgressRemove(task);
			handlers.onLog(formatTaskLine(task));
		} catch (e) {
			// 转码出错：停止，不改为复制，抛出错误让主流程终止
			handlers.onProgressRemove(task);
			// 删除临时文件
			await fsp.unlink(tmpDest).catch(() => { });
			const err = new Error(`[${task.num}] 转码出错: ${e.message}`);
			err.cmd = lastCommand;
			err.task = task;
			throw err;
		}
	});
}

// 格式化任务行
function formatTaskLine(task) {
	const num = task.num;
	const method = task.method; // 复制|转码|忽略
	const size = task.size !== undefined ? humanSize(task.size) : '';
	// 原因跟在方法后面，用冒号隔开（多个原因用逗号连接）
	let line = `[${num}] ${method}`;
	if (task.reasons && task.reasons.length > 0) {
		line += `:${task.reasons.join(',')}`;
	}
	line += ` ${task.relPath}`;
	if (size) line += ` (${size})`;
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
async function walkDir(dir, relDir, taskQueue, handlers) {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch (e) {
		return;
	}

	for (const entry of entries) {
		const name = entry.name;
		// 忽略特殊文件和目录
		if (isIgnored(name)) continue;
		// 排除已处理目录
		if (entry.isDirectory() && name === PROCESSED_DIR_NAME) continue;

		const fullPath = path.join(dir, name);
		const relPath = relDir ? path.join(relDir, name) : name;

		if (entry.isDirectory()) {
			// 默认进入所有目录，在处理文件时再按 PROCESS_FILTER 过滤
			await walkDir(fullPath, relPath, taskQueue, handlers);
		} else if (entry.isFile()) {
			// 处理过滤器：设置了 PROCESS_FILTER 时，仅处理匹配的文件，不匹配的标记为"规则跳过"
			if (PROCESS_FILTER.length > 0 && !matchesFilter(relPath)) {
				await processFile(fullPath, relPath, taskQueue, handlers, true);
				continue;
			}
			await processFile(fullPath, relPath, taskQueue, handlers);
		}
	}
}

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

// 判断文件相对路径是否匹配任一过滤器项
function matchesFilter(relPath) {
	const normalized = relPath.replace(/\\/g, '/');
	return PROCESS_FILTER.some((pattern) => globToRegExp(pattern).test(normalized));
}

// 主处理函数
export async function runProcessing(handlers) {
	// ffmpeg / ffprobe 路径：默认走 PATH（"ffmpeg" / "ffprobe"），
	// 可通过环境变量 FFMPEG_PATH / FFPROBE_PATH 指定具体路径（与 jiaffmpeg 保持一致）
	const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
	const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
	// 初始化 jiaffmpeg
	jiaffmpeg.initPath({ ffmpeg: ffmpegPath, ffprobe: ffprobePath });

	// 确保已处理目录存在
	await fsp.mkdir(PROCESSED_DIR, { recursive: true });

	const taskQueue = new TaskQueue(VIDEO_TRANSCODE_CONCURRENCY);

	// 遍历相机媒体目录
	await walkDir(CAMERA_MEDIA_DIR, '', taskQueue, handlers);

	// 等待所有转码任务完成
	await taskQueue.wait();

	// 清理空目录（不删除相机媒体目录本身）
	await removeEmptyDirs(CAMERA_MEDIA_DIR, CAMERA_MEDIA_DIR);
}

// 导出配置信息（供 UI 显示）
export function getConfig() {
	return {
		cameraMediaDir: CAMERA_MEDIA_DIR,
		targetDir: TARGET_DIR,
		targetVideoCodec: TARGET_VIDEO_CODEC,
		videoTranscodeConcurrency: VIDEO_TRANSCODE_CONCURRENCY,
		processFilter: PROCESS_FILTER
	};
}
