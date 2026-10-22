import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/index.ts";

export interface StickerToolItem {
	id: string;
	description: string;
	tags: string[];
	fileName: string;
	status: "pending" | "approved";
}

export interface StickerToolStore<T extends StickerToolItem> {
	search(query: string, limit?: number): Promise<T[]>;
	get(id: string): Promise<T | undefined>;
	incrementUsage(id: string): Promise<void>;
}

const searchSchema = Type.Object({
	query: Type.String({ description: "描述想表达的情绪或场景，也可使用标签" }),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});
const sendSchema = Type.Object({ id: Type.String({ description: "ID returned by search_stickers" }) });

export function createStickerTools<T extends StickerToolItem>(
	store: StickerToolStore<T>,
	canUse: () => boolean,
	send: (sticker: T) => Promise<void>,
): ToolDefinition[] {
	const searchableIds = new Set<string>();
	return [
		{
			name: "search_stickers",
			label: "Search Stickers",
			description:
				"Find approved stickers by communicative intent, mood, or action. Search with broad emotional/action words; results may be approximate matches. Only results returned by this tool can be sent.",
			promptSnippet:
				"When a sticker would make a reply warmer, funnier, or more expressive, actively search and send one. Search with a short broad mood/action (such as 开心、无语、安慰、鼓掌); do not require an exact visual or tag match. If no result appears, retry once with a broader word. Prefer a fitting sticker over saying none is suitable.",
			parameters: searchSchema,
			async execute(_id, params) {
				const input = params as { query: string; limit?: number };
				if (!canUse())
					return { content: [{ type: "text", text: "表情包未对当前会话授权。" }], details: {}, isError: true };
				const stickers = await store.search(input.query, input.limit);
				for (const sticker of stickers) searchableIds.add(sticker.id);
				return {
					content: [
						{
							type: "text",
							text: stickers.length
								? stickers
										.map(
											(item) =>
												`id: ${item.id}\ndescription: ${item.description || "(no description)"}\ntags: ${item.tags.join(", ") || "(none)"}`,
										)
										.join("\n\n")
								: "没有找到匹配结果。请改用更宽泛的情绪或动作词重试一次；仍无结果时再用文字回复。",
						},
					],
					details: { count: stickers.length },
				};
			},
		},
		{
			name: "send_sticker",
			label: "Send Sticker",
			description:
				"Send an approved sticker returned by search_stickers. A successful call sends the image to the current QQ conversation.",
			promptSnippet:
				"After choosing a fitting search result, call this tool to actually send the image; do not merely describe or announce it.",
			parameters: sendSchema,
			async execute(_id, params) {
				const input = params as { id: string };
				if (!canUse())
					return { content: [{ type: "text", text: "表情包未对当前会话授权。" }], details: {}, isError: true };
				if (!searchableIds.has(input.id))
					return {
						content: [{ type: "text", text: "请先使用 search_stickers 获取可发送的表情包。" }],
						details: {},
						isError: true,
					};
				const sticker = await store.get(input.id);
				if (!sticker || sticker.status !== "approved")
					return { content: [{ type: "text", text: "表情包不存在或尚未审核。" }], details: {}, isError: true };
				try {
					await send(sticker);
					await store.incrementUsage(sticker.id);
					return {
						content: [
							{
								type: "text",
								text: `已发送表情包：${sticker.description || sticker.tags.join("、") || sticker.fileName}`,
							},
						],
						details: { id: sticker.id },
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						details: {},
						isError: true,
					};
				}
			},
		},
	];
}
