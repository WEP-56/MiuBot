import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import {
	normalizeConnectionEvent,
	normalizeInteractionEvent,
	normalizeRawEvent,
	type PlatformEventBus,
} from "./events.ts";

export type QqBotAdapterOptions = {
	bot: QQBot;
	botId: string;
	eventBus: PlatformEventBus;
	/** 入站消息回调；由宿主接到会话编排。 */
	onMessage: (message: QQBotInboundMessage) => void | Promise<void>;
	/** `ready` 事件派发后调用，宿主在此同步连接状态与 Bot 资料。 */
	onReady?: (bot: QQBot) => void;
	onError?: (error: unknown) => void;
};

/**
 * 把 QQ SDK 的具名事件与透传事件统一接到服务级事件总线。
 *
 * 这里只做「SDK 事件 → 标准事件」的翻译与转发，连接状态、昵称同步等宿主细节由回调注入，
 * 因此 `index.ts` 不必再持有事件归一化逻辑。
 */
export function attachQqBotEvents(options: QqBotAdapterOptions): void {
	const { bot, botId, eventBus } = options;

	bot.on("ready", () => {
		// 宿主先同步连接状态，再派发事件，避免订阅者读到旧的连接状态。
		options.onReady?.(bot);
		void eventBus.emit(normalizeConnectionEvent(botId, "platform.connection.ready"));
	});

	bot.on("error", (error) => {
		options.onError?.(error);
	});

	bot.on("message", async (_context, message) => {
		await options.onMessage(message);
	});

	// 生命周期事件：SDK 把未识别事件统一从 rawEvent 透传，这里归一化后交给事件总线。
	bot.on("rawEvent", (context) => {
		void eventBus.emit(normalizeRawEvent(botId, context.eventType, context.data));
	});

	bot.on("interaction", async (_context, event) => {
		try {
			await eventBus.emit(normalizeInteractionEvent(botId, event));
		} finally {
			// 3 = 忽略/未匹配；插件未处理时避免平台侧一直等待。
			await bot
				.acknowledgeInteraction(event.id, eventBus.listenerCount("platform.interaction") > 0 ? 0 : 3)
				.catch(() => {});
		}
	});

	bot.on("resumed", () => {
		void eventBus.emit(normalizeConnectionEvent(botId, "platform.connection.resumed"));
	});

	bot.on("disconnected", (event) => {
		void eventBus.emit(normalizeConnectionEvent(botId, "platform.connection.lost", event));
	});
}
