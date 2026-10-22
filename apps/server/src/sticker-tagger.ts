import type { Api, ImageContent, Model, TextContent } from "@miubot/provider/compat";
import type { ModelRuntime } from "@miubot/session/model-runtime";
import { processImage } from "@miubot/shared/utils/image-process";

export const STICKER_TAGGING_PROMPT =
	'标注这张表情包在聊天中的表达意图，优先写情绪、动作、互动用途（开心、安慰、拒绝、鼓掌等）。不要把发色、发型、性别、服饰、物种、耳朵等外观写成标签；只有外观就是梗的核心时才写入描述。不猜背景。只输出 JSON：{"description":"表达意图","tags":["情绪/动作/用途"]}。描述不超过 24 字；标签 1-5 个，每个不超过 8 字。';

export function parseStickerAnnotation(text: string): { description: string; tags: string[] } {
	const json = text.match(/\{[\s\S]*\}/)?.[0];
	if (!json) throw new Error("模型输出不是有效 JSON");
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null) throw new Error("模型输出结构无效");
	const value = parsed as { description?: unknown; tags?: unknown };
	if (
		typeof value.description !== "string" ||
		!Array.isArray(value.tags) ||
		value.tags.some((tag) => typeof tag !== "string")
	)
		throw new Error("模型未返回描述和标签");
	const description = value.description.trim().slice(0, 24);
	const tags = [...new Set((value.tags as string[]).map((tag) => tag.trim().slice(0, 8)).filter(Boolean))].slice(0, 5);
	if (!description || tags.length === 0) throw new Error("模型返回的描述或标签为空");
	return { description, tags };
}

export async function tagStickerImage(
	runtime: ModelRuntime,
	model: Model<Api>,
	bytes: Uint8Array,
	mimeType: string,
	signal: AbortSignal,
): Promise<{ description: string; tags: string[] }> {
	if (signal.aborted) throw new DOMException("打标已取消", "AbortError");
	const image = await processImage(bytes, mimeType, {
		resizeOptions: { maxWidth: 512, maxHeight: 512, maxBytes: 512 * 1024, jpegQuality: 65 },
	});
	if (!image.ok) throw new Error(image.message);
	if (signal.aborted) throw new DOMException("打标已取消", "AbortError");
	const content: Array<TextContent | ImageContent> = [
		{ type: "text", text: STICKER_TAGGING_PROMPT },
		{ type: "image", data: image.data, mimeType: image.mimeType },
	];
	const result = await runtime.completeSimple(
		model,
		{ messages: [{ role: "user", content, timestamp: Date.now() }] },
		{ signal, maxTokens: 96, reasoning: "minimal" },
	);
	if (signal.aborted || result.stopReason === "aborted") throw new DOMException("打标已取消", "AbortError");
	if (result.stopReason !== "stop" && result.stopReason !== "length")
		throw new Error(result.errorMessage ?? "模型打标请求失败");
	return parseStickerAnnotation(
		result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join(""),
	);
}
