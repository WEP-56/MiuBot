import { describe, expect, it, vi } from "vitest";
import { createStickerTools } from "../src/tools/stickers/tools.ts";

describe("sticker tools", () => {
	it("enforces authorization and sends only approved search results", async () => {
		const sticker = { id: "sticker-1", fileName: "cat.png", description: "开心猫猫", tags: ["开心"], status: "approved" as const };
		let usageCount = 0;
		const store = {
			async search() { return [sticker]; },
			async get(id: string) { return id === sticker.id ? sticker : undefined; },
			async incrementUsage() { usageCount++; },
		};
		const send = vi.fn().mockResolvedValue(undefined);
		let authorized = false;
		const [search, sendTool] = createStickerTools(store, () => authorized, async (item) => { await send(item.id); });
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
