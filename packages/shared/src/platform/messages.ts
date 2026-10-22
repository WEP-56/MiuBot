/**
 * 归一化入站消息契约（跨包稳定接口，不依赖任何平台 SDK）。
 *
 * 平台适配器负责把自己的协议字段翻译成这里的结构；插件与业务层只消费标准字段。
 */

/** 一条消息里的语义片段。原始平台字段保留在消息的 `raw` 中。 */
export type MessageSegment =
	| { type: "text"; text: string }
	| { type: "mention"; openId?: string; name?: string; isBot: boolean; isAll: boolean }
	| { type: "image"; url: string; mimeType: string; fileName?: string }
	| { type: "audio"; url: string; mimeType: string; fileName?: string; wavUrl?: string; transcript?: string }
	| { type: "video"; url: string; mimeType: string; fileName?: string }
	| { type: "file"; url: string; mimeType: string; fileName?: string };

/** 被引用的消息。 */
export type QuotedMessage = {
	/** 内容来源：平台在推送里直接给出，还是适配器从本地缓存补全。 */
	source: "msg_elements" | "cache";
	/** 被引用消息的平台索引。 */
	refMsgIdx: string;
	text: string;
	attachments: Array<{ contentType: string; url: string; fileName?: string; transcript?: string }>;
};

export type InboundAttachment = {
	kind: MessageSegment["type"];
	url: string;
	mimeType: string;
	fileName?: string;
	wavUrl?: string;
	transcript?: string;
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
	attachments: InboundAttachment[];
	quote?: QuotedMessage;
	timestamp: string;
	msgType?: number;
	msgIdx?: string;
	/** 平台附带的场景信息（来源、扩展参数），字段随平台变化。 */
	messageScene?: { source?: string; ext?: string[] };
	/** 原始平台消息，仅诊断用。 */
	raw: unknown;
};
