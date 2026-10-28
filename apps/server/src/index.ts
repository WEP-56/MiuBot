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
import { createAuditLog } from "./audit.ts";
import { createAuthService } from "./auth.ts";
import { createBuiltinCommands, createCommandDispatcher, createCommandRegistry } from "./commands/index.ts";
import type { HttpContext } from "./http/context.ts";
import { createRequestHandler } from "./http/server.ts";
import { createWebAssets } from "./http/static.ts";
import { createRuntimeLogger } from "./logging.ts";
import { createMemoryDreamService, createMemoryStore } from "./memory.ts";
import { isPeerKey } from "./peer-key.ts";
import { createInboundReferenceStore, createPluginLogger, createPluginSendBridge } from "./platform/plugin-bridge.ts";
import { createQqPlatform } from "./platform/runtime.ts";
import { createProactive } from "./proactive.ts";
import { createQqConnection, type QqConnection } from "./qq/connection.ts";
import { createInboundHandler } from "./qq/inbound.ts";
import { isGlobalSilenceActive } from "./runtime.ts";
import { createScheduler } from "./scheduler.ts";
import { memorySpeakerContexts, sessionPromptContexts, stickerSendContexts } from "./session-context.ts";
import { createStickerTagging } from "./sticker-tagging.ts";
import { StickerStore } from "./stickers.ts";
import { enqueueForTarget } from "./target-queue.ts";
import { toolDisplayName } from "./tool-display.ts";
import { auxiliaryToolNames, isNativeTool, toolNames } from "./tool-names.ts";
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
/**
 * 入站白名单（`group:<群 ID>` / `c2c:<用户 ID>`，逗号分隔）。
 *
 * 设了就以环境变量为准：工作台里改不动，避免「UI 显示一套、实际生效另一套」。
 */
const envAllowedPeers = parsePeerList(process.env.MIUBOT_ALLOWED_PEERS);
/** 整体禁用文件与命令类工具（`bash` / `write` / `edit` / `read` …），公网部署的保险丝。 */
const disableNativeTools = isDisabled(process.env.MIUBOT_DISABLE_NATIVE_TOOLS);

for (const entry of allowedHosts) {
	if (entry.includes("*")) log("WARN", `MIUBOT_ALLOWED_HOSTS 不支持通配符，已忽略：${entry}`);
}
/**
 * 审计日志：登录/登出/改密 + 所有变更类管理请求。
 *
 * 与运行日志分开存：运行日志会被工作台轮询、也会随 issue 贴出去，而审计要回答的是
 * 「这条配置是谁什么时候改的」，得留得住、冲不掉。
 */
const audit = createAuditLog({ filePath: join(dataDir, "audit.log"), dir: dataDir });
const auth = await createAuthService({
	dataDir,
	secureCookies,
	onAudit: (action, detail) => audit.record({ action, actor: "admin", detail }),
});
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
const memoryStore = createMemoryStore(dataDir);
const stickerStore = new StickerStore(dataDir);
const mcpRuntime = new McpRuntime();

/**
 * 进程启动时间：`/admin` 用它算运行时长。取在装配之前，等于「进程开始工作」的时刻。
 */
const startedAt = Date.now();
/**
 * 内置斜杠命令。
 *
 * 先建它再建插件宿主：宿主需要内置命令名做查重（插件不能覆盖 `/new` 这类入口）。
 * `summary` 是闭包，只在真的有人敲 `/admin` 时求值，因此可以引用后面才装配的子系统。
 */
const builtinCommands = createBuiltinCommands({
	version,
	startedAt,
	summary: () => ({
		bots: {
			connected: [...connection.states.values()].filter((item) => item.phase === "connected").length,
			total: state.getConfig().qqBots.length,
		},
		plugins: {
			active: pluginHost.list().filter((plugin) => plugin.state === "active").length,
			total: pluginHost.list().length,
		},
		admins: state.getConfig().admins.length,
	}),
});

/**
 * 装配顺序有依赖：插件宿主先建（Agent 会话要从中取插件工具），
 * 平台对象又要早于插件宿主（事件总线是插件的订阅源），因此平台排在中间。
 * `connection` 仍需留声明：平台与插件桥的回调只在运行时才用到它。
 */
