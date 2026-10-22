import { createHash } from "node:crypto";
import type { NormalizedPlatformEvent, PlatformEventType, PlatformScope } from "@miubot/shared/platform/events";
import type { InteractionEvent, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

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

/**
 * 内容指纹：仅用于日志与诊断。
 *
 * 它**不能**当作幂等键——两条真实事件可以拥有完全相同的 payload，重投也可能附带变化的元数据。
 */
function fingerprintOf(data: unknown): string | undefined {
	if (data === undefined) return undefined;
	try {
		return createHash("sha256")
			.update(JSON.stringify(data) ?? "")
			.digest("hex")
			.slice(0, 16);
	} catch {
		return undefined;
	}
}

/**
 * 把 `rawEvent` 的透传数据归一化成标准事件。未知事件保留为 `platform.raw`。
 *
 * QQ 只在少数事件上给出稳定 `id`；没有时**不填** `dedupKey`，由宿主按“不可强制去重”处理，
 * 避免把两次真实事件误判成重投。
 */
export function normalizeRawEvent(botId: string, eventType: string, data: unknown): NormalizedPlatformEvent {
	const record = asRecord(data);
	const type = RAW_EVENT_MAP[eventType] ?? "platform.raw";
	const scope = SCOPE_BY_EVENT[eventType];
	const peerId = pickPeerId(record);
	const platformId = readString(record, "id");
	const senderId = readString(record, "op_member_openid") ?? readString(record, "user_openid");
	const fingerprint = fingerprintOf(data);
	return {
		eventId: platformId ?? crypto.randomUUID(),
		type,
		platform: "qq",
		botId,
		timestamp: readString(record, "timestamp") ?? new Date().toISOString(),
		...(scope ? { scope } : {}),
		...(peerId ? { peerId } : {}),
		...(senderId ? { senderId } : {}),
		payload: { rawEventType: eventType, ...record },
		...(platformId ? { dedupKey: platformId } : {}),
		...(fingerprint ? { fingerprint } : {}),
		origin: "platform",
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
		// 按钮交互的事件 id 由平台提供且稳定，可安全用于幂等。
		dedupKey: event.id,
		origin: "platform",
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
		dedupKey: message.messageId,
		origin: "platform",
		raw: message.raw,
	};
}

/**
 * 连接状态事件（ready / resumed / 断开）。
 *
 * 连接事件永远不带 `dedupKey`：断线重连的次数本身就是信息，去重会让状态机停在错误的一侧。
 */
export function normalizeConnectionEvent(
	botId: string,
	type: "platform.connection.ready" | "platform.connection.resumed" | "platform.connection.lost",
	detail?: unknown,
): NormalizedPlatformEvent {
	return {
		eventId: crypto.randomUUID(),
		type,
		platform: "qq",
		botId,
		timestamp: new Date().toISOString(),
		payload: asRecord(detail),
		origin: "platform",
		...(detail === undefined ? {} : { raw: detail }),
	};
}
