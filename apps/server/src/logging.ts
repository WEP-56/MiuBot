import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export type RuntimeLog = {
	time: string;
	level: LogLevel;
	text: string;
	sessionId?: string;
};

export type RuntimeLogger = {
	/** 内存中的最近日志，供管理 API 读取。 */
	list(): RuntimeLog[];
	/** 写入一条日志：内存 + 追加文件 + 控制台。文本先脱敏再落盘。 */
	write(level: LogLevel, text: string, sessionId?: string): void;
	/** 启动时把历史日志装回内存（当前文件 + 轮转文件，按时间顺序）。 */
	load(): Promise<void>;
	/** 等待队列中的写入落盘（优雅退出时用）。 */
	flush(): Promise<void>;
};

export type RuntimeLoggerOptions = {
	filePath: string;
	dir: string;
	/** 内存保留条数，供工作台轮询。 */
	limit?: number;
	/** 单个日志文件的上限，超过就轮转。 */
	maxBytes?: number;
	/** 保留的文件数（含当前文件）。`5` = 10 MB × 5 ≈ 50 MB 上限。 */
	maxFiles?: number;
};

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
/** 单条日志的字符上限：防止一次异常把整段提示词/响应体倒进日志。 */
const MAX_TEXT_LENGTH = 2000;

/**
 * 运行日志：内存保留最近 `limit` 条给界面轮询，同时追加写入 `filePath`。
 *
 * 三条约束，都是公网长期运行的前提：
 *
 * 1. **有上限**：单文件超过 `maxBytes` 就轮转，最多保留 `maxFiles` 个文件。
 *    无上限追加迟早撑爆磁盘，而磁盘满会让配置写盘失败。
 * 2. **不落密钥**：写入前统一脱敏（`redact`），调用点不需要各自记得处理。
 * 3. **不阻塞消息路径**：写文件是排队的异步任务，`write()` 立即返回；退出时 `flush()`。
 */
export function createRuntimeLogger(options: RuntimeLoggerOptions): RuntimeLogger {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFiles = Math.max(2, options.maxFiles ?? DEFAULT_MAX_FILES);
	let entries: RuntimeLog[] = [];
	/** 当前文件字节数；`-1` 表示还没 stat 过。 */
	let size = -1;
	let queue: Promise<void> = Promise.resolve();

	const enqueue = (task: () => Promise<void>): void => {
		queue = queue.then(task, task).catch(() => undefined);
	};

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
		list: () => entries,
		async load() {
			entries = await readRecent(options.filePath, maxFiles, limit);
			size = -1;
			await currentSize();
		},
		write: (level, text, sessionId) => {
			const entry: RuntimeLog = {
				time: new Date().toISOString(),
				level,
				text: sanitize(text),
				...(sessionId ? { sessionId } : {}),
			};
			entries.push(entry);
			if (entries.length > limit) entries = entries.slice(-limit);
			console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info"](`[${level}] ${entry.text}`);
			const line = `${JSON.stringify(entry)}\n`;
			const bytes = Buffer.byteLength(line);
			enqueue(async () => {
				const current = await currentSize();
				if (current > 0 && current + bytes > maxBytes) await rotate();
				await mkdir(options.dir, { recursive: true });
				await appendFile(options.filePath, line, "utf8");
				size = (size < 0 ? 0 : size) + bytes;
			});
		},
		async flush() {
			await queue;
		},
	};
}

/**
 * 脱敏 + 截断。
 *
 * 目标是「调用点不需要记住哪些字段是秘密」：密钥、Bearer 令牌、32 位以上十六进制
 * （会话 id / 令牌）与超长 base64 一律打码。宁可多遮，也不要把 `config.json` 里的东西
 * 抄进一个会被备份、被工作台展示、还会随 issue 一起发出去的文件。
 */
export function redact(text: string): string {
	let value = text;
	// `sk-…` / `pk-…` 这类带前缀的 API Key。
	value = value.replace(/\b([sp]k|rk)-[A-Za-z0-9_-]{12,}/g, "$1-***");
	value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer ***");
	// `apiKey=…` / `"appSecret": "…"` 这类键值对（保留引号，方便 grep）。
	value = value.replace(
		/((?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|secret|password|token)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
		(_match, prefix: string, raw: string) => {
			const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : "";
			return `${prefix}${quote}***${quote}`;
		},
	);
	// 32 位以上十六进制：会话 id、api-token、各类签名。
	value = value.replace(/\b[a-f0-9]{32,}\b/gi, "***");
	// 超长 base64 / base64url：JWT、二维码凭据等。
	value = value.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "***");
	return value;
}

function sanitize(text: string): string {
	const redacted = redact(text);
	return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}…（已截断）` : redacted;
}

/** 当前文件 + `.1`…`.N`，从新到旧读，凑够 `limit` 条再按时间正序返回。 */
async function readRecent(filePath: string, maxFiles: number, limit: number): Promise<RuntimeLog[]> {
	const collected: RuntimeLog[] = [];
	const candidates = [filePath];
	for (let index = 1; index <= maxFiles - 1; index += 1) candidates.push(`${filePath}.${index}`);
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
			try {
				collected.push(JSON.parse(line) as RuntimeLog);
			} catch {
				// 轮转时可能留下半行，跳过。
			}
		}
	}
	return collected.reverse();
}
