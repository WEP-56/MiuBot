import type { PluginHost, PluginLogger, PluginStorage } from "@miubot/plugin/host/index";
import type { MessageTarget, PluginTextOptions } from "@miubot/shared/platform/outbound";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { OutboundChannel } from "./outbound.ts";

/**
 * 插件出站桥接的依赖。
 *
 * 这里刻意不接收 `QQBot`：插件永远拿不到平台客户端，只能通过 botId 请求发送。
 */
export type PluginSendBridgeDependencies = {
	/** 由 botId 取统一出站通道；通道内部已封装分片、配额与媒体。 */
	channelForBotId: (botId: string) => OutboundChannel | undefined;
	/** 记录发送失败；桥接不吞错误，但会先上报。 */
	onError: (error: unknown, detail: { botId: string; target: MessageTarget }) => void;
};

/**
 * 入站消息引用（`msgId` 反查）。
 *
 * 插件侧契约不含 `msgId`，但被动回复需要它。宿主在入站时记录「某会话最近一条消息」，
 * 桥接发送时补上，从而尽量走被动回复而不是主动推送。
 *
 * **不能无条件使用**：`msgId` 有有效期与配额限制，过期的凭据会让发送直接失败。
 */
export type InboundReference = { msgId: string; recordedAt: number };

const DEFAULT_REFERENCE_TTL_MS = 5 * 60_000;

export function createInboundReferenceStore(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
	const ttlMs = options.ttlMs ?? DEFAULT_REFERENCE_TTL_MS;
	const maxEntries = options.maxEntries ?? 500;
	const now = options.now ?? Date.now;
	const references = new Map<string, InboundReference>();

	return {
		record(botId: string, target: MessageTarget, msgId: string): void {
			const key = `${botId}:${target.scope}:${target.targetId}`;
			references.delete(key);
			references.set(key, { msgId, recordedAt: now() });
			while (references.size > maxEntries) {
				const oldest = references.keys().next().value;
				if (oldest === undefined) break;
				references.delete(oldest);
			}
		},
		/** 取仍然有效的引用；过期的按不存在处理，避免拿旧 `msgId` 硬发。 */
		take(botId: string, target: MessageTarget): string | undefined {
			const key = `${botId}:${target.scope}:${target.targetId}`;
			const reference = references.get(key);
			if (!reference) return undefined;
			references.delete(key);
			return now() - reference.recordedAt <= ttlMs ? reference.msgId : undefined;
		},
		get size(): number {
			return references.size;
		},
	};
}

export type InboundReferenceStore = ReturnType<typeof createInboundReferenceStore>;

/**
 * 生成插件可见的发送函数。
 *
 * 这一层只负责 `botId → 通道`、被动回复上下文补全与**来源标注**；权限、Bot 范围、
 * 生命周期与速率限制已在 `PluginContext` 与宿主侧完成，因此这里不再重复。
 *
 * 来源必须逐次随发送传入：用全局状态会在多插件并发时互相覆盖，导致 `message.sent`
 * 被标错来源、自激过滤失效。
 */
export function createPluginSendBridge(
	deps: PluginSendBridgeDependencies,
	references?: InboundReferenceStore,
): (
	pluginId: string,
	botId: string,
	target: MessageTarget,
	text: string,
	options?: PluginTextOptions,
) => Promise<void> {
	return async (pluginId, botId, target, text, options) => {
		const channel = deps.channelForBotId(botId);
		if (!channel) throw new Error(`未找到 Bot ${botId} 的出站通道`);
		const msgId = references?.take(botId, target);
		const sendTarget: MessageTarget & { msgId?: string } = msgId ? { ...target, msgId } : target;
		const meta = { origin: "plugin" as const, originPluginId: pluginId };
		try {
			if (options?.markdown) await channel.sendMarkdown(sendTarget, text, {}, meta);
			else await channel.sendText(sendTarget, text, {}, meta);
		} catch (error) {
			deps.onError(error, { botId, target });
			throw error;
		}
	};
}

/** 由应用日志实现的插件日志出口；插件只能写日志，不能读 Miubot 运行日志。 */
export function createPluginLogger(log: (level: "INFO" | "WARN" | "ERROR", text: string) => void): PluginLogger {
	return {
		info: (message) => log("INFO", message),
		warn: (message) => log("WARN", message),
		error: (message) => log("ERROR", message),
	};
}

/** 组合根持有的宿主句柄类型，避免 `index.ts` 直接依赖 `@miubot/plugin` 的内部结构。 */
export type AppPluginHost = PluginHost;
export type AppPluginStorage = PluginStorage;
export type AppQqBot = QQBot;
