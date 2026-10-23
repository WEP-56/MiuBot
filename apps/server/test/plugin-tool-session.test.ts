import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStorage, createPluginHost, type PluginHost } from "@miubot/plugin/host/index";
import { McpRuntime } from "@miubot/plugin/tools/index";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentHost, type AgentHost, type PeerConfig, type RuntimeSession } from "../src/agent-host.ts";
import { createDefaultConfig, type AppConfig } from "../src/runtime.ts";
import { StickerStore } from "../src/stickers.ts";

/**
 * 端到端验证「插件工具真的进了会话」。
 *
 * 这里用的是真实的 `createAgentSession`：只构造会话、不发请求，所以不需要真实模型调用，
 * 但工具注册表、扩展加载器、`setActiveToolsByName` 全都是生产路径。
 */

const roots: string[] = [];
let dataDir = "";
let config: AppConfig;
let pluginHost: PluginHost;
let agentHost: AgentHost;
/** 按用例改写对象配置，用来验证 `useTools` 关闭时的行为。 */
let peerOverride: PeerConfig | undefined;

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-session-"));
	roots.push(root);
	dataDir = join(root, "data");
	const agentDir = join(root, "agent");
	const pluginsDir = join(root, "plugins");
	await mkdir(dataDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(pluginsDir, { recursive: true });

	// 一个注册了工具的插件。
	const directory = join(pluginsDir, "test.dice");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "test.dice",
			name: "骰子",
			version: "0.1.0",
			entry: "./index.ts",
			permissions: ["tool:register"],
		}),
		"utf8",
	);
	await writeFile(
		join(directory, "index.ts"),
		`export default {
			id: "test.dice",
			setup(ctx) {
				ctx.tools.register({
					name: "roll_dice",
					description: "掷一个骰子",
					parameters: { properties: { sides: { type: "integer", description: "面数" } } },
					async execute(input) { return "掷出了 " + String(input.sides ?? 6); },
				});
			},
		};`,
		"utf8",
	);

	pluginHost = createPluginHost({
		pluginsDir,
		eventSource: { subscribe: () => () => undefined },
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		reservedToolNames: () => ["web_search", "read", "bash"],
	});
	await pluginHost.discover();
	await pluginHost.start("test.dice");

	config = createDefaultConfig();
	// 只造一个「看起来可用」的提供商：本测试不会真的发请求。
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
	config.tools.enabled = ["read"];

	agentHost = createAgentHost({
		dataDir,
		agentDir,
		getConfig: () => config,
		getPeerConfig: () => peerOverride,
		getPromptContext: () => undefined,
		getStickerContext: () => undefined,
		getSessions: () => [],
		stickerStore: new StickerStore(dataDir),
		mcpRuntime: new McpRuntime(),
		pluginTools: pluginHost.tools,
		pluginExtensions: pluginHost.extensions,
	});
});

afterAll(async () => {
	agentHost?.rebuildAgentSessions();
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

describe("插件工具进入 Agent 会话", () => {
	it("sessions 的激活工具集里包含插件注册的工具", async () => {
		const session = await agentHost.getAgentSession(runtimeSession());
		expect(session.getActiveToolNames()).toContain("roll_dice");
		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getAllTools().some((tool) => tool.name === "roll_dice")).toBe(true);
	});

	it("对象关闭 useTools 后不激活任何工具，插件工具也随之消失", async () => {
		peerOverride = {
			botId: "bot-1",
			scope: "group",
			peerId: "group-1",
			name: "测试群",
			personaId: "default",
			providerId: "test-provider",
			modelId: "test-model",
			useTools: false,
			features: { activeReply: false },
		};
		const session = await agentHost.getAgentSession(runtimeSession({ id: "session-2" }));
		expect(session.getActiveToolNames()).not.toContain("roll_dice");
		peerOverride = undefined;
	});
});

describe("插件停用后会话不再提供该工具", () => {
	it("停用并重建会话后，激活工具集里没有插件工具", async () => {
		await pluginHost.stop("test.dice");
		agentHost.rebuildAgentSessions();

		const session = await agentHost.getAgentSession(runtimeSession({ id: "session-3" }));
		expect(session.getActiveToolNames()).not.toContain("roll_dice");
	});
});
