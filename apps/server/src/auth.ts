import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, restrictFileMode, writeFileAtomic, writeJsonAtomic } from "./storage.ts";

/**
 * 管理面认证：单管理员口令 + 服务端可撤销会话。
 *
 * 为什么不是「一个共享令牌」：令牌一旦下发就等价于管理员，既撤销不了也说不清是谁在用。
 * 这里换成
 *
 * - 口令用 scrypt 散列存盘（`admin-password`，0600），可用 `MIUBOT_PASSWORD_HASH` /
 *   `MIUBOT_ADMIN_PASSWORD` 覆盖（容器与 systemd 用前者更常见）。
 * - 登录成功后签发随机会话 id，**服务端**保存其 SHA-256 与过期时间；Cookie 只携带原值。
 *   登出、改口令都能立刻让会话失效，不依赖浏览器端过期。
 * - 失败 5 次锁 5 分钟：单管理员场景下不存在「按用户区分」的意义，按全局计。
 *
 * 共享令牌（`api-token`）保留但降级为自动化脚本用：它不再能换浏览器 Cookie，
 * 只能通过 `Authorization: Bearer` / `X-Miubot-Token` 直接调用管理 API。
 */

export const SESSION_COOKIE = "miubot_session";
/** 会话绝对有效期（滑动续期：每次校验通过就往后推）。 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
/** 会话文件最多保留的条数，避免反复登录把文件撑大。 */
const MAX_SESSIONS = 20;

const PASSWORD_MIN_LENGTH = 8;
const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const HASH_PREFIX = "scrypt";

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

export type PasswordSource = "env-hash" | "env-password" | "file" | "generated";

export type LoginResult =
	| { ok: true; token: string }
	| { ok: false; reason: "invalid" | "locked"; retryAfterSeconds: number };

export type PasswordChangeResult = { ok: true } | { ok: false; message: string };

export type AuthService = {
	/** 首次启动自动生成的口令明文；只用于启动日志提示一次。 */
	readonly generatedPassword: string | undefined;
	readonly passwordSource: PasswordSource;
	readonly passwordPath: string;
	login(password: string): Promise<LoginResult>;
	/** 校验浏览器会话；通过即滑动续期。 */
	verify(sessionToken: string | undefined): boolean;
	revoke(sessionToken: string | undefined): Promise<void>;
	changePassword(current: string, next: string, keepToken: string | undefined): Promise<PasswordChangeResult>;
	activeSessions(): number;
	sessionCookie(token: string): string;
	clearCookie(): string;
	/** 落盘待写的会话变更（优雅退出时调用）。 */
	flush(): Promise<void>;
};

export type AuthOptions = {
	dataDir: string;
	/** HTTPS 部署时为 Cookie 加 `Secure`。 */
	secureCookies: boolean;
	/** 审计钩子：登录成功/失败/锁定、登出、改密。不传则什么都不记。 */
	onAudit?: (action: string, detail: string) => void;
};

type StoredSession = { id: string; createdAt: number; expiresAt: number };

