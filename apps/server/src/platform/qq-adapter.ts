import type { NormalizedPlatformEvent, PlatformEventBus } from "@miubot/shared/platform/events";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { normalizeConnectionEvent, normalizeInteractionEvent, normalizeRawEvent } from "./events.ts";

/**
 * Interaction ACK 决策。
 *
 * 用独立的窄接口取代「订阅者数量」判断：「有活跃订阅者」不等于「这个交互真的被处理了」。
 * 例如修仙插件监听所有按钮，却只认识 `cultivation:*`，此时不应声称已处理。
 *
 * 传入已归一化的完整交互事件，宿主才能按 `payload.buttonId` / `buttonData`、`botId`、
 * `scope` 和插件启用状态做精确匹配，而不是只知道「有个交互发生了」。
 *
 * 返回 `true` 表示已有处理方接手，平台侧收到「成功」；返回 `false` 时回 `3`（忽略/未匹配）。
 */
export type InteractionAckDecision = (event: NormalizedPlatformEvent) => boolean;

export type QqBotAdapterOptions = {
	bot: QQBot;
	botId: string;
	eventBus: PlatformEventBus;
	/** 入站消息回调；由宿主接到会话编排。 */
	onMessage: (message: QQBotInboundMessage) => void | Promise<void>;
	/** 全局静默时不向宿主或插件分发平台事件。 */
	acceptEvents?: () => boolean;
	/** `ready` 事件派发后调用，宿主在此同步连接状态与 Bot 资料。 */
	onReady?: (bot: QQBot) => void;
	onError?: (error: unknown) => void;
	/**
	 * 交互 ACK 决策。缺省时退化为「有 `platform.interaction` 订阅者即视为已处理」，
	 * 仅适用于没有插件宿主的场合。
	 *
	 * **过渡实现：** 宿主接入事件分发后，`listenerCount` 会因永久注册的分发包装而恒 ≥ 1，
	 * 该兜底必须由宿主注入的决策函数取代。
	 */
	canHandleInteraction?: InteractionAckDecision;
};

/** ACK 码：0 = 成功处理，3 = 忽略/未匹配（避免平台侧一直等待）。 */
const ACK_HANDLED = 0;
const ACK_IGNORED = 3;

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
		if (options.acceptEvents && !options.acceptEvents()) return;
		await options.onMessage(message);
	});

	// 生命周期事件：SDK 把未识别事件统一从 rawEvent 透传，这里归一化后交给事件总线。
	bot.on("rawEvent", (context) => {
		if (options.acceptEvents && !options.acceptEvents()) return;
		void eventBus.emit(normalizeRawEvent(botId, context.eventType, context.data));
	});

	bot.on("interaction", async (_context, event) => {
		if (options.acceptEvents && !options.acceptEvents()) {
			await bot.acknowledgeInteraction(event.id, ACK_IGNORED).catch(() => {});
			return;
		}
		const normalized = normalizeInteractionEvent(botId, event);
		const handled = options.canHandleInteraction
			? options.canHandleInteraction(normalized)
			: eventBus.listenerCount("platform.interaction") > 0;
		try {
			await eventBus.emit(normalized);
		} finally {
			await bot.acknowledgeInteraction(event.id, handled ? ACK_HANDLED : ACK_IGNORED).catch(() => {});
		}
	});

	bot.on("resumed", () => {
		void eventBus.emit(normalizeConnectionEvent(botId, "platform.connection.resumed"));
	});

	bot.on("disconnected", (event) => {
		void eventBus.emit(normalizeConnectionEvent(botId, "platform.connection.lost", event));
	});
}
