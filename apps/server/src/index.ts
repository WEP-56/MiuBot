import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileStorage, createPluginHost, type PluginHost } from "@miubot/plugin/host/index";
import { McpRuntime } from "@miubot/plugin/tools/index";
import { createAgentHost } from "./agent-host.ts";
import { createApiSecurity, loadOrCreateAuthToken } from "./api-security.ts";
import { createAppState } from "./app-state.ts";
import type { HttpContext } from "./http/context.ts";
import { createRequestHandler } from "./http/server.ts";
import { createRuntimeLogger, type RuntimeLog } from "./logging.ts";
import { createInboundReferenceStore, createPluginLogger, createPluginSendBridge } from "./platform/plugin-bridge.ts";
import { createQqPlatform } from "./platform/runtime.ts";
import { createProactive } from "./proactive.ts";
import { createQqConnection, type QqConnection } from "./qq/connection.ts";
import { createInboundHandler } from "./qq/inbound.ts";
import { sessionPromptContexts, stickerSendContexts } from "./session-context.ts";
import { createStickerTagging } from "./sticker-tagging.ts";
import { StickerStore } from "./stickers.ts";
import { auxiliaryToolNames, toolNames } from "./tool-names.ts";

/**
 * 进程入口与组合根。
 *
 * 这里只做三件事：确定路径与端口、把子系统装配起来、启动 HTTP 与管理 API。
 * 具体职责在各自模块：路由 `http/`、状态持久化 `app-state.ts`、QQ 连接 `qq/connection.ts`、
 * 入站流水线 `qq/inbound.ts`、群聊插话 `proactive.ts`、表情包打标 `sticker-tagging.ts`。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, ".miubot");
const logsPath = join(dataDir, "runtime.log");
const agentDir = join(dataDir, "agent");
/** 插件目录：每个子目录一个插件，含 `miubot.plugin.json` 与入口。 */
const pluginsDir = join(dataDir, "plugins");
/** 随仓库分发的内置插件；用户插件目录里的同名插件会被忽略。 */
const builtinPluginsDir = join(root, "..", "..", "plugins");
/** 插件存储命名空间根目录；每个插件一个 JSON 文件。 */
const pluginStorageDir = join(dataDir, "plugin-data");
const port = Number(process.env.MIUBOT_PORT ?? 8787);
/** 管理 API 令牌文件：只有本机进程可读，浏览器通过 HttpOnly Cookie 使用它。 */
const authTokenPath = join(dataDir, "api-token");
const apiSecurity = createApiSecurity({
	port,
	token: await loadOrCreateAuthToken(authTokenPath),
	extraOrigins: (process.env.MIUBOT_ALLOWED_ORIGINS ?? "").split(","),
});

/** 运行日志：内存最近 1000 条 + `runtime.log` 追加写入。 */
const logger = createRuntimeLogger({ filePath: logsPath, dir: dataDir });
const log = logger.write;

const state = createAppState({ dataDir });
const stickerStore = new StickerStore(dataDir);
const mcpRuntime = new McpRuntime();

/**
 * 装配顺序有依赖：插件宿主先建（Agent 会话要从中取插件工具），
 * 平台对象又要早于插件宿主（事件总线是插件的订阅源），因此平台排在中间。
 * `connection` 仍需留声明：平台与插件桥的回调只在运行时才用到它。
 */
let connection: QqConnection;
const platform = createQqPlatform({
	onEventError: (error, type, eventType) =>
		log(
			"ERROR",
			`平台事件订阅失败（${type} / ${eventType}）：${error instanceof Error ? error.message : String(error)}`,
		),
	onSendError: (error) => log("WARN", `发送消息失败：${error instanceof Error ? error.message : String(error)}`),
	resolveBotId: (bot) => state.getConfig().qqBots.find((item) => connection.client(item.id) === bot)?.id,
});
/** 入站消息引用：让插件回复尽量走被动回复，而不是主动推送。 */
const inboundReferences = createInboundReferenceStore();
const pluginHost: PluginHost = createPluginHost({
	// 内置插件优先：同名 id 以仓库内的为准，用户目录用于放自己的插件。
	pluginsDir: [builtinPluginsDir, pluginsDir],
	eventSource: platform.eventBus,
	sendMessage: createPluginSendBridge(
		{
			channelForBotId: (botId) => {
				const bot = connection.client(botId);
				return bot ? platform.channelFor(bot) : undefined;
			},
			onError: (error, detail) =>
				log(
					"WARN",
					`插件发送失败（${detail.botId} → ${detail.target.scope}:${detail.target.targetId}）：${error instanceof Error ? error.message : String(error)}`,
				),
		},
		inboundReferences,
	),
	storageFor: (pluginId) => createFileStorage({ root: pluginStorageDir, pluginId }),
	logger: createPluginLogger((level, text) => log(level, text)),
	// 插件工具不能覆盖内置 / MCP 工具：同名会让模型「以为在调内置工具、实际跑了插件代码」。
	reservedToolNames: () => [
		...toolNames,
		...auxiliaryToolNames,
		...mcpRuntime.getEnabledToolDefinitions().map((tool) => tool.name),
	],
});

