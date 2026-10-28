import { describe, expect, it, vi } from "vitest";
import { createStickerTools } from "../src/tools/stickers/tools.ts";

describe("sticker tools", () => {
	it("explains when social reactions should be searched and sent", () => {
		const [search, send] = createStickerTools(
			{ search: async () => [], get: async () => undefined, incrementUsage: async () => {} },
			() => true,
			async () => {},
		);
		expect(search.promptSnippet).toContain("庆祝好消息");
		expect(search.promptSnippet).toContain("短意图词搜索");
		expect(search.promptSnippet).toContain("不要硬发");
		expect(send.promptSnippet).toContain("调用本工具一次");
	});

	it("enforces authorization and sends only approved search results", async () => {
		const sticker = {
			id: "sticker-1",
			fileName: "cat.png",
			description: "开心猫猫",
			tags: ["开心"],
			status: "approved" as const,
		};
		let usageCount = 0;
		const store = {
			async search() {
				return [sticker];
			},
			async get(id: string) {
				return id === sticker.id ? sticker : undefined;
			},
			async incrementUsage() {
				usageCount++;
			},
		};
		const send = vi.fn().mockResolvedValue(undefined);
		let authorized = false;
		const [search, sendTool] = createStickerTools(
			store,
			() => authorized,
			async (item) => {
				await send(item.id);
			},
		);
		const context = {} as Parameters<typeof search.execute>[4];
		expect((await search.execute("1", { query: "开心" }, undefined, undefined, context)).isError).toBe(true);
		authorized = true;
		const found = await search.execute("2", { query: "开心" }, undefined, undefined, context);
		expect(found.content[0]?.type === "text" && found.content[0].text).toContain(sticker.id);
		await sendTool.execute("3", { id: sticker.id }, undefined, undefined, context);
		expect(send).toHaveBeenCalledWith(sticker.id);
		expect(usageCount).toBe(1);
	});
});
