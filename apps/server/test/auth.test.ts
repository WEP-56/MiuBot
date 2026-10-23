import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAuthService,
	generatePassword,
	hashPassword,
	isPasswordHash,
	readCookieHeader,
	SESSION_COOKIE,
	verifyPassword,
} from "../src/auth.ts";

const ENV_KEYS = ["MIUBOT_PASSWORD_HASH", "MIUBOT_ADMIN_PASSWORD"] as const;

let dir: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-auth-"));
});

afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
	for (const key of ENV_KEYS) delete process.env[key];
});

function dataDir(): string {
	if (!dir) throw new Error("临时目录未创建");
	return dir;
}

describe("password hashing", () => {
	it("round-trips a password through scrypt", async () => {
		const hash = await hashPassword("correct horse battery");
		expect(isPasswordHash(hash)).toBe(true);
		expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
		expect(await verifyPassword("correct horse battery", hash)).toBe(true);
		expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
	});

	it("salts every hash", async () => {
		const first = await hashPassword("same-password");
		const second = await hashPassword("same-password");
		expect(first).not.toBe(second);
	});

	it("rejects malformed or foreign hashes instead of throwing", async () => {
		for (const stored of ["", "plaintext", "scrypt$1$2$3", `bcrypt$16384$8$1$${"a".repeat(32)}$${"b".repeat(64)}`]) {
			expect(await verifyPassword("whatever", stored), stored).toBe(false);
			expect(isPasswordHash(stored), stored).toBe(false);
		}
		// 参数被改过的散列不再被接受：换了参数必须换前缀，否则会拿旧散列配新参数。
		const hash = await hashPassword("password-123");
		expect(await verifyPassword("password-123", hash.replace("$16384$", "$32768$"))).toBe(false);
	});
});

describe("first boot", () => {
	it("generates a password once, hashes it on disk and reports it for the startup log", async () => {
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(service.passwordSource).toBe("generated");
		expect(service.generatedPassword).toBeTruthy();
		expect(service.generatedPassword?.length).toBeGreaterThanOrEqual(16);
		const stored = await readFile(join(dataDir(), "admin-password"), "utf8");
		expect(isPasswordHash(stored)).toBe(true);
		// 落盘的是散列，不是明文。
		expect(stored).not.toContain(service.generatedPassword as string);

		const login = await service.login(service.generatedPassword as string);
		expect(login.ok).toBe(true);
	});

	it("reuses the stored hash on later boots and stops printing the password", async () => {
		const first = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		const password = first.generatedPassword as string;
		const second = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(second.generatedPassword).toBeUndefined();
		expect(second.passwordSource).toBe("file");
		expect((await second.login(password)).ok).toBe(true);
	});

	it("regenerates when the stored file is corrupted", async () => {
		await writeFile(join(dataDir(), "admin-password"), "not-a-hash", "utf8");
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(service.passwordSource).toBe("generated");
		expect(service.generatedPassword).toBeTruthy();
	});

	it("honours MIUBOT_ADMIN_PASSWORD without writing it to disk", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "env-provided-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(service.passwordSource).toBe("env-password");
		expect((await service.login("env-provided-password")).ok).toBe(true);
		await expect(readFile(join(dataDir(), "admin-password"), "utf8")).rejects.toThrow();
	});

	it("honours MIUBOT_PASSWORD_HASH and rejects a malformed one", async () => {
		process.env.MIUBOT_PASSWORD_HASH = await hashPassword("hash-provided-password");
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(service.passwordSource).toBe("env-hash");
		expect((await service.login("hash-provided-password")).ok).toBe(true);

		process.env.MIUBOT_PASSWORD_HASH = "obviously-not-a-hash";
		await expect(createAuthService({ dataDir: dataDir(), secureCookies: false })).rejects.toThrow(
			/MIUBOT_PASSWORD_HASH/,
		);
	});
});

