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
				"为明确的社交回应搜索已审核表情包，例如庆祝、感谢、安慰、接玩笑或回应明显情绪。按想表达的情绪或动作搜索；只有本工具返回的结果可以发送。",
			promptSnippet:
				"遇到这些社交场景时优先搜索并发送一个表情包：庆祝好消息、感谢、安慰、回应明显情绪、接轻松玩笑。用短意图词搜索，例如“庆祝”“感谢”“安慰”“开心”“无语”“鼓掌”，不要描述图片长什么样。结果不必完全匹配关键词，但含义必须合适。事实答复、日常信息、严肃/敏感/紧急话题不要发。找不到合适结果就用文字回复，不要硬发。",
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
								: "没有找到匹配结果。只有在换成一个更宽泛的意图词后仍可能找到合适表情时才重试；否则直接用文字回复，不要强行发送。",
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
				"发送一张由 search_stickers 返回、且明显适合当前社交场景的已审核表情包。调用成功后图片会发到当前 QQ 对话。",
			promptSnippet:
				"社交回应场景下找到合适结果后，调用本工具一次来实际发送，不要只描述或声称发过；同一条回应不要连续发送多张表情包。",
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
