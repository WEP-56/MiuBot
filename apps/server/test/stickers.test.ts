import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StickerStore } from "../src/stickers.ts";

describe("StickerStore", () => {
	it("deduplicates by content hash and only searches approved stickers", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-stickers-"));
		try {
			const store = new StickerStore(root);
			const bytes = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
			const first = await store.importFile("cat.png", bytes);
			const duplicate = await store.importFile("other.png", bytes);
			expect(first.duplicate).toBe(false);
			expect(duplicate.duplicate).toBe(true);
			expect(await store.search("cat")).toEqual([]);
			await store.update(first.sticker.id, { description: "开心猫猫", tags: ["开心", "猫猫"], status: "approved" });
			expect((await store.search("猫猫"))[0]?.id).toBe(first.sticker.id);
			expect((await store.search("开心鼓掌"))[0]?.id).toBe(first.sticker.id);
			expect((await store.search("完全无关"))).toEqual([]);
			await store.incrementUsage(first.sticker.id);
			expect((await store.get(first.sticker.id))?.usageCount).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
