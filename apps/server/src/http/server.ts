import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiSecurity } from "../api-security.ts";
import type { HttpContext } from "./context.ts";
import { headerValue, json } from "./response.ts";
import { dispatch } from "./router.ts";

/**
 * 管理 API 的请求入口，顺序固定：
 *
 * 1. 按 Origin 白名单回写 CORS 头（不匹配就一个都不给）。
 * 2. `api-security` 三层校验：Host → Origin → 令牌。
 * 3. 预检请求直接回 204（仍已通过 Host / Origin 校验）。
 * 4. 会话下发端点。
 * 5. 路由分发；未命中 404，抛错 500。
 */
export function createRequestHandler(options: {
	context: HttpContext;
	security: ApiSecurity;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const { context, security } = options;
	return async (req, res) => {
		const origin = headerValue(req.headers.origin);
		const corsOrigin = security.corsOrigin(origin);
		if (corsOrigin) {
			res.setHeader("access-control-allow-origin", corsOrigin);
			res.setHeader("vary", "origin");
		}
		const pathname = (req.url ?? "/").split("?")[0] ?? "/";
		const decision = security.authorize({
			method: req.method ?? "GET",
			host: headerValue(req.headers.host),
			origin,
			authorization: headerValue(req.headers.authorization),
			tokenHeader: headerValue(req.headers["x-miubot-token"]),
			cookie: headerValue(req.headers.cookie),
			secFetchSite: headerValue(req.headers["sec-fetch-site"]),
			pathname,
		});
		if (!decision.ok) {
			json(res, decision.status, { ok: false, message: decision.message });
			return;
		}
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
				"access-control-allow-headers": "content-type,x-miubot-token",
				"access-control-max-age": "600",
			});
			res.end();
			return;
		}
		// 用固定 base 解析路径：`Host` 头已在上面校验，但仍不拿它拼 URL，避免解析期注入。
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			// 工作台启动时换取会话 Cookie；令牌本身不返回给前端 JS，只存在于 HttpOnly Cookie 中。
			if (url.pathname === "/api/auth/session" && req.method === "POST") {
				res.setHeader("set-cookie", security.sessionCookie());
				json(res, 200, { ok: true });
				return;
			}
			if (await dispatch(context, req, res, url)) return;
			json(res, 404, { ok: false, message: "Not found" });
		} catch (error) {
			json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	};
}
