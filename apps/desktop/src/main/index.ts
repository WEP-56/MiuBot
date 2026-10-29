import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions, isNewerVersion, normalize } from "@miubot/shared/utils/version";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import extract from "extract-zip";
import type { DesktopUpdateStatus, InstallProgress, ReleaseInfo, ReleaseList, Settings } from "../shared/ipc.ts";
import { IPC } from "../shared/ipc.ts";
import { createPaths, ensureDirs, type Paths, readSettings, writeSettings } from "./paths.ts";
import {
	createReleaseFetcher,
	downloadVerified,
	isVersionInstalled,
	type Release,
	type ReleaseFetcher,
} from "./releases.ts";
import { relinkWorkspaces } from "./relink.ts";
import { createService, type Service } from "./service.ts";
import { DESKTOP_VERSION } from "./version.ts";

/**
 * 主进程：窗口、IPC、以及服务进程的生命周期。
 *
 * 两个窗口：
 * - 首页（`renderer`）：本地打包的 React 应用，`loadFile` 加载，只通过 preload 与主进程通信，
 *   不访问 HTTP。所以它碰不到服务端那套 Origin / Cookie 规则。
 * - 控制台：直接导航到 `http://127.0.0.1:<port>`，就是完整工作台。
 *   **不能嵌 iframe**：服务端下发 `frame-ancestors 'none'` + `X-Frame-Options: DENY`。
 */

const RELEASE_PAGE = "https://github.com/WEP-56/MiuBot/releases/latest";
const DESKTOP_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

const paths: Paths = createPaths();
let settings: Settings;
let service: Service;
let releases: ReleaseFetcher;
let homeWindow: BrowserWindow | undefined;
let consoleWindow: BrowserWindow | undefined;
let desktopUpdate: DesktopUpdateStatus = {
	current: DESKTOP_VERSION,
	latest: null,
	updateAvailable: false,
	url: null,
	error: null,
};
let desktopUpdateCheckedAt = 0;

const preloadPath = join(import.meta.dirname, "..", "preload", "index.cjs");

function createHomeWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 900,
		height: 640,
		minWidth: 760,
		minHeight: 560,
		show: false,
		backgroundColor: "#000000",
		title: "MiuBot Desktop",
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		homeWindow = undefined;
	});
	void window.loadFile(join(import.meta.dirname, "..", "renderer", "index.html"));
	return window;
}

/**
 * 控制台窗口。
 *
 * 它加载的是服务端托管的工作台——内容面包含用户装的插件所产生的界面，
 * 因此权限一律关掉，并且不允许开新窗口（外链交给系统浏览器）。
 */
function openConsole(url: string): void {
	if (consoleWindow && !consoleWindow.isDestroyed()) {
		void consoleWindow.loadURL(url);
		consoleWindow.focus();
		return;
	}
	consoleWindow = new BrowserWindow({
		width: 1280,
		height: 860,
		backgroundColor: "#000000",
		title: "MiuBot 控制台",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			partition: "persist:miubot-console",
		},
	});
	consoleWindow.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});
	consoleWindow.on("closed", () => {
		consoleWindow = undefined;
	});
	void consoleWindow.loadURL(url);
}

function send(channel: string, payload: unknown): void {
	homeWindow?.webContents.send(channel, payload);
}

async function listInstalled(): Promise<Set<string>> {
	const installed = new Set<string>();
	try {
		for (const name of await readdir(paths.versions)) {
			if (await isVersionInstalled(paths.entryFile(name))) installed.add(name);
		}
	} catch {}
	return installed;
}

/**
 * 合并两个来源的版本列表：远端 release + 本地已安装的版本目录。
 *
 * 只列远端是不够的：断网、GitHub 限流、或某个旧版本已从 release 页面撤下时，
 * 用户本地装着的那份就成了「看不见也删不掉」的孤儿，只能去翻文件系统。
 * 因此本地装了什么就一定要出现在列表里——远端信息缺失时 `asset` 为 null，
 * 界面据此只给「启用 / 删除」，不给「下载」。
 */
async function toReleaseInfos(): Promise<ReleaseList> {
	const list = await releases.list();
	const installed = await listInstalled();
	const infos: ReleaseInfo[] = list.releases.map((release) => ({
		version: release.version,
		tag: release.tag,
		publishedAt: release.publishedAt,
		prerelease: release.prerelease,
		installed: installed.has(release.version),
		asset: release.asset && {
			name: release.asset.name,
			url: release.asset.url,
			size: release.asset.size,
			sha256: release.asset.sha256,
		},
	}));
	const known = new Set(infos.map((info) => info.version));
	for (const version of installed) {
		if (known.has(version)) continue;
		infos.push({ version, tag: `v${version}`, publishedAt: null, prerelease: false, installed: true, asset: null });
	}
	// 新的在前；本地独有版本没有发布时间，排在最后。
	infos.sort((left, right) => {
		if (left.publishedAt && right.publishedAt) return right.publishedAt.localeCompare(left.publishedAt);
		if (left.publishedAt) return -1;
		if (right.publishedAt) return 1;
		return compareVersions(right.version, left.version);
	});
	return { releases: infos, error: list.error };
}

