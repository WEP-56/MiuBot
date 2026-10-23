import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost, type PluginHost } from "@miubot/plugin/host/index";
import { createFilePluginConfig } from "@miubot/plugin/host/config";
import { createFileStorage } from "@miubot/plugin/host/storage";
import { strToU8, zipSync, type Zippable } from "fflate";
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
	packagesDir: string;
	config: AppConfig;
	saved: () => number;
	rebuilds: () => number;
	deleteAssets: ReturnType<typeof vi.fn>;
	host: PluginHost;
	call: (method: string, path: string, payload?: unknown) => Promise<Call>;
	upload: (path: string, bytes: Uint8Array, contentType?: string) => Promise<Call>;
}> {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugins-api-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	const packagesDir = join(root, "packages");
	await mkdir(pluginsDir, { recursive: true });
	await mkdir(packagesDir, { recursive: true });
	const deleteAssets = vi.fn().mockResolvedValue(undefined);

	const host = createPluginHost({
		pluginsDir,
		installDir: pluginsDir,
		eventSource: { subscribe: () => () => undefined },
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: join(root, "config"), pluginId }),
		deleteAssets,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	});

	const config = createDefaultConfig();
	const rebuildAgentSessions = vi.fn();
	let saveCount = 0;
	const ctx = {
		config: {
			get: () => config,
			replace: () => undefined,
			save: async () => {
				saveCount += 1;
			},
		},
		// 启停会重建会话以同步工具集；这里只验证「有没有被调用」，不需要真会话。
		agentHost: { rebuildAgentSessions },
		// 安装/卸载会写审计：断言用不到内容，但要有个能接住的实现。
		audit: { record: () => undefined, list: async () => [], flush: async () => undefined },
		plugins: {
			list: host.list,
			get: host.get,
			discover: host.discover,
			start: host.start,
			stop: host.stop,
			reload: host.reload,
			config: { inspect: host.config.inspect, save: host.config.save },
			install: host.install,
			importArchive: host.importArchive,
			uninstall: host.uninstall,
			directories: [pluginsDir],
		},
	} as unknown as HttpContext;

	/** 统一的响应捕获；JSON 调用与二进制上传共用。 */
	async function invoke(req: IncomingMessage, url: URL): Promise<Call> {
		let status = 0;
		let responseBody = "";
		const res = {
			writeHead: (code: number) => {
				status = code;
				return res;
			},
			setHeader: () => res,
			end: (chunk?: string) => {
				responseBody = chunk ?? "";
			},
		} as unknown as ServerResponse;
		const handled = await handlePluginRoutes(ctx, req, res, url);
		if (!handled) throw new Error(`路由未处理：${req.method} ${url.pathname}`);
		return { status, body: responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : {} };
	}

	return {
		ctx,
		host,
		pluginsDir,
		packagesDir,
		config,
		deleteAssets,
		saved: () => saveCount,
		rebuilds: () => rebuildAgentSessions.mock.calls.length,
		call: async (method, path, requestBody) => {
			const url = new URL(path, "http://127.0.0.1");
			// 请求体按需变成异步可迭代对象，让路由里的 `body()` 能正常读出 JSON。
			const req = {
				method,
				url: path,
				headers: {},
				async *[Symbol.asyncIterator]() {
					if (requestBody !== undefined) yield Buffer.from(JSON.stringify(requestBody));
				},
			} as unknown as IncomingMessage;
			return invoke(req, url);
		},
		upload: async (path, bytes, contentType = "application/zip") => {
			const url = new URL(path, "http://127.0.0.1");
			const req = {
				method: "POST",
				url: path,
				headers: { "content-type": contentType },
				async *[Symbol.asyncIterator]() {
					yield Buffer.from(bytes);
				},
			} as unknown as IncomingMessage;
			return invoke(req, url);
		},
	};
}

const pluginSource = `
export default {
	id: globalThis.__pluginId,
	setup() {},
};
`;

/** 写一个可运行的插件目录；`id` 同时作为目录名。`setup` 可替换成注册工具等自定义实现。 */
async function writePlugin(
	pluginsDir: string,
	id: string,
	extra: Record<string, unknown> = {},
	setup?: string,
): Promise<void> {
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
	const source = setup
		? `export default { id: ${JSON.stringify(id)}, setup(ctx) { ${setup} } };`
		: pluginSource.replace("globalThis.__pluginId", JSON.stringify(id));
	await writeFile(join(directory, "index.ts"), source, "utf8");
}

type PluginRow = {
	id: string;
	state: string;
	enabled: boolean;
	source: string;
	tools: string[];
	extensions: string[];
	error?: string;
};