export async function createAuthService(options: AuthOptions): Promise<AuthService> {
	const passwordPath = join(options.dataDir, "admin-password");
	const sessionsPath = join(options.dataDir, "admin-sessions.json");

	const resolved = await resolvePassword(passwordPath);
	let passwordHash = resolved.hash;
	const sessions = new Map<string, StoredSession>();
	for (const record of await loadSessions(sessionsPath)) sessions.set(record.id, record);

	let failures = 0;
	let firstFailureAt = 0;
	let lockedUntil = 0;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	async function saveSessions(): Promise<void> {
		// 顺带清掉过期条目：否则「登出过的会话」会一直留在文件里。
		const now = Date.now();
		for (const [id, record] of sessions) if (record.expiresAt <= now) sessions.delete(id);
		await writeJsonAtomic(sessionsPath, [...sessions.values()]);
	}

	function scheduleSave(): void {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			void saveSessions().catch(() => undefined);
		}, 30_000);
		saveTimer.unref();
	}

	function resetFailures(): void {
		failures = 0;
		firstFailureAt = 0;
		lockedUntil = 0;
	}

	async function issueSession(): Promise<string> {
		const token = randomBytes(32).toString("hex");
		const id = hashToken(token);
		const now = Date.now();
		sessions.set(id, { id, createdAt: now, expiresAt: now + SESSION_TTL_MS });
		// 超出上限时丢最早的：单管理员用不到 20 条并发会话，留下的只可能是历史残留。
		if (sessions.size > MAX_SESSIONS) {
			const ordered = [...sessions.values()].sort((left, right) => left.createdAt - right.createdAt);
			for (const record of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(record.id);
		}
		await saveSessions();
		return token;
	}

	return {
		generatedPassword: resolved.generated,
		passwordSource: resolved.source,
		passwordPath,
		async login(password) {
			const now = Date.now();
			if (lockedUntil > now) {
				options.onAudit?.("auth.login.locked", "登录被拒绝：仍处于锁定期");
				return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
			}
			if (await verifyPassword(password, passwordHash)) {
				resetFailures();
				options.onAudit?.("auth.login", "管理员登录成功");
				return { ok: true, token: await issueSession() };
			}
			// 失败计数按窗口滚动：5 分钟内连续 5 次才锁，否则只清零重新数。
			if (firstFailureAt === 0 || now - firstFailureAt > FAILURE_WINDOW_MS) {
				firstFailureAt = now;
				failures = 0;
			}
			failures += 1;
			if (failures >= MAX_FAILURES) {
				lockedUntil = now + LOCK_MS;
				failures = 0;
				firstFailureAt = 0;
				options.onAudit?.("auth.login.locked", "连续口令错误，已锁定 5 分钟");
				return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil(LOCK_MS / 1000) };
			}
			options.onAudit?.("auth.login.failed", `口令错误（连续第 ${failures} 次）`);
			return { ok: false, reason: "invalid", retryAfterSeconds: 0 };
		},
		verify(sessionToken) {
			if (!sessionToken) return false;
			const id = hashToken(sessionToken);
			const record = sessions.get(id);
			if (!record) return false;
			const now = Date.now();
			if (record.expiresAt <= now) {
				sessions.delete(id);
				scheduleSave();
				return false;
			}
			record.expiresAt = now + SESSION_TTL_MS;
			scheduleSave();
			return true;
		},
		async revoke(sessionToken) {
			if (!sessionToken) return;
			if (sessions.delete(hashToken(sessionToken))) {
				options.onAudit?.("auth.logout", "会话已撤销");
				await saveSessions();
			}
		},
		async changePassword(current, next, keepToken) {
			if (!(await verifyPassword(current, passwordHash))) {
				options.onAudit?.("auth.password.failed", "改密被拒绝：当前口令不正确");
				return { ok: false, message: "当前口令不正确" };
			}
			if (next.length < PASSWORD_MIN_LENGTH) {
				options.onAudit?.("auth.password.failed", "改密被拒绝：新口令太短");
				return { ok: false, message: `新口令至少 ${PASSWORD_MIN_LENGTH} 位` };
			}
			if (next === current) {
				options.onAudit?.("auth.password.failed", "改密被拒绝：新口令与当前相同");
				return { ok: false, message: "新口令不能与当前口令相同" };
			}
			const hash = await hashPassword(next);
			await writeFileAtomic(passwordPath, `${hash}\n`);
			passwordHash = hash;
			// 改口令后其余会话一律作废：口令泄露的处置手段必须是「改完就断」。
			const keep = keepToken ? hashToken(keepToken) : undefined;
			for (const id of [...sessions.keys()]) if (id !== keep) sessions.delete(id);
			resetFailures();
			await saveSessions();
			options.onAudit?.("auth.password", "管理员口令已修改，其余会话已作废");
			return { ok: true };
		},
		activeSessions: () => sessions.size,
		sessionCookie: (token) => buildSessionCookie(token, { secure: options.secureCookies }),
		clearCookie: () => buildClearCookie({ secure: options.secureCookies }),
		async flush() {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = undefined;
			}
			await saveSessions();
		},
	};
}

