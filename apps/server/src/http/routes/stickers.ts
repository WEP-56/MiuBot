import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { binaryBody, body, json } from "../response.ts";

/** `/api/stickers`：素材库、采集/打标设置、导入与图片读取。 */
export async function handleStickerRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	const store = ctx.stickers.store;

	if (url.pathname === "/api/stickers" && req.method === "GET") {
		json(res, 200, {
			stickers: await store.list(),
			enabled: config.tools.stickersEnabled,
			autoCollectProbability: config.tools.stickerAutoCollectProbability,
			taggingModel: {
				providerId: config.tools.stickerTaggerProviderId,
				modelId: config.tools.stickerTaggerModelId,
			},
			taggingProviders: config.providers
				.filter((item) => item.enabled && item.apiKey && item.models.some((model) => model.supportsVision))
				.map(({ id, name, models }) => ({
					id,
					name,
					models: models
						.filter((model) => model.supportsVision)
						.map(({ id: modelId, name: modelName }) => ({ id: modelId, name: modelName })),
				})),
		});
		return true;
	}
	if (url.pathname === "/api/stickers/settings" && req.method === "PUT") {
		const input = await body(req);
		const probability = input.autoCollectProbability ?? config.tools.stickerAutoCollectProbability;
		if (typeof probability !== "number" || !Number.isInteger(probability) || probability < 0 || probability > 100) {
			json(res, 400, { ok: false, message: "采集概率必须是 0 到 100 的整数" });
			return true;
		}
		const providerId =
			typeof input.taggingProviderId === "string" ? input.taggingProviderId : config.tools.stickerTaggerProviderId;
		const modelId =
			typeof input.taggingModelId === "string" ? input.taggingModelId : config.tools.stickerTaggerModelId;
		if (Boolean(providerId) !== Boolean(modelId)) {
			json(res, 400, { ok: false, message: "请选择完整的打标模型" });
			return true;
		}
		if (providerId) {
			const provider = config.providers.find((item) => item.id === providerId && item.enabled && item.apiKey);
			if (!provider?.models.some((model) => model.id === modelId && model.supportsVision)) {
				json(res, 400, { ok: false, message: "打标模型不可用或不支持视觉输入" });
				return true;
			}
		}
		const modelChanged =
			providerId !== config.tools.stickerTaggerProviderId || modelId !== config.tools.stickerTaggerModelId;
		config.tools.stickerAutoCollectProbability = probability;
		config.tools.stickerTaggerProviderId = providerId;
		config.tools.stickerTaggerModelId = modelId;
		await ctx.config.save();
		if (modelChanged) ctx.stickers.resetTagging();
		ctx.stickers.scheduleTagging();
		json(res, 200, { ok: true, autoCollectProbability: probability, taggingModel: { providerId, modelId } });
		return true;
	}
	if (url.pathname === "/api/stickers/import" && req.method === "POST") {
		try {
			const bytes = await binaryBody(req, 10 * 1024 * 1024);
			const result = await store.importFile(url.searchParams.get("filename") ?? "sticker", bytes);
			if (!result.duplicate) ctx.stickers.scheduleTagging();
			json(res, result.duplicate ? 200 : 201, {
				ok: true,
				duplicate: result.duplicate,
				sticker: result.sticker,
				stickers: await store.list(),
			});
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	const stickerImage = url.pathname.match(/^\/api\/stickers\/([^/]+)\/image$/);
	if (stickerImage && req.method === "GET") {
		const item = await store.get(decodeURIComponent(stickerImage[1]!));
		const image = item && (await store.image(item.id));
		if (!item || !image) {
			json(res, 404, { ok: false, message: "表情包不存在" });
			return true;
		}
		res.writeHead(200, {
			"content-type": item.mimeType,
			"cache-control": "private, max-age=300",
			"x-content-type-options": "nosniff",
		});
		res.end(image);
		return true;
	}
	const stickerMatch = url.pathname.match(/^\/api\/stickers\/([^/]+)$/);
	if (stickerMatch && req.method === "PATCH") {
		const input = await body(req);
		if (
			input.description !== undefined &&
			(typeof input.description !== "string" || input.description.length > 500)
		) {
			json(res, 400, { ok: false, message: "描述最多 500 个字符" });
			return true;
		}
		if (
			input.tags !== undefined &&
			(!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string") || input.tags.length > 20)
		) {
			json(res, 400, { ok: false, message: "标签列表无效" });
			return true;
		}
		if (input.status !== undefined && input.status !== "pending" && input.status !== "approved") {
			json(res, 400, { ok: false, message: "审核状态无效" });
			return true;
		}
		const sticker = await store.update(decodeURIComponent(stickerMatch[1]!), {
			...(typeof input.description === "string" ? { description: input.description } : {}),
			...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
			...(input.status === "pending" || input.status === "approved" ? { status: input.status } : {}),
		});
		json(
			res,
			sticker ? 200 : 404,
			sticker ? { ok: true, sticker, stickers: await store.list() } : { ok: false, message: "表情包不存在" },
		);
		return true;
	}
	if (stickerMatch && req.method === "DELETE") {
		const deleted = await store.remove(decodeURIComponent(stickerMatch[1]!));
		json(
			res,
			deleted ? 200 : 404,
			deleted ? { ok: true, stickers: await store.list() } : { ok: false, message: "表情包不存在" },
		);
		return true;
	}
	return false;
}
