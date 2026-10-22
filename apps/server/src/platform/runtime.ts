import type { NormalizedPlatformEvent, PlatformEventBus } from "@miubot/shared/platform/events";
import { createPlatformEventBus } from "@miubot/shared/platform/events";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { createMessageDeduplicator, type MessageDeduplicator } from "./inbound.ts";
import { createOutboundChannel, type OutboundChannel } from "./outbound.ts";

export type QqPlatformOptions = {
	/** 平台事件订阅失败的日志出口；由宿主注入，避免平台层直接依赖应用日志实现。 */
	onEventError: (error: unknown, type: string, eventType: string) => void;
	/** 发送失败日志出口。 */
	onSendError: (error: unknown) => void;
	/** 由 Bot 实例反查配置 ID；查不到时退化为 `default`（单 Bot 场景无影响）。 */
	resolveBotId: (bot: QQBot) => string | undefined;
	/**
	 * 为一次发送标注引发者。
	 *
	 * 缺省为 `agent`。插件桥接接入后（A2）由宿主提供，用 `plugin` + `originPluginId` 标记来源，
	 * 使插件不会被自己发出的 `message.sent` 反复唤醒。
	 */
	resolveSendOrigin?: () => Pick<NormalizedPlatformEvent, "origin" | "originPluginId" | "causationId">;
};

export type QqPlatform = {
	eventBus: PlatformEventBus;
	inboundDeduper: MessageDeduplicator;
	/** 取 Bot 对应的统一出站通道；同一 Bot 复用同一个通道以共享被动回复配额。 */
	channelFor: (bot: QQBot) => OutboundChannel;
};

/**
 * QQ 平台层装配。
 *
 * 组合根只需创建一份实例并注入日志与 Bot 反查函数；事件总线、入站去重与出站通道
 * 都属于平台层，不应散落在进程入口里。
 */
export function createQqPlatform(options: QqPlatformOptions): QqPlatform {
	const eventBus = createPlatformEventBus({
		onError: (error, event, type) => options.onEventError(error, type, event.type),
	});
	const inboundDeduper = createMessageDeduplicator();
	const outboundChannels = new Map<string, OutboundChannel>();

	function channelFor(bot: QQBot): OutboundChannel {
		const key = options.resolveBotId(bot) ?? "default";
		const existing = outboundChannels.get(key);
		if (existing) return existing;
		const channel = createOutboundChannel({
			bot,
			onError: (error) => options.onSendError(error),
			onSent: (info) => {
				void eventBus.emit({
					eventId: crypto.randomUUID(),
					type: "message.sent",
					platform: "qq",
					botId: key,
					timestamp: new Date().toISOString(),
					scope: info.target.scope,
					peerId: info.target.targetId,
					payload: {
						kind: info.kind,
						messages: info.messages,
						fallbackUsed: info.fallbackUsed,
						...(info.target.msgId ? { msgId: info.target.msgId } : {}),
					},
					...(options.resolveSendOrigin?.() ?? { origin: "agent" }),
					// 发送观察事件每次都不同，不参与去重。
				});
			},
		});
		outboundChannels.set(key, channel);
		return channel;
	}

	return { eventBus, inboundDeduper, channelFor };
}
