import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ServiceState } from "../shared/ipc.ts";

/**
 * 服务进程的启停与健康探测。
 *
 * 为什么带一个固定的 `node.exe`：Electron 自带的 Node 版本随 Electron 升级而变，
 * 且不是原版 Node（`process.versions.electron` 会让部分 SDK 走分叉）。用发布包里
 * 自带的官方 Node，服务进程与界面进程完全解耦：崩了只影响服务，重启干净。
 *
 * 停止为什么不发信号：Windows 没有能把 SIGTERM 投递给子进程的机制，
 * `child.kill()` 等于 TerminateProcess，服务端注册的优雅退出不会执行。
 * 因此走 stdin 控制通道（服务端侧见 `apps/server/src/index.ts` 的 `MIUBOT_CONTROL_STDIO`），
 * 超时未退再强杀整个进程树。
 */

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 500;
const GRACEFUL_STOP_MS = 10_000;

export type ServiceTarget = {
	version: string;
	/** 该版本解压后的目录；`apps/server`、`node_modules` 都在里面。 */
	versionDir: string;
};

export type ServiceOptions = {
	/** 所有版本共用的 Node 运行时（见 `paths.ts` 的说明）。 */
	nodeExe: string;
	dataDir: string;
	logFile: string;
	/** 期望端口；被占用时顺延。 */
	port: number;
	/** 当前要运行哪个版本。切换版本后即时生效，不需要重建 service。 */
	target(): ServiceTarget;
	onState: (state: ServiceState) => void;
	onLog: (line: string) => void;
};

export type Service = {
	state(): ServiceState;
	start(): Promise<{ ok: true } | { ok: false; message: string }>;
	stop(): Promise<void>;
	dismissPassword(): void;
	dispose(): Promise<void>;
};

