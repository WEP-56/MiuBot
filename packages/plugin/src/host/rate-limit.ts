import type { PluginInactiveError } from "./lifecycle.ts";

/**
 * 插件出站速率限制。
 *
 * 位置刻意放在**出站能力层**而不是事件分发层：分发层丢弃 `message.sent` 只是中断循环，
 * 消息其实已经真的发到群里了。在这里拒绝则连 `OutboundChannel` 都不会被调用。
 *
 * 计数维度是 `(botId, scope, targetId)`：同一会话内计数，多群并行互不干扰。
 * 状态随插件实例创建，插件重启后自动清零。
 */

export type SendRateLimitOptions = {
	/** 窗口内允许的发送次数。 */
	maxSends?: number;
	/** 滑动窗口长度。 */
	windowMs?: number;
	/** 同时跟踪的会话数上限，防止长期运行累积。 */
	maxTargets?: number;
	now?: () => number;
};

/** 超过出站速率限制。插件可以捕获它做降级，未捕获则由宿主记日志。 */
export class PluginRateLimitedError extends Error {
	readonly pluginId: string;
	readonly target: string;

	constructor(pluginId: string, target: string, maxSends: number, windowMs: number) {
		super(`插件 ${pluginId} 向 ${target} 的发送超过限制（${windowMs}ms 内 ${maxSends} 次）`);
		this.name = "PluginRateLimitedError";
		this.pluginId = pluginId;
		this.target = target;
	}
}

/** 宽松默认值：正常插件（欢迎语、关键词回复）远够不到，但能挡住 A→B→A 自激循环。 */
const DEFAULT_MAX_SENDS = 5;
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_TARGETS = 200;

export function createSendRateLimiter(pluginId: string, options: SendRateLimitOptions = {}) {
	const maxSends = options.maxSends ?? DEFAULT_MAX_SENDS;
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
	const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS;
	const now = options.now ?? Date.now;
	/** 每个会话最近的发送时间戳（毫秒）。 */
	const history = new Map<string, number[]>();

	function prune(key: string, timestamp: number): number[] {
		const recent = (history.get(key) ?? []).filter((sentAt) => timestamp - sentAt < windowMs);
		if (recent.length === 0) history.delete(key);
		else history.set(key, recent);
		return recent;
	}

	return {
		/** 超限时抛出 {@link PluginRateLimitedError}；否则登记本次发送。 */
		assertWithinLimit(botId: string, target: { scope: string; targetId: string }): void {
			const timestamp = now();
			const key = `${botId}:${target.scope}:${target.targetId}`;
			const recent = prune(key, timestamp);
			if (recent.length >= maxSends) {
				throw new PluginRateLimitedError(pluginId, key, maxSends, windowMs);
			}
			recent.push(timestamp);
			history.set(key, recent);
			// 有界：超出上限时丢弃最久未活动的会话记录。
			while (history.size > maxTargets) {
				const oldest = history.keys().next().value;
				if (oldest === undefined) break;
				history.delete(oldest);
			}
		},
		/** 当前窗口内的剩余配额，用于诊断。 */
		remaining(botId: string, target: { scope: string; targetId: string }): number {
			const key = `${botId}:${target.scope}:${target.targetId}`;
			return Math.max(0, maxSends - prune(key, now()).length);
		},
		get maxSends(): number {
			return maxSends;
		},
		get windowMs(): number {
			return windowMs;
		},
	};
}

export type SendRateLimiter = ReturnType<typeof createSendRateLimiter>;

/** 未声明权限等前置失败与限流共用同一套错误语义，便于插件统一 catch。 */
export type PluginSendError = PluginInactiveError | PluginRateLimitedError;
