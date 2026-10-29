import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewerVersion, normalize } from "@miubot/shared/utils/version";

/**
 * 当前版本号。
 *
 * 三个来源，优先级从高到低：
 *
 * 1. `MIUBOT_VERSION`：CI 打镜像时用 tag 注入（`--build-arg MIUBOT_VERSION=v0.2.0`），
 *    桌面端启动服务进程时也用它。
 * 2. 仓库根的 `VERSION` 文件：发布包（tarball）里由 CI 写入。
 * 3. 根 `package.json` 的 `version`：源码直接跑时的兜底。
 *
 * 都没有时返回 `0.0.0-dev`，工作台据此显示「开发版」，更新检查也就不会误报。
 */
export function resolveVersion(): string {
	const fromEnv = process.env.MIUBOT_VERSION?.trim();
	if (fromEnv) return normalize(fromEnv);
	const root = repoRoot();
	try {
		const fromFile = readFileSync(join(root, "VERSION"), "utf8").trim();
		if (fromFile) return normalize(fromFile);
	} catch {}
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
		if (typeof manifest.version === "string" && manifest.version.trim()) return normalize(manifest.version);
	} catch {}
	return "0.0.0-dev";
}

/**
 * 版本比较与归一化：桌面端（`apps/desktop`）要用同一套语义，实现在
 * `@miubot/shared/utils/version`，这里只转出，保持既有导入路径不变。
 */
export { isNewerVersion, normalize };

/** 仓库根目录：本文件在 `apps/server/src/` 下。 */
function repoRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
