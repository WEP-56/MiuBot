/**
 * 管理面认证。
 *
 * 服务端不再「访问即发令牌」：工作台先用口令登录换一个 HttpOnly 会话 Cookie，
 * 之后同源 `fetch` 自动携带，因此各页面无需改动请求代码。
 */

export type AuthState = { authenticated: boolean; sessions: number };

export async function fetchAuthState(): Promise<AuthState> {
	try {
		const response = await fetch("/api/auth/me", { headers: { accept: "application/json" } });
		if (!response.ok) return { authenticated: false, sessions: 0 };
		const data = (await response.json()) as Partial<AuthState>;
		return {
			authenticated: data.authenticated === true,
			sessions: typeof data.sessions === "number" ? data.sessions : 0,
		};
	} catch {
		return { authenticated: false, sessions: 0 };
	}
}

export type LoginOutcome = { ok: true } | { ok: false; message: string; retryAfterSeconds?: number };

export async function login(password: string): Promise<LoginOutcome> {
	try {
		const response = await fetch("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password }),
		});
		const data = (await response.json().catch(() => ({}))) as {
			message?: string;
			retryAfterSeconds?: number;
		};
		if (response.ok) return { ok: true };
		return {
			ok: false,
			message: data.message ?? `登录失败（HTTP ${response.status}）`,
			...(typeof data.retryAfterSeconds === "number" ? { retryAfterSeconds: data.retryAfterSeconds } : {}),
		};
	} catch (error) {
		return {
			ok: false,
			message: `无法连接 Miubot Server：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** 登出：服务端撤销会话，Cookie 由响应清掉。 */
export async function logout(): Promise<void> {
	await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
}

export type PasswordOutcome = { ok: true } | { ok: false; message: string };

export async function changePassword(current: string, next: string): Promise<PasswordOutcome> {
	try {
		const response = await fetch("/api/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ current, next }),
		});
		if (response.ok) return { ok: true };
		const data = (await response.json().catch(() => ({}))) as { message?: string };
		return { ok: false, message: data.message ?? "修改失败" };
	} catch (error) {
		return {
			ok: false,
			message: `无法连接 Miubot Server：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
