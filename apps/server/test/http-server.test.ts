import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request as httpRequest,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiSecurity } from "../src/api-security.ts";
import { createAuthService, type AuthService } from "../src/auth.ts";
import type { HttpContext } from "../src/http/context.ts";
import { createRateLimiter } from "../src/http/rate-limit.ts";
import { createRequestHandler } from "../src/http/server.ts";
import { createWebAssets } from "../src/http/static.ts";
import { createDefaultConfig } from "../src/runtime.ts";

/**
 * 请求入口的集成测试：真实 HTTP server + 真实 `auth` + 桩 context。
 *
 * 桩 context 只填本文件用到的访问器，其余字段一碰就抛错——避免测试悄悄走到
 * 生产代码里不存在的分支。这是测试夹具，不是生产类型。
 */

const PASSWORD = "integration-test-password";

let dir: string;
let auth: AuthService;
let logs: string[];
let auditEntries: Array<{ action: string; actor: string; detail: string }>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-http-"));
	process.env.MIUBOT_ADMIN_PASSWORD = PASSWORD;
	auth = await createAuthService({ dataDir: join(dir, "data"), secureCookies: false });
	logs = [];
	auditEntries = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	delete process.env.MIUBOT_ADMIN_PASSWORD;
});

async function makeDist(name = "dist"): Promise<string> {
	const distDir = join(dir, name);
	await mkdir(distDir, { recursive: true });
	await writeFile(join(distDir, "index.html"), "<!doctype html><title>miubot-shell</title>", "utf8");
	return distDir;
}

function stubContext(overrides: Partial<Record<keyof HttpContext, unknown>> = {}): HttpContext {
	return {
		auth,
		log: (_level: string, text: string) => {
			logs.push(text);
		},
		qq: { states: new Map() },
		config: { get: () => createDefaultConfig(), replace: () => undefined, save: async () => undefined },
		logs: { list: () => [] },
		audit: {
			record: (entry: { action: string; actor: string; detail: string }) => {
				auditEntries.push(entry);
			},
			list: async () => auditEntries,
			flush: async () => undefined,
		},
		...overrides,
	} as unknown as HttpContext;
}

type Harness = { port: number; close(): Promise<void> };

