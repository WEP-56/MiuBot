import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImageProviderConfig, ProviderConfig } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { publicConfig } from "../present.ts";
import { body, json } from "../response.ts";

/** `/api/config`：提供商与图像提供商的读取和整体保存。 */
export async function handleConfigRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/config" && req.method === "GET") {
		json(res, 200, publicConfig(config));
		return true;
	}
	if (url.pathname === "/api/config" && req.method === "PUT") {
		const next = await body(req);
		const providers = Array.isArray(next.providers)
			? (next.providers as Array<ProviderConfig & { apiKeyConfigured?: boolean }>)
			: (config.providers as Array<ProviderConfig & { apiKeyConfigured?: boolean }>);
		const imageProviders = Array.isArray(next.imageProviders)
			? (next.imageProviders as Array<ImageProviderConfig & { apiKeyConfigured?: boolean }>)
			: (config.imageProviders as Array<ImageProviderConfig & { apiKeyConfigured?: boolean }>);
		ctx.config.replace({
			...config,
			providers: providers.map(({ apiKeyConfigured: _configured, ...provider }) => ({
				...provider,
				apiKey: provider.apiKey || config.providers.find((existing) => existing.id === provider.id)?.apiKey || "",
			})),
			imageProviders: imageProviders.map(({ apiKeyConfigured: _configured, ...provider }) => ({
				...provider,
				apiKey:
					provider.apiKey || config.imageProviders.find((existing) => existing.id === provider.id)?.apiKey || "",
			})),
		});
		await ctx.config.save();
		json(res, 200, publicConfig(ctx.config.get()));
		return true;
	}
	return false;
}
