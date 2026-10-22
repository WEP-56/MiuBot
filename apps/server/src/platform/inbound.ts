import type { Deduplicator, DeduplicatorOptions } from "@miubot/shared/platform/dedup";
import { createDeduplicator } from "@miubot/shared/platform/dedup";
import type {
	InboundAttachment,
	MessageSegment,
	NormalizedInboundMessage,
	QuotedMessage,
} from "@miubot/shared/platform/messages";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

// 契约类型统一由 `@miubot/shared/platform/messages` 持有；这里只实现 QQ 专有的归一化。
export type { InboundAttachment, MessageSegment, NormalizedInboundMessage, QuotedMessage };

function mediaKind(mimeType: string): MessageSegment["type"] {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "file";
}

function readMentions(message: QQBotInboundMessage): NormalizedInboundMessage["mentions"] {
	return (message.mentions ?? []).map((mention) => ({
		...((mention.member_openid ?? mention.user_openid)
			? { openId: mention.member_openid ?? mention.user_openid }
			: {}),
		...((mention.nickname ?? mention.username) ? { name: mention.nickname ?? mention.username } : {}),
		isBot: mention.bot === true || mention.is_you === true,
		isAll: mention.scope === "all",
	}));
}

/**
 * 解析引用消息。
 *
 * 引用消息时 QQ 会把被引用的原文放进 `msg_elements[0]`，这是缓存未命中时唯一可靠的来源。
 * 消息正文自身的元素在 `msg_elements` 里紧随其后。
 */
function readQuote(message: QQBotInboundMessage): QuotedMessage | undefined {
	if (!message.refMsgIdx) return undefined;
	const elements = message.msgElements ?? [];
	const quoted = elements.find((element) => element.msg_idx === message.refMsgIdx);
	if (!quoted) return undefined;
	const attachments = (quoted.attachments ?? []).map((attachment) => ({
		contentType: attachment.content_type,
		url: attachment.url,
		...(attachment.filename ? { fileName: attachment.filename } : {}),
		...(attachment.asr_refer_text ? { transcript: attachment.asr_refer_text } : {}),
	}));
	return { source: "msg_elements", refMsgIdx: message.refMsgIdx, text: quoted.content ?? "", attachments };
}

/** 把 `@机器人` 标记从正文中剔除。标记形如 `<@!appid>` 或 `<@appid>`。 */
export function stripBotMention(text: string, appId: string): string {
	const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`<@!?${escaped}>`, "g"), "").trim();
}

/**
 * 归一化一条 QQ 入站消息。
 *
 * 消费 SDK 已提供但此前被丢弃的字段：`messageId`（去重）、`msgElements`（引用链与富消息段）、
 * `messageScene`、`mentions`（全部被 @ 成员）、`msgType`、`attachments.voice_wav_url`。
 */
