<script setup>
import { ref, reactive, onMounted } from 'vue'
import { Box, Text, ProgressBar, Newline, useApp } from '@wolf-tui/vue'
import { runProcessing, buildProgressLine, getConfig } from './core.js'

const { exit } = useApp()

// 配置信息
const config = getConfig()

// 静态 log（已完成的任务结果）
const logs = ref([])

// 动态进度（正在转码的任务）
// 每个元素: { num, relPath, encoder, pct, timeLeft, time, frame, bitrate, fps, speed, size }
const progresses = reactive([])

// 处理状态
const status = ref('运行中')
const error = ref(null)

// 启动处理
onMounted(() => {
	runProcessing({
		onLog: (line) => {
			logs.value.push(line)
		},
		onProgressAdd: (task) => {
			progresses.push({
				num: task.num,
				relPath: task.relPath,
				encoder: '',
				pct: 0,
				timeLeft: '',
				time: '',
				frame: 0,
				bitrate: '',
				fps: '',
				speed: '',
				size: task.size
			})
		},
		onProgress: (task, data) => {
			const info = buildProgressLine(task, data)
			const p = progresses.find((x) => x.num === task.num)
			if (p) {
				p.encoder = info.encoder
				p.pct = info.pct
				p.timeLeft = info.timeLeft
				p.time = info.time
				p.frame = info.frame
				p.bitrate = info.bitrate
				p.fps = info.fps
				p.speed = info.speed
			}
		},
		onProgressRemove: (task) => {
			const idx = progresses.findIndex((x) => x.num === task.num)
			if (idx !== -1) progresses.splice(idx, 1)
		}
	})
		.then(() => {
			status.value = '完成'
			// 稍等片刻让最终状态渲染，然后退出
			setTimeout(() => finishAndExit(), 300)
		})
		.catch((e) => {
			status.value = '出错'
			error.value = e
			// 稍等片刻让错误信息渲染，然后退出
			setTimeout(() => finishAndExit(), 500)
		})
})

// 退出：不调用 exit()（会清除 wolf-tui 渲染内容），直接 process.exit 保留最后渲染的界面
function finishAndExit() {
	// 让 wolf-tui 渲染最终状态（含所有静态日志和动态进度）
	// 稍等片刻让最终渲染完成，然后直接退出（保留终端内容）
	setTimeout(() => process.exit(0), 100)
}
</script>

<template>
	<Box :style="{ flexDirection: 'column', padding: 1 }">
		<!-- 标题 -->
		<Text :style="{ color: 'green', fontWeight: 'bold' }">=== 相机媒体提取工具 ===</Text>
		<Text>相机媒体目录: {{ config.cameraMediaDir }}</Text>
		<Text>目标目录: {{ config.targetDir }}</Text>
		<Text>目标视频编码: {{ config.targetVideoCodec }}</Text>
		<Text>视频并发转码数: {{ config.videoTranscodeConcurrency }}</Text>
		<Text>处理过滤: {{ config.processFilter && config.processFilter.length > 0 ? config.processFilter.join(', ') : '全部' }}</Text>
		<Newline />

		<!-- 静态结果 log 区（已完成的任务，向上滚动） -->
		<Text v-for="(log, i) in logs" :key="'log-' + i">{{ log }}</Text>

		<!-- 动态进度区（正在转码的任务，固定在底部） -->
		<Box v-for="p in progresses" :key="p.num" :style="{ flexDirection: 'column' }">
			<Text>[{{ p.num }}] 转码 {{ p.relPath }} {{ p.encoder }} 进度:{{ p.pct.toFixed(0) }}% 剩余:{{ p.timeLeft }} time:{{ p.time }} frame:{{ p.frame }} bitrate:{{ p.bitrate }} fps:{{ p.fps }} speed:{{ p.speed }}</Text>
			<ProgressBar :value="p.pct" :style="{ width: 40 }" />
		</Box>

		<!-- 状态 -->
		<Newline />
		<Text v-if="status === '完成'" :style="{ color: 'green' }">=== 处理完成 ===</Text>
		<Text v-else-if="status === '出错'" :style="{ color: 'red' }">=== 处理出错: {{ error ? error.message : '' }} ===</Text>
	</Box>
</template>
