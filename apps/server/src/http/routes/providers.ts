import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** `/api/providers/models`（拉取上游模型列表）与 `/api/providers/catalog`。 */
export async function handleProviderRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/providers/models" && req.method === "POST") {
		const input = await body(req);
		const provider = config.providers.find((item) => item.id === String(input.providerId ?? ""));
		const apiKey = String(input.apiKey ?? provider?.apiKey ?? "");
		if (!provider && (!input.baseUrl || !input.apiKey)) {
			json(res, 404, { ok: false, message: "请填写提供商 API 地址和 API Key" });
			return true;
		}
		if (!apiKey) {
			json(res, 400, { ok: false, message: "请先配置 API Key" });
			return true;
		}
		const baseUrl = String(input.baseUrl ?? provider?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
		const isAnthropic = String(input.api ?? provider?.api ?? "") === "anthropic-messages";
		const modelsUrl = isAnthropic
			? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models`
			: `${baseUrl}/models`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const headers: Record<string, string> = isAnthropic
				? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
				: { authorization: `Bearer ${apiKey}` };
			const response = await fetch(modelsUrl, { headers, signal: controller.signal });
			const data: unknown = await response.json();
			if (!response.ok) {
				json(res, 400, { ok: false, message: `模型列表接口返回 HTTP ${response.status}` });
				return true;
			}
			const models =
				typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
					? (data as { data: Array<{ id?: unknown; name?: unknown; display_name?: unknown }> }).data
							.filter((item) => typeof item.id === "string")
							.map((item) => ({
								id: item.id as string,
								name:
									typeof item.name === "string"
										? item.name
										: typeof item.display_name === "string"
											? item.display_name
											: (item.id as string),
							}))
					: [];
			json(res, 200, { ok: true, models });
		} finally {
			clearTimeout(timeout);
		}
		return true;
	}
	if (url.pathname === "/api/providers/catalog" && req.method === "GET") {
		json(res, 200, {
			providers: config.providers.map(({ apiKey, ...provider }) => ({
				...provider,
				apiKeyConfigured: Boolean(apiKey),
			})),
		});
		return true;
	}
	return false;
}
