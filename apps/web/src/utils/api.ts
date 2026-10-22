/**
 * 管理 API 会话建立。
 *
 * 服务端 `/api/*` 需要令牌。工作台不接触令牌本身：向 `/api/auth/session` 换一个 HttpOnly Cookie，
 * 之后同源 `fetch` 自动携带，因此各页面无需改动请求代码。
 */
let session: Promise<void> | undefined;

export function ensureApiSession(): Promise<void> {
	session ??= fetch("/api/auth/session", { method: "POST" })
		.then(() => undefined)
		.catch(() => undefined);
	return session;
}
