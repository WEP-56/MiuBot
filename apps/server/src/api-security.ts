import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildSessionCookie, readCookieHeader, SESSION_COOKIE } from "./auth.ts";
import { restrictFileMode, writeFileAtomic } from "./storage.ts";

/**
 * 管理 API（`/api/*`）的请求边界。
 *
 * 四层校验，顺序固定：
 *
 * 1. `Host` 必须是回环（含服务端口）或 `MIUBOT_ALLOWED_HOSTS` 里显式列出的域名 ——
 *    挡住 DNS rebinding（外部域名解析到本机，浏览器带着 `Host: evil.com` 打进来）。
 *    不支持通配符，也不读 `X-Forwarded-Host`：反代应该把真实域名写回 `Host`。
 * 2. `Origin` 只接受工作台同源地址与显式白名单 —— 挡住任意网页跨域读取聊天记录。
 * 3. `Sec-Fetch-Site: cross-site` 一律拒绝 —— 补上 Origin 被剥离的场景。
 * 4. 凭据：浏览器会话 Cookie（服务端可撤销）或自动化令牌（请求头）。
 *
 * 非 `/api` 路径是工作台静态资源，只过 1、2 两层：登录页本身必须在未认证时能加载。
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** 免认证端点：存活探测与登录流程自身。它们仍受 Host / Origin 校验约束。 */
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"]);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type ApiSecurityOptions = {
	/** 服务实际监听端口，用于校验回环 `Host` 的端口。 */
	port: number;
	/** 自动化脚本用的共享令牌；未配置时只接受浏览器会话。 */
	token?: string;
	/** 额外允许的 `Host`（域名，可带端口）。空数组 = 只接受回环。 */
	allowedHosts?: string[];
	/** 额外允许的浏览器 Origin（自定义前端端口）。 */
	extraOrigins?: string[];
	/** 会话 Cookie 是否加 `Secure`。 */
	secureCookies: boolean;
	/** 校验浏览器会话 Cookie。 */
	verifySession(sessionToken: string): boolean;
};

export type ApiRequestFacts = {
	method: string;
	/** `Host` 头原值。 */
	host: string | undefined;
	origin: string | undefined;
	authorization: string | undefined;
	tokenHeader: string | undefined;
	cookie: string | undefined;
	/** `Sec-Fetch-Site` 头，浏览器自动携带；用于补齐 Origin 被剥离的场景。 */
	secFetchSite: string | undefined;
	/** 仅路径，不含查询串。 */
	pathname: string;
};

export type ApiSecurityDecision =
	| {
			ok: true;
			/** 命中的浏览器会话原值；请求入口据此重新下发 Cookie 以滑动续期。 */
			session?: string;
	  }
	| { ok: false; status: 401 | 403; message: string };

export type ApiSecurity = {
	authorize(facts: ApiRequestFacts): ApiSecurityDecision;
	/** 允许的 Origin 原样返回（用于回写 CORS 头）；不允许时返回 `undefined`，此时不回写任何 CORS 头。 */
	corsOrigin(origin: string | undefined): string | undefined;
	/** 下发会话 Cookie 的 `Set-Cookie` 值。 */
	sessionCookie(sessionToken: string): string;
	/** 会话 Cookie 是否带 `Secure`（同时决定是否发 HSTS）。 */
	secureCookies: boolean;
};

