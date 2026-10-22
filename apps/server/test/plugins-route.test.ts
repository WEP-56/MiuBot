import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost, type PluginHost } from "@miubot/plugin/host/index";
import { createFileStorage } from "@miubot/plugin/host/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConfig, type AppConfig } from "../src/runtime.ts";
import type { HttpContext } from "../src/http/context.ts";
import { handlePluginRoutes } from "../src/http/routes/plugins.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Call = { status: number; body: Record<string, unknown> };

/**
 * 只搭路由需要的那两个依赖：`config` 与 `plugins`。
 *
 * 其它字段与插件路由无关，用不到就不伪造——测试的目标是「配置和宿主有没有一起改」，
 * 不是把整个 `HttpContext` 复刻一遍。
 */
async function harness(): Promise<{
	ctx: HttpContext;
	pluginsDir: string;
	config: AppConfig;
	saved: () => number;
	host: PluginHost;
	call: (method: string, path: string) => Promise<Call>;
}> {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugins-api-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	await mkdir(pluginsDir, { recursive: true });

	const host = createPluginHost({
		pluginsDir,
		eventSource: { subscribe: () => () => undefined },
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	});

	const config = createDefaultConfig();
	let saveCount = 0;
	const ctx = {
		config: {
			get: () => config,
			replace: () => undefined,
			save: async () => {
				saveCount += 1;
			},
		},
		plugins: {
			list: host.list,
			get: host.get,
			discover: host.discover,
			start: host.start,
			stop: host.stop,
			reload: host.reload,
			directories: [pluginsDir],
		},
	} as unknown as HttpContext;

	return {
		ctx,
		host,
		pluginsDir,
		config,
		saved: () => saveCount,
		call: async (method, path) => {
			const url = new URL(path, "http://127.0.0.1");
			const req = { method, url: path, headers: {} } as IncomingMessage;
			let status = 0;
			let payload = "";
			const res = {
				writeHead: (code: number) => {
					status = code;
					return res;
				},
				setHeader: () => res,
				end: (chunk?: string) => {
					payload = chunk ?? "";
				},
			} as unknown as ServerResponse;
			const handled = await handlePluginRoutes(ctx, req, res, url);
			if (!handled) throw new Error(`路由未处理：${method} ${path}`);
			return { status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} };
		},
	};
}

const pluginSource = `
export default {
	id: globalThis.__pluginId,
	setup() {},
};
`;

/** 写一个可运行的插件目录；`id` 同时作为目录名。 */
async function writePlugin(pluginsDir: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
	const directory = join(pluginsDir, id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id,
			name: `插件 ${id}`,
			version: "0.1.0",
			entry: "./index.ts",
			permissions: ["event:*"],
			...extra,
		}),
		"utf8",
	);
	// 入口里把 id 写死成具体值：加载器会校验导出 id 与 manifest 是否一致。
	await writeFile(join(directory, "index.ts"), pluginSource.replace("globalThis.__pluginId", JSON.stringify(id)), "utf8");
}

type PluginRow = {
	id: string;
	state: string;
	enabled: boolean;
	source: string;
	error?: string;
};

function rows(response: Call): PluginRow[] {
	return response.body.plugins as PluginRow[];
}

function row(response: Call, id: string): PluginRow | undefined {
	return rows(response).find((item) => item.id === id);
}

describe("GET /api/plugins", () => {
	it("列出已登记的插件及其配置放行状态", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.call("POST", "/api/plugins/discover");
		await h.host.start("demo.one");

		const response = await h.call("GET", "/api/plugins");
		expect(response.status).toBe(200);
		expect(row(response, "demo.one")).toMatchObject({ state: "active", enabled: true, source: "plugin" });
		expect(response.body.directories).toEqual([h.pluginsDir]);
	});

	it("把坏掉的插件目录作为诊断条目列出，并标记为不可放行", async () => {
		const h = await harness();
		await mkdir(join(h.pluginsDir, "broken"), { recursive: true });
		await writeFile(join(h.pluginsDir, "broken", "miubot.plugin.json"), "{ not json", "utf8");

		const response = await h.call("POST", "/api/plugins/discover");
		expect(row(response, "invalid:broken")).toMatchObject({ source: "invalid", enabled: false });
	});

	it("重复扫描不会把已有插件标成重复", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");

		await h.call("POST", "/api/plugins/discover");
		const second = await h.call("POST", "/api/plugins/discover");
		// `discover()` 是幂等的：重新扫描只补新插件，不能把跑着的插件判成冲突。
		expect(rows(second).map((item) => item.id)).toEqual(["demo.one"]);
	});
});

