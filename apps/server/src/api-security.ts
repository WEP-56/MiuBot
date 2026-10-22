import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 管理 API（`/api/*`）的本机安全边界。
 *
 * 三层校验，顺序固定：
 *
 * 1. `Host` 只接受回环名字与本进程端口 —— 挡住 DNS rebinding（域名解析到 127.0.0.1）。
 * 2. `Origin` 只接受开发工作台与本机同源地址 —— 挡住任意网页跨域读取聊天记录。
 * 3. 令牌（Cookie 或请求头）—— 挡住无法发送 `Origin` 但能发起请求的客户端，例如本地打开的 `file://` 页面。
 *
 * 令牌不能替代浏览器侧的 Origin 检查：无 `Origin` 的本地进程本就能读 `.miubot/` 下的文件，
 * 这里的目标是「浏览器里跑的东西拿不到数据」，而不是防御本机任意进程。
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** 免认证端点：存活探测与令牌下发。两者仍受 Host / Origin 校验约束。 */
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/api/auth/session"]);
const AUTH_COOKIE = "miubot_token";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type ApiSecurityOptions = {
	/** 服务实际监听端口，用于校验 `Host`。 */
	port: number;
	token: string;
	/** 额外允许的浏览器 Origin（自定义前端端口）。 */
	extraOrigins?: string[];
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

export type ApiSecurityDecision = { ok: true } | { ok: false; status: 401 | 403; message: string };

export type ApiSecurity = {
	authorize(facts: ApiRequestFacts): ApiSecurityDecision;
	/** 允许的 Origin 原样返回（用于回写 CORS 头）；不允许时返回 `undefined`，此时不回写任何 CORS 头。 */
	corsOrigin(origin: string | undefined): string | undefined;
	/** 下发会话 Cookie 的 `Set-Cookie` 值。 */
	sessionCookie(): string;
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

	const corsOrigin = (origin: string | undefined): string | undefined => {
		const normalized = normalizeOrigin(origin);
		return normalized && allowedOrigins.has(normalized) ? normalized : undefined;
	};

	return {
		corsOrigin,
		sessionCookie: () => `${AUTH_COOKIE}=${options.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
		authorize(facts) {
			if (!isLoopbackHost(facts.host, options.port))
				return { ok: false, status: 403, message: "Host 不被允许：管理 API 只接受本机回环地址" };
			// `Origin` 缺失代表非浏览器客户端；存在就必须在白名单内（含 `null`，一律拒绝）。
			if (facts.origin !== undefined && !corsOrigin(facts.origin))
				return { ok: false, status: 403, message: "Origin 不被允许：请从 Miubot 工作台访问管理 API" };
			// 改写类请求的兜底：浏览器会带 `Sec-Fetch-Site`，跨站值一律拒绝，即使 Origin 被剥离。
			if (facts.secFetchSite?.trim().toLowerCase() === "cross-site")
				return { ok: false, status: 403, message: "跨站请求被拒绝" };
			// 预检请求按规范不带凭据，只能靠 Host / Origin 判定；真正请求仍需令牌。
			if (facts.method.toUpperCase() === "OPTIONS") return { ok: true };
			if (UNAUTHENTICATED_PATHS.has(facts.pathname)) return { ok: true };
			if (!hasValidToken(facts, options.token))
				return { ok: false, status: 401, message: "未认证：请先建立管理会话" };
			return { ok: true };
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
		if (TOKEN_PATTERN.test(stored)) return stored;
	} catch {}
	const token = randomBytes(32).toString("hex");
	await mkdir(dirname(tokenPath), { recursive: true });
	await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	return token;
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
	if (!host) return false;
	let parsed: URL;
	try {
		parsed = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
	// 端口必须与服务端口一致；不带端口仅在服务监听 80 时成立，避免别的本机服务借用回环名。
	const expected = port === 80 ? "" : String(port);
	return parsed.port === expected;
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
	const cookie = readCookie(facts.cookie, AUTH_COOKIE);
	return safeEqual(bearer, expected) || safeEqual(header, expected) || safeEqual(cookie, expected);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return undefined;
}

/** 定长比较：先用 SHA-256 摊平长度，避免长度差异影响耗时。 */
function safeEqual(actual: string | undefined, expected: string): boolean {
	if (!actual) return false;
	const left = createHash("sha256").update(actual).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}
