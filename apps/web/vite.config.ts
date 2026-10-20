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
	server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
});