export function createService(options: ServiceOptions): Service {
	let child: ChildProcess | undefined;
	let current: ServiceState = {
		phase: "stopped",
		version: null,
		port: null,
		url: null,
		error: null,
		generatedPassword: null,
		startedAt: null,
	};
	let logStream: WriteStream | undefined;
	let stopping = false;

	function setState(patch: Partial<ServiceState>): void {
		current = { ...current, ...patch };
		options.onState(current);
	}

	function append(line: string): void {
		const text = line.trimEnd();
		if (!text) return;
		options.onLog(text);
		// 首次启动的口令只打印在进程输出里（服务端刻意不写 runtime.log），
		// 桌面端在这里截下来交给界面显示一次。
		const match = text.match(/已生成管理员口令[:：]\s*(\S+)/);
		if (match?.[1]) {
			setState({ generatedPassword: match[1] });
			// 绝不能把明文口令写进 desktop.log：那会让「不落盘」这个设计彻底失效，
			// 任何能读日志的人（截图、上报、备份）都能拿到管理员口令。
			logStream?.write(`${new Date().toISOString()} [已生成管理员口令：已隐去，见界面弹窗]\n`);
			return;
		}
		logStream?.write(`${new Date().toISOString()} ${text}\n`);
	}

	async function start(): Promise<{ ok: true } | { ok: false; message: string }> {
		if (current.phase === "running" || current.phase === "starting") return { ok: true };
		if (!options.target().version) return { ok: false, message: "还没有选择版本" };
		const target = options.target();
		const port = await findFreePort(options.port);
		setState({
			phase: "starting",
			version: target.version,
			port,
			url: null,
			error: null,
			generatedPassword: null,
			startedAt: new Date().toISOString(),
		});

		await mkdir(options.dataDir, { recursive: true });
		logStream ??= createWriteStream(options.logFile, { flags: "a" });

		let proc: ChildProcess;
		try {
			proc = spawn(options.nodeExe, ["--conditions=source", "--enable-source-maps", "src/index.ts"], {
				cwd: join(target.versionDir, "apps", "server"),
				// 不给服务进程一个可见的控制台窗口；日志通过管道回收。
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					MIUBOT_HOST: "127.0.0.1",
					MIUBOT_PORT: String(port),
					MIUBOT_DATA_DIR: options.dataDir,
					MIUBOT_VERSION: target.version,
					// 让服务端挂上 stdin 停止通道（Windows 上唯一的优雅退出路径）。
					MIUBOT_CONTROL_STDIO: "1",
					NODE_ENV: "production",
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setState({ phase: "crashed", error: `无法启动服务进程：${message}` });
			return { ok: false, message };
		}

		child = proc;
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => append(chunk));
		proc.stderr?.on("data", (chunk: string) => append(chunk));
		proc.on("error", (error) => {
			setState({ phase: "crashed", error: `服务进程错误：${error.message}` });
		});
		proc.on("exit", (code, signal) => {
			child = undefined;
			if (stopping) {
				setState({ phase: "stopped", url: null, port: null });
				return;
			}
			setState({
				phase: "crashed",
				url: null,
				error: `服务进程已退出（code=${code ?? "null"}${signal ? `，signal=${signal}` : ""}）`,
			});
		});

		const url = `http://127.0.0.1:${port}`;
		if (await waitForHealth(url, proc)) {
			setState({ phase: "running", url });
			return { ok: true };
		}
		const detail = current.error ?? "启动超时";
		// 超时的进程还挂着：先按优雅路径收一遍，避免留下半个服务端占端口。
		await stop();
		setState({ phase: "crashed", error: `${detail}（端口 ${port}）` });
		return { ok: false, message: detail };
	}

	async function stop(): Promise<void> {
		const proc = child;
		if (!proc) {
			setState({ phase: "stopped", url: null, port: null });
			return;
		}
		stopping = true;
		setState({ phase: "stopping", url: null });
		const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
		// 1) 请求优雅退出：服务端会断 Gateway、关端口、落盘会话。
		try {
			proc.stdin?.write("shutdown\n");
			proc.stdin?.end();
		} catch {}
		const timedOut = await Promise.race([
			exited.then(() => false),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(true), GRACEFUL_STOP_MS)),
		]);
		// 2) 还没退就强杀整棵树：插件派生的子进程不跟着父进程走。
		if (timedOut && proc.pid !== undefined) {
			append("[desktop] 服务进程未在 10 秒内退出，强制结束");
			killTree(proc.pid);
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
		}
		child = undefined;
		stopping = false;
		setState({ phase: "stopped", url: null, port: null });
	}

	async function dispose(): Promise<void> {
		await stop();
		logStream?.end();
		logStream = undefined;
	}

	return {
		state: () => current,
		start,
		stop,
		dismissPassword: () => setState({ generatedPassword: null }),
		dispose,
	};
}

/**
 * 找一个可用端口：从期望端口向上试。
 *
 * 绑一次 127.0.0.1 只是探测，随即释放；服务进程启动时理论上仍可能被别的进程抢到，
 * 但那种窗口极短，真撞上了健康检查会失败并把端口写进错误信息里，用户能看懂。
 */
async function findFreePort(preferred: number): Promise<number> {
	for (let offset = 0; offset < 50; offset += 1) {
		const port = preferred + offset;
		if (port > 65535) break;
		if (await isPortFree(port)) return port;
	}
	return preferred;
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		// 只探回环：服务端默认只听 127.0.0.1，绑 0.0.0.0 会把「别人占用了回环」误报成空闲。
		server.listen(port, "127.0.0.1");
	});
}

/**
 * 轮询 `/api/health` 直到就绪。
 *
 * 该端点免认证，且请求不带 `Origin` 头，因此能穿过 `api-security` 的 Host / Origin 校验。
 * 进程提前退出时立刻失败，不必傻等到超时。
 */
async function waitForHealth(baseUrl: string, proc: ChildProcess): Promise<boolean> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.signalCode !== null) return false;
		try {
			const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return true;
		} catch {
			// 端口还没 listen：正常，继续等。
		}
		await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
	}
	return false;
}

/** Windows 上必须 `taskkill /T` 才能连子进程一起结束；其他平台退化到 kill 进程组。 */
function killTree(pid: number): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}
