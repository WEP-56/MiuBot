import { pathToFileURL } from "node:url";
import type { PluginDefinition } from "./context.ts";

/** 加载插件入口模块得到的东西，形状尚不可信。 */
function readDefinition(moduleExports: unknown): unknown {
	if (typeof moduleExports !== "object" || moduleExports === null) return undefined;
	const record = moduleExports as Record<string, unknown>;
	return record.default ?? record.plugin;
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.setup === "function";
}

export type LoadEntryResult = { ok: true; definition: PluginDefinition } | { ok: false; message: string };

/**
 * 加载插件入口。
 *
 * 允许 `.ts`：开发期直接写 TypeScript 省掉构建步骤，代价是插件源码会被载入主进程。
 * 这与「首版只支持管理员手工放置的可信本地插件」的边界一致——插件不是沙箱，
 * 它拥有与 Miubot 同等的进程权限。
 *
 * `.js` / `.mjs` / `.cjs` 走原生 `import()`；`.ts` 等需要转换的扩展走 jiti。
 */
export async function loadPluginEntry(entryPath: string): Promise<LoadEntryResult> {
	const needsTransform = !/\.(?:js|mjs|cjs)$/i.test(entryPath);
	let moduleExports: unknown;
	try {
		if (needsTransform) {
			// jiti 用于加载插件入口的 TypeScript 源码；这是确有动态加载需求的场合。
			const { createJiti } = await import("jiti");
			const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
			moduleExports = await jiti.import(entryPath);
		} else {
			moduleExports = await import(pathToFileURL(entryPath).href);
		}
	} catch (error) {
		return { ok: false, message: `加载入口失败：${error instanceof Error ? error.message : String(error)}` };
	}

	const definition = readDefinition(moduleExports);
	if (!isPluginDefinition(definition)) {
		return { ok: false, message: "入口必须默认导出一个带 id 与 setup 的插件定义" };
	}
	return { ok: true, definition };
}
