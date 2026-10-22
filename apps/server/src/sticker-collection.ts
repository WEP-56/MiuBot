import { basename, extname } from "node:path";
import { downloadImage, type MediaAttachment } from "./media.ts";
import { extensionForMime, type StickerStore } from "./stickers.ts";

type StickerImporter = Pick<StickerStore, "importFile">;

export async function collectInboundStickers(
	attachments: MediaAttachment[],
	probabilityPercent: number,
	store: StickerImporter,
	options: { download?: typeof downloadImage; random?: () => number } = {},
): Promise<{ imported: number; duplicates: number; failed: number; stickerIds: string[] }> {
	const result = { imported: 0, duplicates: 0, failed: 0, stickerIds: [] as string[] };
	if (probabilityPercent <= 0) return result;
	const download = options.download ?? downloadImage;
	const random = options.random ?? Math.random;
	for (const attachment of attachments.filter((item) => item.kind === "image").slice(0, 4)) {
		if (random() * 100 >= probabilityPercent) continue;
		try {
			const { bytes, mimeType } = await download(attachment.url);
			const extension = extensionForMime(mimeType);
			const sourceName = basename(attachment.fileName ?? "collected-sticker");
			const fileName = `${sourceName.slice(0, sourceName.length - extname(sourceName).length) || "collected-sticker"}${extension}`;
			const imported = await store.importFile(fileName, bytes);
			if (imported.duplicate) result.duplicates++;
			else {
				result.imported++;
				result.stickerIds.push(imported.sticker.id);
			}
		} catch {
			result.failed++;
		}
	}
	return result;
}
