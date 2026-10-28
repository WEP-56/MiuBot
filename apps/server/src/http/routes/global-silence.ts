import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

export async function handleGlobalSilenceRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/global-silence") return false;
	const config = ctx.config.get();
	if (req.method === "GET") {
		json(res, 200, { globalSilence: config.globalSilence });
		return true;
	}
	if (req.method !== "PUT") return false;
	const input = await body(req);
	const quietStart = String(input.quietStart ?? config.globalSilence.quietStart);
	const quietEnd = String(input.quietEnd ?? config.globalSilence.quietEnd);
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)) {
		json(res, 400, { ok: false, message: "请填写有效的全局静默时段" });
		return true;
	}
	config.globalSilence = { quietStart, quietEnd };
	await ctx.config.save();
	ctx.log("INFO", "全局静默时段已更新");
	json(res, 200, { ok: true, globalSilence: config.globalSilence });
	return true;
}
