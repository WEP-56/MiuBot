import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiSecurity, loadOrCreateAuthToken, type ApiRequestFacts } from "../src/api-security.ts";
import { SESSION_COOKIE } from "../src/auth.ts";

const TOKEN = "a".repeat(64);
const SESSION = "s".repeat(64);
const PORT = 8787;

const security = createApiSecurity({
	port: PORT,
	token: TOKEN,
	secureCookies: false,
	verifySession: (value) => value === SESSION,
});

function facts(overrides: Partial<ApiRequestFacts> = {}): ApiRequestFacts {
	return {
		method: "GET",
		host: `127.0.0.1:${PORT}`,
		origin: undefined,
		authorization: undefined,
		tokenHeader: undefined,
		cookie: undefined,
		secFetchSite: undefined,
		pathname: "/api/config",
		...overrides,
	};
}

const withSession = { cookie: `${SESSION_COOKIE}=${SESSION}` };

describe("management API host guard", () => {
	it("accepts loopback hosts on the serving port", () => {
		for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
			expect(security.authorize(facts({ host, ...withSession })).ok, host).toBe(true);
		}
	});

	it("rejects DNS rebinding hosts", () => {
		for (const host of [`evil.example:${PORT}`, `127.0.0.1.nip.io:${PORT}`, `localhost:${PORT + 1}`, undefined]) {
			const decision = security.authorize(facts({ host, ...withSession }));
			expect(decision, String(host)).toEqual({ ok: false, status: 403, message: expect.stringContaining("Host") });
		}
	});

	it("rejects requests without a Host header even when authenticated", () => {
		expect(security.authorize(facts({ host: undefined, ...withSession })).ok).toBe(false);
	});
});

describe("management API public host allowlist", () => {
	const publicSecurity = createApiSecurity({
		port: PORT,
		allowedHosts: ["example.com", "miu.example.net:8443"],
		secureCookies: true,
		verifySession: (value) => value === SESSION,
	});

	it("accepts explicitly listed hosts", () => {
		for (const host of ["example.com", "example.com:443", "miu.example.net:8443"]) {
			expect(publicSecurity.authorize(facts({ host, ...withSession })).ok, host).toBe(true);
		}
	});

	it("still accepts loopback so local health checks work behind a proxy", () => {
		expect(publicSecurity.authorize(facts({ ...withSession })).ok).toBe(true);
	});

	it("rejects unlisted hosts, including subdomains", () => {
		for (const host of ["evil.com", "api.example.com", "example.com.evil.com", "miu.example.net:443"]) {
			expect(publicSecurity.authorize(facts({ host, ...withSession })).ok, host).toBe(false);
		}
	});

	it("ignores wildcard entries instead of trusting every host", () => {
		const wildcard = createApiSecurity({
			port: PORT,
			allowedHosts: ["*"],
			secureCookies: false,
			verifySession: () => true,
		});
		expect(wildcard.authorize(facts({ host: "evil.com" })).ok).toBe(false);
	});

	it("derives allowed origins from the host allowlist", () => {
		expect(publicSecurity.corsOrigin("https://example.com")).toBe("https://example.com");
		expect(publicSecurity.corsOrigin("https://evil.com")).toBeUndefined();
	});
});

