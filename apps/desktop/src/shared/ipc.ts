/**
 * 主进程与渲染进程共用的契约。
 *
 * 渲染进程只能看到 preload 暴露的这一组方法，所以这里的类型就是桌面端的全部能力边界。
 * 不要把 Electron 内部对象（`BrowserWindow`、`IpcMainEvent`）写进这里：它们会被
 * `tsc` 带进渲染进程的类型空间，等于把 Node 侧类型泄漏给界面代码。
 */

/** 一个可安装的服务端版本。**版本号已去掉 `v` 前缀**（`0.5.0`）。 */
export type ReleaseInfo = {
	version: string;
	tag: string;
	publishedAt: string | null;
	prerelease: boolean;
	/** 服务包的下载地址与预期摘要；`sha256` 来自 release asset 的 `digest` 字段。 */
	asset: {
		name: string;
		url: string;
		size: number;
		sha256: string;
	} | null;
	/** 本机是否已安装（`versions/<version>` 存在且完整）。 */
	installed: boolean;
};

export type ServicePhase = "stopped" | "starting" | "running" | "stopping" | "crashed";

export type ServiceState = {
	phase: ServicePhase;
	version: string | null;
	port: number | null;
	/** 已就绪的访问地址；`phase === "running"` 时才有值。 */
	url: string | null;
	/** 最近一次失败原因（启动超时、进程异常退出等）。 */
	error: string | null;
	/** 首次启动时服务端生成的管理员口令，只保留到界面确认过为止。 */
	generatedPassword: string | null;
	startedAt: string | null;
};

export type Settings = {
	/** 当前启用的版本号；未设置表示还没装过。 */
	activeVersion: string | null;
	/** 首选端口；被占用时会顺延。 */
	port: number;
	/** 关闭窗口时是退出还是留在托盘（v1 只有退出，字段留给后续）。 */
	keepRunningOnClose: boolean;
};

export type DesktopUpdateStatus = {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	url: string | null;
	error: string | null;
};

export type InstallProgress = {
	version: string;
	/** `downloading` → `verifying` → `extracting` → `done`。 */
	stage: "downloading" | "verifying" | "extracting" | "done";
	received: number;
	total: number;
};

/**
 * 版本列表。
 *
 * `error` 与 `releases` 同时返回而不是二选一：远端拉取失败时本地已安装的版本仍然要能管理，
 * 界面把错误显示成一条提示，而不是把整个列表换成一个空状态。
 */
export type ReleaseList = {
	releases: ReleaseInfo[];
	/** 远端拉取失败的原因；成功时为 null。 */
	error: string | null;
};

/** preload 通过 `contextBridge` 暴露成 `window.miubot`。 */
export type DesktopApi = {
	getState(): Promise<{ service: ServiceState; settings: Settings; desktop: DesktopUpdateStatus }>;
	listReleases(refresh?: boolean): Promise<ReleaseList>;
	install(version: string): Promise<{ ok: true } | { ok: false; message: string }>;
	activate(version: string): Promise<{ ok: true } | { ok: false; message: string }>;
	remove(version: string): Promise<{ ok: true } | { ok: false; message: string }>;
	start(): Promise<{ ok: true } | { ok: false; message: string }>;
	stop(): Promise<{ ok: true } | { ok: false; message: string }>;
	openConsole(): Promise<void>;
	openInBrowser(): Promise<void>;
	dismissPassword(): Promise<void>;
	updateSettings(patch: Partial<Settings>): Promise<Settings>;
	checkDesktopUpdate(): Promise<DesktopUpdateStatus>;
	openReleasePage(): Promise<void>;
	openPath(what: "data" | "logs" | "versions"): Promise<void>;
	/** 订阅主进程推送；返回取消订阅函数。 */
	onState(listener: (state: ServiceState) => void): () => void;
	onProgress(listener: (progress: InstallProgress) => void): () => void;
	onLog(listener: (line: string) => void): () => void;
};

export const IPC = {
	stateGet: "state:get",
	releasesList: "releases:list",
	releasesInstall: "releases:install",
	releasesActivate: "releases:activate",
	releasesRemove: "releases:remove",
	serviceStart: "service:start",
	serviceStop: "service:stop",
	serviceOpenConsole: "service:open-console",
	serviceOpenBrowser: "service:open-browser",
	serviceDismissPassword: "service:dismiss-password",
	settingsUpdate: "settings:update",
	desktopCheckUpdate: "desktop:check-update",
	desktopOpenReleasePage: "desktop:open-release-page",
	shellOpenPath: "shell:open-path",
	eventState: "event:state",
	eventProgress: "event:progress",
	eventLog: "event:log",
} as const;
