import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 桌面端的构建：主进程 + preload + 渲染层三份产物，全部落在 `dist/`。
 *
 * - 主进程与 preload 用 esbuild 打成单文件，且都输出 **CommonJS**。
 *   preload 必须是 CJS：`sandbox: true` 时 Electron 只接受 CommonJS preload。
 *   主进程同样走 CJS——`electron` 这个包在 ESM 下没有具名导出（`index.js` 的
 *   `module.exports` 是个路径字符串），`import { BrowserWindow } from "electron"`
 *   会在实例化阶段直接抛 SyntaxError。
 * - `extract-zip` 一起打包进去（纯 JS，无原生模块），运行时不需要 `node_modules`。
 * - 渲染层交给 vite（React + TS）。
 *
 * 服务端代码不在这里构建：它由 release 里的 `miubot-win-x64-*.zip` 提供，桌面端只负责
 * 下载、校验、解压、运行。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

/**
 * 版本号只有一个来源：仓库根 `package.json` 的 `version`，由发布流程随 tag 一起更新。
 * 桌面端跟着主线走——每次推 tag 都会重出安装包，没有独立发布的理由；
 * 分成两个号只会让「桌面端版本」和「服务端版本」悄悄错开。
 *
 * 这里读出后做两件事：
 * 1. 通过 esbuild `define` 注入到主进程，界面与更新检查都用它（见 `src/main/version.ts`）；
 * 2. 写回 `apps/desktop/package.json` 的 `version`，让 electron-builder 生成的文件名
 *    与 `app.getVersion()` 一致。两个号对不上时，安装包名字会骗人。
 */
const rootVersion = JSON.parse(await readFile(join(root, "..", "..", "package.json"), "utf8")).version;
if (typeof rootVersion !== "string" || !/^\d+\.\d+\.\d+/.test(rootVersion))
	throw new Error(`根 package.json 的 version 不可用：${String(rootVersion)}`);

const manifestPath = join(root, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== rootVersion) {
	manifest.version = rootVersion;
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	console.log(`[build] apps/desktop/package.json 版本同步为 ${rootVersion}`);
}

const shared = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "cjs",
	logLevel: "warning",
	// electron 由运行时提供，其余（含 extract-zip）全部内联。
	external: ["electron"],
	sourcemap: "linked",
	define: {
		// 源码按 ESM 写（`import.meta.dirname`），输出是 CJS；在这里做一次等价替换，
		// 免得源码里出现 `__dirname` 这种在 ESM 语境下不存在的标识符。
		"import.meta.dirname": "__dirname",
		__DESKTOP_VERSION__: JSON.stringify(rootVersion),
	},
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
	...shared,
	entryPoints: [join(root, "src/main/index.ts")],
	outfile: join(dist, "main/index.cjs"),
});

await build({
	...shared,
	entryPoints: [join(root, "src/preload/index.ts")],
	outfile: join(dist, "preload/index.cjs"),
});

const { build: viteBuild } = await import("vite");
await viteBuild({ configFile: join(root, "vite.config.ts"), mode: "production" });

console.log("desktop build done →", dist);