async function findRelease(version: string): Promise<Release | undefined> {
	const list = await releases.list();
	return list.releases.find((item) => item.version === version);
}

/** 把解压好的目录「扶正」：发布包顶层是 `miubot-win-x64-<tag>/`，剥掉这一层。 */
async function normalizeExtractedDir(dir: string): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	const dirs = entries.filter((entry) => entry.isDirectory());
	if (entries.some((entry) => entry.isFile() && entry.name === "apps")) return;
	const only = dirs.length === 1 ? dirs[0] : undefined;
	if (!only) return;
	const nested = join(dir, only.name);
	for (const entry of await readdir(nested)) await rename(join(nested, entry), join(dir, entry));
	await rm(nested, { recursive: true, force: true });
}

async function installVersion(version: string): Promise<{ ok: true } | { ok: false; message: string }> {
	const release = await findRelease(version);
	if (!release?.asset) return { ok: false, message: "该版本没有可用的 Windows 服务包" };
	const target = paths.versionDir(version);
	if (await isVersionInstalled(paths.entryFile(version))) return { ok: true };

	const archive = join(paths.downloads, release.asset.name);
	const progress = (stage: InstallProgress["stage"], received = 0, total = 0): void => {
		const payload: InstallProgress = { version, stage, received, total };
		send(IPC.eventProgress, payload);
	};
	progress("downloading", 0, release.asset.size);
	const downloaded = await downloadVerified(release.asset, archive, {
		onProgress: (received, total) => progress("downloading", received, total),
	});
	if (!downloaded.ok) return { ok: false, message: downloaded.message };

	progress("verifying");
	// 解压前先清空目标目录：半成品版本会让「已安装」判定与回滚同时出错。
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	progress("extracting");
	try {
		await extract(archive, { dir: target });
		await normalizeExtractedDir(target);
		await relinkWorkspaces(target);
	} catch (error) {
		await rm(target, { recursive: true, force: true });
		return { ok: false, message: `解压失败：${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await rm(archive, { force: true });
	}

	if (await isVersionInstalled(paths.entryFile(version))) {
		progress("done");
		return { ok: true };
	}
	await rm(target, { recursive: true, force: true });
	return { ok: false, message: "包内容不完整：缺少 apps/server/src/index.ts 或 node_modules" };
}

async function activateVersion(version: string): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!(await listInstalled()).has(version)) return { ok: false, message: "该版本尚未安装" };
	if (service.state().phase !== "stopped") await service.stop();
	settings = { ...settings, activeVersion: version };
	await writeSettings(paths, settings);
	// 停止后 `service.version` 里还留着上次运行的版本号；不清掉，界面头部会显示
	// 一个与「当前启用版本」不符的旧值。
	service.reset();
	return { ok: true };
}

async function removeVersion(version: string): Promise<{ ok: true } | { ok: false; message: string }> {
	if (settings.activeVersion === version) return { ok: false, message: "当前启用的版本不能删除，请先切换到其他版本" };
	// 数据目录不在版本目录内，删版本不会碰配置与会话；这一点是刻意的。
	await rm(paths.versionDir(version), { recursive: true, force: true });
	return { ok: true };
}

/**
 * 检查桌面端自身的更新。
 *
 * 只提示 + 引导跳转 release 页面，不自动下载安装：
 * 自动更新等于给自己开一条「拉取远端可执行文件并运行」的通道，与项目对服务端
 * 自动更新的态度保持一致。
 */
async function checkDesktopUpdate(force = false): Promise<DesktopUpdateStatus> {
	if (!force && Date.now() - desktopUpdateCheckedAt < DESKTOP_UPDATE_TTL_MS && !desktopUpdate.error)
		return desktopUpdate;
	try {
		const response = await fetch("https://api.github.com/repos/WEP-56/MiuBot/releases/latest", {
			headers: { accept: "application/vnd.github+json", "user-agent": `miubot-desktop/${DESKTOP_VERSION}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
		const payload = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
		const latest = typeof payload.tag_name === "string" ? normalize(payload.tag_name) : null;
		desktopUpdate = {
			current: DESKTOP_VERSION,
			latest,
			updateAvailable: latest ? isNewerVersion(latest, DESKTOP_VERSION) : false,
			url: typeof payload.html_url === "string" ? payload.html_url : null,
			error: null,
		};
	} catch (error) {
		desktopUpdate = { ...desktopUpdate, error: error instanceof Error ? error.message : String(error) };
	}
	desktopUpdateCheckedAt = Date.now();
	return desktopUpdate;
}

function registerIpc(): void {
	ipcMain.handle(IPC.stateGet, async () => {
		await checkDesktopUpdate().catch(() => undefined);
		return { service: service.state(), settings, desktop: desktopUpdate };
	});
	ipcMain.handle(IPC.releasesList, async (_event, refresh: unknown) => {
		if (refresh === true) await releases.list(true);
		return toReleaseInfos();
	});
	ipcMain.handle(IPC.releasesInstall, async (_event, version: unknown) => installVersion(String(version)));
	ipcMain.handle(IPC.releasesActivate, async (_event, version: unknown) => activateVersion(String(version)));
	ipcMain.handle(IPC.releasesRemove, async (_event, version: unknown) => removeVersion(String(version)));
	ipcMain.handle(IPC.serviceStart, async () => {
		const active = settings.activeVersion;
		if (!active) return { ok: false, message: "还没有可用的版本，请先下载一个版本" };
		const result = await service.start();
		// 启动成功就直接把用户送到工作台；首页留着做管理。
		if (result.ok && service.state().url) openConsole(service.state().url as string);
		return result;
	});
	ipcMain.handle(IPC.serviceStop, async () => {
		await service.stop();
		return { ok: true };
	});
	ipcMain.handle(IPC.serviceOpenConsole, async () => {
		const url = service.state().url;
		if (url) openConsole(url);
	});
	ipcMain.handle(IPC.serviceOpenBrowser, async () => {
		const url = service.state().url;
		if (url) await shell.openExternal(url);
	});
	ipcMain.handle(IPC.serviceDismissPassword, async () => {
		service.dismissPassword();
	});
	ipcMain.handle(IPC.settingsUpdate, async (_event, patch: unknown) => {
		if (patch && typeof patch === "object") {
			const next = patch as Partial<Settings>;
			settings = {
				...settings,
				port: typeof next.port === "number" ? next.port : settings.port,
				keepRunningOnClose:
					typeof next.keepRunningOnClose === "boolean" ? next.keepRunningOnClose : settings.keepRunningOnClose,
			};
			await writeSettings(paths, settings);
		}
		return settings;
	});
	ipcMain.handle(IPC.desktopCheckUpdate, async () => checkDesktopUpdate(true));
	ipcMain.handle(IPC.desktopOpenReleasePage, async () => {
		await shell.openExternal(desktopUpdate.url ?? RELEASE_PAGE);
	});
	ipcMain.handle(IPC.shellOpenPath, async (_event, what: unknown) => {
		const target =
			what === "data"
				? paths.data
				: what === "logs"
					? paths.logFile
					: what === "versions"
						? paths.versions
						: undefined;
		if (!target) return;
		if (what === "logs") {
			// 日志是文件：用「在文件夹中显示」，直接 openPath 会尝试用默认程序打开。
			await shell.showItemInFolder(target);
			return;
		}
		await shell.openPath(target);
	});
}

async function bootstrap(): Promise<void> {
	await ensureDirs(paths);
	settings = await readSettings(paths);
	releases = createReleaseFetcher();
	service = createService({
		nodeExe: paths.nodeExe,
		dataDir: paths.data,
		logFile: paths.logFile,
		port: settings.port,
		// 每次启动时读当前启用的版本：切换版本后不需要重建 service 实例。
		target: () => {
			const version = settings.activeVersion ?? "";
			return { version, versionDir: paths.versionDir(version) };
		},
		onState: (state) => send(IPC.eventState, state),
		onLog: (line) => send(IPC.eventLog, line),
	});
	registerIpc();
	homeWindow = createHomeWindow();
	void checkDesktopUpdate().catch(() => undefined);
}

app.on("window-all-closed", () => {
	// 关掉窗口就退出：桌面端的定位是「启动器」，不是常驻后台的服务管理器。
	// 服务进程会由 `before-quit` 先优雅停掉。
	void app.quit();
});

app.on("before-quit", (event) => {
	if (!service || service.state().phase === "stopped") return;
	event.preventDefault();
	void service.dispose().finally(() => app.exit(0));
});

app.whenReady()
	.then(bootstrap)
	.catch((error: unknown) => {
		void dialog.showErrorBox("MiuBot Desktop 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
	});
