import type { InteractionEvent, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

/**
 * 标准平台事件。
 *
 * QQ 官方 Gateway 只把 C2C / 群消息与按钮交互派发成具名事件，其余生命周期事件统一从
 * `rawEvent` 透传（见 qqbot-nodejs `event-dispatcher.js`：未识别事件返回 `action: "raw"`）。
 * 这里把两类来源归一成同一份契约，插件与业务层只消费标准事件。
 */
export type PlatformEventType =
	| "message.received"
	| "message.sent"
	| "platform.interaction"
	| "platform.group.bot_added"
	| "platform.group.bot_removed"
	| "platform.group.message_rejected"
	| "platform.group.message_allowed"
	| "platform.c2c.message_rejected"
	| "platform.c2c.message_allowed"
	| "platform.friend.added"
	| "platform.friend.removed"
	| "platform.guild.member_added"
	| "platform.guild.member_removed"
	| "platform.reaction.added"
	| "platform.reaction.removed"
	| "platform.connection.ready"
	| "platform.connection.resumed"
	| "platform.connection.lost"
	| "platform.raw";

export type PlatformScope = "group" | "c2c" | "guild" | "dm";

export type NormalizedPlatformEvent = {
	/** 幂等键：同一事件重复到达（重连重投）时保持不变。 */
	eventId: string;
	type: PlatformEventType;
	platform: "qq";
	botId: string;
	timestamp: string;
	scope?: PlatformScope;
	/** 会话对象 ID：群 OpenID 或用户 OpenID。 */
	peerId?: string;
	senderId?: string;
	payload: Record<string, unknown>;
	/** 原始平台数据，字段不稳定，仅供诊断与高级订阅。 */
	raw?: unknown;
};

/** 原始事件类型 → 标准事件类型。未列出的走 `platform.raw`，保证不丢事件。 */
const RAW_EVENT_MAP: Record<string, PlatformEventType> = {
	GROUP_ADD_ROBOT: "platform.group.bot_added",
	GROUP_DEL_ROBOT: "platform.group.bot_removed",
	GROUP_MSG_REJECT: "platform.group.message_rejected",
	GROUP_MSG_RECEIVE: "platform.group.message_allowed",
	C2C_MSG_REJECT: "platform.c2c.message_rejected",
	C2C_MSG_RECEIVE: "platform.c2c.message_allowed",
	FRIEND_ADD: "platform.friend.added",
	FRIEND_DEL: "platform.friend.removed",
	GUILD_MEMBER_ADD: "platform.guild.member_added",
	GUILD_MEMBER_REMOVE: "platform.guild.member_removed",
	MESSAGE_REACTION_ADD: "platform.reaction.added",
	MESSAGE_REACTION_REMOVE: "platform.reaction.removed",
	READY: "platform.connection.ready",
	RESUMED: "platform.connection.resumed",
};

/** 群/私聊语义的事件 → 作用域，用于给插件提供统一过滤维度。 */
const SCOPE_BY_EVENT: Partial<Record<string, PlatformScope>> = {
	GROUP_ADD_ROBOT: "group",
	GROUP_DEL_ROBOT: "group",
	GROUP_MSG_REJECT: "group",
	GROUP_MSG_RECEIVE: "group",
	C2C_MSG_REJECT: "c2c",
	C2C_MSG_RECEIVE: "c2c",
	FRIEND_ADD: "c2c",
	FRIEND_DEL: "c2c",
};

function readString(source: unknown, key: string): string | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value ? value : undefined;
}

function asRecord(source: unknown): Record<string, unknown> {
	return typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
}

/** 群事件用 group_openid，私聊事件用 openid / user_openid / op_member_openid。 */
function pickPeerId(data: Record<string, unknown>): string | undefined {
	return (
		readString(data, "group_openid") ??
		readString(data, "openid") ??
		readString(data, "user_openid") ??
		readString(data, "channel_id")
	);
}

/** 把 `rawEvent` 的透传数据归一化成标准事件。未知事件保留为 `platform.raw`。 */
export function normalizeRawEvent(botId: string, eventType: string, data: unknown): NormalizedPlatformEvent {
	const record = asRecord(data);
	const type = RAW_EVENT_MAP[eventType] ?? "platform.raw";
	const scope = SCOPE_BY_EVENT[eventType];
	const peerId = pickPeerId(record);
	const eventId =
		readString(record, "id") ?? `${botId}:${eventType}:${readString(record, "timestamp") ?? ""}:${peerId ?? ""}`;
	return {
		eventId,
		type,
		platform: "qq",
		botId,
		timestamp: readString(record, "timestamp") ?? new Date().toISOString(),
		...(scope ? { scope } : {}),
		...(peerId ? { peerId } : {}),
		...((readString(record, "op_member_openid") ?? readString(record, "user_openid"))
			? { senderId: readString(record, "op_member_openid") ?? readString(record, "user_openid") }
			: {}),
		payload: { rawEventType: eventType, ...record },
		raw: data,
	};
}

