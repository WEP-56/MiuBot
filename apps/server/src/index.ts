import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFilePluginConfig,
	createFileStorage,
	createPluginHost,
	type PluginHost,
} from "@miubot/plugin/host/index";
import { McpRuntime } from "@miubot/plugin/tools/index";
import { createAgentHost } from "./agent-host.ts";
import { createApiSecurity, loadOrCreateAuthToken } from "./api-security.ts";
import { createAppState } from "./app-state.ts";
import { createAuthService } from "./auth.ts";
import type { HttpContext } from "./http/context.ts";
import { createRequestHandler } from "./http/server.ts";
import { createWebAssets } from "./http/static.ts";
import { createRuntimeLogger } from "./logging.ts";
import { createInboundReferenceStore, createPluginLogger, createPluginSendBridge } from "./platform/plugin-bridge.ts";
import { createQqPlatform } from "./platform/runtime.ts";
import { createProactive } from "./proactive.ts";
import { createQqConnection, type QqConnection } from "./qq/connection.ts";
import { createInboundHandler } from "./qq/inbound.ts";
import { sessionPromptContexts, stickerSendContexts } from "./session-context.ts";
import { createStickerTagging } from "./sticker-tagging.ts";
import { StickerStore } from "./stickers.ts";
import { auxiliaryToolNames, toolNames } from "./tool-names.ts";
import { createUpdateChecker } from "./update-check.ts";
import { resolveVersion } from "./version.ts";

/**
 * 进程入口与组合根。
 *
 * 这里只做三件事：确定路径与端口、把子系统装配起来、启动 HTTP 与管理 API。
 * 具体职责在各自模块：路由 `http/`、状态持久化 `app-state.ts`、QQ 连接 `qq/connection.ts`、
 * 入站流水线 `qq/inbound.ts`、群聊插话 `proactive.ts`、表情包打标 `sticker-tagging.ts`。
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * 数据目录：默认 `apps/server/.miubot`。
 *
 * `MIUBOT_DATA_DIR` 是容器化 / 只读根文件系统的前提：把配置、会话、插件数据挂到
 * `/var/lib/miubot` 这样的独立卷上，仓库目录就可以是只读的。
 */
const dataDir = resolve(process.env.MIUBOT_DATA_DIR?.trim() || join(root, ".miubot"));
const logsPath = join(dataDir, "runtime.log");
const agentDir = join(dataDir, "agent");
/** 插件目录：每个子目录一个插件，含 `miubot.plugin.json` 与入口。 */
const pluginsDir = join(dataDir, "plugins");
/** 随仓库分发的内置插件；用户插件目录里的同名插件会被忽略。 */
const builtinPluginsDir = join(root, "..", "..", "plugins");
/** 插件存储命名空间根目录；每个插件一个 JSON 文件。 */
const pluginStorageDir = join(dataDir, "plugin-data");
/**
 * 插件配置目录，与 `plugin-data/` 分开：配置是管理员填的少量设置，数据是插件的业务状态。
 * 卸载插件时「保留数据」不该顺手保住配置（反之亦然），所以从目录上就分开。
 */
const pluginConfigDir = join(dataDir, "plugin-config");
const port = Number(process.env.MIUBOT_PORT ?? 8787);
/**
 * 监听地址。默认只监听回环：公网部署时由 nginx / Caddy 终结 TLS 再转发过来，
 * 应用本身仍然不直接对公网开口。
 */
const listenHost = process.env.MIUBOT_HOST?.trim() || "127.0.0.1";
/** 允许的 `Host`（对外域名，可带端口）。为空 = 只接受回环。不支持通配符。 */
const allowedHosts = splitList(process.env.MIUBOT_ALLOWED_HOSTS);
const extraOrigins = splitList(process.env.MIUBOT_ALLOWED_ORIGINS);
/**
 * 会话 Cookie 的 `Secure`：HTTPS 部署必须开。
 *
 * 默认按「配了对外域名」推断——那正是把服务放到 TLS 后面的标志；纯 HTTP
 * （SSH 隧道、内网）保持关闭，否则浏览器不保存 Cookie，登录会变成无限重定向。
 * `MIUBOT_COOKIE_SECURE` 可显式覆盖。
 */
const secureCookies = resolveSecureCookies(allowedHosts);

/** 运行日志：内存最近 1000 条 + `runtime.log` 追加写入。 */
const logger = createRuntimeLogger({ filePath: logsPath, dir: dataDir });
const log = logger.write;

for (const entry of allowedHosts) {
	if (entry.includes("*")) log("WARN", `MIUBOT_ALLOWED_HOSTS 不支持通配符，已忽略：${entry}`);
}
const auth = await createAuthService({ dataDir, secureCookies });
/** 管理 API 令牌：只给自动化脚本用（`Authorization: Bearer`），不再换浏览器 Cookie。 */
const authTokenPath = join(dataDir, "api-token");
const apiSecurity = createApiSecurity({
	port,
	token: await loadOrCreateAuthToken(authTokenPath),
	allowedHosts,
	extraOrigins,
	secureCookies,
	verifySession: (token) => auth.verify(token),
});
/** 工作台静态产物：与 API 同源托管，部署拓扑收敛成一个端口。 */
const assets = createWebAssets(resolve(process.env.MIUBOT_WEB_DIST?.trim() || join(root, "..", "web", "dist")));

