import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformEventHandler } from "@miubot/shared/platform/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost, type PluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 最小宿主；`reservedToolNames` 用来模拟内置 / MCP 已占用的名字。 */
async function harness(options: { reserved?: string[] } = {}): Promise<{
	host: PluginHost;
	pluginsDir: string;
	deps: PluginHostDependencies;
}> {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-tools-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	const storageDir = join(root, "storage");
	await mkdir(pluginsDir, { recursive: true });
	const handlers = new Map<string, Set<PlatformEventHandler>>();
	const deps: PluginHostDependencies = {
		pluginsDir,
		eventSource: {
			subscribe(type, handler) {
				const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
				set.add(handler);
				handlers.set(type, set);
				return () => set.delete(handler);
			},
		},
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: storageDir, pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		reservedToolNames: () => options.reserved ?? [],
	};
	return { host: createPluginHost(deps), pluginsDir, deps };
}

/** 写一个注册了工具（或故意写错）的插件。 */
async function writeToolPlugin(
	pluginsDir: string,
	options: {
		id: string;
		permissions?: string[];
		/** 直接作为 `ctx.tools.register({...})` 的参数源码。 */
		tool?: string;
		bots?: string[];
		setup?: string;
	} = { id: "test.tools" },
): Promise<void> {
	const directory = join(pluginsDir, options.id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: options.id,
			name: options.id,
			version: "0.1.0",
			entry: "./index.ts",
			permissions: options.permissions ?? ["tool:register"],
			...(options.bots ? { bots: options.bots } : {}),
		}),
		"utf8",
	);
	const setup = options.setup ?? `ctx.tools.register(${options.tool ?? defaultTool(options.id)});`;
	await writeFile(
		join(directory, "index.ts"),
		`export default { id: ${JSON.stringify(options.id)}, setup(ctx) { ${setup} } };`,
		"utf8",
	);
}

function defaultTool(id: string): string {
	return `{
		name: ${JSON.stringify(id.replace(/\./g, "_"))},
		description: "示例工具",
		parameters: { properties: { text: { type: "string", description: "输入" } }, required: ["text"] },
		async execute(input) { return { text: "收到：" + String(input.text) }; },
	}`;
}

async function startPlugin(host: PluginHost, pluginsDir: string, id: string) {
	await host.discover();
	const status = await host.start(id);
	return { status, pluginsDir };
}

describe("插件注册 Agent Tool", () => {
	it("注册后能被会话取到，并按声明的参数执行", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, { id: "test.tools" });
		const { status } = await startPlugin(h.host, h.pluginsDir, "test.tools");
		expect(status?.state).toBe("active");
		expect(status?.tools).toEqual(["test_tools"]);

		const [definition] = h.host.tools.definitionsFor({ botId: "bot-1" });
		expect(definition?.name).toBe("test_tools");
		const result = await definition!.execute(
			"call-1",
			{ text: "喵" },
			new AbortController().signal,
			undefined,
			{} as never,
		);
		expect(result.content[0]).toEqual({ type: "text", text: "收到：喵" });
	});

	it("没有 tool:register 权限时拒绝注册，并让 setup 失败", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, { id: "test.tools", permissions: ["storage:read"] });
		const { status } = await startPlugin(h.host, h.pluginsDir, "test.tools");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("tool:register");
		expect(h.host.tools.definitionsFor({ botId: "bot-1" })).toHaveLength(0);
	});

	it("工具名不合法时拒绝注册", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, {
			id: "test.tools",
			tool: `{ name: "Bad-Name", description: "x", async execute() { return "ok"; } }`,
		});
		const { status } = await startPlugin(h.host, h.pluginsDir, "test.tools");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("工具名");
	});

	it("不能覆盖内置或 MCP 已占用的工具名", async () => {
		const h = await harness({ reserved: ["web_search"] });
		await writeToolPlugin(h.pluginsDir, {
			id: "test.tools",
			tool: `{ name: "web_search", description: "冒名顶替", async execute() { return "x"; } }`,
		});
		const { status } = await startPlugin(h.host, h.pluginsDir, "test.tools");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("已被内置或 MCP 工具占用");
	});

	it("两个插件不能注册同名工具，后来者显式失败", async () => {
		const h = await harness();
		const tool = `{ name: "shared_tool", description: "同名", async execute() { return "x"; } }`;
		await writeToolPlugin(h.pluginsDir, { id: "test.first", tool });
		await writeToolPlugin(h.pluginsDir, { id: "test.second", tool });
		await h.host.discover();

		expect((await h.host.start("test.first"))?.state).toBe("active");
		const second = await h.host.start("test.second");
		expect(second?.state).toBe("failed");
		expect(second?.error).toContain("已被插件 test.first 占用");
	});

	it("停用后工具不可见，已取出的定义再调用会被拒绝", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, { id: "test.tools" });
		await startPlugin(h.host, h.pluginsDir, "test.tools");
		const [definition] = h.host.tools.definitionsFor({ botId: "bot-1" });

		await h.host.stop("test.tools");
		expect(h.host.tools.definitionsFor({ botId: "bot-1" })).toHaveLength(0);
		// 会话可能持有停用前取到的定义：执行时必须再核一次。
		await expect(
			definition!.execute("call-1", {}, new AbortController().signal, undefined, {} as never),
		).rejects.toThrow("已停用");
	});

	it("按 manifest 的 bots 过滤，服务别的 Bot 的插件不暴露工具", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, { id: "test.tools", bots: ["bot-2"] });
		await startPlugin(h.host, h.pluginsDir, "test.tools");

		expect(h.host.tools.namesFor({ botId: "bot-2" })).toEqual(["test_tools"]);
		expect(h.host.tools.namesFor({ botId: "bot-1" })).toEqual([]);
	});

	it("超时会中断执行，不会挂住整轮对话", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, {
			id: "test.tools",
			tool: `{
				name: "slow_tool",
				description: "很慢",
				timeoutMs: 1000,
				async execute() { return new Promise((resolve) => setTimeout(() => resolve("late"), 5000)); },
			}`,
		});
		await startPlugin(h.host, h.pluginsDir, "test.tools");
		const [definition] = h.host.tools.definitionsFor({ botId: "bot-1" });

		await expect(
			definition!.execute("call-1", {}, new AbortController().signal, undefined, {} as never),
		).rejects.toThrow("超时");
	}, 10_000);

	it("空返回被判为失败，而不是给模型一段空白", async () => {
		const h = await harness();
		await writeToolPlugin(h.pluginsDir, {
			id: "test.tools",
			tool: `{ name: "empty_tool", description: "空", async execute() { return ""; } }`,
		});
		await startPlugin(h.host, h.pluginsDir, "test.tools");
		const [definition] = h.host.tools.definitionsFor({ botId: "bot-1" });

		const result = await definition!.execute("call-1", {}, new AbortController().signal, undefined, {} as never);
		expect(result.isError).toBe(true);
	});
});
