import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiSecurity } from "../api-security.ts";
import type { HttpContext } from "./context.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";
import { HttpError, headerValue, json } from "./response.ts";
import { dispatch } from "./router.ts";
import type { WebAssets } from "./static.ts";

/**
 * 请求入口，顺序固定：
 *
 * 1. 安全响应头（所有响应，含静态页面）。
 * 2. 按 Origin 白名单回写 CORS 头（不匹配就一个都不给）。
 * 3. 来源限速。
 * 4. `api-security` 校验：Host → Origin → 跨站 → 凭据。
 * 5. 预检请求直接回 204（仍已通过 Host / Origin 校验）。
 * 6. `/api/*` 交给路由表；其余路径回工作台 HTML（SPA 回退）。
 * 7. 未命中 404，抛错按 `HttpError` 回状态码，其余 500 只回 trace id。
 *
 * 静态页面与 API 同源，是刻意的：Cookie 的 `SameSite` / `Secure` / CORS 语义
 * 在单 origin 下退化成默认安全状态，不会出现「前端一个域、API 另一个域」的踩坑组合。
 */
export function createRequestHandler(options: {
	context: HttpContext;
	security: ApiSecurity;
	assets: WebAssets;
	limiter?: RateLimiter;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	const { context, security, assets } = options;
	// 600 次/分钟：工作台是轮询的，正常操作远低于此，够挡住扫描与暴力重放。
	const limiter = options.limiter ?? createRateLimiter({ capacity: 120, refillPerSecond: 10 });

	return async (req, res) => {
		const pathname = (req.url ?? "/").split("?")[0] ?? "/";
		const origin = headerValue(req.headers.origin);
		const corsOrigin = security.corsOrigin(origin);
		applySecurityHeaders(res, security.secureCookies);
		if (corsOrigin) {
			res.setHeader("access-control-allow-origin", corsOrigin);
			res.setHeader("vary", "origin");
		}
		if (!limiter.take(req.socket.remoteAddress ?? "unknown")) {
			res.setHeader("retry-after", "1");
			json(res, 429, { ok: false, message: "请求过于频繁，请稍后再试" });
			return;
		}
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
		// 会话是滑动的：每次通过校验都重发 Cookie，浏览器端与服务器端的过期时间才对得上。
		if (decision.session) res.setHeader("set-cookie", security.sessionCookie(decision.session));
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
				"access-control-allow-headers": "content-type,x-miubot-token",
				"access-control-max-age": "600",
			});
			res.end();
			return;
		}
		if (!pathname.startsWith("/api")) {
			await serveWorkbench(req, res, assets);
			return;
		}
		// 用固定 base 解析路径：`Host` 头已在上面校验，但仍不拿它拼 URL，避免解析期注入。
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			if (await dispatch(context, req, res, url)) return;
			json(res, 404, { ok: false, message: "Not found" });
		} catch (error) {
			respondError(context, res, error);
		}
	};
}

async function serveWorkbench(req: IncomingMessage, res: ServerResponse, assets: WebAssets): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		json(res, 405, { ok: false, message: "工作台只支持 GET / HEAD" });
		return;
	}
	const html = await assets.index();
	if (html === undefined) {
		json(res, 503, {
			ok: false,
			message: `工作台尚未构建：${assets.distDir} 下没有 index.html。开发时用 vite dev，部署前先构建。`,
		});
		return;
	}
	// SPA 回退：`/plugins` 这类前端路由由浏览器接管，服务端一律回同一份 HTML。
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(req.method === "HEAD" ? undefined : html);
}

function respondError(context: HttpContext, res: ServerResponse, error: unknown): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	if (error instanceof HttpError) {
		json(res, error.status, { ok: false, message: error.message });
		return;
	}
	// 500 不回内部细节：路径、堆栈与上游报错文案都是攻击者的情报来源，只留 trace id。
	const traceId = randomBytes(4).toString("hex");
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	context.log("ERROR", `管理 API 处理失败（trace ${traceId}）：${detail}`);
	json(res, 500, { ok: false, message: "服务器内部错误", traceId });
}

function applySecurityHeaders(res: ServerResponse, secure: boolean): void {
	res.setHeader("x-content-type-options", "nosniff");
	res.setHeader("referrer-policy", "no-referrer");
	res.setHeader("x-frame-options", "DENY");
	// 单文件产物把 JS/CSS 内联在 HTML 里，`unsafe-inline` 是它存在的前提；
	// 除此之外一律只允许同源，图片放开 https 是因为 QQ 头像走 CDN。
	res.setHeader(
		"content-security-policy",
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: https:",
			"media-src 'self' data: blob:",
			"font-src 'self' data:",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'self'",
		].join("; "),
	);
	// HSTS 只在 HTTPS 部署下发；明文部署发它会把浏览器锁进一个连不上的 https。
	if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
}
