import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStorage, createPluginHost, type PluginHost } from "@miubot/plugin/host/index";
import { McpRuntime } from "@miubot/plugin/tools/index";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentHost, type AgentHost, type RuntimeSession } from "../src/agent-host.ts";
import { createDefaultConfig, type AppConfig } from "../src/runtime.ts";
import { StickerStore } from "../src/stickers.ts";

/**
 * 端到端验证「插件贡献的 Pi Extension 真的被 `DefaultResourceLoader` 装载」。
 *
 * 用真实 `createAgentSession`：只构造会话、不发请求，所以不需要真实模型调用，
 * 但资源加载、扩展工厂执行、钩子进 `ExtensionRunner` 走的全是生产路径。
 *
 * 断言落在会话自己的扩展运行器上（`session.extensionRunner`），而不是靠真跑一轮对话：
 * 钩子选择的都是 `agent_start` / `agent_end` 这类载荷极简、且由通用 `emit()` 派发的事件，
 * 测试可以直接触发，既确认「handler 进了运行器」，也确认「派发时插件代码真的被执行」。
 */

const roots: string[] = [];
let dataDir = "";
let config: AppConfig;
let pluginHost: PluginHost;
let agentHost: AgentHost;
let logSpy: ReturnType<typeof vi.fn>;

type HookLog = { hook: string; plugin: string };
const globalKey = "__miubotExtensionHookLog";

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-ext-session-"));
	roots.push(root);
	dataDir = join(root, "data");
	const agentDir = join(root, "agent");
	const pluginsDir = join(root, "plugins");
	await mkdir(dataDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(pluginsDir, { recursive: true });
	(globalThis as Record<string, unknown>)[globalKey] = [] satisfies HookLog[];

	/**
	 * 写一个插件。
	 *
	 * 默认注册单个钩子（`hook` + `effect`）；传 `factoryBody` 时整个工厂体由它接管——
	 * 「工厂抛错」必须发生在工厂执行期，写在钩子体里就变成运行期错误了。
	 */
	async function writePlugin(
		id: string,
		options: { permissions: string[]; bots?: string[]; hook?: string; effect?: string; factoryBody?: string },
	): Promise<void> {
		const factoryBody =
			options.factoryBody ??
			`pi.on(${JSON.stringify(options.hook)}, () => { ${options.effect ?? ""} });`;
		const directory = join(pluginsDir, id);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "miubot.plugin.json"),
			JSON.stringify({
				schemaVersion: 1,
				id,
				name: id,
				version: "0.1.0",
				entry: "./index.ts",
				permissions: options.permissions,
				...(options.bots ? { bots: options.bots } : {}),
			}),
			"utf8",
		);
		await writeFile(
			join(directory, "index.ts"),
			`export default {
				id: ${JSON.stringify(id)},
				setup(ctx) {
					ctx.extensions.register({
						name: "hooks",
						factory(pi) { ${factoryBody} },
					});
				},
			};`,
			"utf8",
		);
	}

	await writePlugin("test.hooks", {
		permissions: ["extension:register"],
		hook: "agent_start",
		effect: `globalThis.${globalKey}.push({ hook: "agent_start", plugin: "test.hooks" });`,
	});
	// 工厂直接抛错：会话必须照常建出来，错误要进运行日志。
	await writePlugin("test.broken", {
		permissions: ["extension:register"],
		factoryBody: `throw new Error("工厂炸了");`,
	});
	// 只服务 bot-2 的插件：bot-1 的会话里不应被装载。
	await writePlugin("test.scoped", {
		permissions: ["extension:register"],
		bots: ["bot-2"],
		hook: "agent_end",
		effect: `globalThis.${globalKey}.push({ hook: "agent_end", plugin: "test.scoped" });`,
	});

	pluginHost = createPluginHost({
		pluginsDir,
		eventSource: { subscribe: () => () => undefined },
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	});
	await pluginHost.discover();
	for (const id of ["test.hooks", "test.broken", "test.scoped"]) await pluginHost.start(id);
	for (const id of ["test.hooks", "test.scoped"]) {
		expect(pluginHost.get(id)?.state).toBe("active");
	}

	config = createDefaultConfig();
	// 工具集置空：这样「会话照常可用」可以用一个确定的空集合来断言，
	// 不会被 `createDefaultConfig()` 默认启用的 `web_search` 干扰。
	config.tools.enabled = [];
	config.providers = [
		{
			id: "test-provider",
			name: "Test",
			api: "openai-completions",
			apiKey: "sk-test",
			baseUrl: "https://example.invalid/v1",
			enabled: true,
			ttsModel: "",
			imageModel: "",
			models: [
				{
					id: "test-model",
					name: "Test Model",
					api: "openai-completions",
					maxOutput: 1024,
					maxContext: 8000,
					compressionThreshold: 6000,
					supportsThinking: false,
					supportsVision: false,
					supportsTools: true,
				},
			],
		},
	];

	logSpy = vi.fn();
	agentHost = createAgentHost({
		dataDir,
		agentDir,
		getConfig: () => config,
		getPeerConfig: () => undefined,
		getPromptContext: () => undefined,
		getStickerContext: () => undefined,
		getSessions: () => [],
		stickerStore: new StickerStore(dataDir),
		mcpRuntime: new McpRuntime(),
		pluginTools: pluginHost.tools,
		pluginExtensions: pluginHost.extensions,
		log: (level, text) => logSpy(level, text),
	});
});

