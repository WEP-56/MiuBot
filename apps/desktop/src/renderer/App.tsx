import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopUpdateStatus, InstallProgress, ReleaseInfo, ServiceState, Settings } from "../shared/ipc.ts";

/**
 * 首页：启动、更新、管理。
 *
 * 三个区块对应三件互不重叠的事：
 * 1. 运行状态 —— 启停、访问地址、现场日志；
 * 2. 版本 —— 从 release 下载、启用、删除（数据目录不随版本走，删除版本不丢配置）；
 * 3. 桌面端自身 —— 只做「有新版本 → 打开 release 页面」，不自动更新。
 */

const PHASE_LABEL: Record<ServiceState["phase"], string> = {
	stopped: "已停止",
	starting: "启动中",
	running: "运行中",
	stopping: "停止中",
	crashed: "已崩溃",
};

const PHASE_TONE: Record<ServiceState["phase"], string> = {
	stopped: "muted",
	starting: "amber",
	running: "green",
	stopping: "amber",
	crashed: "red",
};

const STAGE_LABEL: Record<InstallProgress["stage"], string> = {
	downloading: "下载中",
	verifying: "校验中",
	extracting: "解压中",
	done: "完成",
};

function formatSize(bytes: number): string {
	if (!bytes) return "—";
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function App() {
	const [service, setService] = useState<ServiceState | null>(null);
	const [settings, setSettings] = useState<Settings | null>(null);
	const [desktop, setDesktop] = useState<DesktopUpdateStatus | null>(null);
	const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
	const [releaseError, setReleaseError] = useState<string | null>(null);
	const [progress, setProgress] = useState<InstallProgress | null>(null);
	const [logs, setLogs] = useState<string[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const logRef = useRef<HTMLDivElement | null>(null);

	// 远端列表与本地已安装版本是两个来源，一起更新；失败时保留已拿到的本地部分。
	// `useCallback` 让 effect 的依赖稳定：只在挂载时订阅一次，不能每次渲染重订阅。
	const loadReleases = useCallback(async (refresh = false) => {
		const list = await window.miubot.listReleases(refresh);
		setReleases(list.releases);
		setReleaseError(list.error);
	}, []);

	/**
	 * 把主进程的设置与运行状态重新拉一遍。
	 *
	 * 安装、启用、删除都会改变「哪些版本可用 / 哪个是当前版本」，而这些判定都在主进程里。
	 * 界面不重取一次，就会出现「磁盘上已经启用，启动按钮却还是灰的」这种自相矛盾的状态。
	 */
	const syncFromMain = useCallback(async () => {
		const state = await window.miubot.getState();
		setService(state.service);
		setSettings(state.settings);
		setDesktop(state.desktop);
	}, []);

	useEffect(() => {
		void syncFromMain();
		void loadReleases();

		const offState = window.miubot.onState((next) => setService(next));
		const offProgress = window.miubot.onProgress((next) => {
			setProgress(next);
			if (next.stage === "done") void loadReleases();
		});
		const offLog = window.miubot.onLog((line) => setLogs((previous) => [...previous.slice(-299), line]));
		return () => {
			offState();
			offProgress();
			offLog();
		};
	}, [loadReleases, syncFromMain]);

	// 日志固定滚到底部：启动失败的现场就在最后几行。每次日志变化都滚，所以只需 logs。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 故意只在 logs 变化时滚动
	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [logs]);

	const installed = useMemo(() => (releases ?? []).filter((item) => item.installed), [releases]);
	const activeVersion = settings?.activeVersion ?? null;
	const running = service?.phase === "running";

	const run = async (key: string, action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
		setBusy(key);
		setNotice(null);
		try {
			const result = await action();
			if (!result.ok) setNotice(result.message);
			// 成功后必须重新同步：启用改了 activeVersion、安装改了版本列表，
			// 两者都会影响按钮的可用性。
			await Promise.all([syncFromMain(), loadReleases()]);
		} finally {
			setBusy(null);
		}
	};

	const refresh = async () => {
		setBusy("refresh");
		try {
			await loadReleases(true);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="app">
			<div className="header">
				<div className="brand">
					<h1>MiuBot Desktop</h1>
					<span className="sub">启动器 · 版本管理</span>
				</div>
				<div className="row">
					<span className={`pill ${PHASE_TONE[service?.phase ?? "stopped"]}`}>
						<span className="dot" />
						{PHASE_LABEL[service?.phase ?? "stopped"]}
					</span>
					{service?.version ? <span className="pill muted">v{service.version}</span> : null}
				</div>
			</div>

			{desktop?.updateAvailable ? (
				<div className="banner warn">
					<span>
						桌面端有新版 v{desktop.latest}（当前 v{desktop.current}）。只做提示，需要手动下载安装。
					</span>
					<div className="actions">
						<button type="button" className="small" onClick={() => void window.miubot.openReleasePage()}>
							打开下载页
						</button>
					</div>
				</div>
			) : null}

			{notice ? <div className="banner error">{notice}</div> : null}

			{/* ── 运行状态 ───────────────────────────────────────── */}
			<div className="card">
				<div className="card-head">
					<span className="card-title">运行状态</span>
					<div className="row">
						{service?.url ? (
							<>
								<button type="button" className="small" onClick={() => void window.miubot.openConsole()}>
									控制台
								</button>
								<button type="button" className="small" onClick={() => void window.miubot.openInBrowser()}>
									浏览器打开
								</button>
								<span className="meta mono">{service.url}</span>
							</>
						) : null}
					</div>
				</div>

				<div className="row">
					{/* 主按钮跟着状态走：停着时「启动」是主操作，跑起来后「控制台」才是用户下一步想点的。 */}
					<button
						type="button"
						className={running ? undefined : "primary"}
						disabled={!activeVersion || running || service?.phase === "starting" || busy !== null}
						onClick={() => void run("start", () => window.miubot.start())}
					>
						{busy === "start" ? "启动中…" : "启动服务"}
					</button>
					<button
						type="button"
						disabled={service?.phase === "stopped" || service?.phase === "crashed" || busy !== null}
						onClick={() => void run("stop", () => window.miubot.stop())}
					>
						{busy === "stop" ? "停止中…" : "停止服务"}
					</button>
					<span className="spacer" />
					<button type="button" className="link" onClick={() => void window.miubot.openPath("data")}>
						数据目录
					</button>
					<button type="button" className="link" onClick={() => void window.miubot.openPath("logs")}>
						日志文件
					</button>
				</div>

				{service?.error ? <div className="banner error">{service.error}</div> : null}

				{logs.length > 0 ? (
					<div className="logs" ref={logRef}>
						{logs.join("\n")}
					</div>
				) : (
					<div className="meta">启动后这里会显示服务端输出；启动失败时也看这里。</div>
				)}
			</div>

			{/* ── 版本 ──────────────────────────────────────────── */}
			<div className="card">
				<div className="card-head">
					<span className="card-title">服务端版本</span>
					<button type="button" className="small" disabled={busy !== null} onClick={() => void refresh()}>
						{busy === "refresh" ? "检查中…" : "检查更新"}
					</button>
				</div>

				{progress && progress.stage !== "done" ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<div className="row">
							<span className="meta">
								v{progress.version} · {STAGE_LABEL[progress.stage]}
								{progress.total ? ` ${Math.round((progress.received / progress.total) * 100)}%` : ""}
							</span>
						</div>
						<div className="progress">
							<div
								style={{
									width: progress.total
										? `${Math.min(100, (progress.received / progress.total) * 100)}%`
										: "30%",
								}}
							/>
						</div>
					</div>
				) : null}

				{releaseError ? (
					<div className="banner warn">
						<span>取不到远端版本列表：{releaseError}。已安装的版本仍可启用或删除。</span>
					</div>
				) : null}

				{releases === null ? (
					<div className="meta">正在获取版本列表…</div>
				) : releases.length === 0 ? (
					<div className="meta">
						还没有可用的 Windows 服务包。发布时会附带 miubot-win-x64-&lt;版本&gt;.zip；断网时也取不到列表。
					</div>
				) : (
					<div className="release-list">
						{releases.map((release) => (
							<div
								className={`release ${release.version === activeVersion ? "active" : ""}`}
								key={release.version}
							>
								<span className="version">v{release.version}</span>
								{release.prerelease ? <span className="pill muted">预发布</span> : null}
								{release.version === activeVersion ? <span className="pill green">当前</span> : null}
								{release.installed && release.version !== activeVersion ? (
									<span className="pill muted">已安装</span>
								) : null}
								<span className="spacer" />
								{/* 只有远端才有时才显示大小与日期；本地独有的版本两个占位符比留空更吵。 */}
								{release.asset ? <span className="meta">{formatSize(release.asset.size)}</span> : null}
								{release.publishedAt ? <span className="meta">{formatDate(release.publishedAt)}</span> : null}
								{release.installed ? (
									<>
										{release.version !== activeVersion ? (
											<button
												type="button"
												className="small"
												disabled={busy !== null || running}
												title={running ? "请先停止服务再切换版本" : undefined}
												onClick={() =>
													void run(`activate:${release.version}`, () =>
														window.miubot.activate(release.version),
													)
												}
											>
												启用
											</button>
										) : null}
										{release.version !== activeVersion ? (
											<button
												type="button"
												className="small danger"
												disabled={busy !== null}
												onClick={() =>
													void run(`remove:${release.version}`, () =>
														window.miubot.remove(release.version),
													)
												}
											>
												删除
											</button>
										) : null}
									</>
								) : release.asset ? (
									<button
										type="button"
										className="small primary"
										disabled={busy !== null}
										onClick={() =>
											void run(`install:${release.version}`, () => window.miubot.install(release.version))
										}
									>
										{busy === `install:${release.version}` ? "安装中…" : "下载"}
									</button>
								) : (
									<span className="meta">无服务包</span>
								)}
							</div>
						))}
					</div>
				)}

				<div className="meta">
					共 {installed.length} 个版本已安装。数据目录跨版本共享，切换或删除版本都不会动配置与会话。
				</div>
			</div>

			{/* ── 桌面端自身 ────────────────────────────────────── */}
			<div className="card">
				<div className="card-head">
					<span className="card-title">桌面端</span>
					<span className="meta">v{desktop?.current ?? "—"}</span>
				</div>
				<div className="row">
					<button
						type="button"
						className="small"
						disabled={busy !== null}
						onClick={() =>
							void (async () => {
								setBusy("desktop-update");
								try {
									setDesktop(await window.miubot.checkDesktopUpdate());
								} finally {
									setBusy(null);
								}
							})()
						}
					>
						检查桌面端更新
					</button>
					<button type="button" className="link" onClick={() => void window.miubot.openPath("versions")}>
						版本目录
					</button>
					{desktop?.error ? <span className="meta">检查失败：{desktop.error}</span> : null}
				</div>
			</div>

			{service?.generatedPassword ? (
				<PasswordDialog password={service.generatedPassword} onClose={() => void window.miubot.dismissPassword()} />
			) : null}
		</div>
	);
}

/**
 * 首次启动生成的随机口令。
 *
 * 服务端只把明文打进进程输出（不落盘、不进 runtime.log），桌面端截下来后放在这里显示一次：
 * 关掉就再也看不到，之后只能用工作台里的「修改口令」重设。
 */
function PasswordDialog({ password, onClose }: { password: string; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement | null>(null);
	useEffect(() => {
		ref.current?.showModal();
	}, []);
	return (
		<dialog ref={ref} onClose={onClose}>
			<h3>管理员口令已生成</h3>
			<p>
				这是首次启动生成的口令，只显示这一次（不写入日志）。登录工作台后请到「设置 → 管理员口令」改成自己记得住的。
			</p>
			<code className="password">{password}</code>
			<div className="actions">
				<button
					type="button"
					onClick={() => {
						void navigator.clipboard.writeText(password);
					}}
				>
					复制
				</button>
				<button type="button" className="primary" onClick={onClose}>
					我已保存
				</button>
			</div>
		</dialog>
	);
}
