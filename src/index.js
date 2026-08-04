/**
 * 入口文件：渲染主 UI 组件
 */
import { render } from '@wolf-tui/vue'
import App from './App.vue'

const instance = render(App, { maxFps: 30 })

// 处理进程退出（stdin 监听器会保持进程存活，需要显式退出）
// 当 UI 渲染完成后，由 App.vue 内部逻辑触发退出
// 这里监听进程信号
process.on('SIGINT', () => {
	instance.unmount()
	process.exit(0)
})