async function startServer(
	options: {
		context?: HttpContext;
		secureCookies?: boolean;
		distDir?: string;
		capacity?: number;
		refillPerSecond?: number;
	} = {},
): Promise<Harness> {
	const distDir = options.distDir ?? (await makeDist());
	const context = options.context ?? stubContext();
	// 回环 Host 校验需要真实端口，而端口要 listen 之后才知道，因此 handler 延迟到拿到端口再建。
	let dispatch: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
	const server = createServer((request, response) => {
		void dispatch?.(request, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
	const port = address.port;
	dispatch = createRequestHandler({
		context,
		security: createApiSecurity({
			port,
			secureCookies: options.secureCookies ?? false,
			verifySession: (token) => auth.verify(token),
		}),
		assets: createWebAssets(distDir),
		limiter: createRateLimiter({ capacity: options.capacity ?? 1000, refillPerSecond: options.refillPerSecond ?? 1000 }),
	});
	return {
		port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

type Response = { status: number; headers: IncomingHttpHeaders; text: string };

function call(
	port: number,
	options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path ?? "/",
				headers: { host: `127.0.0.1:${port}`, ...options.headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						text: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		request.on("error", reject);
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

async function loginCookie(port: number): Promise<string> {
	const response = await call(port, {
		method: "POST",
		path: "/api/auth/login",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: PASSWORD }),
	});
	expect(response.status).toBe(200);
	const cookie = response.headers["set-cookie"]?.[0];
	if (!cookie) throw new Error("登录未下发 Cookie");
	return cookie.split(";")[0] ?? "";
}

describe("workbench hosting", () => {
	it("serves the shell at / and on SPA routes", async () => {
		const harness = await startServer();
		try {
			for (const path of ["/", "/plugins", "/sessions/abc"]) {
				const response = await call(harness.port, { path });
				expect(response.status, path).toBe(200);
				expect(response.headers["content-type"], path).toContain("text/html");
				expect(response.text, path).toContain("miubot-shell");
			}
		} finally {
			await harness.close();
		}
	});

	it("answers 503 with a build hint when dist is missing", async () => {
		const harness = await startServer({ distDir: join(dir, "not-built") });
		try {
			const response = await call(harness.port, { path: "/" });
			expect(response.status).toBe(503);
			expect(response.text).toContain("工作台尚未构建");
		} finally {
			await harness.close();
		}
	});

	it("rejects non-GET methods on the shell", async () => {
		const harness = await startServer();
		try {
			expect((await call(harness.port, { method: "POST", path: "/" })).status).toBe(405);
		} finally {
			await harness.close();
		}
	});

	it("answers unknown API paths with JSON", async () => {
		const harness = await startServer();
		try {
			const response = await call(harness.port, { path: "/api/nope" });
			expect(response.status).toBe(401);
			expect(response.headers["content-type"]).toContain("application/json");
		} finally {
			await harness.close();
		}
	});
});

describe("authentication boundary", () => {
	it("no longer hands out a session without credentials", async () => {
		const harness = await startServer();
		try {
			const response = await call(harness.port, { method: "POST", path: "/api/auth/session" });
			expect(response.status).toBe(401);
			expect(response.headers["set-cookie"]).toBeUndefined();
		} finally {
			await harness.close();
		}
	});

	it("rejects a forged or expired session cookie", async () => {
		const harness = await startServer();
		try {
			for (const cookie of ["miubot_session=deadbeef", `miubot_session=${"f".repeat(64)}`]) {
				const response = await call(harness.port, { path: "/api/logs", headers: { cookie } });
				expect(response.status, cookie).toBe(401);
			}
		} finally {
			await harness.close();
		}
	});

	it("guards the management API and accepts the session cookie", async () => {
		const harness = await startServer();
		try {
			expect((await call(harness.port, { path: "/api/logs" })).status).toBe(401);
			const cookie = await loginCookie(harness.port);
			const authorized = await call(harness.port, { path: "/api/logs", headers: { cookie } });
			expect(authorized.status).toBe(200);
			// 滑动续期：带着会话的响应会重新下发 Cookie。
			expect(authorized.headers["set-cookie"]?.[0]).toContain("miubot_session=");
		} finally {
			await harness.close();
		}
	});

	it("reports the login state and revokes the session on logout", async () => {
		const harness = await startServer();
		try {
			const anonymous = await call(harness.port, { path: "/api/auth/me" });
			expect(JSON.parse(anonymous.text)).toMatchObject({ authenticated: false });

			const cookie = await loginCookie(harness.port);
			const authenticated = await call(harness.port, { path: "/api/auth/me", headers: { cookie } });
			expect(JSON.parse(authenticated.text)).toMatchObject({ authenticated: true });

			const loggedOut = await call(harness.port, { method: "POST", path: "/api/auth/logout", headers: { cookie } });
			expect(loggedOut.status).toBe(200);
			expect(loggedOut.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

			const afterLogout = await call(harness.port, { path: "/api/auth/me", headers: { cookie } });
			expect(JSON.parse(afterLogout.text)).toMatchObject({ authenticated: false });
		} finally {
			await harness.close();
		}
	});

	it("rejects a wrong password and locks repeated failures", async () => {
		const harness = await startServer();
		try {
			const attempt = () =>
				call(harness.port, {
					method: "POST",
					path: "/api/auth/login",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password: "nope" }),
				});
			expect((await attempt()).status).toBe(401);
			for (let index = 0; index < 4; index += 1) await attempt();
			const locked = await attempt();
			expect(locked.status).toBe(429);
			expect(locked.headers["retry-after"]).toBeTruthy();
		} finally {
			await harness.close();
		}
	});

	it("rejects a forged Host header even with a valid session", async () => {
		const harness = await startServer();
		try {
			const cookie = await loginCookie(harness.port);
			const response = await call(harness.port, {
				path: "/api/health",
				headers: { host: "evil.example", cookie },
			});
			expect(response.status).toBe(403);
		} finally {
			await harness.close();
		}
	});
});

describe("request hygiene", () => {
	it("rejects malformed JSON with 400 instead of 500", async () => {
		const harness = await startServer();
		try {
			const cookie = await loginCookie(harness.port);
			const response = await call(harness.port, {
				method: "PUT",
				path: "/api/config",
				headers: { cookie, "content-type": "application/json" },
				body: "{not json",
			});
			expect(response.status).toBe(400);
		} finally {
			await harness.close();
		}
	});

	it("records mutations in the audit log but not reads", async () => {
		const harness = await startServer();
		try {
			const cookie = await loginCookie(harness.port);
			await call(harness.port, { path: "/api/logs", headers: { cookie } });
			await call(harness.port, {
				method: "PUT",
				path: "/api/config",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(auditEntries).toHaveLength(1);
			expect(auditEntries[0]?.action).toBe("api.mutation");
			expect(auditEntries[0]?.detail).toContain("PUT /api/config");
		} finally {
			await harness.close();
		}
	});

	it("serves the audit trail through the management API", async () => {
		const harness = await startServer();
		try {
			const cookie = await loginCookie(harness.port);
			const response = await call(harness.port, { path: "/api/audit?limit=5", headers: { cookie } });
			expect(response.status).toBe(200);
			expect((JSON.parse(response.text) as { entries: unknown[] }).entries).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("hides internal error details behind a trace id", async () => {
		const context = stubContext({
			logs: {
				list: () => {
					throw new Error("EACCES: /var/lib/miubot/secret.json");
				},
			},
		});
		const harness = await startServer({ context });
		try {
			const cookie = await loginCookie(harness.port);
			const response = await call(harness.port, { path: "/api/logs", headers: { cookie } });
			expect(response.status).toBe(500);
			expect(response.text).not.toContain("secret.json");
			const payload = JSON.parse(response.text) as { message: string; traceId: string };
			expect(payload.message).toBe("服务器内部错误");
			expect(payload.traceId).toMatch(/^[a-f0-9]{8}$/);
			// 详情只进运行日志。
			expect(logs.join("\n")).toContain("secret.json");
		} finally {
			await harness.close();
		}
	});

	it("sends the hardening headers and HSTS only on HTTPS", async () => {
		const plain = await startServer();
		try {
			const response = await call(plain.port, { path: "/" });
			expect(response.headers["x-content-type-options"]).toBe("nosniff");
			expect(response.headers["referrer-policy"]).toBe("no-referrer");
			expect(response.headers["x-frame-options"]).toBe("DENY");
			expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
			expect(response.headers["strict-transport-security"]).toBeUndefined();
		} finally {
			await plain.close();
		}

		const secure = await startServer({ secureCookies: true });
		try {
			const response = await call(secure.port, { path: "/" });
			expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
		} finally {
			await secure.close();
		}
	});

	it("answers preflight without a credential and rate-limits bursts", async () => {
		const harness = await startServer({ capacity: 2, refillPerSecond: 0 });
		try {
			expect((await call(harness.port, { method: "OPTIONS", path: "/api/config" })).status).toBe(204);
			expect((await call(harness.port, { path: "/api/health" })).status).toBe(200);
			const limited = await call(harness.port, { path: "/api/health" });
			expect(limited.status).toBe(429);
			expect(limited.headers["retry-after"]).toBe("1");
		} finally {
			await harness.close();
		}
	});
});

describe("inbound whitelist", () => {
	it("saves valid peer keys and rejects malformed ones", async () => {
		const harness = await startServer();
		try {
			const cookie = await loginCookie(harness.port);
			const saved = await call(harness.port, {
				method: "PUT",
				path: "/api/access",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({ allowedPeers: ["group:123456", "c2c:abcdef"] }),
			});
			expect(saved.status).toBe(200);
			expect((JSON.parse(saved.text) as { allowedPeers: string[] }).allowedPeers).toEqual([
				"group:123456",
				"c2c:abcdef",
			]);

			const rejected = await call(harness.port, {
				method: "PUT",
				path: "/api/access",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({ allowedPeers: ["123456"] }),
			});
			expect(rejected.status).toBe(400);
		} finally {
			await harness.close();
		}
	});

	it("stays read-only when the environment variable wins", async () => {
		const context = stubContext({ envAllowedPeers: ["group:999"] });
		const harness = await startServer({ context });
		try {
			const cookie = await loginCookie(harness.port);
			const read = await call(harness.port, { path: "/api/access", headers: { cookie } });
			expect(read.status).toBe(200);
			const payload = JSON.parse(read.text) as { allowedPeers: string[]; source: string };
			expect(payload).toEqual({ allowedPeers: ["group:999"], source: "env" });

			const write = await call(harness.port, {
				method: "PUT",
				path: "/api/access",
				headers: { cookie, "content-type": "application/json" },
				body: JSON.stringify({ allowedPeers: [] }),
			});
			expect(write.status).toBe(409);
		} finally {
			await harness.close();
		}
	});
});
