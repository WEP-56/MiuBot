import { isIP } from "node:net";
import { MediaFileType, type QQBotInboundMessage, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { ImageContent } from "@miubot/provider";
import { processImage } from "@miubot/shared/utils/image-process";

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

export interface OutboundMedia {
	kind: MediaKind;
	buffer: Buffer;
	fileName: string;
	caption?: string;
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

export async function downloadImage(url: string, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array; mimeType: string }> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || isIP(parsed.hostname) || parsed.hostname.endsWith(".localhost") || parsed.hostname.endsWith(".local") || !parsed.hostname.includes(".")) {
		throw new Error("图片附件地址必须是公网 HTTPS URL");
	}
	const response = await fetcher(parsed, { signal: AbortSignal.timeout(15_000), redirect: "error" });
	if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
	const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (!mimeType.startsWith("image/")) throw new Error("附件响应不是图片");
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_INBOUND_IMAGE_BYTES) throw new Error("图片超过 12 MB 限制");
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

export async function prepareInboundMedia(
	message: Pick<QQBotInboundMessage, "attachments">,
	options: { supportsVision: boolean; fetcher?: typeof fetch },
): Promise<PreparedInboundMedia> {
	const source = message.attachments ?? [];
	const attachments: MediaAttachment[] = source.map((attachment) => ({
		kind: mediaKind(attachment.content_type.toLowerCase()),
		url: attachment.url,
		mimeType: attachment.content_type,
		...(attachment.filename ? { fileName: attachment.filename } : {}),
		...(attachment.asr_refer_text ? { transcript: attachment.asr_refer_text } : {}),
	}));
	const images: ImageContent[] = [];
	const notes: string[] = [];
	const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");
	if (imageAttachments.length > 0 && !options.supportsVision) notes.push("收到图片，但当前会话模型不支持图片输入。");
	if (imageAttachments.length > MAX_INBOUND_IMAGES) notes.push(`图片最多处理 ${MAX_INBOUND_IMAGES} 张，本条消息其余图片已略过。`);

	for (const attachment of imageAttachments.slice(0, MAX_INBOUND_IMAGES)) {
		if (!options.supportsVision) break;
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
			notes.push(`${attachment.fileName ?? "图片"}读取失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const attachment of attachments.filter((item) => item.kind !== "image")) {
		const label = attachment.kind === "audio" ? "音频" : attachment.kind === "video" ? "视频" : "文件";
		notes.push(attachment.transcript ? `收到${label}附件，语音识别文本：${attachment.transcript}` : `收到${label}附件：${attachment.fileName ?? attachment.mimeType}（目前仅传递附件信息）`);
	}

	return { attachments, images, context: notes.join("\n") };
}

export async function sendQQMedia(
	bot: { sendMedia(options: { target: ReplyTarget; fileType: MediaFileType; buffer: Buffer; fileName: string; content?: string }): Promise<unknown> },
	target: ReplyTarget,
	media: OutboundMedia,
): Promise<void> {
	const fileType = {
		image: MediaFileType.IMAGE,
		audio: MediaFileType.VOICE,
		video: MediaFileType.VIDEO,
		file: MediaFileType.FILE,
	}[media.kind];
	await bot.sendMedia({ target, fileType, buffer: media.buffer, fileName: media.fileName, ...(media.caption ? { content: media.caption } : {}) });
}
