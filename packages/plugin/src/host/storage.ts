import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 插件存储的默认实现：每个插件一个 JSON 文件，按插件 id 隔离。
 *
 * 这是**最小可用**实现，不追求并发性能：单进程内串行写入即可；
 * 需要事务或大量数据的插件应自行维护数据库，而不是把这里当作通用 DB。
 */
export type FileStorageOptions = {
	/** 存储根目录；实际文件为 `<root>/<pluginId>.json`。 */
	root: string;
	pluginId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 插件 id 已由 manifest 校验过字符集，这里仍再挡一次路径分隔符。 */
function fileNameFor(pluginId: string): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new Error(`插件 id 不合法：${pluginId}`);
	return `${pluginId}.json`;
}

export function createFileStorage(options: FileStorageOptions) {
	const path = join(options.root, fileNameFor(options.pluginId));
	let queue: Promise<void> = Promise.resolve();

	async function readAll(): Promise<Record<string, unknown>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	/** 串行化写入，避免同一插件的并发 `set` 互相覆盖。 */
	function mutate(operation: (data: Record<string, unknown>) => boolean): Promise<void> {
		const next = queue.then(async () => {
			const data = await readAll();
			if (!operation(data)) return;
			await mkdir(options.root, { recursive: true });
			await writeFile(path, JSON.stringify(data, null, 2), "utf8");
		});
		queue = next.catch(() => {});
		return next;
	}

	return {
		async get(key: string): Promise<unknown> {
			return (await readAll())[key];
		},
		async set(key: string, value: unknown): Promise<void> {
			await mutate((data) => {
				data[key] = value;
				return true;
			});
		},
		async delete(key: string): Promise<void> {
			await mutate((data) => {
				if (!(key in data)) return false;
				delete data[key];
				return true;
			});
		},
		async keys(): Promise<string[]> {
			return Object.keys(await readAll()).sort();
		},
	};
}

/** 列出存储根目录下已有的插件 id，用于诊断孤立数据。 */
export async function listStoredPlugins(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root);
		return entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length));
	} catch {
		return [];
	}
}
