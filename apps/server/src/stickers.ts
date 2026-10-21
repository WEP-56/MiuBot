import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { detectSupportedImageMimeType } from "@miubot/shared/utils/mime";

const MAX_STICKER_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function searchTerms(query: string): string[] {
	const normalized = query.toLocaleLowerCase().replace(/[，。！？、；：,.!?;:()[\]{}"']/g, " ").trim();
	const terms = normalized.split(/\s+/).filter(Boolean);
	const expanded = new Set(terms);
	for (const part of terms) {
		if (/^[\p{Script=Han}]+$/u.test(part) && part.length > 2) {
			for (let index = 0; index < part.length - 1; index++) expanded.add(part.slice(index, index + 2));
		}
	}
	return [...expanded];
}

export interface Sticker {
	id: string;
	fileName: string;
	mimeType: string;
	sha256: string;
	size: number;
	createdAt: string;
	description: string;
	tags: string[];
	status: "pending" | "approved";
	usageCount: number;
}

export class StickerStore {
	private readonly dir: string;
	private readonly indexPath: string;
	private items: Sticker[] = [];
	private loaded = false;
	private loading: Promise<void> | undefined;
	private queue: Promise<void> = Promise.resolve();

	constructor(dataDir: string) {
		this.dir = join(dataDir, "stickers");
		this.indexPath = join(this.dir, "index.json");
	}

	async list(): Promise<Sticker[]> {
		await this.load();
		return this.items.map((item) => ({ ...item, tags: [...item.tags] }));
	}

	async importFile(fileName: string, bytes: Uint8Array): Promise<{ sticker: Sticker; duplicate: boolean }> {
		await this.load();
		const safeName = basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160) || "sticker";
		if (!ALLOWED_EXTENSIONS.has(extname(safeName).toLowerCase())) throw new Error("仅支持 JPG、PNG、GIF、WebP、BMP 图片");
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_STICKER_BYTES) throw new Error("图片为空或超过 10 MB");
		const mimeType = detectSupportedImageMimeType(bytes);
		if (!mimeType) throw new Error("图片格式无效或暂不支持（不支持 APNG）");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const existing = this.items.find((item) => item.sha256 === sha256);
		if (existing) return { sticker: { ...existing, tags: [...existing.tags] }, duplicate: true };
		const sticker: Sticker = { id: randomUUID(), fileName: safeName, mimeType, sha256, size: bytes.byteLength, createdAt: new Date().toISOString(), description: "", tags: [], status: "pending", usageCount: 0 };
		await mkdir(this.dir, { recursive: true });
		await writeFile(join(this.dir, `${sticker.id}${extensionForMime(mimeType)}`), bytes, { flag: "wx" });
		this.items.unshift(sticker);
		await this.save();
		return { sticker: { ...sticker, tags: [] }, duplicate: false };
	}

	async get(id: string): Promise<Sticker | undefined> {
		await this.load();
		const sticker = this.items.find((item) => item.id === id);
		return sticker ? { ...sticker, tags: [...sticker.tags] } : undefined;
	}

	async image(id: string): Promise<Buffer | undefined> {
		const sticker = await this.get(id);
		if (!sticker) return undefined;
		try { return await readFile(join(this.dir, `${sticker.id}${extensionForMime(sticker.mimeType)}`)); } catch { return undefined; }
	}

	async update(id: string, input: { description?: string; tags?: string[]; status?: Sticker["status"] }): Promise<Sticker | undefined> {
		await this.load();
		const sticker = this.items.find((item) => item.id === id);
		if (!sticker) return undefined;
		if (input.description !== undefined) sticker.description = input.description.trim().slice(0, 500);
		if (input.tags !== undefined) sticker.tags = [...new Set(input.tags.map((tag) => tag.trim().slice(0, 32)).filter(Boolean))].slice(0, 20);
		if (input.status !== undefined) sticker.status = input.status;
		await this.save();
		return { ...sticker, tags: [...sticker.tags] };
	}

	async remove(id: string): Promise<boolean> {
		await this.load();
		const index = this.items.findIndex((item) => item.id === id);
		if (index < 0) return false;
		const [sticker] = this.items.splice(index, 1);
		await rm(join(this.dir, `${sticker!.id}${extensionForMime(sticker!.mimeType)}`), { force: true });
		await this.save();
		return true;
	}

	async search(query: string, limit = 5): Promise<Sticker[]> {
		await this.load();
		const terms = searchTerms(query);
		return this.items.map((item, index) => {
			const text = `${item.description} ${item.tags.join(" ")}`.toLocaleLowerCase();
			const score = terms.reduce((total, term) => total + (text.includes(term) ? term.length > 1 ? 2 : 1 : 0), 0);
			return { item, index, score };
		}).filter(({ item, score }) => item.status === "approved" && (terms.length === 0 || score > 0))
			.sort((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, Math.min(10, Math.max(1, limit))).map(({ item }) => ({ ...item, tags: [...item.tags] }));
	}

	async incrementUsage(id: string): Promise<void> {
		await this.load();
		const item = this.items.find((sticker) => sticker.id === id && sticker.status === "approved");
		if (!item) throw new Error("表情包不存在或尚未审核");
		item.usageCount++;
		await this.save();
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loading ??= (async () => {
			try {
				const parsed: unknown = JSON.parse(await readFile(this.indexPath, "utf8"));
				if (Array.isArray(parsed)) this.items = parsed.filter((item): item is Sticker => typeof item === "object" && item !== null && typeof (item as Sticker).id === "string" && typeof (item as Sticker).sha256 === "string");
			} catch { this.items = []; }
			this.loaded = true;
		})();
		await this.loading;
	}

	private async save(): Promise<void> {
		const data = JSON.stringify(this.items, null, 2);
		this.queue = this.queue.catch(() => undefined).then(async () => {
			await mkdir(this.dir, { recursive: true });
			const tempPath = `${this.indexPath}.${randomUUID()}.tmp`;
			await writeFile(tempPath, data, "utf8");
			await rename(tempPath, this.indexPath);
		});
		await this.queue;
	}
}

export function extensionForMime(mimeType: string): string {
	switch (mimeType) {
		case "image/jpeg": return ".jpg";
		case "image/png": return ".png";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/bmp": return ".bmp";
		default: throw new Error("表情包图片格式无效");
	}
}