const agentHost = createAgentHost({
	dataDir,
	agentDir,
	getConfig: state.getConfig,
	getPeerConfig: state.getPeerConfig,
	getPromptContext: (sessionId) => sessionPromptContexts.get(sessionId),
	getStickerContext: (sessionId) => stickerSendContexts.get(sessionId),
	getSessions: state.getSessions,
	stickerStore,
	mcpRuntime,
	// 按会话所属 Bot 过滤：manifest 里声明只服务某个 Bot 的插件，不能把工具暴露给别的 Bot。
	pluginTools: pluginHost.tools,
});
const stickerTagging = createStickerTagging({
	getConfig: state.getConfig,
	stickerStore,
	agentHost,
	log,
});

const proactive = createProactive({
	state,
	agentHost,
	platform,
	getClient: (botId) => connection.client(botId),
	log,
});
const inbound = createInboundHandler({
	state,
	agentHost,
	platform,
	stickerTagging,
	proactive,
	inboundReferences,
	stickerStore,
	log,
});
connection = createQqConnection({
	getConfig: state.getConfig,
	saveConfig: state.saveConfig,
	platform,
	pluginHost,
	onMessage: inbound,
});

/**
 * 管理 API 的依赖上下文。
 *
 * 路由模块只通过这里访问运行时状态：`config` / `sessions` 会被整体替换，
 * 因此一律走 get/replace，不允许路由各自持有引用。
 */
const httpContext: HttpContext = {
	config: { get: state.getConfig, replace: state.setConfig, save: state.saveConfig },
	sessions: {
		get: state.getSessions,
		replace: state.setSessions,
		save: state.saveSessions,
		create: state.createSession,
	},
	peers: {
		get: state.getPeers,
		find: state.getPeerConfig,
		ensure: state.createPeerConfig,
		save: state.savePeers,
	},
	agentHost,
	mcpRuntime,
	plugins: {
		list: pluginHost.list,
		get: pluginHost.get,
		discover: pluginHost.discover,
		start: pluginHost.start,
		stop: pluginHost.stop,
		reload: pluginHost.reload,
		directories: [builtinPluginsDir, pluginsDir],
	},
	stickers: { store: stickerStore, scheduleTagging: stickerTagging.schedule, resetTagging: stickerTagging.reset },
	proactive: { metrics: proactive.metrics, decisions: proactive.decisions, sentToday: proactive.sentToday },
	qq: {
		states: connection.states,
		qr: connection.qr,
		test: connection.test,
		activate: connection.activate,
		stop: connection.stop,
		startQr: connection.startQr,
	},
	logs: { list: logger.list },
	agentDir,
	log,
};

await state.load();
try {
	logger.restore(
		(await readFile(logsPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.slice(-1000)
			.map((line) => JSON.parse(line) as RuntimeLog),
	);
} catch {
	logger.restore([]);
}
stickerTagging.schedule(10_000);
mcpRuntime.setGlobalToolsEnabled(state.getConfig().tools.mcpEnabled);
await mcpRuntime.replace(state.getConfig().mcpServers);

// 先发现全部插件（含失效目录，便于诊断），再按配置启停。
const configuredPlugins = state.getConfig().plugins;
const discoveredPlugins = await pluginHost.discover();
for (const plugin of discoveredPlugins) {
	if (plugin.error) log("WARN", `插件不可用：${plugin.id}；${plugin.error}`);
}
// `enabled` 为空表示全部启用；`disabled` 始终优先。装好插件却毫无反应比误启用更难排查。
const pluginAllowlist = configuredPlugins.enabled.length > 0 ? configuredPlugins.enabled : undefined;
for (const plugin of discoveredPlugins) {
	if (plugin.error) continue;
	if (configuredPlugins.disabled.includes(plugin.id)) {
		log("INFO", `插件 ${plugin.id} 已在配置中禁用，跳过启用`);
		continue;
	}
	if (pluginAllowlist && !pluginAllowlist.includes(plugin.id)) continue;
	const status = await pluginHost.start(plugin.id);
	if (status?.state === "active") continue;
	if (status) log("WARN", `插件 ${plugin.id} 未能启用：${status.error ?? status.state}`);
}
const activePluginCount = pluginHost.list().filter((plugin) => plugin.state === "active").length;
log("INFO", `插件加载完成：${activePluginCount}/${discoveredPlugins.length} 个启用`);

const activeBot = state.getConfig().qqBots.find((bot) => bot.enabled);
if (activeBot?.appId && activeBot.appSecret) void connection.connect(activeBot);
log("INFO", "Miubot Server 已启动");
log("INFO", `管理 API 仅接受本机工作台访问；令牌文件：${authTokenPath}`);
createServer(createRequestHandler({ context: httpContext, security: apiSecurity })).listen(port, "127.0.0.1", () =>
	console.log(`Miubot server listening on http://127.0.0.1:${port}`),
);
