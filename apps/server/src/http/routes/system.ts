import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { json } from "../response.ts";

/** 存活探测与运行日志。认证与 CORS 已在请求入口处理。 */
export async function handleSystemRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/health") {
		json(res, 200, {
			ok: true,
			qq: [...ctx.qq.states.values()].find((state) => state.phase === "connected")?.phase ?? "disconnected",
		});
		return true;
	}
	if (url.pathname === "/api/logs" && req.method === "GET") {
		json(res, 200, { logs: ctx.logs.list().slice(-500).reverse() });
		return true;
	}
	return false;
}