/** `Set-Cookie` 值：HttpOnly + SameSite=Strict，HTTPS 部署再加 Secure。 */
export function buildSessionCookie(token: string, options: { secure: boolean }): string {
	const parts = [
		`${SESSION_COOKIE}=${token}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
		`Max-Age=${SESSION_TTL_SECONDS}`,
	];
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

/** 登出用：同名 Cookie 立刻过期。 */
export function buildClearCookie(options: { secure: boolean }): string {
	const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
	if (options.secure) parts.push("Secure");
	return parts.join("; ");
}

/** 从 `Cookie` 头里取一个值；同名只取第一个。 */
export function readCookieHeader(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return undefined;
}

/** 口令散列格式：`scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`。 */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, SCRYPT_KEYLEN);
	return [
		HASH_PREFIX,
		SCRYPT_COST,
		SCRYPT_BLOCK_SIZE,
		SCRYPT_PARALLELIZATION,
		salt.toString("hex"),
		key.toString("hex"),
	].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.trim().split("$");
	if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return false;
	const [, cost, blockSize, parallelization, saltHex, hashHex] = parts;
	// 参数写死在这里：换了参数必须换前缀，否则会拿旧散列去配新参数，永远校验不过。
	if (Number(cost) !== SCRYPT_COST) return false;
	if (Number(blockSize) !== SCRYPT_BLOCK_SIZE) return false;
	if (Number(parallelization) !== SCRYPT_PARALLELIZATION) return false;
	if (!/^[a-f0-9]{32}$/.test(saltHex ?? "")) return false;
	if (!/^[a-f0-9]{64}$/.test(hashHex ?? "")) return false;
	const expected = Buffer.from(hashHex as string, "hex");
	const actual = await derive(password, Buffer.from(saltHex as string, "hex"), expected.length);
	return timingSafeEqual(actual, expected);
}

/** 是否是本模块认识的散列（用于判断口令文件是否被写坏）。 */
export function isPasswordHash(value: string): boolean {
	const parts = value.trim().split("$");
	return parts.length === 6 && parts[0] === HASH_PREFIX && /^[a-f0-9]{64}$/.test(parts[5] ?? "");
}

/** 生成可复制粘贴的口令（18 字节 base64url ≈ 24 字符）。 */
export function generatePassword(): string {
	return randomBytes(18).toString("base64url");
}

async function resolvePassword(
	passwordPath: string,
): Promise<{ hash: string; source: PasswordSource; generated?: string }> {
	const fromEnvHash = process.env.MIUBOT_PASSWORD_HASH?.trim();
	if (fromEnvHash) {
		if (!isPasswordHash(fromEnvHash))
			throw new Error("MIUBOT_PASSWORD_HASH 不是合法的 scrypt 散列（格式 scrypt$16384$8$1$salt$hash）");
		return { hash: fromEnvHash, source: "env-hash" };
	}
	const fromEnvPassword = process.env.MIUBOT_ADMIN_PASSWORD;
	if (fromEnvPassword) {
		if (fromEnvPassword.length < PASSWORD_MIN_LENGTH)
			throw new Error(`MIUBOT_ADMIN_PASSWORD 至少 ${PASSWORD_MIN_LENGTH} 位`);
		return { hash: await hashPassword(fromEnvPassword), source: "env-password" };
	}
	try {
		const stored = (await readFile(passwordPath, "utf8")).trim();
		if (isPasswordHash(stored)) {
			await restrictFileMode(passwordPath);
			return { hash: stored, source: "file" };
		}
	} catch {}
	const generated = generatePassword();
	const hash = await hashPassword(generated);
	await writeFileAtomic(passwordPath, `${hash}\n`);
	return { hash, source: "generated", generated };
}

async function loadSessions(path: string): Promise<StoredSession[]> {
	const stored = await readJsonFile(path);
	if (!Array.isArray(stored)) return [];
	const now = Date.now();
	const records: StoredSession[] = [];
	for (const entry of stored) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Partial<StoredSession>;
		if (typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)) continue;
		if (typeof record.expiresAt !== "number" || record.expiresAt <= now) continue;
		records.push({
			id: record.id,
			createdAt: typeof record.createdAt === "number" ? record.createdAt : now,
			expiresAt: record.expiresAt,
		});
	}
	return records.sort((left, right) => left.createdAt - right.createdAt).slice(-MAX_SESSIONS);
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function derive(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(password, salt, keylen, (error, key) => (error ? reject(error) : resolve(key)));
	});
}
