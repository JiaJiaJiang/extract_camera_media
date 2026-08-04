import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { wolfie } from '@wolf-tui/plugin/vite'

export default defineConfig({
	plugins: [
		vue({
			template: {
				compilerOptions: {
					isCustomElement: (tag) => tag.startsWith('wolfie-'),
					hoistStatic: false,
				},
			},
		}),
		wolfie('vue'),
	],
	build: {
		target: 'node20',
		outDir: '.',
		emptyOutDir: false,
		lib: {
			entry: 'src/index.js',
			formats: ['cjs'],
			fileName: 'index',
		},
		rollupOptions: {
			external: [
				/^vue(\/|$)/,
				/^@wolf-tui\//,
				/^jiaffmpeg(\/|$)/,
				/^node:/,
				'fs', 'path', 'os', 'util', 'events', 'stream', 'child_process',
			],
		},
	},
})