let connection: QqConnection;
let agentHost: ReturnType<typeof createAgentHost>;
const scheduler = createScheduler({
	dataDir,
	isPaused: () => isGlobalSilenceActive(state.getConfig().globalSilence),
	getSession: (id) => state.getSessions().find((session) => session.id === id),
	getAllowedTools: (id) => {
		const session = state.getSessions().find((item) => item.id === id);
		return session && agentHost ? agentHost.activeToolsForSession(session) : [];
	},
	execute: async (task) => {
		const session = state.getSessions().find((item) => item.id === task.sessionId);
		if (isGlobalSilenceActive(state.getConfig().globalSilence)) return;
		if (!session) throw new Error("绑定的会话不存在");
		const bot = connection.client(session.botId);
		if (!bot) throw new Error("绑定会话的 QQ Bot 未连接");
		await enqueueForTarget(`${session.botId}:${session.scope}:${session.peerId}`, async () => {
			const channel = platform.channelFor(bot);
			const target = { scope: session.scope, targetId: session.peerId };
			const agentSession = await agentHost.getAgentSession(session);
			const previousTools = agentSession.getActiveToolNames();
			agentSession.setActiveToolsByName(
				task.allowedTools.filter((name) => agentHost.activeToolsForSession(session).includes(name)),
			);
			sessionPromptContexts.set(session.id, `这是定时任务「${task.name}」的执行。按任务 Prompt 完成工作。`);
			stickerSendContexts.set(session.id, { bot, target, channel });
			session.messages.push({
				role: "user",
				content: `【定时任务：${task.name}】${task.prompt}`,
				timestamp: new Date().toISOString(),
			});
			await state.saveSessions();
			const answers: string[] = [];
			const peer = state.getPeerConfig(session.scope, session.peerId, session.botId);
			let deliveryQueue = Promise.resolve();
			const unsubscribe = agentSession.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const text = event.message.content
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("\n")
						.trim();
					if (text) answers.push(text);
				}
				if (event.type === "tool_execution_start" && peer?.features.showToolActivity)
					deliveryQueue = deliveryQueue
						.then(async () => {
							await channel.sendText(target, `正在使用「${toolDisplayName(event.toolName)}」…`);
						})
						.catch((error: unknown) => log("WARN", `定时任务 Tool 状态发送失败：${String(error)}`, session.id));
				if (event.type === "tool_execution_end" && peer?.features.showToolActivity) {
					const duration = event.durationMs === undefined ? "" : `（${(event.durationMs / 1000).toFixed(1)} 秒）`;
					deliveryQueue = deliveryQueue
						.then(async () => {
							await channel.sendText(
								target,
								`「${toolDisplayName(event.toolName)}」${event.isError ? "执行失败" : "执行成功"}${duration}`,
							);
						})
						.catch((error: unknown) => log("WARN", `定时任务 Tool 状态发送失败：${String(error)}`, session.id));
				}
			});
			try {
				await agentSession.prompt(task.prompt);
				await deliveryQueue;
				for (const answer of answers) {
					session.messages.push({ role: "assistant", content: answer, timestamp: new Date().toISOString() });
					await state.saveSessions();
					await channel.sendText(target, answer);
				}
				session.updatedAt = new Date().toISOString();
				await state.saveSessions();
			} finally {
				unsubscribe();
				agentSession.setActiveToolsByName(previousTools);
				sessionPromptContexts.delete(session.id);
				stickerSendContexts.delete(session.id);
			}
		});
	},
	log,
});
const platform = createQqPlatform({
	onEventError: (error, type, eventType) =>
		log(
			"ERROR",
			`平台事件订阅失败（${type} / ${eventType}）：${error instanceof Error ? error.message : String(error)}`,
		),
	onSendError: (error) => log("WARN", `发送消息失败：${error instanceof Error ? error.message : String(error)}`),
	resolveBotId: (bot) => state.getConfig().qqBots.find((item) => connection.client(item.id) === bot)?.id,
	isSilenced: () => isGlobalSilenceActive(state.getConfig().globalSilence),
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
	// 同理，插件命令不能覆盖内置命令：用户敲的是 `/名字`，抢到名字就等于换掉了实现。
	reservedCommandNames: () => builtinCommands.map((command) => command.name),
});

/**
 * 斜杠命令注册表：内置命令 + 存活插件命令，减去配置里禁用的。
 *
 * 禁用读的是配置而不是快照：工作台改完立即生效，不需要重启。
 */
const commandRegistry = createCommandRegistry({
	builtins: builtinCommands,
	plugins: { list: pluginHost.commands.list, find: pluginHost.commands.find },
	isDisabled: (name) => state.getConfig().commands.disabled.includes(name),
});