afterAll(async () => {
	agentHost?.rebuildAgentSessions();
	delete (globalThis as Record<string, unknown>)[globalKey];
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function runtimeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
	return {
		id: "session-1",
		scope: "group",
		peerId: "group-1",
		peerName: "测试群",
		botId: "bot-1",
		title: "测试群",
		personaId: "default",
		personaName: "Miu",
		personaPrompt: "",
		providerId: "test-provider",
		modelId: "test-model",
		summary: "",
		compactedThrough: 0,
		messages: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		active: true,
		...overrides,
	};
}

function hookLog(): HookLog[] {
	return (globalThis as Record<string, unknown>)[globalKey] as HookLog[];
}

/** 运行日志里「某个插件扩展工厂抛错」的条目；路径形如 `<inline:plugin:test.broken/hooks>`。 */
function brokenWarnings(): unknown[][] {
	return logSpy.mock.calls.filter(
		([level, text]) =>
			level === "WARN" && String(text).includes("plugin:test.broken/hooks") && String(text).includes("工厂炸了"),
	);
}

describe("插件扩展被会话装载", () => {
	it("建会话时执行插件工厂，钩子注册到会话的扩展运行器并真的能被派发", async () => {
		const session = await agentHost.getAgentSession(runtimeSession({ id: "s-basic" }));
		// 服务端自己的 `miubot-qq-scene` 只挂 `before_agent_start`，所以这个 handler 只可能来自插件。
		expect(session.extensionRunner.hasHandlers("agent_start")).toBe(true);
		expect(hookLog().filter((item) => item.plugin === "test.hooks")).toHaveLength(0);

		await session.extensionRunner.emit({ type: "agent_start" });
		expect(hookLog().filter((item) => item.plugin === "test.hooks")).toHaveLength(1);
	});

	it("manifest 的 bots 决定哪些会话装载该扩展", async () => {
		const bot1 = await agentHost.getAgentSession(runtimeSession({ id: "s-scope" }));
		expect(bot1.extensionRunner.hasHandlers("agent_end")).toBe(false);

		const bot2 = await agentHost.getAgentSession(runtimeSession({ id: "s-scope-2", botId: "bot-2" }));
		expect(bot2.extensionRunner.hasHandlers("agent_end")).toBe(true);
		await bot2.extensionRunner.emit({ type: "agent_end", messages: [] });
		expect(hookLog().filter((item) => item.plugin === "test.scoped")).toHaveLength(1);
	});

	it("工厂抛错不会拖垮会话，原因写进运行日志", async () => {
		// 坏工厂是全局的：前面每个会话都会各报一次，所以这里比增量而不是比总数。
		const before = brokenWarnings().length;
		const session = await agentHost.getAgentSession(runtimeSession({ id: "s-broken" }));
		// 会话照常可用，只是少了那一个坏扩展；其它插件的钩子不受影响。
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.extensionRunner.hasHandlers("agent_start")).toBe(true);
		expect(brokenWarnings()).toHaveLength(before + 1);
	});

	it("插件停用并重建后，新会话不再装载它的扩展", async () => {
		await pluginHost.stop("test.hooks");
		agentHost.rebuildAgentSessions();

		const session = await agentHost.getAgentSession(runtimeSession({ id: "s-after-stop" }));
		expect(session.extensionRunner.hasHandlers("agent_start")).toBe(false);
	});
});
