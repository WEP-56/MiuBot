import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiSecurity, loadOrCreateAuthToken, type ApiRequestFacts } from "../src/api-security.ts";

const TOKEN = "a".repeat(64);
const PORT = 8787;

const security = createApiSecurity({ port: PORT, token: TOKEN });

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

describe("management API host guard", () => {
	it("accepts loopback hosts on the serving port", () => {
		for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
			expect(security.authorize(facts({ host, cookie: `miubot_token=${TOKEN}` })).ok, host).toBe(true);
		}
	});

	it("rejects DNS rebinding hosts", () => {
		for (const host of [`evil.example:${PORT}`, `127.0.0.1.nip.io:${PORT}`, `localhost:${PORT + 1}`, undefined]) {
			const decision = security.authorize(facts({ host, cookie: `miubot_token=${TOKEN}` }));
			expect(decision, String(host)).toEqual({ ok: false, status: 403, message: expect.stringContaining("Host") });
		}
	});

	it("rejects requests without a Host header even when authenticated", () => {
		expect(security.authorize(facts({ host: undefined, cookie: `miubot_token=${TOKEN}` })).ok).toBe(false);
	});
});

describe("management API origin guard", () => {
	it("allows the development workbench origins", () => {
		for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", `http://127.0.0.1:${PORT}`]) {
			expect(security.authorize(facts({ origin, cookie: `miubot_token=${TOKEN}` })).ok, origin).toBe(true);
			expect(security.corsOrigin(origin)).toBe(origin);
		}
	});

	it("never echoes CORS headers for foreign origins", () => {
		for (const origin of ["https://evil.example", "http://127.0.0.1:3000", "null", "file://", undefined]) {
			expect(security.corsOrigin(origin), String(origin)).toBeUndefined();
		}
		// `Origin: null`（本地 file:// 页面）必须按「不匹配」处理，不能当成缺失 Origin。
		expect(security.authorize(facts({ origin: "null", cookie: `miubot_token=${TOKEN}` }))).toEqual({
			ok: false,
			status: 403,
			message: expect.stringContaining("Origin"),
		});
	});

	it("rejects cross-site browser requests even with a valid cookie", () => {
		expect(security.authorize(facts({ secFetchSite: "cross-site", cookie: `miubot_token=${TOKEN}` })).ok).toBe(false);
	});

	it("honours extra origins from configuration", () => {
		const custom = createApiSecurity({ port: PORT, token: TOKEN, extraOrigins: ["http://127.0.0.1:4173"] });
		expect(custom.corsOrigin("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
		expect(custom.authorize(facts({ origin: "http://127.0.0.1:4173" })).ok).toBe(false); // 仍缺令牌
		expect(custom.authorize(facts({ origin: "http://127.0.0.1:4173", cookie: `miubot_token=${TOKEN}` })).ok).toBe(
			true,
		);
	});
});

describe("management API token guard", () => {
	it("rejects unauthenticated access to sensitive reads", () => {
		for (const pathname of ["/api/config", "/api/logs", "/api/peers", "/api/sessions/abc"]) {
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

	it("accepts bearer, dedicated header and cookie", () => {
		expect(security.authorize(facts({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true);
		expect(security.authorize(facts({ authorization: `bearer ${TOKEN}` })).ok).toBe(true);
		expect(security.authorize(facts({ tokenHeader: TOKEN })).ok).toBe(true);
		expect(security.authorize(facts({ cookie: `theme=dark; miubot_token=${TOKEN}; other=1` })).ok).toBe(true);
	});

	it("only exempts health and session bootstrap from the token requirement", () => {
		expect(security.authorize(facts({ pathname: "/api/health" })).ok).toBe(true);
		expect(security.authorize(facts({ pathname: "/api/auth/session" })).ok).toBe(true);
		// 前缀相似路径不能顺带放行。
		expect(security.authorize(facts({ pathname: "/api/health/detail" })).ok).toBe(false);
	});

	it("lets preflight through without a token, but never from a foreign origin", () => {
		// 预检按规范不带 Cookie，放行它不构成数据泄漏；Host / Origin 仍要过。
		expect(security.authorize(facts({ method: "OPTIONS", pathname: "/api/config" })).ok).toBe(true);
		expect(security.authorize(facts({ method: "OPTIONS", origin: "https://evil.example" })).ok).toBe(false);
		expect(security.authorize(facts({ method: "OPTIONS", host: "evil.example:8787" })).ok).toBe(false);
		// 真正请求依旧需要令牌。
		expect(security.authorize(facts({ method: "PUT", pathname: "/api/config" })).ok).toBe(false);
	});

	it("cannot be bypassed by a matching prefix in the cookie jar", () => {
		expect(security.authorize(facts({ cookie: `miubot_token_v2=${TOKEN}` })).ok).toBe(false);
	});

	it("emits an HttpOnly, SameSite=Strict session cookie", () => {
		const cookie = security.sessionCookie();
		expect(cookie).toContain(`miubot_token=${TOKEN}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/");
		expect(cookie).not.toContain("Secure");
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
