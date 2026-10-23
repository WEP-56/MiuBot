import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 工作台静态产物。
 *
 * `vite-plugin-singlefile` 把整个工作台打进一个 `index.html`（JS/CSS 全内联），
 * 因此托管只需要一个文件 + SPA 回退，不需要静态目录映射，也就没有路径穿越面。
 * 产物在进程启动后不会变（部署 = 重启），读一次缓存即可。
 */
export type WebAssets = {
	readonly distDir: string;
	/** 工作台入口 HTML；尚未构建时返回 undefined。 */
	index(): Promise<string | undefined>;
};

export function createWebAssets(distDir: string): WebAssets {
	let cached: string | undefined;
	return {
		distDir,
		async index() {
			if (cached !== undefined) return cached;
			try {
				cached = await readFile(join(distDir, "index.html"), "utf8");
			} catch {
				return undefined;
			}
			return cached;
		},
	};
}