describe("POST /api/plugins/:id/disable", () => {
	it("写入 disabled、停掉宿主，并让 GET 反映为未放行", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		await h.host.start("demo.one");

		const response = await h.call("POST", "/api/plugins/demo.one/disable");
		expect(response.status).toBe(200);
		expect(row(response, "demo.one")).toMatchObject({ state: "inactive", enabled: false });
		// 配置必须一起改：只停宿主的话下次启动插件又会活过来。
		expect(h.config.plugins.disabled).toEqual(["demo.one"]);
		expect(h.saved()).toBe(1);
		expect(h.host.get("demo.one")?.state).toBe("inactive");
	});
});

describe("POST /api/plugins/:id/enable", () => {
	it("清掉 disabled 并重新启动", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		h.config.plugins.disabled = ["demo.one"];

		const response = await h.call("POST", "/api/plugins/demo.one/enable");
		expect(response.status).toBe(200);
		expect(row(response, "demo.one")).toMatchObject({ state: "active", enabled: true });
		expect(h.config.plugins.disabled).toEqual([]);
	});

	it("白名单非空时把插件补进白名单，避免重启后又消失", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		h.config.plugins.enabled = ["another.plugin"];

		await h.call("POST", "/api/plugins/demo.one/enable");
		expect(h.config.plugins.enabled).toEqual(["another.plugin", "demo.one"]);
	});

	it("setup 失败后点启用会重试一次，而不是带着旧错误原地不动", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		// 先让首次加载失败：入口导出错误 id，宿主会把条目记成 failed。
		await writeFile(
			join(h.pluginsDir, "demo.one", "index.ts"),
			`export default { id: "wrong.id", setup() {} };`,
			"utf8",
		);
		await h.host.start("demo.one");
		expect(h.host.get("demo.one")?.state).toBe("failed");

		// 修好入口后再启用：应当真的起来，而不是直接返回上一次的错误。
		await writeFile(
			join(h.pluginsDir, "demo.one", "index.ts"),
			`export default { id: "demo.one", setup() {} };`,
			"utf8",
		);
		const response = await h.call("POST", "/api/plugins/demo.one/enable");
		expect(row(response, "demo.one")).toMatchObject({ state: "active" });
	});
});

describe("POST /api/plugins/:id/reload", () => {
	it("重读 manifest，让改过的版本号生效", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		await h.host.start("demo.one");

		await writePlugin(h.pluginsDir, "demo.one", { version: "0.2.0" });
		const response = await h.call("POST", "/api/plugins/demo.one/reload");
		expect(row(response, "demo.one")).toMatchObject({ state: "active", version: "0.2.0" });
	});

	it("磁盘上的 manifest 被改坏时保留条目并报错", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		await h.host.start("demo.one");

		await writeFile(join(h.pluginsDir, "demo.one", "miubot.plugin.json"), "{ broken", "utf8");
		const response = await h.call("POST", "/api/plugins/demo.one/reload");
		expect(row(response, "demo.one")).toMatchObject({ state: "failed" });
		expect(row(response, "demo.one")?.error).toContain("manifest");
	});

	it("配置里禁用的插件拒绝重载，避免跑出一个下次启动就消失的实例", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.one");
		await h.host.discover();
		h.config.plugins.disabled = ["demo.one"];

		const response = await h.call("POST", "/api/plugins/demo.one/reload");
		expect(response.status).toBe(409);
		expect(h.host.get("demo.one")?.state).toBe("inactive");
	});
});

describe("错误边界", () => {
	it("未知插件返回 404", async () => {
		const h = await harness();
		const response = await h.call("POST", "/api/plugins/nope/enable");
		expect(response.status).toBe(404);
		expect(response.body.message).toBe("插件不存在");
	});

	it("诊断条目拒绝启停并给出原因", async () => {
		const h = await harness();
		await mkdir(join(h.pluginsDir, "broken"), { recursive: true });
		await writeFile(join(h.pluginsDir, "broken", "miubot.plugin.json"), "{ not json", "utf8");
		await h.host.discover();

		const response = await h.call("POST", "/api/plugins/invalid%3Abroken/enable");
		expect(response.status).toBe(400);
		expect(String(response.body.message)).toContain("manifest");
	});

	it("未命中插件路由时交回路由表，不吞掉请求", async () => {
		const h = await harness();
		const url = new URL("/api/plugins/demo.one/toggle", "http://127.0.0.1");
		const handled = await handlePluginRoutes(
			h.ctx,
			{ method: "POST", url: "/api/plugins/demo.one/toggle", headers: {} } as IncomingMessage,
			{ writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse,
			url,
		);
		expect(handled).toBe(false);
	});
});
