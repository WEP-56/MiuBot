/**
 * 把官方 Node 运行时下到 `apps/desktop/.node/`，供开发时以及打包前使用。
 *
 * 为什么需要它：服务进程必须跑在**官方 Node** 上，而不是 Electron 自带的那个
 * （版本随 Electron 变、`process.versions.electron` 还会让部分 SDK 走分叉）。而
 * `node.exe` 一个就 86 MB，不能按版本各存一份，只能随安装包分发一份、所有版本共用。
 *
 * 用法：
 *   node scripts/fetch-node.mjs            # 当前平台/架构，版本见 .node-version
 *   node scripts/fetch-node.mjs --arch=arm64
 *
 * CI 里在 `electron-builder` 之前跑，产物落在 `.node/`，由 `extraResources` 带进安装包。
 */
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, ".node");

// 与服务端 `engines.node` 对齐；改这里时同步 `.github/workflows/release.yml` 的 node-version。
const NODE_VERSION = process.env.MIUBOT_NODE_VERSION?.trim() || "22.23.4";

const archFlag = process.argv.find((arg) => arg.startsWith("--arch="));
const arch = normalizeArch(archFlag ? archFlag.slice("--arch=".length) : process.arch);
const platform = process.platform;

/** Node 的官方压缩包用 `win-x64` / `win-arm64` 这种拼法；npm 的 arch 名是 `x64`/`arm64`。 */
function normalizeArch(value) {
	if (value === "x64" || value === "amd64") return "x64";
	if (value === "arm64") return "arm64";
	throw new Error(`不支持的架构：${value}`);
}

if (platform !== "win32") {
	// 桌面端只发 Windows 包；其他平台只是方便本机调试。
	console.warn(`[fetch-node] 当前平台是 ${platform}，桌面端只发布 Windows 包`);
}

const archiveName = `node-v${NODE_VERSION}-${platform === "win32" ? "win" : platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
const archivePath = join(target, archiveName);

await mkdir(target, { recursive: true });

// 已经有了就跳过：CI 里这一步在缓存命中后应当零成本。
if (await hasNode(target)) {
	console.log(`[fetch-node] 已存在：${target}`);
	process.exit(0);
}

console.log(`[fetch-node] 下载 ${url}`);
const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
const hash = createHash("sha256");
const tee = new ReadableStream({
	async start(controller) {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			controller.enqueue(value);
		}
		controller.close();
	},
});
await pipeline(Readable.fromWeb(tee), createWriteStream(archivePath));

// 官方 SHASUMS256.txt：能校验就校验，取不到就只告警——这一步不是安全边界，
// 真正的安全边界在服务包下载（那里必须过 sha256 才行）。
try {
	const shasums = await (await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).text();
	const expected = shasums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find((parts) => parts[1] === archiveName)?.[0];
	const actual = hash.digest("hex");
	if (expected && expected !== actual) {
		await rm(archivePath, { force: true });
		throw new Error(`Node 压缩包校验失败：期望 ${expected}，实际 ${actual}`);
	}
} catch (error) {
	if (error instanceof Error && error.message.includes("校验失败")) throw error;
	console.warn("[fetch-node] 跳过 SHASUMS 校验：", error instanceof Error ? error.message : error);
}

// 解压到临时目录再挑出需要的东西：官方包里的 npm/npx/corepack 全都不要，
// 桌面端只需要 node 运行时本体（连带 LICENSE）。
// 暂存目录必须放在 target **外面**：下面会整体删掉 target 再重建。
const staging = join(dirname(root), `.node-staging-${process.pid}`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
if (platform === "win32") {
	const { default: extract } = await import("extract-zip");
	await extract(archivePath, { dir: staging });
} else {
	const { spawn } = await import("node:child_process");
	await new Promise((resolve, reject) => {
		const proc = spawn("tar", ["-xzf", archivePath, "-C", staging], { stdio: "inherit" });
		proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
	});
}
const inner = join(staging, `node-v${NODE_VERSION}-${platform === "win32" ? "win" : platform}-${arch}`);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const exe = platform === "win32" ? "node.exe" : "node";
for (const name of [exe, "LICENSE"]) {
	await rename(join(inner, name), join(target, name)).catch(() => undefined);
}
if (platform !== "win32") await chmod(join(target, exe), 0o755);
await rm(staging, { recursive: true, force: true });
await rm(archivePath, { force: true });

if (!(await hasNode(target))) throw new Error(`解压后没找到 ${exe}：${target}`);
console.log(`[fetch-node] 就绪：${join(target, exe)}`);
// 顺带记下版本，打包时用作 productVersion 之外的元信息没有意义，这里只打印。
console.log(`[fetch-node] Node v${NODE_VERSION} ${platform}-${arch}`);

async function hasNode(dir) {
	const exe = join(dir, platform === "win32" ? "node.exe" : "node");
	try {
		return (await stat(exe)).isFile();
	} catch {
		return false;
	}
}
