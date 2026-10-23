import { redact } from "./logging.ts";
import { createRotatingWriter } from "./rotating-writer.ts";

/** 一条审计记录。只记「谁做了什么」，不记请求体——里面可能带密钥。 */
export type AuditEntry = {
	at: string;
	/** 机器可读的动作名，如 `auth.login` / `api.mutation`。 */
	action: string;
	/** 谁做的。目前只有一个管理员，预留给将来的多用户。 */
	actor: string;
	/** 人可读的细节：目标、结果、耗时。 */
	detail: string;
};

export type AuditLog = {
	/** 追加一条；`at` 由本模块填。 */
	record(entry: Omit<AuditEntry, "at">): void;
	/** 最近的记录，新的在前。 */
	list(limit?: number): Promise<AuditEntry[]>;
	/** 等待落盘（优雅退出时用）。 */
	flush(): Promise<void>;
};

export type AuditLogOptions = {
	filePath: string;
	dir: string;
	maxBytes?: number;
	maxFiles?: number;
};

const DEFAULT_LIMIT = 200;

/**
 * 审计日志：追加写 `audit.log`（JSON Lines，10 MB × 3 轮转）。
 *
 * 与运行日志分开的理由不同：运行日志是排障用的，会被工作台轮询、也可能随 issue 贴出去；
 * 审计日志回答的是「这条配置是谁什么时候改的」，需要长期保留且不能被正常运行日志冲掉。
 *
 * 内容仍然过一遍 `redact`：审计条目里可能出现路径、ID、错误文案，不该顺手把密钥抄进去。
 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
	const writer = createRotatingWriter({
		filePath: options.filePath,
		dir: options.dir,
		maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
		maxFiles: options.maxFiles ?? 3,
	});

	return {
		record: (entry) => {
			const full: AuditEntry = { at: new Date().toISOString(), ...entry };
			writer.append(`${redact(JSON.stringify(full))}\n`);
		},
		async list(limit = DEFAULT_LIMIT) {
			const lines = await writer.readRecent(limit);
			const entries: AuditEntry[] = [];
			for (const line of lines) {
				try {
					entries.push(JSON.parse(line) as AuditEntry);
				} catch {
					// 轮转边界上的半行，跳过。
				}
			}
			return entries.reverse();
		},
		flush: () => writer.flush(),
	};
}