export function normalizeInboundMessage(
	botId: string,
	appId: string,
	message: QQBotInboundMessage,
): NormalizedInboundMessage | undefined {
	const isGroup = message.kind === "group";
	const peerId = isGroup ? message.groupOpenid : message.senderId;
	if (!peerId) return undefined;

	const rawText = message.content ?? "";
	const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const mentionedBot =
		message.rawEventType === "GROUP_AT_MESSAGE_CREATE" ||
		(message.mentions ?? []).some((mention) => mention.is_you === true) ||
		new RegExp(`<@!?${escaped}>`).test(rawText);

	const attachments = (message.attachments ?? []).map((attachment) => {
		const mimeType = attachment.content_type.toLowerCase();
		return {
			kind: mediaKind(mimeType) as MessageSegment["type"],
			url: attachment.url,
			mimeType: attachment.content_type,
			...(attachment.filename ? { fileName: attachment.filename } : {}),
			...(attachment.voice_wav_url ? { wavUrl: attachment.voice_wav_url } : {}),
			...(attachment.asr_refer_text ? { transcript: attachment.asr_refer_text } : {}),
		};
	});

	const text = stripBotMention(rawText, appId);
	const mentions = readMentions(message);
	const segments: MessageSegment[] = [
		...(text ? [{ type: "text" as const, text }] : []),
		...mentions.map((mention) => ({ type: "mention" as const, ...mention })),
		...attachments.map((attachment) =>
			attachment.kind === "image"
				? {
						type: "image" as const,
						url: attachment.url,
						mimeType: attachment.mimeType,
						...(attachment.fileName ? { fileName: attachment.fileName } : {}),
					}
				: attachment.kind === "audio"
					? {
							type: "audio" as const,
							url: attachment.url,
							mimeType: attachment.mimeType,
							...(attachment.fileName ? { fileName: attachment.fileName } : {}),
							...(attachment.wavUrl ? { wavUrl: attachment.wavUrl } : {}),
							...(attachment.transcript ? { transcript: attachment.transcript } : {}),
						}
					: attachment.kind === "video"
						? {
								type: "video" as const,
								url: attachment.url,
								mimeType: attachment.mimeType,
								...(attachment.fileName ? { fileName: attachment.fileName } : {}),
							}
						: {
								type: "file" as const,
								url: attachment.url,
								mimeType: attachment.mimeType,
								...(attachment.fileName ? { fileName: attachment.fileName } : {}),
							},
		),
	];

	const quote = readQuote(message);

	return {
		messageId: message.messageId,
		kind: message.kind,
		scope: message.kind,
		botId,
		peerId,
		senderId: message.senderId || "unknown",
		...(message.senderName ? { senderName: message.senderName } : {}),
		senderIsBot: message.senderIsBot === true,
		text,
		rawText,
		mentionedBot,
		mentions,
		segments,
		attachments,
		...(quote ? { quote } : {}),
		timestamp: message.timestamp,
		...(message.msgType === undefined ? {} : { msgType: message.msgType }),
		...(message.msgIdx ? { msgIdx: message.msgIdx } : {}),
		...(message.messageScene ? { messageScene: message.messageScene } : {}),
		raw: message.raw,
	};
}

/** 引用消息的 Prompt 片段；没有引用时返回空串，便于调用方直接过滤。 */
export function describeQuoteContext(quote: QuotedMessage | undefined): string {
	if (!quote) return "";
	return `本条消息引用了更早的一条消息${quote.attachments.length ? `（含 ${quote.attachments.length} 个附件）` : ""}，被引用内容：\n${quote.text || "(被引用消息没有文本)"}`;
}

export type InboundAcceptance =
	| { status: "accepted"; message: NormalizedInboundMessage; dedupKey: string }
	| { status: "duplicate"; messageId: string; peerId: string; dedupKey: string }
	| { status: "ignored"; reason: "unsupported-scope" | "sender-is-bot" };

/**
 * 入站准入：过滤非会话消息与 Bot 自身消息、归一化、再按 `botId + messageId` 去重。
 *
 * 宿主拿到 `accepted` 后只做会话编排；处理失败时可调用 `deduper.forget(dedupKey)` 允许重试。
 */
export function acceptInboundMessage(options: {
	botId: string;
	appId: string;
	message: QQBotInboundMessage;
	deduper: MessageDeduplicator;
}): InboundAcceptance {
	const { botId, appId, message, deduper } = options;
	if (message.kind !== "group" && message.kind !== "c2c") return { status: "ignored", reason: "unsupported-scope" };
	if (message.senderIsBot) return { status: "ignored", reason: "sender-is-bot" };
	const normalized = normalizeInboundMessage(botId, appId, message);
	if (!normalized) return { status: "ignored", reason: "unsupported-scope" };
	const dedupKey = `${botId}:${normalized.messageId}`;
	if (!deduper.shouldProcess(dedupKey))
		return { status: "duplicate", messageId: normalized.messageId, peerId: normalized.peerId, dedupKey };
	return { status: "accepted", message: normalized, dedupKey };
}

/** 入站消息去重器。实现与插件宿主共用 `@miubot/shared/platform/dedup`。 */
export function createMessageDeduplicator(options: DeduplicatorOptions = {}): Deduplicator {
	return createDeduplicator(options);
}

export type MessageDeduplicator = Deduplicator;
