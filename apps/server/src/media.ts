import { isIP } from "node:net";
import type { ImageContent } from "@miubot/provider";
import type { InboundAttachment, QuotedMessage } from "@miubot/shared/platform/messages";
import { processImage } from "@miubot/shared/utils/image-process";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

const MAX_INBOUND_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INBOUND_IMAGES = 4;

export type MediaKind = "image" | "audio" | "video" | "file";

export interface MediaAttachment {
	kind: MediaKind;
	url: string;
	mimeType: string;
	fileName?: string;
	transcript?: string;
}

export interface PreparedInboundMedia {
	attachments: MediaAttachment[];
	images: ImageContent[];
	context: string;
}

function mediaKind(mimeType: string): MediaKind {
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	return "file";
}

function kindLabel(kind: MediaKind): string {
	if (kind === "audio") return "音频";
	if (kind === "video") return "视频";
	if (kind === "file") return "文件";
	return "图片";
}

/** 归一化附件转成媒体层形态；`text`/`mention` 段不会出现在附件里，兜底按文件处理。 */
export function toMediaAttachments(attachments: InboundAttachment[]): MediaAttachment[] {
	return attachments.map((attachment) => ({
		kind:
			attachment.kind === "image" || attachment.kind === "audio" || attachment.kind === "video"
				? attachment.kind
				: "file",
		url: attachment.url,
		mimeType: attachment.mimeType,
		...(attachment.fileName ? { fileName: attachment.fileName } : {}),
		...(attachment.transcript ? { transcript: attachment.transcript } : {}),
	}));
}

/** 附件的简短占位说明，给只有附件没有正文的消息用（例如纯图片）。 */
export function describeMediaAttachments(attachments: MediaAttachment[]): string {
	return attachments.map((attachment) => `[${kindLabel(attachment.kind)}]`).join(" ");
}

export async function downloadImage(
	url: string,
	fetcher: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
	const parsed = new URL(url);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		isIP(parsed.hostname) ||
		parsed.hostname.endsWith(".localhost") ||
		parsed.hostname.endsWith(".local") ||
		!parsed.hostname.includes(".")
	) {
		throw new Error("图片附件地址必须是公网 HTTPS URL");
	}
	const response = await fetcher(parsed, { signal: AbortSignal.timeout(15_000), redirect: "error" });
	if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
	const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (!mimeType.startsWith("image/")) throw new Error("附件响应不是图片");
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_IMAGE_BYTES)
		throw new Error("图片超过 12 MB 限制");
	if (!response.body) throw new Error("图片响应没有内容");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_INBOUND_IMAGE_BYTES) {
			await reader.cancel();
			throw new Error("图片超过 12 MB 限制");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, mimeType };
}

