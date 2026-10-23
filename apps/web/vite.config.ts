import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	plugins: [react(), tailwindcss(), viteSingleFile()],
	resolve: { alias: { "@": path.resolve(dirname, "src") } },
	// 开发代理必须改写 Host：服务端按 Host 判定「回环或 MIUBOT_ALLOWED_HOSTS」，否则 403。
	// ⚠️ 这一行只服务本地开发。生产反代要 `proxy_set_header Host $host`，
	// 照抄 changeOrigin 的效果等于关掉 Host 校验（见 deploy/nginx.conf）。
	server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } } },
});