/** 当前版本：镜像/发布包由 CI 注入，源码直接跑时回落到 package.json。 */
const version = resolveVersion();
/**
 * 内置更新检查：只提示，不自动升级。
 * `MIUBOT_UPDATE_CHECK=0` 可关（完全不出站）；`MIUBOT_UPDATE_REPO` 供 fork 改仓库。
 */
const updates = createUpdateChecker({
	currentVersion: version,
	repo: process.env.MIUBOT_UPDATE_REPO?.trim() || undefined,
	enabled: !isDisabled(process.env.MIUBOT_UPDATE_CHECK),
});

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
	// 安装目标只能是用户目录：内置目录在仓库里，装进去会被 git 看见、升级时被覆盖。
	installDir: pluginsDir,
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
	configFor: (pluginId) => createFilePluginConfig({ root: pluginConfigDir, pluginId }),
	/**
	 * 卸载时删除插件的持久化资源。
	 *
	 * 数据与配置分别由路由按用户勾选决定，这里只负责落手：两个目录分开存，就是为了
	 * 「删代码保留数据」和「连配置一起清掉」能各自成立。
	 */
	deleteAssets: async (pluginId, options) => {
		if (options.data) await rm(join(pluginStorageDir, `${pluginId}.json`), { force: true });
		if (options.config) await rm(join(pluginConfigDir, `${pluginId}.json`), { force: true });
	},
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
	// 同理，插件贡献的对话钩子也按 Bot 过滤，并且只在会话创建时取一次。
	pluginExtensions: pluginHost.extensions,
	log: (level, text) => log(level, text),
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
	auth,
	version,
	updates,
	plugins: {
		list: pluginHost.list,
		get: pluginHost.get,
		discover: pluginHost.discover,
		start: pluginHost.start,
		stop: pluginHost.stop,
		reload: pluginHost.reload,
		config: { inspect: pluginHost.config.inspect, save: pluginHost.config.save },
		install: pluginHost.install,
		importArchive: pluginHost.importArchive,
		uninstall: pluginHost.uninstall,
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
await logger.load();
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

log("INFO", `Miubot ${version}`);
log("INFO", `数据目录：${dataDir}`);
log("INFO", `管理面：http://${listenHost}:${port}；允许的 Host：${allowedHosts.join(", ") || "仅回环"}`);
log("INFO", `管理员口令：${describePasswordSource(auth)}（${auth.passwordPath}）`);
if (auth.generatedPassword) {
	// 只写进程输出，不进 runtime.log：日志页会被工作台展示、也会随备份一起走，
	// 不该长期留着管理员口令。journalctl / docker compose logs 里仍然能看到。
	console.warn(`[WARN] 已生成管理员口令：${auth.generatedPassword}`);
	log("WARN", "已生成管理员口令（只打印在进程输出里，未写入运行日志）；请立刻登录工作台并修改。");
}
log("INFO", `自动化令牌（仅请求头，不用于浏览器）：${authTokenPath}`);
if ((await assets.index()) === undefined)
	log("WARN", `未找到工作台构建产物：${assets.distDir}/index.html（开发时用 vite dev，部署前先构建）`);
log("INFO", "Miubot Server 已启动");

const server = createServer(createRequestHandler({ context: httpContext, security: apiSecurity, assets }));
server.listen(port, listenHost, () => console.log(`Miubot server listening on http://${listenHost}:${port}`));
// 启动后预热一次更新检查（失败静默）：工作台第一次打开就有结果，不用等一次往返。
updates.warm();

/**
 * 优雅退出：systemd 停服务发 SIGTERM，默认行为是直接杀进程——QQ Gateway 会留在
 * 「已连接」状态直到服务端超时，重启后还会撞上旧会话。
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log("INFO", `收到 ${signal}，正在退出`);
	for (const bot of state.getConfig().qqBots) connection.stop(bot.id);
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	log("INFO", "Miubot Server 已停止");
	// 最后一行日志也要落盘：flush 放在「已停止」之后。
	await Promise.allSettled([
		logger.flush(),
		auth.flush(),
		state.saveConfig(),
		state.saveSessions(),
		state.savePeers(),
		state.saveProactiveUsage(),
	]);
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/** 逗号分隔的环境变量列表；去掉空白与空项。 */
function splitList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** `0` / `false` / `no` / `off` 视为关闭；未设置视为开启。 */
function isDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function resolveSecureCookies(allowedHosts: string[]): boolean {
	const explicit = process.env.MIUBOT_COOKIE_SECURE?.trim().toLowerCase();
	if (explicit) return explicit !== "0" && explicit !== "false" && explicit !== "no";
	return allowedHosts.length > 0;
}

function describePasswordSource(service: { passwordSource: string }): string {
	switch (service.passwordSource) {
		case "env-hash":
			return "来自 MIUBOT_PASSWORD_HASH";
		case "env-password":
			return "来自 MIUBOT_ADMIN_PASSWORD（未落盘）";
		case "file":
			return "来自口令文件";
		default:
			return "首次启动生成";
	}
}
