import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";

export type RotatingWriterOptions = {
	filePath: string;
	dir: string;
	/** 单个文件的上限，超过就轮转。 */
	maxBytes?: number;
	/** 保留的文件数（含当前文件）。`5` = 10 MB × 5 ≈ 50 MB 上限。 */
	maxFiles?: number;
};

export type RotatingWriter = {
	/** 追加一行（自动补换行）。写入排队执行，不阻塞调用方。 */
	append(line: string): void;
	/** 等待队列中的写入落盘（优雅退出时用）。 */
	flush(): Promise<void>;
	/** 当前文件 + `.1`…`.N`，返回最近 `limit` 行，按时间正序。 */
	readRecent(limit: number): Promise<string[]>;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

/**
 * 有上限的追加写文件。
 *
 * 无上限追加迟早撑爆磁盘，而磁盘满会让配置写盘失败——运行日志和审计日志都要这个保证。
 * 写入走一条串行队列：轮转与追加不会交错，进程被 SIGTERM 掐掉前 `flush()` 一次即可。
 */
export function createRotatingWriter(options: RotatingWriterOptions): RotatingWriter {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFiles = Math.max(2, options.maxFiles ?? DEFAULT_MAX_FILES);
	/** 当前文件字节数；`-1` 表示还没 stat 过。 */
	let size = -1;
	let queue: Promise<void> = Promise.resolve();

	async function currentSize(): Promise<number> {
		if (size >= 0) return size;
		try {
			size = (await stat(options.filePath)).size;
		} catch {
			size = 0;
		}
		return size;
	}

	async function rotate(): Promise<void> {
		// 先删最旧的，再从新到旧挪，最后把当前文件改成 .1。
		await rm(`${options.filePath}.${maxFiles - 1}`, { force: true });
		for (let index = maxFiles - 2; index >= 1; index -= 1) {
			await rename(`${options.filePath}.${index}`, `${options.filePath}.${index + 1}`).catch(() => undefined);
		}
		await rename(options.filePath, `${options.filePath}.1`).catch(() => undefined);
		size = 0;
	}

	return {
		append(line) {
			const bytes = Buffer.byteLength(line);
			queue = queue
				.then(async () => {
					const current = await currentSize();
					if (current > 0 && current + bytes > maxBytes) await rotate();
					await mkdir(options.dir, { recursive: true });
					await appendFile(options.filePath, line, "utf8");
					size = (size < 0 ? 0 : size) + bytes;
				})
				.catch(() => undefined);
		},
		async flush() {
			await queue;
		},
		async readRecent(limit) {
			const collected: string[] = [];
			const candidates = [options.filePath];
			for (let index = 1; index <= maxFiles - 1; index += 1) candidates.push(`${options.filePath}.${index}`);
			for (const candidate of candidates) {
				if (collected.length >= limit) break;
				let content: string;
				try {
					content = await readFile(candidate, "utf8");
				} catch {
					continue;
				}
				const lines = content.split("\n").filter(Boolean).reverse();
				for (const line of lines) {
					if (collected.length >= limit) break;
					collected.push(line);
				}
			}
			return collected.reverse();
		},
	};
}