describe("management API origin guard", () => {
	it("allows the development workbench origins", () => {
		for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${PORT}`]) {
			expect(security.authorize(facts({ origin, ...withSession })).ok, origin).toBe(true);
			expect(security.corsOrigin(origin)).toBe(origin);
		}
	});

	it("never echoes CORS headers for foreign origins", () => {
		for (const origin of ["https://evil.example", "http://127.0.0.1:3000", "null", "file://", undefined]) {
			expect(security.corsOrigin(origin), String(origin)).toBeUndefined();
		}
		// `Origin: null`（本地 file:// 页面）必须按「不匹配」处理，不能当成缺失 Origin。
		expect(security.authorize(facts({ origin: "null", ...withSession }))).toEqual({
			ok: false,
			status: 403,
			message: expect.stringContaining("Origin"),
		});
	});

	it("rejects cross-site browser requests even with a valid session", () => {
		expect(security.authorize(facts({ secFetchSite: "cross-site", ...withSession })).ok).toBe(false);
	});

	it("honours extra origins from configuration", () => {
		const custom = createApiSecurity({
			port: PORT,
			token: TOKEN,
			extraOrigins: ["http://127.0.0.1:4173"],
			secureCookies: false,
			verifySession: () => false,
		});
		expect(custom.corsOrigin("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
		expect(custom.authorize(facts({ origin: "http://127.0.0.1:4173" })).ok).toBe(false); // 仍缺凭据
		expect(custom.authorize(facts({ origin: "http://127.0.0.1:4173", tokenHeader: TOKEN })).ok).toBe(true);
	});
});

describe("management API credential guard", () => {
	it("rejects unauthenticated access to sensitive reads", () => {
		for (const pathname of ["/api/config", "/api/logs", "/api/peers", "/api/sessions/abc", "/api/auth/session"]) {
			expect(security.authorize(facts({ pathname })), pathname).toEqual({
				ok: false,
				status: 401,
				message: expect.stringContaining("未认证"),
			});
		}
	});

	it("rejects wrong or truncated tokens", () => {
		for (const token of ["", "b".repeat(64), "a".repeat(63), `${TOKEN}0`]) {
			expect(security.authorize(facts({ tokenHeader: token })).ok, token).toBe(false);
		}
	});

	it("accepts bearer and dedicated header, but no longer a shared-token cookie", () => {
		expect(security.authorize(facts({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true);
		expect(security.authorize(facts({ authorization: `bearer ${TOKEN}` })).ok).toBe(true);
		expect(security.authorize(facts({ tokenHeader: TOKEN })).ok).toBe(true);
		// 旧浏览器会话 Cookie（明文共享令牌）已作废：令牌只能走请求头。
		expect(security.authorize(facts({ cookie: `miubot_token=${TOKEN}` })).ok).toBe(false);
	});

	it("accepts a valid browser session and echoes it back for sliding renewal", () => {
		const decision = security.authorize(facts(withSession));
		expect(decision).toEqual({ ok: true, session: SESSION });
	});

	it("rejects an unknown or expired session", () => {
		expect(security.authorize(facts({ cookie: `${SESSION_COOKIE}=${"x".repeat(64)}` })).ok).toBe(false);
		expect(security.authorize(facts({ cookie: `${SESSION_COOKIE}=` })).ok).toBe(false);
	});

	it("only exempts the bootstrap endpoints from the credential requirement", () => {
		for (const pathname of ["/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"]) {
			expect(security.authorize(facts({ pathname })).ok, pathname).toBe(true);
		}
		// 前缀相似路径不能顺带放行。
		expect(security.authorize(facts({ pathname: "/api/health/detail" })).ok).toBe(false);
		expect(security.authorize(facts({ pathname: "/api/auth/login-extra" })).ok).toBe(false);
	});

	it("serves the workbench shell without credentials but keeps the host guard", () => {
		expect(security.authorize(facts({ pathname: "/" })).ok).toBe(true);
		expect(security.authorize(facts({ pathname: "/plugins" })).ok).toBe(true);
		expect(security.authorize(facts({ pathname: "/", host: "evil.com" })).ok).toBe(false);
	});

	it("lets preflight through without a credential, but never from a foreign origin", () => {
		// 预检按规范不带 Cookie，放行它不构成数据泄漏；Host / Origin 仍要过。
		expect(security.authorize(facts({ method: "OPTIONS", pathname: "/api/config" })).ok).toBe(true);
		expect(security.authorize(facts({ method: "OPTIONS", origin: "https://evil.example" })).ok).toBe(false);
		expect(security.authorize(facts({ method: "OPTIONS", host: "evil.example:8787" })).ok).toBe(false);
		// 真正请求依旧需要凭据。
		expect(security.authorize(facts({ method: "PUT", pathname: "/api/config" })).ok).toBe(false);
	});

	it("cannot be bypassed by a matching prefix in the cookie jar", () => {
		expect(security.authorize(facts({ cookie: `${SESSION_COOKIE}_v2=${SESSION}` })).ok).toBe(false);
	});

	it("emits HttpOnly, SameSite=Strict cookies and adds Secure only on HTTPS", () => {
		const insecure = security.sessionCookie(SESSION);
		expect(insecure).toContain(`${SESSION_COOKIE}=${SESSION}`);
		expect(insecure).toContain("HttpOnly");
		expect(insecure).toContain("SameSite=Strict");
		expect(insecure).toContain("Path=/");
		expect(insecure).not.toContain("Secure");

		const secure = createApiSecurity({
			port: PORT,
			secureCookies: true,
			verifySession: () => false,
		});
		expect(secure.sessionCookie(SESSION)).toContain("Secure");
	});
});

describe("auth token persistence", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
		dir = undefined;
		delete process.env.MIUBOT_AUTH_TOKEN;
	});

	it("creates a 64 character hex token once and reuses it", async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-auth-"));
		const tokenPath = join(dir, "nested", "api-token");
		const created = await loadOrCreateAuthToken(tokenPath);
		expect(created).toMatch(/^[a-f0-9]{64}$/);
		expect((await readFile(tokenPath, "utf8")).trim()).toBe(created);
		expect(await loadOrCreateAuthToken(tokenPath)).toBe(created);
	});

	it("regenerates when the stored file is corrupted", async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-auth-"));
		const tokenPath = join(dir, "api-token");
		await writeFile(tokenPath, "not-a-token", "utf8");
		const token = await loadOrCreateAuthToken(tokenPath);
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect(token).not.toBe("not-a-token");
	});

	it("lets MIUBOT_AUTH_TOKEN override the file without writing it", async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-auth-"));
		process.env.MIUBOT_AUTH_TOKEN = "c".repeat(64);
		expect(await loadOrCreateAuthToken(join(dir, "api-token"))).toBe("c".repeat(64));
		await expect(readFile(join(dir, "api-token"), "utf8")).rejects.toThrow();
	});
});
