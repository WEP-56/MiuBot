import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectInboundStickers } from "../src/sticker-collection.ts";
import { StickerStore } from "../src/stickers.ts";

describe("automatic sticker collection", () => {
	it("samples each image independently and ignores non-image attachments", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-sticker-collection-"));
		try {
			const bytes = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
			const download = vi.fn(async () => ({ bytes, mimeType: "image/png" }));
			const random = vi.fn().mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
			const store = new StickerStore(root);
			const result = await collectInboundStickers([
				{ kind: "image", url: "https://cdn.example/one", mimeType: "image/png", fileName: "one.png" },
				{ kind: "image", url: "https://cdn.example/two", mimeType: "image/png", fileName: "two.png" },
				{ kind: "audio", url: "https://cdn.example/voice", mimeType: "audio/ogg" },
			], 50, store, { download, random });

			expect(result).toEqual({ imported: 1, duplicates: 0, failed: 0, stickerIds: [expect.any(String)] });
			expect(download).toHaveBeenCalledOnce();
			expect(random).toHaveBeenCalledTimes(2);
			expect(await store.list()).toMatchObject([{ fileName: "one.png", description: "", tags: [], status: "pending" }]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does nothing at zero probability and reports duplicate content", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-sticker-collection-"));
		try {
			const bytes = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
			const download = vi.fn(async () => ({ bytes, mimeType: "image/png" }));
			const store = new StickerStore(root);
			const attachment = { kind: "image" as const, url: "https://cdn.example/image", mimeType: "image/png", fileName: "image.png" };

			expect(await collectInboundStickers([attachment], 0, store, { download })).toEqual({ imported: 0, duplicates: 0, failed: 0, stickerIds: [] });
			expect(download).not.toHaveBeenCalled();
			const result = await collectInboundStickers([attachment, attachment], 100, store, { download, random: () => 0 });
			expect(result).toMatchObject({ imported: 1, duplicates: 1, failed: 0 });
			expect(result.stickerIds).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
