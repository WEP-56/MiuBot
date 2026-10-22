import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

/** 一条消息里的语义片段。原始平台字段保留在 `raw` 中，业务代码优先消费标准字段。 */
export type MessageSegment =
	| { type: "text"; text: string }
	| { type: "mention"; openId?: string; name?: string; isBot: boolean; isAll: boolean }
	| { type: "image"; url: string; mimeType: string; fileName?: string }
	| { type: "audio"; url: string; mimeType: string; fileName?: string; wavUrl?: string; transcript?: string }
	| { type: "video"; url: string; mimeType: string; fileName?: string }
	| { type: "file"; url: string; mimeType: string; fileName?: string };

/** 被引用的消息。`source` 说明内容从引用索引命中还是从推送的 msg_elements 兜底。 */
export type QuotedMessage = {
	source: "msg_elements";
	/** 被引用消息的 msg_idx。 */
	refMsgIdx: string;
	text: string;
	attachments: Array<{ contentType: string; url: string; fileName?: string; transcript?: string }>;
};

export type NormalizedInboundMessage = {
	/** 平台消息 ID，用作去重与幂等键。 */
	messageId: string;
	kind: "c2c" | "group" | "guild" | "dm";
	scope: "group" | "c2c" | "guild" | "dm";
	botId: string;
	peerId: string;
	senderId: string;
	senderName?: string;
	senderIsBot: boolean;
	/** 去掉 @bot 标记后的正文。 */
	text: string;
	/** 原始正文（含 @ 标记）。 */
	rawText: string;
	mentionedBot: boolean;
	/** 被 @ 的其他成员。 */
	mentions: Array<{ openId?: string; name?: string; isBot: boolean; isAll: boolean }>;
	segments: MessageSegment[];
	attachments: Array<{
		kind: MessageSegment["type"];
		url: string;
		mimeType: string;
		fileName?: string;
		wavUrl?: string;
		transcript?: string;
	}>;
	quote?: QuotedMessage;
	timestamp: string;
	msgType?: number;
	msgIdx?: string;
	/** 平台附带的场景信息（来源、扩展参数），字段随平台变化。 */
	messageScene?: { source?: string; ext?: string[] };
	/** 原始平台消息，仅诊断用。 */
	raw: unknown;
};

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

/**
 * 入站消息 id 去重。
 *
 * QQ Gateway 重连后会重投事件；没有去重时同一条消息可能触发重复回复与重复副作用。
 * 采用有界 LRU + TTL，避免长期占用内存。
 */
export function createMessageDeduplicator(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
	const maxEntries = options.maxEntries ?? 2_000;
	const ttlMs = options.ttlMs ?? 10 * 60_000;
	const now = options.now ?? Date.now;
	const seen = new Map<string, number>();

	return {
		/** 首次出现返回 true；重复或已过期返回 false。 */
		shouldProcess(key: string): boolean {
			const timestamp = now();
			for (const [entryKey, seenAt] of seen) {
				if (timestamp - seenAt <= ttlMs) break;
				seen.delete(entryKey);
			}
			const existing = seen.get(key);
			if (existing !== undefined && timestamp - existing <= ttlMs) return false;
			seen.delete(key);
			seen.set(key, timestamp);
			while (seen.size > maxEntries) {
				const oldest = seen.keys().next().value;
				if (oldest === undefined) break;
				seen.delete(oldest);
			}
			return true;
		},
		/** 回滚一个已登记但未实际处理的 key，用于处理失败后允许重试。 */
		forget(key: string): void {
			seen.delete(key);
		},
		get size(): number {
			return seen.size;
		},
	};
}

export type MessageDeduplicator = ReturnType<typeof createMessageDeduplicator>;