export function createApiSecurity(options: ApiSecurityOptions): ApiSecurity {
	const allowedOrigins = new Set<string>();
	for (const entry of options.extraOrigins ?? []) {
		const origin = normalizeOrigin(entry);
		if (origin) allowedOrigins.add(origin);
	}
	for (const hostname of ["127.0.0.1", "localhost"]) {
		allowedOrigins.add(`http://${hostname}:${options.port}`);
		allowedOrigins.add(`http://${hostname}:5173`);
	}

	const allowedHosts: ParsedHost[] = [];
	for (const entry of options.allowedHosts ?? []) {
		// 通配符会把 DNS rebinding 防护一次性关掉，直接忽略而不是悄悄接受。
		if (entry.includes("*")) continue;
		const parsed = parseHost(entry);
		if (!parsed) continue;
		allowedHosts.push(parsed);
		// 同源部署时浏览器会带 `Origin: https://<域名>`；由 Host 允许名单推导，
		// 省掉「忘了配 MIUBOT_ALLOWED_ORIGINS → 登录页 403」这一类最难排查的配置事故。
		const authority = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
		allowedOrigins.add(`https://${authority}`);
		allowedOrigins.add(`http://${authority}`);
	}

	const corsOrigin = (origin: string | undefined): string | undefined => {
		const normalized = normalizeOrigin(origin);
		return normalized && allowedOrigins.has(normalized) ? normalized : undefined;
	};

	return {
		corsOrigin,
		secureCookies: options.secureCookies,
		sessionCookie: (sessionToken) => buildSessionCookie(sessionToken, { secure: options.secureCookies }),
		authorize(facts) {
			const host = parseHost(facts.host ?? "");
			if (!host || !isAllowedHost(host, options.port, allowedHosts))
				return { ok: false, status: 403, message: "Host 不被允许：请通过 MIUBOT_ALLOWED_HOSTS 配置对外域名" };
			// `Origin` 缺失代表非浏览器客户端；存在就必须在白名单内（含 `null`，一律拒绝）。
			if (facts.origin !== undefined && !corsOrigin(facts.origin))
				return { ok: false, status: 403, message: "Origin 不被允许：请从 Miubot 工作台访问管理 API" };
			// 改写类请求的兜底：浏览器会带 `Sec-Fetch-Site`，跨站值一律拒绝，即使 Origin 被剥离。
			if (facts.secFetchSite?.trim().toLowerCase() === "cross-site")
				return { ok: false, status: 403, message: "跨站请求被拒绝" };
			// 预检请求按规范不带凭据，只能靠 Host / Origin 判定；真正请求仍需凭据。
			if (facts.method.toUpperCase() === "OPTIONS") return { ok: true };
			// 工作台静态资源（含登录页）不需要凭据；数据都在 `/api` 后面。
			if (!facts.pathname.startsWith("/api")) return { ok: true };
			if (UNAUTHENTICATED_PATHS.has(facts.pathname)) return { ok: true };
			const session = readCookieHeader(facts.cookie, SESSION_COOKIE);
			if (session && options.verifySession(session)) return { ok: true, session };
			if (options.token && hasValidToken(facts, options.token)) return { ok: true };
			return { ok: false, status: 401, message: "未认证：请先登录 Miubot 工作台" };
		},
	};
}

/**
 * 默认令牌文件不存在时生成 64 位十六进制令牌。
 *
 * `MIUBOT_AUTH_TOKEN` 可覆盖文件值（用于自动化脚本），此时不写入磁盘。
 */
export async function loadOrCreateAuthToken(tokenPath: string): Promise<string> {
	const fromEnv = process.env.MIUBOT_AUTH_TOKEN?.trim();
	if (fromEnv && TOKEN_PATTERN.test(fromEnv)) return fromEnv;
	try {
		const stored = (await readFile(tokenPath, "utf8")).trim();
		if (TOKEN_PATTERN.test(stored)) {
			await restrictFileMode(tokenPath);
			return stored;
		}
	} catch {}
	const token = randomBytes(32).toString("hex");
	await writeFileAtomic(tokenPath, `${token}\n`);
	return token;
}

type ParsedHost = { hostname: string; port: string };

/** 解析 `Host` / 允许名单条目：只接受 `host[:port]`，不猜协议、不接受路径与凭据。 */
function parseHost(value: string): ParsedHost | undefined {
	const trimmed = value.trim().toLowerCase();
	if (!trimmed || trimmed.includes("/") || trimmed.includes("@") || /\s/.test(trimmed)) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(`http://${trimmed}`);
	} catch {
		return undefined;
	}
	if (parsed.username || parsed.password) return undefined;
	return { hostname: parsed.hostname, port: parsed.port };
}

function isAllowedHost(host: ParsedHost, port: number, allowedHosts: ParsedHost[]): boolean {
	// 回环：端口必须与服务端口一致，避免别的本机服务借用回环名。
	if (LOOPBACK_HOSTNAMES.has(host.hostname) && host.port === (port === 80 ? "" : String(port))) return true;
	for (const entry of allowedHosts) {
		if (entry.hostname !== host.hostname) continue;
		// 名单里带端口就要求端口一致；不带端口表示「这个域名的任何端口」。
		if (!entry.port || entry.port === host.port) return true;
	}
	return false;
}

function normalizeOrigin(origin: string | undefined): string | undefined {
	if (!origin) return undefined;
	const trimmed = origin.trim();
	// `file://` 页面跨域请求会发送 `Origin: null`，不能当成「无 Origin」放行。
	if (!trimmed || trimmed === "null") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	if (parsed.username || parsed.password) return undefined;
	return parsed.origin;
}

function hasValidToken(facts: ApiRequestFacts, expected: string): boolean {
	const bearer = facts.authorization
		?.trim()
		.match(/^bearer\s+(.+)$/i)?.[1]
		?.trim();
	const header = facts.tokenHeader?.trim();
	return safeEqual(bearer, expected) || safeEqual(header, expected);
}

/** 定长比较：先用 SHA-256 摊平长度，避免长度差异影响耗时。 */
function safeEqual(actual: string | undefined, expected: string): boolean {
	if (!actual) return false;
	const left = createHash("sha256").update(actual).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}
