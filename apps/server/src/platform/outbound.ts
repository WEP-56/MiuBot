import { type InlineKeyboard, MediaFileType, type QQBot, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";

export type OutboundTextOptions = {
	/** 分成多条消息发送。默认按 5000 字符切分。 */
	chunkLimit?: number;
	/** 使用 Markdown 消息（msg_type=2）。 */
	markdown?: boolean;
	/** 附带的按钮，仅在消息支持时使用。 */
	keyboard?: InlineKeyboard;
	/** 是否允许降级为主动推送。默认 true；主动推送受平台权限与额度约束。 */
	allowProactiveFallback?: boolean;
};

export interface OutboundChannelDependencies {
	bot: QQBot;
	/** 单条消息被动回复次数上限，耗尽后自动降级主动推送。 */
	passiveReplyLimit?: number;
	/** 被动回复有效期。 */
	passiveReplyTtlMs?: number;
	onError?: (error: unknown, target: ReplyTarget) => void;
	/** 发送成功后的观察回调，供 `message.sent` 事件与审计使用。 */
	onSent?: (info: {
		target: ReplyTarget;
		kind: "text" | "markdown" | "media";
		messages: number;
		fallbackUsed: boolean;
		/** 引发本次发送的来源；由调用方逐次传入，避免用全局状态记录。 */
		origin?: "agent" | "plugin" | "system";
		originPluginId?: string;
	}) => void;
}

/**
 * 单次发送的来源标注。
 *
 * 逐次传入而不是用全局变量：多个插件并发发送时，全局状态会互相覆盖，
 * 导致 `message.sent` 被标错来源、自激过滤失效。
 */
export type OutboundOriginMeta = {
	origin?: "agent" | "plugin" | "system";
	originPluginId?: string;
};

export type OutboundMessageResult = {
	messages: number;
	fallbackUsed: boolean;
};

/**
 * QQ 被动回复配额。
 *
 * 官方限制同一条 msgId 只能被动回复若干次；耗尽后必须不带 msgId 主动推送。
 * `sendText` 无 msgId 时本来就会走主动推送，所以这里统一在发消息前降级。
 */
export function createReplyLimiter(
	options: { limit?: number; ttlMs?: number; maxTracked?: number; now?: () => number } = {},
) {
	const limit = options.limit ?? 4;
	const ttlMs = options.ttlMs ?? 60 * 60_000;
	const maxTracked = options.maxTracked ?? 10_000;
	const now = options.now ?? Date.now;
	const counts = new Map<string, { count: number; firstSeenAt: number }>();

	return {
		canReply(target: ReplyTarget): boolean {
			if (!target.msgId) return true;
			const tracked = counts.get(target.msgId);
			if (!tracked) return true;
			if (now() - tracked.firstSeenAt > ttlMs) {
				counts.delete(target.msgId);
				return true;
			}
			return tracked.count < limit;
		},
		record(target: ReplyTarget): void {
			if (!target.msgId) return;
			const tracked = counts.get(target.msgId);
			if (tracked) {
				tracked.count += 1;
			} else {
				if (counts.size >= maxTracked) {
					const first = counts.keys().next().value;
					if (first !== undefined) counts.delete(first);
				}
				counts.set(target.msgId, { count: 1, firstSeenAt: now() });
			}
		},
		remaining(target: ReplyTarget): number {
			if (!target.msgId) return Number.POSITIVE_INFINITY;
			const tracked = counts.get(target.msgId);
			return tracked ? Math.max(0, limit - tracked.count) : limit;
		},
		reset(target: ReplyTarget): void {
			if (target.msgId) counts.delete(target.msgId);
		},
		get limit(): number {
			return limit;
		},
	};
}

export type ReplyLimiter = ReturnType<typeof createReplyLimiter>;

/**
 * 文本分片。
 *
 * QQ 单条消息上限约 5000 字符。按行切分并尽量保持代码块/表格完整，避免在结构中间断开。
 * 与 example/dsh-qqbot 的 chunker 保持一致。
 */
export function chunkText(text: string, limit = 5000): string[] {
	if (text.length <= limit) return text ? [text] : [""];
	const lines = text.split("\n");
	const chunks: string[] = [];
	let current = "";
	let inCodeBlock = false;
	let tableBuffer: string[] = [];

	const flushTable = (): void => {
		if (tableBuffer.length === 0) return;
		const block = tableBuffer.join("\n");
		tableBuffer = [];
		if (!current) {
			current = block;
			return;
		}
		const candidate = `${current}\n${block}`;
		if (candidate.length > limit) {
			chunks.push(current);
			current = block;
		} else {
			current = candidate;
		}
	};

	const appendLine = (line: string): void => {
		if (!current) {
			current = line;
			return;
		}
		const candidate = `${current}\n${line}`;
		if (candidate.length > limit) {
			chunks.push(current);
			current = line;
		} else {
			current = candidate;
		}
	};

	for (const line of lines) {
		if (/^```/.test(line)) {
			flushTable();
			inCodeBlock = !inCodeBlock;
			appendLine(line);
			continue;
		}
		if (inCodeBlock) {
			appendLine(line);
			continue;
		}
		if (/^\|.+\|$/.test(line)) {
			tableBuffer.push(line);
			continue;
		}
		flushTable();
		appendLine(line);
	}
	flushTable();
	if (current) chunks.push(current);
	if (chunks.length === 0) chunks.push(text);
	return chunks;
}

export type TextChunker = typeof chunkText;

function passiveTarget(target: ReplyTarget): ReplyTarget {
	return target.msgId ? { ...target, msgId: undefined } : target;
}

export type OutboundMedia = {
	kind: "image" | "audio" | "video" | "file";
	buffer: Uint8Array;
	fileName: string;
	content?: string;
};

/**
 * C2C 流式回复会话。
 *
 * QQ 只对私聊开放 `stream_messages`，且需要同一个 msgId 锚定；群聊没有流式能力，
 * 因此上层必须按 `supported` 决定是否走流式。
 */
export type OutboundStream = {
	/** 是否真的建立了流式会话（群聊或缺少 msgId 时为 false）。 */
	supported: boolean;
	update(fullText: string): Promise<void>;
	complete(): Promise<void>;
	cancel(): void;
};

export type OutboundChannel = {
	sendText(
		target: ReplyTarget,
		content: string,
		options?: OutboundTextOptions,
		meta?: OutboundOriginMeta,
	): Promise<OutboundMessageResult>;
	sendMarkdown(
		target: ReplyTarget,
		content: string,
		options?: OutboundTextOptions,
		meta?: OutboundOriginMeta,
	): Promise<OutboundMessageResult>;
	sendMedia(target: ReplyTarget, media: OutboundMedia, meta?: OutboundOriginMeta): Promise<OutboundMessageResult>;
	/** 尝试开启流式回复；群聊或缺少 msgId 时返回 `supported: false`。 */
	openStream(target: ReplyTarget): OutboundStream;
};

const MEDIA_FILE_TYPE: Record<"image" | "audio" | "video" | "file", MediaFileType> = {
	image: MediaFileType.IMAGE,
	audio: MediaFileType.VOICE,
	video: MediaFileType.VIDEO,
	file: MediaFileType.FILE,
};

/**
 * 统一出站通道。
 *
 * 所有会对外产生消息的代码都走这里：文本自动分片、被动配额耗尽自动降级主动推送、
 * 媒体走 QQ 富媒体上传。这样插件接入后不会绕过限流与格式约束。
 */
export function createOutboundChannel(deps: OutboundChannelDependencies): OutboundChannel {
	const limiter = createReplyLimiter({ limit: deps.passiveReplyLimit, ttlMs: deps.passiveReplyTtlMs });

	async function sendText(
		target: ReplyTarget,
		content: string,
		options: OutboundTextOptions = {},
		meta: OutboundOriginMeta = {},
	): Promise<OutboundMessageResult> {
		const chunkLimit = options.chunkLimit ?? 5000;
		const allowFallback = options.allowProactiveFallback !== false;
		const chunks = chunkText(content, chunkLimit);
		let fallbackUsed = false;
		for (const [index, chunk] of chunks.entries()) {
			let sendTarget = target;
			if (!limiter.canReply(target)) {
				if (!allowFallback) throw new Error("被动回复配额已耗尽，且不允许主动推送降级");
				sendTarget = passiveTarget(target);
				fallbackUsed = true;
			}
			try {
				if (options.markdown && index === 0 && chunks.length === 1) {
					await deps.bot.sendMarkdown(
						sendTarget,
						chunk,
						options.keyboard ? { keyboard: options.keyboard } : undefined,
					);
				} else {
					await deps.bot.sendText(sendTarget, chunk);
				}
			} catch (error) {
				deps.onError?.(error, sendTarget);
				throw error;
			}
			limiter.record(target);
		}
		const result = { messages: chunks.length, fallbackUsed };
		deps.onSent?.({ target, kind: options.markdown ? "markdown" : "text", ...result, ...meta });
		return result;
	}

	async function sendMarkdown(
		target: ReplyTarget,
		content: string,
		options: OutboundTextOptions = {},
		meta: OutboundOriginMeta = {},
	): Promise<OutboundMessageResult> {
		return sendText(target, content, { ...options, markdown: true }, meta);
	}

	async function sendMedia(
		target: ReplyTarget,
		media: OutboundMedia,
		meta: OutboundOriginMeta = {},
	): Promise<OutboundMessageResult> {
		let sendTarget = target;
		let fallbackUsed = false;
		if (!limiter.canReply(target)) {
			sendTarget = passiveTarget(target);
			fallbackUsed = true;
		}
		try {
			await deps.bot.sendMedia({
				target: sendTarget,
				fileType: MEDIA_FILE_TYPE[media.kind],
				buffer: Buffer.from(media.buffer),
				fileName: media.fileName,
				...(media.content ? { content: media.content } : {}),
			});
		} catch (error) {
			deps.onError?.(error, sendTarget);
			throw error;
		}
		limiter.record(target);
		const result = { messages: 1, fallbackUsed };
		deps.onSent?.({ target, kind: "media", ...result, ...meta });
		return result;
	}

	/**
	 * 流式回复。
	 *
	 * QQ 只在 C2C 开放 `stream_messages`，并且必须用入站 msgId 锚定；群聊或缺少 msgId
	 * 时返回 `supported: false`，由调用方回退到普通文本发送。
	 */
	function openStream(target: ReplyTarget): OutboundStream {
		if (target.scope !== "c2c" || !target.msgId || !limiter.canReply(target)) {
			return {
				supported: false,
				update: async () => {},
				complete: async () => {},
				cancel: () => {},
			};
		}
		const session = deps.bot.openStream({ target });
		limiter.record(target);
		return {
			supported: true,
			update: async (fullText: string) => {
				try {
					await session.update(fullText);
				} catch (error) {
					deps.onError?.(error, target);
					throw error;
				}
			},
			complete: async () => {
				try {
					await session.complete();
				} catch (error) {
					deps.onError?.(error, target);
					throw error;
				}
			},
			cancel: () => session.cancel(),
		};
	}

	return { sendText, sendMarkdown, sendMedia, openStream };
}

export type OutboundChannelInstance = ReturnType<typeof createOutboundChannel>;
