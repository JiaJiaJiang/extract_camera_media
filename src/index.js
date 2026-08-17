/**
 * 入口文件：渲染主 UI 组件
 * 所有参数定义（从环境变量或默认值获取配置）都放在这里，
 * 组装成 scanOptions / processOptions 对象，作为 vue 参数传入 core.js。
 */
import { render, h } from '@wolf-tui/vue'
import jiaffmpeg from 'jiaffmpeg'
import App from './App.vue'

// 初始化 jiaffmpeg（ffmpeg/ffprobe 路径：默认走 PATH，可通过环境变量指定）
jiaffmpeg.initPath({
	ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
	ffprobe: process.env.FFPROBE_PATH || 'ffprobe'
})

// ==================== 参数定义（环境变量 / 默认值） ====================

// 源目录（必须通过环境变量 CAMERA_MEDIA_DIR 设置，无默认值）
const sourceDir = process.env.CAMERA_MEDIA_DIR
// 目标目录（必须通过环境变量 TARGET_DIR 设置，无默认值）
const targetDir = process.env.TARGET_DIR
// 已处理目录（非绝对路径则相对 sourceDir 获取）
const processedDir = process.env.PROCESSED_DIR || '已处理'

// 处理过滤器：只处理匹配的文件/目录（逗号分隔的 glob 模式列表）
// 支持 * 匹配单个路径段内的任意字符，** 匹配多级未知目录
// 为空/未设置时处理所有文件；设置后仅处理匹配的文件，不匹配的文件标记为"规则跳过"
const filter = (process.env.PROCESS_FILTER || '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean)

// 目标视频编码：'h265' 或 'h264'，默认 h265
let targetCodec = process.env.TARGET_VIDEO_CODEC || 'h265'
if (targetCodec !== 'h264' && targetCodec !== 'h265') {
	targetCodec = 'h265'
}

// 视频并发转码任务数，默认 1，可通过环境变量 VIDEO_TRANSCODE_CONCURRENCY 设置
let concurrency = parseInt(process.env.VIDEO_TRANSCODE_CONCURRENCY || '1', 10)
if (isNaN(concurrency) || concurrency < 1) {
	concurrency = 1
}

// 强行转码所有视频（测试用），可通过环境变量 FORCE_TRANSCODE 设置
const forceTranscode = process.env.FORCE_TRANSCODE === '1' || process.env.FORCE_TRANSCODE === 'true'

// 必要配置检查
if (!sourceDir) {
	console.error('[配置错误] 缺少必要环境变量: CAMERA_MEDIA_DIR')
	console.error('请在启动前设置这些环境变量（可参考 run_sample.bat）。')
	process.exit(1)
}
if (!targetDir) {
	console.error('[配置错误] 缺少必要环境变量: TARGET_DIR')
	console.error('请在启动前设置这些环境变量（可参考 run_sample.bat）。')
	process.exit(1)
}

// ==================== 组装参数对象 ====================

// 文件扫描参数
const scanOptions = {
	filter, // 处理过滤器：返回 bool 的函数 或 包含 glob 字符串的数组
	// onEnterDir(fullPath, relativePath) // 进入目录时扫描文件目录前调用的回调函数，以便对文件进行预处理
	sourceDir,
	targetDir,
	processedDir // 已处理文件被移动到此目录，传入的非绝对路径的话则相对 sourceDir 获取
}

// 转码具体参数
const processOptions = {
	concurrency, // 视频并发转码任务数
	forceTranscode, // 强行转码所有视频（测试用）
	transcodeVideo: {
		densityThreshold: 0.053, // 要转码的视频密度阈值
		targetCodec, // 可选 h265 或 h264，根据 targetCodec 自动选择目标编码器
		hardwareEncoder: true, // 是否使用硬件编码，硬件加速编码器优先级使用 nvenc,qsv,amf 的顺序
		hardwareDecoder: false, // 是否使用硬件解码
		quantizationQuality: 23, // 量化质量（最好的质量）
		qualityGap: 13, // 在量化质量的基础上允许的最差质量值
		minKeyframeInterval: 150, // 关键帧间隔
		sceneChangeThreshold: '96%', // 场景变化阈值
		profile: 'main', // 编码 profile
		fpsMode: 'passthrough', // 帧率模式
		container: 'mp4' // 文件容器格式
	},
	transcodeAudio: {
		targetCodec: 'aac', // 如果视频中的音频不符合此编码则转码对应音轨
		quality: 1 // 控制音质，0.0 为最差，1.0 为最好
		// bitrate // 控制音质，和 quality 不同时使用
	}
}

// ==================== 渲染 UI ====================

// 通过 h() 把 scanOptions / processOptions 作为 props 传给 App 组件
// render 的第二个参数是渲染选项（如 maxFps 渲染帧率控制），不是组件 props
const instance = render(h(App, { scanOptions, processOptions }), { maxFps: 30 })

// 处理进程退出（stdin 监听器会保持进程存活，需要显式退出）
// 当 UI 渲染完成后，由 App.vue 内部逻辑触发退出
// 这里监听进程信号
process.on('SIGINT', () => {
	instance.unmount()
	process.exit(0)
})
