import type { IncomingMessage, ServerResponse } from "node:http";
import { readCookieHeader, SESSION_COOKIE } from "../../auth.ts";
import type { HttpContext } from "../context.ts";
import { body, headerValue, json } from "../response.ts";

/**
 * 管理面登录、登出、会话探测与口令修改。
 *
 * 这些端点本身由 `api-security` 决定是否需要凭据：`login` / `logout` / `me` 免认证
 * （否则登录页无法自举），`password` 需要已登录。失败锁定与限速在 `auth` 与请求入口。
 */
export async function handleAuthRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/auth/")) return false;
	const session = readCookieHeader(headerValue(req.headers.cookie), SESSION_COOKIE);

	if (url.pathname === "/api/auth/me" && req.method === "GET") {
		json(res, 200, {
			ok: true,
			authenticated: Boolean(session && ctx.auth.verify(session)),
			sessions: ctx.auth.activeSessions(),
		});
		return true;
	}

	if (url.pathname === "/api/auth/login" && req.method === "POST") {
		const input = await body(req);
		const password = typeof input.password === "string" ? input.password : "";
		if (!password) {
			json(res, 400, { ok: false, message: "请填写管理员口令" });
			return true;
		}
		const result = await ctx.auth.login(password);
		if (result.ok) {
			ctx.log("INFO", "管理面登录成功");
			res.setHeader("set-cookie", ctx.auth.sessionCookie(result.token));
			json(res, 200, { ok: true });
			return true;
		}
		if (result.reason === "locked") {
			ctx.log("WARN", `管理面登录失败次数过多，已锁定 ${result.retryAfterSeconds} 秒`);
			res.setHeader("retry-after", String(result.retryAfterSeconds));
			json(res, 429, {
				ok: false,
				message: `口令错误次数过多，请 ${Math.ceil(result.retryAfterSeconds / 60)} 分钟后再试`,
				retryAfterSeconds: result.retryAfterSeconds,
			});
			return true;
		}
		ctx.log("WARN", "管理面登录失败：口令不正确");
		json(res, 401, { ok: false, message: "口令不正确" });
		return true;
	}

	if (url.pathname === "/api/auth/logout" && req.method === "POST") {
		await ctx.auth.revoke(session);
		res.setHeader("set-cookie", ctx.auth.clearCookie());
		json(res, 200, { ok: true });
		return true;
	}

	if (url.pathname === "/api/auth/password" && req.method === "POST") {
		const input = await body(req);
		const current = typeof input.current === "string" ? input.current : "";
		const next = typeof input.next === "string" ? input.next : "";
		const result = await ctx.auth.changePassword(current, next, session);
		if (!result.ok) {
			json(res, 400, result);
			return true;
		}
		// 其余会话已作废，当前这个保留：改口令的人不该被自己踢下线。
		ctx.log("INFO", "管理员口令已更新，其余会话已作废");
		json(res, 200, { ok: true });
		return true;
	}

	return false;
}
