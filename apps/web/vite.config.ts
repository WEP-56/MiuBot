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
	// 代理必须改写 Host：服务端按 Host 判定「只接受本机回环地址」，否则会拿到 403。
	server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } } },
});
