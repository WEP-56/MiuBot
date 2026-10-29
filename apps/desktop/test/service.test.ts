import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceState } from "../src/shared/ipc.ts";
import { createService } from "../src/main/service.ts";

/**
 * 服务进程的启动与停止。
 *
 * 用真实子进程跑一个小型假服务端，而不是把 `spawn` 打桩：这一层要验证的正是
 * 「Windows 上能不能真的停掉它」——打桩会把最关键的平台差异全部抹掉。
 * 假服务端复刻了真实服务端的三件相关行为：按 MIUBOT_PORT 监听、首启打印口令、
 * 收到 stdin 的 `shutdown` 后自己退出。
 */

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeVersionDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "miubot-service-test-"));
	dirs.push(root);
	const serverDir = join(root, "apps", "server", "src");
	await mkdir(serverDir, { recursive: true });	// 假服务端：只实现桌面端依赖的三个行为。
	await writeFile(
		join(serverDir, "index.ts"),
		`import { createServer } from "node:http";

const port = Number(process.env.MIUBOT_PORT ?? 0);
const server = createServer((request, response) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ ok: true }));
});
server.listen(port, "127.0.0.1", () => {
	console.log("首次启动，已生成管理员口令：TestPassw0rd!");
	console.error("[stderr] 启动完成 port=" + port);
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (!chunk.includes("shutdown")) return;
	server.close(() => {
		console.log("已停止");
		process.exit(0);
	});
});
process.stdin.resume();
`,
		"utf8",
	);
	return root;
}

type Harness = {
	states: ServiceState[];
	logs: string[];
	service: ReturnType<typeof createService>;
	versionDir: string;
};

async function harness(port: number): Promise<Harness> {
	const versionDir = await makeVersionDir();
	const dataDir = join(dirname(versionDir), `${basename(versionDir)}-data`);
	dirs.push(dataDir);
	const states: ServiceState[] = [];
	const logs: string[] = [];
	const service = createService({
		// 用当前进程的 node 跑假服务端：与发布形态（官方 node + strip-types）一致。
		nodeExe: process.execPath,
		dataDir,
		logFile: join(dataDir, "desktop.log"),
		port,
		target: () => ({ version: "0.5.0", versionDir }),
		onState: (state) => states.push(state),
		onLog: (line) => logs.push(line),
	});
	return { states, logs, service, versionDir };
}

describe("createService", () => {
	it("启动后进入 running 并给出可用地址", async () => {
		const { service, states } = await harness(18787);
		const result = await service.start();
		expect(result.ok).toBe(true);
		expect(service.state().phase).toBe("running");
		expect(service.state().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(states.map((state) => state.phase)).toContain("starting");
		await service.dispose();
		expect(service.state().phase).toBe("stopped");
	});

	it("截获首次启动生成的管理员口令", async () => {
		const { service } = await harness(18788);
		await service.start();
		expect(service.state().generatedPassword).toBe("TestPassw0rd!");
		// 界面关掉弹窗后不该再显示。
		service.dismissPassword();
		expect(service.state().generatedPassword).toBeNull();
		await service.dispose();
	});

	it("通过 stdin 通道优雅停止（Windows 上唯一可行的路径）", async () => {
		const { service, logs } = await harness(18789);
		await service.start();
		await service.stop();
		expect(service.state().phase).toBe("stopped");
		// 假服务端收到 shutdown 才会打印这一行：证明走的是优雅路径而不是强杀。
		expect(logs.some((line) => line.includes("已停止"))).toBe(true);
		// 不该走到强杀分支。
		expect(logs.some((line) => line.includes("强制结束"))).toBe(false);
	});

	it("端口被占用时顺延到下一个可用端口", async () => {
		const first = await harness(18790);
		await first.service.start();
		const takenPort = first.service.state().port;
		const second = await harness(18790);
		await second.service.start();
		expect(second.service.state().port).not.toBe(takenPort);
		expect(second.service.state().phase).toBe("running");
		await Promise.all([first.service.dispose(), second.service.dispose()]);
	});

	it("入口缺失时报告失败而不是一直等", async () => {
		const missing: string[] = [];
		const broken = createService({
			nodeExe: process.execPath,
			dataDir: join(tmpdir(), "miubot-service-missing"),
			logFile: join(tmpdir(), "miubot-service-missing.log"),
			port: 18791,
			target: () => ({ version: "9.9.9", versionDir: join(tmpdir(), "miubot-does-not-exist") }),
			onState: () => undefined,
			onLog: (line) => missing.push(line),
		});
		const result = await broken.start();
		expect(result.ok).toBe(false);
		expect(broken.state().phase).toBe("crashed");
		await broken.dispose();
	});

	it("没有选择版本时拒绝启动", async () => {
		const service = createService({
			nodeExe: process.execPath,
			dataDir: join(tmpdir(), "miubot-service-noversion"),
			logFile: join(tmpdir(), "miubot-service-noversion.log"),
			port: 18792,
			target: () => ({ version: "", versionDir: "" }),
			onState: () => undefined,
			onLog: () => undefined,
		});
		const result = await service.start();
		expect(result.ok).toBe(false);
		expect(service.state().phase).toBe("stopped");
		await service.dispose();
	});
});