/** 下载并处理图片附件；`budget` 限制张数，失败原因与尺寸提示都折成文字说明。 */
async function loadImages(
	attachments: MediaAttachment[],
	options: { budget: number; fetcher?: typeof fetch },
): Promise<{ images: ImageContent[]; notes: string[] }> {
	const images: ImageContent[] = [];
	const notes: string[] = [];
	for (const attachment of attachments.slice(0, options.budget)) {
		try {
			const downloaded = await downloadImage(attachment.url, options.fetcher ?? fetch);
			const processed = await processImage(downloaded.bytes, downloaded.mimeType);
			if (!processed.ok) {
				notes.push(`${attachment.fileName ?? "图片"}无法处理：${processed.message}`);
				continue;
			}
			images.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			if (processed.hints.length > 0) notes.push(...processed.hints);
		} catch (error) {
			notes.push(
				`${attachment.fileName ?? "图片"}读取失败：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { images, notes };
}

/**
 * 处理一组已归一化的附件：图片按视觉能力下载，其余附件只转成文字说明。
 *
 * 插话聚合等「不是一条平台消息」的场景也走这里，避免图片处理逻辑出现第二份。
 */
export async function prepareMediaAttachments(
	attachments: MediaAttachment[],
	options: { supportsVision: boolean; fetcher?: typeof fetch },
): Promise<PreparedInboundMedia> {
	const notes: string[] = [];
	const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
	if (imageAttachments.length > 0 && !options.supportsVision) notes.push("收到图片，但当前会话模型不支持图片输入。");
	if (imageAttachments.length > MAX_INBOUND_IMAGES)
		notes.push(`图片最多处理 ${MAX_INBOUND_IMAGES} 张，其余图片已略过。`);
	const loaded = options.supportsVision
		? await loadImages(imageAttachments, { budget: MAX_INBOUND_IMAGES, fetcher: options.fetcher })
		: { images: [] as ImageContent[], notes: [] as string[] };
	notes.push(...loaded.notes);

	for (const attachment of attachments.filter((item) => item.kind !== "image")) {
		const label = kindLabel(attachment.kind);
		notes.push(
			attachment.transcript
				? `收到${label}附件，语音识别文本：${attachment.transcript}`
				: `收到${label}附件：${attachment.fileName ?? attachment.mimeType}（目前仅传递附件信息）`,
		);
	}

	return { attachments, images: loaded.images, context: notes.join("\n") };
}

/** 引用消息的附件在平台契约里用平台字段名（`contentType`），这里统一成本模块的形态。 */
export function quoteMediaAttachments(quote: QuotedMessage): MediaAttachment[] {
	return quote.attachments.map((attachment) => ({
		kind: mediaKind(attachment.contentType.toLowerCase()),
		url: attachment.url,
		mimeType: attachment.contentType,
		...(attachment.fileName ? { fileName: attachment.fileName } : {}),
		...(attachment.transcript ? { transcript: attachment.transcript } : {}),
	}));
}

/**
 * QQ 入站消息的附件处理。
 *
 * 引用消息里的图片同样要交给视觉模型：QQ 只在 `msg_elements` 里给出被引用消息的附件，
 * 不下载就等于告诉模型「这里有个附件」然后什么都不给。图片总额度按整条消息算，
 * 正文图片优先，引用图片排在后面。
 */
export async function prepareInboundMedia(
	message: Pick<QQBotInboundMessage, "attachments">,
	options: { supportsVision: boolean; quote?: QuotedMessage; fetcher?: typeof fetch },
): Promise<PreparedInboundMedia> {
	const attachments: MediaAttachment[] = (message.attachments ?? []).map((attachment) => ({
		kind: mediaKind(attachment.content_type.toLowerCase()),
		url: attachment.url,
		mimeType: attachment.content_type,
		...(attachment.filename ? { fileName: attachment.filename } : {}),
		...(attachment.asr_refer_text ? { transcript: attachment.asr_refer_text } : {}),
	}));
	const prepared = await prepareMediaAttachments(attachments, options);

	const quotedImages = (options.quote ? quoteMediaAttachments(options.quote) : []).filter(
		(attachment) => attachment.kind === "image",
	);
	if (quotedImages.length === 0) return prepared;

	const notes = prepared.context ? [prepared.context] : [];
	const budget = Math.max(0, MAX_INBOUND_IMAGES - prepared.images.length);
	const loaded =
		options.supportsVision && budget > 0
			? await loadImages(quotedImages, { budget, fetcher: options.fetcher })
			: { images: [] as ImageContent[], notes: [] as string[] };
	if (!options.supportsVision) {
		notes.push("被引用消息包含图片，但当前会话模型不支持图片输入。");
	} else if (budget === 0) {
		notes.push("被引用消息中的图片没有处理：本条消息的图片已达上限。");
	} else {
		if (loaded.images.length > 0)
			notes.push(`被引用消息中的 ${loaded.images.length} 张图片已作为附图提供，排在正文图片之后。`);
		notes.push(...loaded.notes);
		if (quotedImages.length > budget) notes.push(`被引用消息中的图片最多处理 ${budget} 张，其余已略过。`);
	}

	return {
		attachments: prepared.attachments,
		images: [...prepared.images, ...loaded.images],
		context: notes.join("\n"),
	};
}