describe("sessions", () => {
	it("issues a revocable session that survives a restart", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "session-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		const login = await service.login("session-test-password");
		if (!login.ok) throw new Error("登录失败");
		expect(service.verify(login.token)).toBe(true);
		expect(service.activeSessions()).toBe(1);

		await service.flush();
		const restarted = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(restarted.verify(login.token)).toBe(true);

		await restarted.revoke(login.token);
		expect(restarted.verify(login.token)).toBe(false);
		expect(restarted.activeSessions()).toBe(0);
	});

	it("rejects unknown and expired sessions", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "session-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(service.verify(undefined)).toBe(false);
		expect(service.verify("f".repeat(64))).toBe(false);

		const login = await service.login("session-test-password");
		if (!login.ok) throw new Error("登录失败");
		// 手工把过期时间改到过去，模拟会话自然到期。
		const path = join(dataDir(), "admin-sessions.json");
		const stored = JSON.parse(await readFile(path, "utf8")) as Array<{ expiresAt: number }>;
		await writeFile(path, JSON.stringify(stored.map((item) => ({ ...item, expiresAt: Date.now() - 1000 }))), "utf8");
		const restarted = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(restarted.verify(login.token)).toBe(false);
		expect(restarted.activeSessions()).toBe(0);
	});

	it("keeps the session id out of the on-disk file", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "session-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		const login = await service.login("session-test-password");
		if (!login.ok) throw new Error("登录失败");
		const stored = await readFile(join(dataDir(), "admin-sessions.json"), "utf8");
		expect(stored).not.toContain(login.token);
		expect(stored).toContain('"id"');
	});
});

describe("failed-login lockout", () => {
	it("locks after five consecutive failures and rejects even the right password", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "lockout-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const result = await service.login("wrong-password");
			expect(result).toEqual({ ok: false, reason: "invalid", retryAfterSeconds: 0 });
		}
		const locked = await service.login("wrong-password");
		expect(locked.ok).toBe(false);
		if (locked.ok) throw new Error("unreachable");
		expect(locked.reason).toBe("locked");
		expect(locked.retryAfterSeconds).toBeGreaterThan(0);

		const duringLock = await service.login("lockout-test-password");
		expect(duringLock.ok).toBe(false);
		if (duringLock.ok) throw new Error("unreachable");
		expect(duringLock.reason).toBe("locked");
	});

	it("resets the counter after a successful login", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "lockout-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		for (let round = 0; round < 2; round += 1) {
			for (let attempt = 0; attempt < 4; attempt += 1) await service.login("wrong-password");
			expect((await service.login("lockout-test-password")).ok).toBe(true);
		}
	});
});

describe("password change", () => {
	it("requires the current password and rejects weak or identical replacements", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "change-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(await service.changePassword("wrong", "new-password-123", undefined)).toEqual({
			ok: false,
			message: "当前口令不正确",
		});
		expect((await service.changePassword("change-test-password", "short", undefined)).ok).toBe(false);
		expect((await service.changePassword("change-test-password", "change-test-password", undefined)).ok).toBe(false);
	});

	it("rotates the stored hash, keeps the caller's session and revokes the rest", async () => {
		process.env.MIUBOT_ADMIN_PASSWORD = "change-test-password";
		const service = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		const keep = await service.login("change-test-password");
		const other = await service.login("change-test-password");
		if (!keep.ok || !other.ok) throw new Error("登录失败");

		expect(await service.changePassword("change-test-password", "brand-new-password", keep.token)).toEqual({
			ok: true,
		});
		expect(service.verify(keep.token)).toBe(true);
		expect(service.verify(other.token)).toBe(false);
		expect((await service.login("change-test-password")).ok).toBe(false);
		expect((await service.login("brand-new-password")).ok).toBe(true);
	});
});

describe("cookie helpers", () => {
	it("adds Secure only when asked", async () => {
		const plain = await createAuthService({ dataDir: dataDir(), secureCookies: false });
		expect(plain.sessionCookie("abc")).not.toContain("Secure");
		const secure = await createAuthService({ dataDir: dataDir(), secureCookies: true });
		expect(secure.sessionCookie("abc")).toContain("Secure");
		expect(secure.clearCookie()).toContain("Max-Age=0");
	});

	it("reads a single cookie value", () => {
		expect(readCookieHeader(`theme=dark; ${SESSION_COOKIE}=abc; other=1`, SESSION_COOKIE)).toBe("abc");
		expect(readCookieHeader(`theme=dark`, SESSION_COOKIE)).toBeUndefined();
		expect(readCookieHeader(undefined, SESSION_COOKIE)).toBeUndefined();
		expect(readCookieHeader(`${SESSION_COOKIE}_v2=abc`, SESSION_COOKIE)).toBeUndefined();
	});

	it("generates URL-safe passwords", () => {
		expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{16,}$/);
	});
});