/**
 * 现造一个插件 ZIP，省掉往仓库里塞二进制夹具。
 *
 * `prefix` 模拟「整个目录被打包」的常见形态——macOS 的「压缩」和资源管理器都会
 * 多包一层目录，解压侧必须自己找到 manifest 所在的那一层。
 */
function makePluginZip(id: string, prefix = ""): Uint8Array {
	const tree: Zippable = {
		[`${prefix}miubot.plugin.json`]: strToU8(
			JSON.stringify({
				schemaVersion: 1,
				id,
				name: `插件 ${id}`,
				version: "0.1.0",
				entry: "./index.ts",
				permissions: ["event:*"],
			}),
		),
		[`${prefix}index.ts`]: strToU8(`export default { id: ${JSON.stringify(id)}, setup() {} };`),
	};
	return zipSync(tree);
}

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

	it("列出插件注册的 Agent 工具名", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.tools", { permissions: ["tool:register"] }, `
			ctx.tools.register({
				name: "demo_ping",
				description: "示例工具",
				async execute() { return "pong"; },
			});
		`);
		await h.host.discover();
		await h.host.start("demo.tools");

		const response = await h.call("GET", "/api/plugins");
		expect(row(response, "demo.tools")?.tools).toEqual(["demo_ping"]);
	});

	it("列出插件注册的对话钩子", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.hooks", { permissions: ["extension:register"] }, `
			ctx.extensions.register({ name: "hooks", factory(pi) { pi.on("agent_start", () => {}); } });
		`);
		await h.host.discover();
		await h.host.start("demo.hooks");

		const response = await h.call("GET", "/api/plugins");
		// 工作台按这个名字展示，路径前缀能直接看出归属插件。
		expect(row(response, "demo.hooks")?.extensions).toEqual(["hooks"]);
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
		// 已有会话里的工具集必须跟着变，否则要等会话自然过期才生效。
		expect(h.rebuilds()).toBeGreaterThan(0);
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

describe("GET /api/plugins/:id/config", () => {
	const config = {
		type: "object",
		properties: {
			welcomeText: { type: "string", title: "欢迎语", default: "默认欢迎", maxLength: 20 },
			apiKey: { type: "string", secret: true },
		},
		required: ["welcomeText"],
	};

	it("返回 schema 与补齐默认值的当前值", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();

		const response = await h.call("GET", "/api/plugins/demo.cfg/config");
		expect(response.status).toBe(200);
		expect(response.body.values).toEqual({ welcomeText: "默认欢迎" });
		expect((response.body.schema as { properties: Record<string, unknown> }).properties.welcomeText).toBeDefined();
	});

	it("没有声明 config 的插件返回空 schema", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.plain");
		await h.host.discover();

		const response = await h.call("GET", "/api/plugins/demo.plain/config");
		expect(response.status).toBe(200);
		expect(response.body.schema).toBeUndefined();
	});

	it("未知插件返回 404", async () => {
		const h = await harness();
		const response = await h.call("GET", "/api/plugins/nope/config");
		expect(response.status).toBe(404);
	});
});

describe("PUT /api/plugins/:id/config", () => {
	const config = {
		type: "object",
		properties: {
			welcomeText: { type: "string", title: "欢迎语", default: "默认欢迎", maxLength: 20 },
			apiKey: { type: "string", secret: true },
		},
		required: ["welcomeText"],
	};

	it("保存合法配置并让运行中的插件重新读取", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();
		await h.host.start("demo.cfg");

		const response = await h.call("PUT", "/api/plugins/demo.cfg/config", {
			values: { welcomeText: "改过的欢迎语" },
		});
		expect(response.status).toBe(200);
		expect(response.body.restarted).toBe(true);
		expect(response.body.values).toEqual({ welcomeText: "改过的欢迎语" });
		// 重启会让插件工具以新代次重新注册；不重建会话的话，旧会话里的定义会被判失效。
		expect(h.rebuilds()).toBeGreaterThan(0);

		// 回读也应该是新值：配置已经落盘，不是只改了内存。
		const reread = await h.call("GET", "/api/plugins/demo.cfg/config");
		expect(reread.body.values).toEqual({ welcomeText: "改过的欢迎语" });
	});

	it("不把 secret 真值回显到响应里", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();
		await h.host.start("demo.cfg");

		const response = await h.call("PUT", "/api/plugins/demo.cfg/config", {
			values: { welcomeText: "ok", apiKey: "sk-secret" },
		});
		expect(response.body.values).toEqual({ welcomeText: "ok" });
		expect(response.body.secretKeys).toEqual(["apiKey"]);
		expect(JSON.stringify(response.body)).not.toContain("sk-secret");
	});

	it("校验失败时逐字段返回问题，且不落盘", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();
		await h.host.start("demo.cfg");

		const response = await h.call("PUT", "/api/plugins/demo.cfg/config", {
			values: { welcomeText: "长".repeat(30) },
		});
		expect(response.status).toBe(400);
		expect(response.body.issues).toContainEqual(expect.objectContaining({ field: "welcomeText" }));

		const reread = await h.call("GET", "/api/plugins/demo.cfg/config");
		expect(reread.body.values).toEqual({ welcomeText: "默认欢迎" });
	});

	it("values 不是对象时返回 400", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();

		const response = await h.call("PUT", "/api/plugins/demo.cfg/config", { values: "nope" });
		expect(response.status).toBe(400);
	});

	it("已停用的插件只保存配置、不自行启动", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.cfg", { config });
		await h.host.discover();
		h.config.plugins.disabled = ["demo.cfg"];

		const response = await h.call("PUT", "/api/plugins/demo.cfg/config", {
			values: { welcomeText: "先存着" },
		});
		expect(response.status).toBe(200);
		expect(response.body.restarted).toBe(false);
		// 下次启动时会读到新值；但保存动作不能让它越过 disabled 自己起来。
		expect(h.host.get("demo.cfg")?.state).toBe("inactive");
	});

	it("未声明 config 的插件拒绝保存", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, "demo.plain");
		await h.host.discover();

		const response = await h.call("PUT", "/api/plugins/demo.plain/config", { values: { a: 1 } });
		expect(response.status).toBe(400);
		expect(String(response.body.message)).toContain("config");
	});
});


describe("POST /api/plugins/install", () => {
	it("安装本地插件包并在配置放行时启动它", async () => {
		const h = await harness();
		await writePlugin(h.packagesDir, "demo.installed");

		const response = await h.call("POST", "/api/plugins/install", {
			path: join(h.packagesDir, "demo.installed"),
		});
		expect(response.status).toBe(200);
		expect(response.body.installed).toBe("demo.installed");
		expect(response.body.started).toBe(true);
		expect(row(response, "demo.installed")).toMatchObject({ state: "active", removable: true });
		// 新插件的工具要进已有会话，否则要等会话自然过期。
		expect(h.rebuilds()).toBeGreaterThan(0);
	});

	it("配置里禁用的 id 装上去但不启动", async () => {
		const h = await harness();
		await writePlugin(h.packagesDir, "demo.muted");
		h.config.plugins.disabled = ["demo.muted"];

		const response = await h.call("POST", "/api/plugins/install", {
			path: join(h.packagesDir, "demo.muted"),
		});
		expect(response.status).toBe(200);
		expect(response.body.started).toBe(false);
		expect(row(response, "demo.muted")).toMatchObject({ state: "inactive", enabled: false });
	});

	it("重复安装返回逐项问题", async () => {
		const h = await harness();
		await writePlugin(h.packagesDir, "demo.installed");
		await h.call("POST", "/api/plugins/install", { path: join(h.packagesDir, "demo.installed") });

		const response = await h.call("POST", "/api/plugins/install", {
			path: join(h.packagesDir, "demo.installed"),
		});
		expect(response.status).toBe(400);
		expect(response.body.issues).toContainEqual(expect.objectContaining({ field: "id" }));
	});

	it("路径为空或不存在时返回 400", async () => {
		const h = await harness();
		expect((await h.call("POST", "/api/plugins/install", {})).status).toBe(400);

		const missing = await h.call("POST", "/api/plugins/install", { path: join(h.packagesDir, "nope") });
		expect(missing.status).toBe(400);
		expect(missing.body.issues).toContainEqual(expect.objectContaining({ field: "path" }));
	});
});

describe("POST /api/plugins/import", () => {
	it("上传 ZIP 后装上并启动，多包一层目录也能认出来", async () => {
		const h = await harness();

		// 前端把 `File` 当 body 直接发，所以这里也给原始字节。
		const response = await h.upload("/api/plugins/import", makePluginZip("demo.uploaded", "demo.uploaded/"));
		expect(response.status).toBe(200);
		expect(response.body.installed).toBe("demo.uploaded");
		expect(response.body.started).toBe(true);
		expect(row(response, "demo.uploaded")).toMatchObject({ state: "active", removable: true, hasConfig: false });
		// 上传路径同样要把新插件的工具送进已有会话。
		expect(h.rebuilds()).toBeGreaterThan(0);
	});

	it("落位后的目录可直接再次扫描，不依赖内存里的临时状态", async () => {
		const h = await harness();
		await h.upload("/api/plugins/import", makePluginZip("demo.uploaded"));

		// 重新 discover 相当于「重启服务」：临时目录必须已经改名成正式目录。
		await h.host.discover();
		expect(h.host.get("demo.uploaded")).toMatchObject({ source: "plugin", directory: join(h.pluginsDir, "demo.uploaded") });
	});

	it("配置里禁用的 id 导入后不启动", async () => {
		const h = await harness();
		h.config.plugins.disabled = ["demo.muted"];

		const response = await h.upload("/api/plugins/import", makePluginZip("demo.muted"));
		expect(response.status).toBe(200);
		expect(response.body.started).toBe(false);
		expect(row(response, "demo.muted")).toMatchObject({ state: "inactive", enabled: false });
	});

	it("非 ZIP 的 content-type 直接拒绝，不进入解压", async () => {
		const h = await harness();
		const response = await h.upload("/api/plugins/import", makePluginZip("demo.x"), "application/octet-stream");
		expect(response.status).toBe(415);
		expect(String(response.body.message)).toContain("ZIP");
	});

	it("Windows 上的 application/x-zip-compressed 也放行", async () => {
		const h = await harness();
		const response = await h.upload(
			"/api/plugins/import",
			makePluginZip("demo.win"),
			"application/x-zip-compressed",
		);
		expect(response.status).toBe(200);
		expect(response.body.installed).toBe("demo.win");
	});

	it("不是 ZIP 的字节返回逐项问题，不留下临时目录", async () => {
		const h = await harness();
		const response = await h.upload("/api/plugins/import", new Uint8Array([1, 2, 3, 4]));
		expect(response.status).toBe(400);
		expect(response.body.issues).toContainEqual(expect.objectContaining({ field: "zip" }));
		// `.incoming-*` 是隐藏目录，扫描会跳过；这里断言它确实没留下东西。
		const leftovers = (await readdir(h.pluginsDir)).filter((name) => name.startsWith("."));
		expect(leftovers).toEqual([]);
	});

	it("ZIP 里没有 manifest 时返回 400", async () => {
		const h = await harness();
		const archive = zipSync({ "index.ts": strToU8("export default { id: 'x', setup() {} };") });
		const response = await h.upload("/api/plugins/import", archive);
		expect(response.status).toBe(400);
		expect(response.body.issues).toContainEqual(expect.objectContaining({ field: "zip" }));
	});

	it("重复 id 返回逐项问题，且不覆盖原有目录", async () => {
		const h = await harness();
		await h.upload("/api/plugins/import", makePluginZip("demo.dup"));

		const again = await h.upload("/api/plugins/import", makePluginZip("demo.dup"));
		expect(again.status).toBe(400);
		expect(again.body.issues).toContainEqual(expect.objectContaining({ field: "id" }));
		// 原插件仍在正常运行，没有被这次重复写入弄坏。
		const list = await h.call("GET", "/api/plugins");
		expect(row(list, "demo.dup")).toMatchObject({ state: "active" });
	});
});

describe("POST /api/plugins/:id/uninstall", () => {
	it("删除插件目录，同时清掉配置里的 id", async () => {
		const h = await harness();
		await writePlugin(h.packagesDir, "demo.installed");
		await h.call("POST", "/api/plugins/install", { path: join(h.packagesDir, "demo.installed") });
		h.config.plugins.disabled = ["demo.installed"];

		const response = await h.call("POST", "/api/plugins/demo.installed/uninstall", {});
		expect(response.status).toBe(200);
		expect(row(response, "demo.installed")).toBeUndefined();
		// 留着不存在的 id 会让「禁用清单」永远有一行幽灵。
		expect(h.config.plugins.disabled).toEqual([]);
		expect(h.saved()).toBeGreaterThan(0);
	});

	it("默认保留数据与配置，勾选后才删", async () => {
		const h = await harness();
		await writePlugin(h.packagesDir, "demo.installed");
		await h.call("POST", "/api/plugins/install", { path: join(h.packagesDir, "demo.installed") });

		await h.call("POST", "/api/plugins/demo.installed/uninstall", {});
		expect(h.deleteAssets).not.toHaveBeenCalled();

		const h2 = await harness();
		await writePlugin(h2.packagesDir, "demo.installed");
		await h2.call("POST", "/api/plugins/install", { path: join(h2.packagesDir, "demo.installed") });
		await h2.call("POST", "/api/plugins/demo.installed/uninstall", { deleteData: true, deleteConfig: true });
		expect(h2.deleteAssets).toHaveBeenCalledWith("demo.installed", { data: true, config: true });
	});

	it("未知插件返回 404", async () => {
		const h = await harness();
		const response = await h.call("POST", "/api/plugins/nope/uninstall", {});
		expect(response.status).toBe(404);
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