/**
 * 按钮交互事件归一化。
 *
 * QQ 只有一个 interaction 入口，`data.resolved.button_data` / `button_id` 由调用方自行约定。
 */
export function normalizeInteractionEvent(botId: string, event: InteractionEvent): NormalizedPlatformEvent {
	const scope: PlatformScope = event.scene === "group" ? "group" : "c2c";
	const peerId = scope === "group" ? (event.group_openid ?? event.user_openid) : event.user_openid;
	const resolved = event.data?.resolved;
	return {
		eventId: event.id,
		type: "platform.interaction",
		platform: "qq",
		botId,
		timestamp: event.timestamp ?? new Date().toISOString(),
		scope,
		...(peerId ? { peerId } : {}),
		...((event.group_member_openid ?? event.user_openid)
			? { senderId: event.group_member_openid ?? event.user_openid }
			: {}),
		payload: {
			interactionId: event.id,
			interactionType: event.data?.type,
			buttonId: resolved?.button_id,
			buttonData: resolved?.button_data,
			messageId: resolved?.message_id,
			...(event.chat_type === undefined ? {} : { chatType: event.chat_type }),
		},
		raw: event,
	};
}

/** 把一条已标准化的入站消息转成事件，供插件只监听消息而无需接入 Agent。 */
export function normalizeMessageEvent(botId: string, message: QQBotInboundMessage): NormalizedPlatformEvent {
	const isGroup = message.kind === "group";
	return {
		eventId: message.messageId,
		type: "message.received",
		platform: "qq",
		botId,
		timestamp: message.timestamp,
		scope: message.kind,
		peerId: isGroup ? message.groupOpenid : message.senderId,
		senderId: message.senderId,
		payload: {
			text: message.content,
			rawEventType: message.rawEventType,
			attachments: message.attachments?.length ?? 0,
			mentionedBot: (message.mentions ?? []).some((mention) => mention.is_you === true),
			...(message.refMsgIdx ? { refMsgIdx: message.refMsgIdx } : {}),
		},
		raw: message.raw,
	};
}

/** 连接状态事件（ready / resumed / 断开）。 */
export function normalizeConnectionEvent(
	botId: string,
	type: "platform.connection.ready" | "platform.connection.resumed" | "platform.connection.lost",
	detail?: unknown,
): NormalizedPlatformEvent {
	return {
		eventId: `${botId}:${type}:${Date.now()}`,
		type,
		platform: "qq",
		botId,
		timestamp: new Date().toISOString(),
		payload: asRecord(detail),
		...(detail === undefined ? {} : { raw: detail }),
	};
}

export type PlatformEventHandler = (event: NormalizedPlatformEvent) => void | Promise<void>;

export type PlatformEventBusOptions = {
	/** 单个订阅者的超时，超时只记录不阻断其它订阅者。 */
	timeoutMs?: number;
	onError?: (error: unknown, event: NormalizedPlatformEvent, type: string) => void;
};

/**
 * 服务级事件总线。
 *
 * 一个订阅者抛错或超时不影响其它订阅者，也不阻断主消息流水线——插件与业务逻辑共享这条契约。
 */
export function createPlatformEventBus(options: PlatformEventBusOptions = {}) {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const handlers = new Map<string, Set<PlatformEventHandler>>();

	function subscribe(type: PlatformEventType | "*", handler: PlatformEventHandler): () => void {
		const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
		set.add(handler);
		handlers.set(type, set);
		return () => {
			const current = handlers.get(type);
			if (!current) return;
			current.delete(handler);
			if (current.size === 0) handlers.delete(type);
		};
	}

	async function runHandler(
		event: NormalizedPlatformEvent,
		type: string,
		handler: PlatformEventHandler,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve(handler(event)),
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						options.onError?.(new Error(`事件订阅者超时 ${timeoutMs}ms（${type}）`), event, type);
						resolve();
					}, timeoutMs);
				}),
			]);
		} catch (error) {
			options.onError?.(error, event, type);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function emit(event: NormalizedPlatformEvent): Promise<void> {
		const targets = [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])];
		await Promise.all(targets.map((handler) => runHandler(event, event.type, handler)));
	}

	function listenerCount(type: PlatformEventType | "*"): number {
		return handlers.get(type)?.size ?? 0;
	}

	return { subscribe, emit, listenerCount };
}

export type PlatformEventBus = ReturnType<typeof createPlatformEventBus>;
