import { useEffect, useState } from "react";
import App from "./App";
import { Icon } from "./components/Icon";
import { ThemeProvider } from "./theme";
import { fetchAuthState, login } from "./utils/api";

/**
 * 登录闸门。
 *
 * 挂载前先问一次 `/api/auth/me`：已登录才渲染工作台，否则停在口令页。
 * 会话是 24h 滑动的，长时间闲置会失效——每 60 秒探一次，失效就退回登录页，
 * 避免各页面继续拿 401 报一堆错。
 */
type Phase = "checking" | "login" | "ready";

export function AuthGate() {
	const [phase, setPhase] = useState<Phase>("checking");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void fetchAuthState().then((state) => {
			if (!cancelled) setPhase(state.authenticated ? "ready" : "login");
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (phase !== "ready") return;
		const timer = window.setInterval(() => {
			void fetchAuthState().then((state) => {
				if (!state.authenticated) setPhase("login");
			});
		}, 60_000);
		return () => window.clearInterval(timer);
	}, [phase]);

	const submit = async () => {
		if (busy || !password) return;
		setBusy(true);
		setError("");
		const outcome = await login(password);
		setBusy(false);
		if (outcome.ok) {
			setPassword("");
			setPhase("ready");
			return;
		}
		setError(
			outcome.retryAfterSeconds
				? `${outcome.message}（约 ${Math.ceil(outcome.retryAfterSeconds / 60)} 分钟后可重试）`
				: outcome.message,
		);
	};

	return (
		<ThemeProvider>
			{phase === "ready" ? (
				<App />
			) : (
				<div
					className="flex h-screen w-screen items-center justify-center p-6"
					style={{ background: "var(--bg-app)", color: "var(--text-main)" }}
				>
					{phase === "checking" ? (
						<p className="text-sm" style={{ color: "var(--text-muted)" }}>
							正在连接 Miubot Server…
						</p>
					) : (
						<form
							className="sketch-card w-full max-w-[380px] space-y-5 p-7"
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
						>
							<div className="flex items-center gap-3">
								<Icon.BotFace size={26} />
								<div className="leading-tight">
									<h1 className="text-lg font-bold tracking-tight">Miubot</h1>
									<p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
										Agent Workspace · 管理员登录
									</p>
								</div>
							</div>
							<label className="block space-y-1.5">
								<span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
									管理员口令
								</span>
								<input
									// biome-ignore lint/a11y/noAutofocus: 登录页只有一个输入框，聚焦它就是默认动作
									autoFocus
									className="sketch-input w-full"
									type="password"
									autoComplete="current-password"
									placeholder="请输入口令"
									value={password}
									disabled={busy}
									onChange={(event) => setPassword(event.target.value)}
								/>
							</label>
							{error && (
								<p className="text-[13px] text-red-400" role="alert">
									{error}
								</p>
							)}
							<button type="submit" className="btn-primary-white w-full justify-center" disabled={busy || !password}>
								{busy ? "验证中…" : "登录"}
							</button>
							<p className="text-[11.5px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
								口令散列保存在数据目录的 <span className="font-mono">admin-password</span>
								。忘记口令时删除该文件并重启服务，新口令会打印在启动日志里。
							</p>
						</form>
					)}
				</div>
			)}
		</ThemeProvider>
	);
}
