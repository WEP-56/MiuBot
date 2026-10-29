import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/ipc.ts";

/**
 * 桌面端的所有本地路径与设置读写。
 *
 * 布局（`%APPDATA%\MiuBot Desktop\` 之下）：
 *
 * ```
 * versions/<版本>/...   解压后的服务端代码；每个版本一个独立目录，升级 = 换目录
 * data/                 MIUBOT_DATA_DIR，唯一跨版本共享的目录
 * downloads/            下载中的临时文件；成功解压后删除
 * desktop.log           启动器自己的日志
 * settings.json         当前版本、端口等
 * ```
 *
 * 数据目录必须在版本目录之外：否则升级到新版本时，配置、会话和插件数据会随旧目录
 * 一起被删掉。这是这一层唯一不能出错的约束。
 *
 * Node 运行时**不在版本目录里**：`node.exe` 单个就 86 MB，按版本各带一份会让
 * 「留一个旧版本以便回滚」从几十兆变成一百多兆。它随桌面端安装包分发一份，
 * 所有版本共用（`resources/node/node.exe`），版本目录里只有服务端自己的代码与依赖。
 */

const DEFAULT_PORT = 8787;

export type Paths = {
	root: string;
	versions: string;
	data: string;
	downloads: string;
	settingsFile: string;
	logFile: string;
	/** 共用的 Node 运行时。 */
	nodeExe: string;
	versionDir(version: string): string;
	/** 版本内的服务端入口，用于判断「装好了没有」。 */
	entryFile(version: string): string;
};

export function createPaths(): Paths {
	// 不用 `app.getPath("userData")`：它按 package.json 的 `name` 拼目录，而这里叫
	// `@miubot/desktop`，会落到 `%APPDATA%\@miubot\desktop`。用户要翻这个目录（数据、版本、日志），
	// 名字得能认出来，所以显式拼一个固定目录。
	const root = join(app.getPath("appData"), "MiuBot Desktop");
	const versions = join(root, "versions");
	return {
		root,
		versions,
		data: join(root, "data"),
		downloads: join(root, "downloads"),
		settingsFile: join(root, "settings.json"),
		logFile: join(root, "desktop.log"),
		nodeExe: resolveNodeExe(),
		versionDir: (version) => join(versions, version),
		entryFile: (version) => join(versions, version, "apps", "server", "src", "index.ts"),
	};
}

/**
 * 共用的 `node.exe` 位置。
 *
 * 打包后由 electron-builder 的 `extraResources` 放到 `resources/node/node.exe`；
 * 开发时用 `scripts/fetch-node.mjs` 下到 `apps/desktop/.node/`。两者都没有就退回
 * PATH 上的 `node`——开发机一定有，用户机器则一定走前两条，所以这条退路不影响发布。
 *
 * 为什么不用 Electron 自带的 Node：它的版本随 Electron 升级而变，且不是原版 Node
 * （`process.versions.electron` 会让部分 SDK 走分叉分支）。服务进程用官方 Node，
 * 与界面进程彻底解耦。
 */
function resolveNodeExe(): string {
	if (app.isPackaged) return join(process.resourcesPath, "node", process.platform === "win32" ? "node.exe" : "node");
	const local = join(app.getAppPath(), ".node", process.platform === "win32" ? "node.exe" : "node");
	if (existsSync(local)) return local;
	return "node";
}

export async function ensureDirs(paths: Paths): Promise<void> {
	for (const dir of [paths.versions, paths.data, paths.downloads]) await mkdir(dir, { recursive: true });
}

const DEFAULT_SETTINGS: Settings = { activeVersion: null, port: DEFAULT_PORT, keepRunningOnClose: false };

export async function readSettings(paths: Paths): Promise<Settings> {
	try {
		const raw = JSON.parse(await readFile(paths.settingsFile, "utf8")) as Partial<Settings>;
		return {
			activeVersion: typeof raw.activeVersion === "string" ? raw.activeVersion : null,
			port: normalizePort(raw.port),
			keepRunningOnClose: raw.keepRunningOnClose === true,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function writeSettings(paths: Paths, settings: Settings): Promise<void> {
	await mkdir(join(paths.settingsFile, ".."), { recursive: true });
	// 原子写：断电时宁可留旧文件，也不要留半个 JSON 让下次启动读不出配置。
	const temp = `${paths.settingsFile}.tmp`;
	await writeFile(temp, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
	await rename(temp, paths.settingsFile);
}

/** 端口落在 1024–65535 之外就回落到默认值：小于 1024 在 Windows 上多数也要管理员。 */
function normalizePort(value: unknown): number {
	const port = typeof value === "number" ? Math.floor(value) : Number(value);
	if (!Number.isFinite(port) || port < 1024 || port > 65535) return DEFAULT_PORT;
	return port;
}
