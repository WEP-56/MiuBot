import { appendFile, mkdir } from "node:fs/promises";

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
	/** 写入一条日志：内存 + 追加文件 + 控制台。 */
	write(level: LogLevel, text: string, sessionId?: string): void;
	/** 启动时把历史日志装回内存。 */
	restore(entries: RuntimeLog[]): void;
};

/**
 * 运行日志：内存保留最近 `limit` 条给界面轮询，同时追加写入 `filePath`。
 *
 * 写文件是异步的（`void ...then`），日志不能阻塞消息处理路径。
 */
export function createRuntimeLogger(options: { filePath: string; dir: string; limit?: number }): RuntimeLogger {
	const limit = options.limit ?? 1000;
	let entries: RuntimeLog[] = [];
	return {
		list: () => entries,
		restore: (restored) => {
			entries = restored;
		},
		write: (level, text, sessionId) => {
			const entry: RuntimeLog = {
				time: new Date().toISOString(),
				level,
				text,
				...(sessionId ? { sessionId } : {}),
			};
			entries.push(entry);
			if (entries.length > limit) entries = entries.slice(-limit);
			void mkdir(options.dir, { recursive: true }).then(() =>
				appendFile(options.filePath, `${JSON.stringify(entry)}\n`, "utf8"),
			);
			console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info"](`[${level}] ${text}`);
		},
	};
}