agentHost = createAgentHost({
	dataDir,
	agentDir,
	getConfig: state.getConfig,
	getPeerConfig: state.getPeerConfig,
	getPromptContext: (sessionId) => sessionPromptContexts.get(sessionId),
	getMemorySpeaker: (sessionId) => memorySpeakerContexts.get(sessionId),
	memoryStore,
	getStickerContext: (sessionId) => stickerSendContexts.get(sessionId),
	getSessions: state.getSessions,
	stickerStore,
	mcpRuntime,
	// 按会话所属 Bot 过滤：manifest 里声明只服务某个 Bot 的插件，不能把工具暴露给别的 Bot。
	pluginTools: pluginHost.tools,
	// 同理，插件贡献的对话钩子也按 Bot 过滤，并且只在会话创建时取一次。
	pluginExtensions: pluginHost.extensions,
	disableNativeTools,
	log: (level, text) => log(level, text),
	createScheduledTask: (sessionId, input) => scheduler.createTask({ ...input, sessionId }),
});
const memoryDream = createMemoryDreamService({
	store: memoryStore,
	getPeers: state.getPeers,
	savePeers: state.savePeers,
	getConfig: state.getConfig,
	isBusy: () => agentHost?.anyAgentLoopRunning() ?? false,
	log,
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
/**
 * 命令分发：权限判定与执行的唯一入口。
 *
 * 内置命令与插件命令都从这里过一遍，不因为来源不同而放宽；越权尝试会写审计。
 */
const commandDispatcher = createCommandDispatcher({
	state,
	agentHost,
	pluginCommands: pluginHost.commands,
	audit,
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
	commandRegistry,
	commandDispatcher,
	// 环境变量优先：设了 MIUBOT_ALLOWED_PEERS 就以它为准，工作台只读展示。
	allowedPeers: () => envAllowedPeers ?? state.getConfig().access.allowedPeers,
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
	audit,
	version,
	updates,
	envAllowedPeers,
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
	commands: { list: commandRegistry.list },
	proactive: { metrics: proactive.metrics, decisions: proactive.decisions, sentToday: proactive.sentToday },
	scheduler,
	memory: memoryStore,
	memoryDream,
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
await scheduler.load();
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
scheduler.start();
memoryDream.start();
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
// 公网部署最容易漏的两件事，启动时直接说出来，别等出事才发现。
const effectiveAllowedPeers = envAllowedPeers ?? state.getConfig().access.allowedPeers;
if (effectiveAllowedPeers.length === 0)
	log("WARN", "未配置入站白名单：任何群、任何私聊都能触发 Agent（工作台「设置 → 入站白名单」）");
else
	log(
		"INFO",
		`入站白名单：${effectiveAllowedPeers.length} 个会话${envAllowedPeers ? "（来自 MIUBOT_ALLOWED_PEERS）" : ""}`,
	);
const riskyTools = state.getConfig().tools.enabled.filter((name) => isNativeTool(name));
if (riskyTools.length > 0)
	log(
		"WARN",
		`已启用高危工具：${riskyTools.join("、")}——公网部署下这等于把服务器交给任何能给 Bot 发消息的人（提示注入 = RCE）`,
	);
if (disableNativeTools) log("WARN", "MIUBOT_DISABLE_NATIVE_TOOLS 已生效：文件与命令类工具全部禁用");
// 管理员名单为空是**刻意**的安全默认：没人能执行 `/admin` 这类命令。但不说出来，
// 用户会以为是命令坏了，所以启动时就点名。
if (state.getConfig().admins.length === 0)
	log("WARN", "未配置管理员：所有管理员命令（如 /admin）都不会响应（工作台「高级配置 → 斜杠命令」）");
else log("INFO", `管理员：${state.getConfig().admins.length} 人`);
const disabledCommands = state.getConfig().commands.disabled;
if (disabledCommands.length > 0)
	log("INFO", `已禁用斜杠命令：${disabledCommands.map((name) => `/${name}`).join("、")}`);
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
	scheduler.stop();
	memoryDream.stop();
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	log("INFO", "Miubot Server 已停止");
	// 最后一行日志也要落盘：flush 放在「已停止」之后。
	await Promise.allSettled([
		logger.flush(),
		audit.flush(),
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

/**
 * 解析 `MIUBOT_ALLOWED_PEERS`。未设置返回 `undefined`（表示「听配置的」）；
 * 设置了但一条都不合法时也返回 `undefined` 并告警——空值绝不能被理解成「放行全部」。
 */
function parsePeerList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const keys = splitList(value);
	const valid = keys.filter((key) => isPeerKey(key));
	for (const key of keys) {
		if (!isPeerKey(key)) log("WARN", `MIUBOT_ALLOWED_PEERS 条目格式无效，已忽略：${key}`);
	}
	if (valid.length === 0) {
		log("ERROR", "MIUBOT_ALLOWED_PEERS 没有任何合法条目，本次启动改为读取工作台里的配置");
		return undefined;
	}
	return [...new Set(valid)];
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
