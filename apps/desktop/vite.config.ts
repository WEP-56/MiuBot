import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * 渲染层（首页）的 vite 配置。
 *
 * `base: "./"` 是必须的：产物用 `file://` 打开，绝对路径 `/assets/...` 会指到磁盘根目录。
 * 这里不配开发服务器代理——首页不访问 HTTP，所有能力都走 preload 的 IPC。
 */
export default defineConfig({
	root: join(root, "src/renderer"),
	base: "./",
	plugins: [react()],
	resolve: { alias: { "@": join(root, "src/renderer") } },
	build: {
		outDir: join(root, "dist/renderer"),
		emptyOutDir: true,
		rollupOptions: { input: join(root, "src/renderer/index.html") },
	},
});
