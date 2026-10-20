import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { startQrConnect, type QrConnectCredentials } from "@tencent-connect/qqbot-connector";
import QRCode from "qrcode";
import { Type } from "typebox";
import type { ToolDefinition } from "@miubot/plugin/extensions/index";
import { createAgentSession } from "@miubot/session/sdk";
import type { AgentSession } from "@miubot/session/agent-session";
import { ModelRuntime } from "@miubot/session/model-runtime";
import { SessionManager } from "@miubot/session/session-manager";
import { createChatCompletion, createDefaultConfig, evaluateProactiveGate, type AppConfig, type ChatMessage, type ModelConfig, type PersonaConfig, type ProviderConfig, type QqBotConfig, type WebSearchProvider } from "./runtime.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, ".miubot");
const configPath = join(dataDir, "config.json");
const sessionsPath = join(dataDir, "sessions.json");
const peerConfigsPath = join(dataDir, "peer-configs.json");
const proactiveUsagePath = join(dataDir, "proactive-usage.json");
const logsPath = join(dataDir, "runtime.log");
const agentDir = join(dataDir, "agent");
const agentSessions = new Map<string, AgentSession>();
let modelRuntime: ModelRuntime | undefined;
const port = Number(process.env.MIUBOT_PORT ?? 8787);

let config: AppConfig = createDefaultConfig();
type RuntimeMessage = { role: "user" | "assistant"; content: string; sender?: string; timestamp: string };
type RuntimeSession = { id: string; scope: "group" | "c2c"; peerId: string; peerName: string; botId: string; title: string; personaId: string; personaName: string; personaPrompt: string; providerId: string; modelId: string; summary: string; compactedThrough: number; messages: RuntimeMessage[]; createdAt: string; updatedAt: string; active: boolean };
type PeerConfig = { botId: string; scope: "group" | "c2c"; peerId: string; personaId: string; providerId: string; modelId: string; useTools: boolean; features: { activeReply: boolean; stickers: boolean; imageGeneration: boolean; tts: boolean } };
type RuntimeLog = { time: string; level: "INFO" | "WARN" | "ERROR"; sessionId?: string; text: string };
let sessions: RuntimeSession[] = [];
let peerConfigs: PeerConfig[] = [];
let runtimeLogs: RuntimeLog[] = [];
let proactiveUsage = { date: "", sent: 0 };
const proactiveMetrics = { groupMessagesReceived: 0, candidates: 0, judgments: 0, planned: 0, sent: 0, blocked: 0 };
const proactiveDecisions: Array<{ time: string; groupId: string; sessionId?: string; result: string; reason: string }> = [];
const activeReplyWindows = new Map<string, { bot: QQBot; botConfig: QqBotConfig; groupId: string; messages: Array<{ sender: string; content: string }>; timer: ReturnType<typeof setTimeout> }>();
const activeReplyCooldowns = new Map<string, number>();
const gateNoticeDates = new Map<string, string>();
const targetQueues = new Map<string, Promise<void>>();
const qqBots = new Map<string, QQBot>();
const qqStates = new Map<string, { phase: "disconnected" | "connecting" | "connected" | "error"; appId?: string; error?: string; nickname?: string; avatarUrl?: string }>();
let qrStop: (() => void) | undefined;
let qrNickname = "QQ Bot";
let qrState: { phase: "idle" | "waiting" | "connected" | "failed"; url?: string; qrSvg?: string; error?: string } = {
	phase: "idle",
};

async function loadConfig(): Promise<void> {
	try {
		const stored = JSON.parse(await readFile(configPath, "utf8")) as Partial<AppConfig> & { qq?: { appId?: string; appSecret?: string; mode?: "qr" | "credentials" } };
		const qqBots = stored.qqBots ?? (stored.qq?.appId && stored.qq.appSecret ? [{ id: stored.qq.appId, nickname: "QQ Bot", avatarUrl: "", appId: stored.qq.appId, appSecret: stored.qq.appSecret, mode: stored.qq.mode ?? "credentials", enabled: true }] : []);
		const { qq: _legacyQq, ...current } = stored;
		const defaults = createDefaultConfig();
		const savedTools = current.tools as Partial<AppConfig["tools"]> | undefined;
		config = {
			...defaults,
			...current,
			qqBots: qqBots.map((bot) => ({ ...bot, nickname: bot.nickname || "QQ Bot", avatarUrl: bot.avatarUrl || "" })),
			tools: {
				enabled: Array.isArray(savedTools?.enabled) ? savedTools.enabled : defaults.tools.enabled,
				webSearch: {
					provider: savedTools?.webSearch?.provider ?? defaults.tools.webSearch.provider,
					apiKeys: { ...defaults.tools.webSearch.apiKeys, ...savedTools?.webSearch?.apiKeys },
				},
			},
			proactiveGate: { ...defaults.proactiveGate, ...current.proactiveGate },
		};
		if (!stored.qqBots && stored.qq) await saveConfig();
		if (config.qqBots.filter((bot) => bot.enabled).length > 1) {
			let keptEnabled = false;
			config.qqBots = config.qqBots.map((bot) => {
				if (!bot.enabled) return bot;
				if (keptEnabled) return { ...bot, enabled: false };
				keptEnabled = true;
				return bot;
			});
			await saveConfig();
		}
	} catch {
		await saveConfig();
	}
}

async function loadRuntimeData(): Promise<void> {
	try {
		const stored = JSON.parse(await readFile(sessionsPath, "utf8")) as Array<Partial<RuntimeSession> & Pick<RuntimeSession, "id" | "scope" | "peerId" | "peerName" | "botId" | "title" | "personaId" | "createdAt" | "updatedAt" | "active">>;
		sessions = stored.map((session) => { const persona = config.personas.find((item) => item.id === session.personaId); const defaultModel = getDefaultModel(); return { ...session, personaName: session.personaName ?? persona?.name ?? "已删除的人格", personaPrompt: session.personaPrompt ?? persona?.systemPrompt ?? "你是一个友善的中文聊天助手。", providerId: session.providerId ?? defaultModel?.provider.id ?? "", modelId: session.modelId ?? defaultModel?.model.id ?? "", summary: session.summary ?? "", compactedThrough: session.compactedThrough ?? 0, messages: session.messages ?? [] }; });
	} catch { sessions = []; }
	try {
		const stored = JSON.parse(await readFile(peerConfigsPath, "utf8")) as Array<Partial<PeerConfig> & Pick<PeerConfig, "botId" | "scope" | "peerId" | "personaId" | "providerId" | "modelId">>;
		peerConfigs = Array.isArray(stored) ? stored.map((item) => ({ ...item, useTools: item.useTools ?? true, features: { activeReply: false, stickers: false, imageGeneration: false, tts: false, ...item.features } })) : [];
	} catch { peerConfigs = []; }
	try { proactiveUsage = JSON.parse(await readFile(proactiveUsagePath, "utf8")) as typeof proactiveUsage; } catch { proactiveUsage = { date: "", sent: 0 }; }
	try { runtimeLogs = (await readFile(logsPath, "utf8")).split("\n").filter(Boolean).slice(-1000).map((line) => JSON.parse(line) as RuntimeLog); } catch { runtimeLogs = []; }
}

async function saveConfig(): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

async function saveSessions(): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(sessionsPath, JSON.stringify(sessions, null, 2), "utf8");
}

async function savePeerConfigs(): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(peerConfigsPath, JSON.stringify(peerConfigs, null, 2), "utf8");
}

async function saveProactiveUsage(): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(proactiveUsagePath, JSON.stringify(proactiveUsage, null, 2), "utf8");
}

function log(level: RuntimeLog["level"], text: string, sessionId?: string): void {
	const entry: RuntimeLog = { time: new Date().toISOString(), level, text, ...(sessionId ? { sessionId } : {}) };
	runtimeLogs.push(entry);
	if (runtimeLogs.length > 1000) runtimeLogs = runtimeLogs.slice(-1000);
	void mkdir(dataDir, { recursive: true }).then(() => appendFile(logsPath, `${JSON.stringify(entry)}\n`, "utf8"));
	console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info"](`[${level}] ${text}`);
}

function publicSession(session: RuntimeSession): Omit<RuntimeSession, "messages" | "summary"> & { messageCount: number; summaryConfigured: boolean } {
	const { messages, summary, ...item } = session;
	return { ...item, messageCount: messages.length, summaryConfigured: Boolean(summary) };
}

function getPeerConfig(scope: PeerConfig["scope"], peerId: string, botId: string): PeerConfig | undefined {
	return peerConfigs.find((item) => item.scope === scope && item.peerId === peerId && item.botId === botId);
}

function getDefaultModel(): { provider: ProviderConfig; model: ModelConfig } | undefined {
	for (const provider of config.providers) {
		if (!provider.enabled || !provider.apiKey) continue;
		const model = provider.models[0];
		if (model) return { provider, model };
	}
	return undefined;
}

function createSession(scope: RuntimeSession["scope"], peerId: string, peerName: string, botId: string): RuntimeSession {
	const now = new Date().toISOString();
	const peerConfig = getPeerConfig(scope, peerId, botId);
	const persona = config.personas.find((item) => item.id === peerConfig?.personaId) ?? config.personas.find((item) => item.id === config.activePersonaId) ?? config.personas[0];
	const modelConfig = peerConfig && config.providers.find((item) => item.id === peerConfig.providerId && item.enabled && item.apiKey)?.models.find((item) => item.id === peerConfig.modelId);
	const defaultModel = modelConfig ? { provider: config.providers.find((item) => item.id === peerConfig?.providerId) as ProviderConfig, model: modelConfig } : getDefaultModel();
	const session: RuntimeSession = { id: crypto.randomUUID(), scope, peerId, peerName, botId, title: "新会话", personaId: persona?.id ?? "default", personaName: persona?.name ?? "默认人格", personaPrompt: persona?.systemPrompt ?? "你是一个友善的中文聊天助手。", providerId: defaultModel?.provider.id ?? "", modelId: defaultModel?.model.id ?? "", summary: "", compactedThrough: 0, messages: [], createdAt: now, updatedAt: now, active: true };
	for (const item of sessions) if (item.scope === scope && item.peerId === peerId && item.botId === botId) item.active = false;
	sessions.unshift(session);
	return session;
}

const nativeToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
const toolNames = [...nativeToolNames, "web_search"];
const toolCatalog = [
	{ name: "web_search", label: "网页搜索", description: "使用 Tavily、Brave、Exa 或 Serper 搜索公开网页。", configurable: true },
	{ name: "read", label: "读取文件", description: "读取工作区文件内容。" },
	{ name: "bash", label: "Bash", description: "在服务器工作目录执行 Bash 命令。" },
	{ name: "powershell", label: "PowerShell", description: "在服务器工作目录执行 PowerShell 命令。" },
	{ name: "edit", label: "编辑文件", description: "对工作区文件进行局部修改。" },
	{ name: "write", label: "写入文件", description: "创建或覆盖工作区文件。" },
	{ name: "grep", label: "内容搜索", description: "在工作区文件中搜索文本。" },
	{ name: "find", label: "查找文件", description: "按名称或模式查找工作区文件。" },
	{ name: "ls", label: "列出目录", description: "查看工作区目录内容。" },
];
const webSearchSchema = Type.Object({ query: Type.String({ description: "Search query" }), count: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of results" })) });

function createWebSearchTool(): ToolDefinition<typeof webSearchSchema> {
	return {
		name: "web_search", label: "Web Search", description: "Search the public web and return titles, URLs, and short snippets.", promptSnippet: "Search the web for current information", defaultActive: true, parameters: webSearchSchema,
		async execute(_id, params, signal) {
			const provider = config.tools.webSearch.provider; const apiKey = config.tools.webSearch.apiKeys[provider];
			if (!apiKey) return { content: [{ type: "text", text: `Configure a ${provider} API key in Advanced > Tools first.` }], details: {}, isError: true };
			const count = Math.min(10, Math.max(1, params.count ?? 5));
			let endpoint: string; let headers: Record<string, string>; let payload: unknown;
			switch (provider) {
				case "tavily": endpoint = "https://api.tavily.com/search"; headers = { "content-type": "application/json" }; payload = { api_key: apiKey, query: params.query, max_results: count, include_answer: false }; break;
				case "brave": endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`; headers = { "x-subscription-token": apiKey, accept: "application/json" }; payload = undefined; break;
				case "exa": endpoint = "https://api.exa.ai/search"; headers = { "content-type": "application/json", "x-api-key": apiKey }; payload = { query: params.query, numResults: count, contents: { text: { maxCharacters: 1200 } } }; break;
				case "serper": endpoint = "https://google.serper.dev/search"; headers = { "content-type": "application/json", "x-api-key": apiKey }; payload = { q: params.query, num: count }; break;
			}
			try {
				const response = await fetch(endpoint, { method: payload === undefined ? "GET" : "POST", headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal });
				const data: unknown = await response.json(); if (!response.ok) return { content: [{ type: "text", text: `Search provider returned HTTP ${response.status}` }], details: {}, isError: true };
				const object = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
				const rawResults = provider === "tavily" ? object.results : provider === "brave" ? (object.web as { results?: unknown[] } | undefined)?.results : provider === "exa" ? object.results : object.organic;
				const results = Array.isArray(rawResults) ? rawResults.slice(0, count).map((item) => {
					const result = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
					return { title: String(result.title ?? ""), url: String(result.url ?? result.link ?? ""), snippet: String(result.content ?? result.description ?? result.snippet ?? result.text ?? "") };
				}) : [];
				return { content: [{ type: "text", text: results.length ? results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n") : "No results found." }], details: {} };
			} catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true }; }
		},
	};
}

function enabledTools(): string[] { return config.tools.enabled.filter((name) => toolNames.includes(name)); }

function applyToolSettings(): void {
	for (const [sessionId, session] of agentSessions) {
		const runtimeSession = sessions.find((item) => item.id === sessionId);
		const peerConfig = runtimeSession && getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId);
		session.setActiveToolsByName(peerConfig?.useTools === false ? [] : enabledTools());
	}
}

async function getPiModel(provider: ProviderConfig, modelConfig: ModelConfig) {
	modelRuntime ??= await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerProvider(provider.id, {
		name: provider.name,
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey,
		models: [{ id: modelConfig.id, name: modelConfig.name || modelConfig.id, api: modelConfig.api as "openai-completions", input: modelConfig.supportsVision ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: modelConfig.supportsThinking, contextWindow: modelConfig.maxContext, maxTokens: modelConfig.maxOutput }],
	});
	if (provider.apiKey) await modelRuntime.setRuntimeApiKey(provider.id, provider.apiKey);
	const model = modelRuntime.getModel(provider.id, modelConfig.id);
	if (!model) throw new Error(`无法在 Pi ModelRuntime 中注册模型 ${provider.id}/${modelConfig.id}`);
	return model;
}

async function getAgentSession(runtimeSession: RuntimeSession): Promise<AgentSession> {
	const existing = agentSessions.get(runtimeSession.id); if (existing) return existing;
	const provider = config.providers.find((item) => item.id === runtimeSession.providerId && item.enabled && item.apiKey);
	const modelConfig = provider?.models.find((item) => item.id === runtimeSession.modelId);
	if (!provider || !modelConfig) throw new Error("该会话使用的模型已不可用，请创建新会话或更新对象配置");
	const model = await getPiModel(provider, modelConfig);
	const customTools = [createWebSearchTool()];
	const created = await createAgentSession({ cwd: dataDir, agentDir, modelRuntime, model, customTools, sessionManager: SessionManager.inMemory(dataDir) });
	const session = created.session;
	const peerConfig = getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId);
	session.setActiveToolsByName(peerConfig?.useTools === false ? [] : enabledTools());
	const systemMessage = session.agent.state.messages[0];
	if (systemMessage?.role === "system") {
		const prior = runtimeSession.messages.slice(runtimeSession.compactedThrough).slice(-20).map((message) => (message.role === "user" ? message.sender ?? "用户" : "助手") + ": " + message.content).join("\n");
		const summary = runtimeSession.summary ? "\n\n此前会话摘要：\n" + runtimeSession.summary : "";
		const history = prior ? "\n\n此前对话记录：\n" + prior : "";
		session.agent.state.messages[0] = { ...systemMessage, content: runtimeSession.personaPrompt + summary + history + "\n\n" + (typeof systemMessage.content === "string" ? systemMessage.content : "") };
	}
	agentSessions.set(runtimeSession.id, session);
	return session;
}

function localDateKey(date = new Date()): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function checkActiveReplyGate(groupId: string, notify: boolean): Promise<boolean> {
	const today = localDateKey();
	if (proactiveUsage.date !== today) proactiveUsage = { date: today, sent: 0 };
	const reasons = evaluateProactiveGate(config.proactiveGate, proactiveUsage.sent);
	if (reasons.length === 0) return true;
	proactiveMetrics.blocked++;
	proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, result: "blocked", reason: reasons.join(", ") });
	if (proactiveDecisions.length > 100) proactiveDecisions.pop();
	log("INFO", `智能插话被全局闸门拦截：${reasons.join(", ")}`);
	if (notify && config.proactiveGate.notifyOnLimit && reasons.includes("daily-limit") && !reasons.includes("quiet-hours") && gateNoticeDates.get(groupId) !== today) {
		gateNoticeDates.set(groupId, today);
		const bot = config.qqBots.find((item) => item.enabled);
		const client = bot ? qqBots.get(bot.id) : undefined;
		if (client) await client.sendText({ scope: "group", targetId: groupId }, "MiuBot 的主动发言限制已触发，今天将暂时保持安静。").catch(() => {});
	}
	return false;
}

function queueActiveReply(bot: QQBot, botConfig: QqBotConfig, groupId: string, sender: string, content: string): void {
	const peerConfig = getPeerConfig("group", groupId, botConfig.id);
	proactiveMetrics.groupMessagesReceived++;
	log("INFO", `收到普通群消息事件 ${groupId}：global=${config.proactiveGate.enabled}, groupOptIn=${peerConfig?.features.activeReply === true}`);
	if (!config.proactiveGate.enabled || !peerConfig?.features.activeReply) {
		const reason = !config.proactiveGate.enabled ? "global-disabled" : "group-not-opted-in";
		proactiveMetrics.blocked++;
		proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, result: "skipped", reason });
		if (proactiveDecisions.length > 100) proactiveDecisions.pop();
		log("INFO", `普通群消息未进入插话聚合：${reason} (${groupId})`);
		return;
	}
	const key = `${botConfig.id}:group:${groupId}`;
	const existing = activeReplyWindows.get(key);
	if (existing) {
		existing.messages.push({ sender, content: content.slice(0, 500) });
		if (existing.messages.length > 12) existing.messages.shift();
		return;
	}
	const window = { bot, botConfig, groupId, messages: [{ sender, content: content.slice(0, 500) }], timer: setTimeout(() => { void enqueueActiveReplyWindow(key); }, config.proactiveGate.aggregationSeconds * 1000) };
	activeReplyWindows.set(key, window);
	proactiveMetrics.candidates++;
	log("INFO", `智能插话聚合窗口开始：${groupId}`);
}

function enqueueActiveReplyWindow(key: string): Promise<void> {
	const [botId, , groupId] = key.split(":");
	const queueKey = `${botId}:group:${groupId}`;
	const previous = targetQueues.get(queueKey) ?? Promise.resolve();
	const next = previous.then(() => evaluateActiveReplyWindow(key));
	targetQueues.set(queueKey, next.then(() => undefined, () => undefined));
	return next;
}

async function evaluateActiveReplyWindow(key: string): Promise<void> {
	const window = activeReplyWindows.get(key);
	if (!window) return;
	activeReplyWindows.delete(key);
	const { bot, botConfig, groupId, messages } = window;
	const peerConfig = getPeerConfig("group", groupId, botConfig.id);
	const session = sessions.find((item) => item.active && item.scope === "group" && item.peerId === groupId && item.botId === botConfig.id);
	if (!config.proactiveGate.enabled || !peerConfig?.features.activeReply || !session) {
		const reason = !config.proactiveGate.enabled ? "global-disabled" : !peerConfig?.features.activeReply ? "group-not-opted-in" : "no-active-session";
		proactiveMetrics.blocked++;
		proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, result: "blocked", reason });
		if (proactiveDecisions.length > 100) proactiveDecisions.pop();
		log("INFO", `智能插话未执行：${reason} (${groupId})`);
		return;
	}
	if (!await checkActiveReplyGate(groupId, true)) return;
	const cooldownKey = `${botConfig.id}:group:${groupId}`;
	const lastReply = activeReplyCooldowns.get(cooldownKey) ?? 0;
	if (Date.now() - lastReply < config.proactiveGate.cooldownMinutes * 60_000) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "blocked", reason: "cooldown" }); log("INFO", `智能插话被群级冷却拦截：${groupId}`, session.id); return; }
	if (!await checkActiveReplyGate(groupId, false)) return;
	const transcript = messages.map((message) => `${message.sender}: ${message.content}`).join("\n");
	let decision: { shouldReply?: boolean; reasonCode?: string; topic?: string };
	if (config.proactiveGate.mode === "probability") {
		if (Math.random() * 100 >= config.proactiveGate.probabilityPercent) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "quiet", reason: "probability-sample" }); log("INFO", `智能插话概率抽样未命中：${groupId} (${config.proactiveGate.probabilityPercent}%)`, session.id); return; }
		decision = { shouldReply: true, reasonCode: "probability-sample", topic: "群聊讨论" };
		log("INFO", `智能插话概率抽样命中：${groupId} (${config.proactiveGate.probabilityPercent}%)`, session.id);
	} else {
		const provider = config.providers.find((item) => item.id === config.proactiveGate.judgeProviderId && item.enabled && item.apiKey);
		const model = provider?.models.find((item) => item.id === config.proactiveGate.judgeModelId);
		if (!provider || !model) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "blocked", reason: "judge-model-unavailable" }); log("WARN", `智能插话判断模型不可用：${groupId}`, session.id); return; }
		proactiveMetrics.judgments++;
		log("INFO", `智能插话调用判断模型：${provider.id}/${model.id}；窗口 ${messages.length} 条`, session.id);
		const decisionResult = await createChatCompletion(config, provider.id, model.id, `群聊最近消息：\n${transcript}\n\n请判断现在是否适合由机器人插话。只在能提供直接相关帮助、回答明确问题或自然延续话题时回复。正常闲聊、话题已结束、信息不足或可能打断时应保持安静。只输出 JSON：{"shouldReply":boolean,"reasonCode":"helpful_answer|directly_relevant|conversation_closed|interruption_risk|no_context","topic":"简短话题"}`, [{ role: "system", content: "你是群聊插话时机判断器。只判断是否值得回复，不生成给群友看的答案。不要输出思维过程。" }]);
		if (!decisionResult.ok || !decisionResult.text) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "blocked", reason: "judge-failed" }); log("WARN", `智能插话判断失败，静默处理：${decisionResult.error ?? "空结果"}`, session.id); return; }
		try {
			const raw = decisionResult.text.match(/\{[\s\S]*\}/)?.[0];
			if (!raw) throw new Error("判断结果不是 JSON");
			decision = JSON.parse(raw) as typeof decision;
		} catch (error) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "blocked", reason: "invalid-judge-response" }); log("WARN", `智能插话判断结果无效：${error instanceof Error ? error.message : String(error)}`, session.id); return; }
	}
	if (decision.shouldReply !== true) { proactiveMetrics.blocked++; proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "quiet", reason: decision.reasonCode ?? "no_context" }); log("INFO", `智能插话判定保持安静：${decision.reasonCode ?? "no_context"}；${decision.topic ?? "未提供主题"}`, session.id); return; }
	proactiveMetrics.planned++;
	const currentPeerConfig = getPeerConfig("group", groupId, botConfig.id);
	if (!config.proactiveGate.enabled || !currentPeerConfig?.features.activeReply || !session.active || !await checkActiveReplyGate(groupId, true) || Date.now() - (activeReplyCooldowns.get(cooldownKey) ?? 0) < config.proactiveGate.cooldownMinutes * 60_000) { log("INFO", `智能插话发送前复核拦截：${groupId}`, session.id); return; }
	const prompt = `群聊话题：${decision.topic ?? "最近讨论"}\n以下是刚刚聚合到的群聊消息：\n${transcript}\n请自然、简洁地参与讨论。不要提及你在分析是否插话，也不要复述整段消息。`;
	try {
		const agentSession = await getAgentSession(session);
		await agentSession.prompt(prompt);
		const answer = agentSession.getLastAssistantText()?.trim();
		if (!answer) { log("WARN", `智能插话 Agent 未生成文本：${groupId}`, session.id); return; }
		if (!config.proactiveGate.enabled || !getPeerConfig("group", groupId, botConfig.id)?.features.activeReply || !session.active || !await checkActiveReplyGate(groupId, true)) { log("INFO", `智能插话生成后复核拦截：${groupId}`, session.id); return; }
		const today = localDateKey();
		if (proactiveUsage.date !== today) proactiveUsage = { date: today, sent: 0 };
		proactiveUsage.sent++;
		await saveProactiveUsage();
		try { await bot.sendText({ scope: "group", targetId: groupId }, answer); }
		catch (error) { proactiveUsage.sent = Math.max(0, proactiveUsage.sent - 1); await saveProactiveUsage(); throw error; }
		activeReplyCooldowns.set(cooldownKey, Date.now());
		proactiveMetrics.sent++;
		proactiveDecisions.unshift({ time: new Date().toISOString(), groupId, sessionId: session.id, result: "sent", reason: decision.reasonCode ?? "helpful_answer" });
		if (proactiveDecisions.length > 100) proactiveDecisions.pop();
		session.messages.push({ role: "user", content: prompt, sender: "群聊聚合", timestamp: new Date().toISOString() }, { role: "assistant", content: answer, timestamp: new Date().toISOString() });
		if (session.title === "新会话") session.title = (decision.topic ?? "群聊主动插话").slice(0, 36);
		session.updatedAt = new Date().toISOString(); await saveSessions();
		log("INFO", `智能插话已发送；主题：${decision.topic ?? "未分类"}；累计 ${proactiveUsage.sent} 条`, session.id);
	} catch (error) { log("ERROR", `智能插话执行失败并静默：${error instanceof Error ? error.message : String(error)}`, session.id); }
}

async function processQQMessage(bot: QQBot, botConfig: QqBotConfig, message: { kind?: string; rawEventType?: string; content?: string; messageId?: string; senderId?: string; senderName?: string; senderIsBot?: boolean; groupOpenid?: string; author?: { user_openid?: string; member_openid?: string; username?: string; bot?: boolean }; mentions?: Array<{ is_you?: boolean }>; replyTarget: Parameters<QQBot["sendText"]>[0] }): Promise<void> {
	const isGroup = message.kind === "group";
	const peerId = isGroup ? message.groupOpenid : message.senderId ?? message.author?.user_openid;
	const senderId = message.senderId ?? message.author?.member_openid ?? message.author?.user_openid ?? "unknown";
	const peerName = message.senderName || message.author?.username || (isGroup ? "QQ 群聊" : `用户 ${senderId.slice(0, 8)}`);
	const text = (message.content ?? "").replace(new RegExp(`<@!?${botConfig.appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "g"), "").trim();
	const mentioned = message.rawEventType === "GROUP_AT_MESSAGE_CREATE" || (message.mentions ?? []).some((mention) => mention.is_you) || new RegExp(`<@!?${botConfig.appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`).test(message.content ?? "");
	if (!peerId || message.senderIsBot || message.author?.bot || !text) return;
	if (isGroup && !mentioned) { queueActiveReply(bot, botConfig, peerId, peerName, text); return; }
	if (isGroup && mentioned) {
		const windowKey = `${botConfig.id}:group:${peerId}`;
		const pendingWindow = activeReplyWindows.get(windowKey);
		if (pendingWindow) { clearTimeout(pendingWindow.timer); activeReplyWindows.delete(windowKey); log("INFO", `智能插话窗口因 Bot 被 @ 而取消：${peerId}`); }
	}
	const queueKey = `${botConfig.id}:${isGroup ? "group" : "c2c"}:${peerId}`;
	const previous = targetQueues.get(queueKey) ?? Promise.resolve();
	const next = previous.then(async () => {
		let session = sessions.find((item) => item.active && item.botId === botConfig.id && item.scope === (isGroup ? "group" : "c2c") && item.peerId === peerId);
		if (text === "/new") {
			session = createSession(isGroup ? "group" : "c2c", peerId, peerName, botConfig.id);
			await saveSessions(); log("INFO", `创建新会话：${peerName} (${isGroup ? "群聊" : "私聊"})`, session.id);
			await bot.sendText(message.replyTarget, "已开始新会话。");
			return;
		}
		if (!session) { session = createSession(isGroup ? "group" : "c2c", peerId, peerName, botConfig.id); await saveSessions(); log("INFO", `首次消息创建会话：${peerName} (${isGroup ? "群聊" : "私聊"})`, session.id); }
		if (text === "/compact") {
			if (session.messages.length < 2) { await bot.sendText(message.replyTarget, "当前会话内容较少，暂时不需要压缩。"); return; }
			const agentSession = await getAgentSession(session);
			const compacted = await agentSession.compact("Summarize the conversation, preserving facts, preferences, decisions, and unfinished tasks.");
			session.summary = compacted.summary; session.compactedThrough = Math.max(0, session.messages.length - 4); session.updatedAt = new Date().toISOString(); await saveSessions();
			log("INFO", "上下文已压缩", session.id); await bot.sendText(message.replyTarget, "上下文压缩完成。"); return;
		}
		const agentSession = await getAgentSession(session);
		session.messages.push({ role: "user", content: text, sender: peerName, timestamp: new Date().toISOString() });
		log("INFO", `收到${isGroup ? "群聊" : "私聊"}消息：${text.slice(0, 300)}`, session.id);
		try { await agentSession.prompt(text); } catch (error) { const detail = error instanceof Error ? error.message : String(error); log("ERROR", `Agent 执行失败：${detail}`, session.id); await bot.sendText(message.replyTarget, `Agent 执行失败：${detail}`); session.messages.pop(); await saveSessions(); return; }
		const answer = agentSession.getLastAssistantText() ?? "";
		session.messages.push({ role: "assistant", content: answer, timestamp: new Date().toISOString() });
		if (session.title === "新会话") session.title = text.slice(0, 36);
		session.updatedAt = new Date().toISOString(); await saveSessions();
		log("INFO", `Agent 回复完成：${agentSession.model?.provider}/${agentSession.model?.id}`, session.id);
		await bot.sendText(message.replyTarget, answer);
		if (isGroup) activeReplyCooldowns.set(`${botConfig.id}:group:${peerId}`, Date.now());
	});
	targetQueues.set(queueKey, next.then(() => undefined, () => undefined));
	await next.catch(async (error: unknown) => { log("ERROR", `消息处理异常：${error instanceof Error ? error.message : String(error)}`); try { await bot.sendText(message.replyTarget, "处理消息时发生错误，请稍后重试。"); } catch {} });
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
	res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	if (chunks.length === 0) return {};
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function publicConfig(): { qqBots: Array<Omit<QqBotConfig, "appSecret"> & { credentialsConfigured: boolean }>; providers: Array<Omit<ProviderConfig, "apiKey"> & { apiKeyConfigured: boolean }> } {
	const qqBots = config.qqBots.map(({ appSecret, ...bot }) => ({ ...bot, credentialsConfigured: Boolean(appSecret) }));
	const providers = config.providers.map(({ apiKey, ...provider }) => ({ ...provider, apiKeyConfigured: Boolean(apiKey) }));
	return { qqBots, providers };
}

async function testQQ(appId: string, appSecret: string): Promise<{ ok: boolean; message: string }> {
	if (!appId || !appSecret) return { ok: false, message: "请填写 AppID 和 AppSecret" };
	try {
		const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appId, clientSecret: appSecret }),
		});
		if (!response.ok) return { ok: false, message: `QQ 官方接口返回 HTTP ${response.status}` };
		const payload: unknown = await response.json();
		if (typeof payload !== "object" || payload === null || typeof (payload as { access_token?: unknown }).access_token !== "string") {
			return { ok: false, message: "凭据无效或官方接口未返回 access_token" };
		}
		return { ok: true, message: "QQ 官方 Bot 凭据有效" };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function stopQQ(id: string): void {
	qqBots.get(id)?.stop();
	qqBots.delete(id);
	const bot = config.qqBots.find((item) => item.id === id);
	qqStates.set(id, { phase: "disconnected", appId: bot?.appId, nickname: bot?.nickname, avatarUrl: bot?.avatarUrl });
}

async function connectQQ(botConfig: QqBotConfig): Promise<void> {
	const { id, appId, appSecret } = botConfig;
	qqStates.set(id, { phase: "connecting", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl });
	try {
		stopQQ(id);
		qqStates.set(id, { phase: "connecting", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl });
		const bot = new QQBot({ appId, appSecret, transport: "websocket", logger: console } as ConstructorParameters<typeof QQBot>[0]);
		bot.on("ready", () => {
			qqStates.set(id, { phase: "connected", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl });
			void bot.api.get<{ username?: string; nickname?: string; avatar?: string }>("/users/@me").then((profile) => {
				const current = config.qqBots.find((item) => item.id === id);
				if (!current) return;
				if (current.nickname === "QQ Bot") current.nickname = profile.nickname || profile.username || current.nickname;
				current.avatarUrl = profile.avatar || current.avatarUrl;
				qqStates.set(id, { phase: "connected", appId, nickname: current.nickname, avatarUrl: current.avatarUrl });
				void saveConfig();
			}).catch(() => {});
		});
		bot.on("error", (error: unknown) => { qqStates.set(id, { phase: "error", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl, error: error instanceof Error ? error.message : String(error) }); });
		bot.on("message", async (_context, message) => { await processQQMessage(bot, botConfig, message); });
		qqBots.set(id, bot);
		await bot.start();
	} catch (error) {
		qqStates.set(id, { phase: "error", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl, error: error instanceof Error ? error.message : String(error) });
	}
}

async function activateBot(bot: QqBotConfig): Promise<void> {
	for (const current of config.qqBots) {
		if (current.id !== bot.id && current.enabled) {
			current.enabled = false;
			stopQQ(current.id);
		}
	}
	bot.enabled = true;
	await saveConfig();
	void connectQQ(bot);
}

function startQr(nickname: string): void {
	qrStop?.();
	qrNickname = nickname.trim() || "QQ Bot";
	qrState = { phase: "waiting" };
	qrStop = startQrConnect({
		onQrDisplayed: (url: string) => { void QRCode.toString(url, { type: "svg", margin: 1 }).then((qrSvg) => { qrState = { phase: "waiting", url, qrSvg }; }).catch((error: unknown) => { qrState = { phase: "failed", error: error instanceof Error ? error.message : String(error) }; }); },
		onSuccess: (credentials: QrConnectCredentials[]) => {
			const credential = credentials[0];
			if (!credential) { qrState = { phase: "failed", error: "扫码未返回有效凭据" }; return; }
			const existing = config.qqBots.find((bot) => bot.appId === credential.appId);
			const bot = existing ?? { id: credential.appId, nickname: qrNickname, avatarUrl: "", appId: credential.appId, appSecret: credential.appSecret, mode: "qr" as const, enabled: false };
			bot.appSecret = credential.appSecret;
			bot.mode = "qr";
			if (!existing) config.qqBots.push(bot);
			qrState = { phase: "connected" };
			void activateBot(bot);
		},
		onFailure: (error: Error) => { qrState = { phase: "failed", error: error.message }; },
		onQrExpired: () => { qrState = { phase: "failed", error: "二维码已过期，请刷新" }; },
	}, { source: "miubot", displayQrCodeToConsole: false });
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type" }); res.end(); return; }
	try {
		if (url.pathname === "/api/health") return json(res, 200, { ok: true, qq: [...qqStates.values()].find((state) => state.phase === "connected")?.phase ?? "disconnected" });
		if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, publicConfig());
		if (url.pathname === "/api/config" && req.method === "PUT") {
			const next = await body(req);
			const providers = Array.isArray(next.providers) ? next.providers as Array<ProviderConfig & { apiKeyConfigured?: boolean }> : config.providers as Array<ProviderConfig & { apiKeyConfigured?: boolean }>;
			config = {
				...config,
				providers: providers.map(({ apiKeyConfigured: _configured, ...provider }) => ({
					...provider,
					apiKey: provider.apiKey || config.providers.find((existing) => existing.id === provider.id)?.apiKey || "",
				})),
			};
			await saveConfig();
			return json(res, 200, publicConfig());
		}
		if (url.pathname === "/api/tools" && req.method === "GET") {
			return json(res, 200, { tools: toolCatalog.map((tool) => ({ ...tool, enabled: config.tools.enabled.includes(tool.name) })), webSearch: { provider: config.tools.webSearch.provider, configuredProviders: Object.fromEntries(Object.entries(config.tools.webSearch.apiKeys).map(([name, key]) => [name, Boolean(key)])) } });
		}
		if (url.pathname === "/api/proactive-gate" && req.method === "GET") return json(res, 200, { proactiveGate: config.proactiveGate, providers: config.providers.filter((item) => item.enabled && item.apiKey).map(({ id, name, models }) => ({ id, name, models: models.map(({ id: modelId, name: modelName }) => ({ id: modelId, name: modelName })) })) });
		if (url.pathname === "/api/proactive-decisions" && req.method === "GET") return json(res, 200, { metrics: proactiveMetrics, sentToday: proactiveUsage.date === localDateKey() ? proactiveUsage.sent : 0, decisions: proactiveDecisions });
		if (url.pathname === "/api/proactive-gate" && req.method === "PUT") {
			const input = await body(req);
			const dailyMessageLimit = input.dailyMessageLimit === undefined ? config.proactiveGate.dailyMessageLimit : Number(input.dailyMessageLimit);
			const aggregationSeconds = input.aggregationSeconds === undefined ? config.proactiveGate.aggregationSeconds : Number(input.aggregationSeconds);
			const cooldownMinutes = input.cooldownMinutes === undefined ? config.proactiveGate.cooldownMinutes : Number(input.cooldownMinutes);
			const probabilityPercent = input.probabilityPercent === undefined ? config.proactiveGate.probabilityPercent : Number(input.probabilityPercent);
			const quietStart = String(input.quietStart ?? config.proactiveGate.quietStart);
			const quietEnd = String(input.quietEnd ?? config.proactiveGate.quietEnd);
			if (!Number.isInteger(dailyMessageLimit) || dailyMessageLimit < 0 || dailyMessageLimit > 100000) return json(res, 400, { ok: false, message: "每日消息上限需为 0 到 100000 的整数" });
			if (!Number.isInteger(aggregationSeconds) || aggregationSeconds < 3 || aggregationSeconds > 60 || !Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1440) return json(res, 400, { ok: false, message: "聚合窗口需为 3 到 60 秒，冷却需为 0 到 1440 分钟" });
			if (!Number.isInteger(probabilityPercent) || probabilityPercent < 1 || probabilityPercent > 100) return json(res, 400, { ok: false, message: "抽样概率需为 1 到 100%" });
			const mode = input.mode === undefined ? config.proactiveGate.mode : input.mode;
			if (mode !== "smart" && mode !== "probability") return json(res, 400, { ok: false, message: "插话模式无效" });
			if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)) return json(res, 400, { ok: false, message: "请填写有效的静默时段" });
			const judgeProviderId = String(input.judgeProviderId ?? config.proactiveGate.judgeProviderId);
			const judgeModelId = String(input.judgeModelId ?? config.proactiveGate.judgeModelId);
			const enabled = input.enabled === undefined ? config.proactiveGate.enabled : input.enabled === true;
			if (enabled && mode === "smart" && !config.providers.some((item) => item.id === judgeProviderId && item.enabled && item.apiKey && item.models.some((model) => model.id === judgeModelId))) return json(res, 400, { ok: false, message: "智能判断模式需选择已配置的判断模型" });
			config.proactiveGate = { enabled, mode, probabilityPercent, dailyMessageLimit, quietStart, quietEnd, notifyOnLimit: input.notifyOnLimit === undefined ? config.proactiveGate.notifyOnLimit : input.notifyOnLimit === true, aggregationSeconds, cooldownMinutes, judgeProviderId, judgeModelId };
			await saveConfig();
			log("INFO", "主动行为全局限制已更新");
			return json(res, 200, { ok: true, proactiveGate: config.proactiveGate });
		}
		if (url.pathname === "/api/tools" && req.method === "PUT") {
			const input = await body(req);
			if (!Array.isArray(input.enabled) || input.enabled.some((name) => typeof name !== "string" || !toolNames.includes(name as typeof toolNames[number]))) return json(res, 400, { ok: false, message: "工具列表无效" });
			const search = typeof input.webSearch === "object" && input.webSearch !== null ? input.webSearch as Record<string, unknown> : {};
			const provider = search.provider;
			if (provider !== undefined && !["tavily", "brave", "exa", "serper"].includes(String(provider))) return json(res, 400, { ok: false, message: "搜索提供商无效" });
			const submittedKeys = typeof search.apiKeys === "object" && search.apiKeys !== null ? search.apiKeys as Record<string, unknown> : {};
			const apiKeys = { ...config.tools.webSearch.apiKeys };
			for (const name of ["tavily", "brave", "exa", "serper"] as const) if (typeof submittedKeys[name] === "string" && submittedKeys[name]) apiKeys[name] = submittedKeys[name] as string;
			config.tools = { enabled: [...new Set(input.enabled as string[])], webSearch: { provider: (provider as WebSearchProvider | undefined) ?? config.tools.webSearch.provider, apiKeys } };
			await saveConfig();
			applyToolSettings();
			return json(res, 200, { ok: true, tools: toolCatalog.map((tool) => ({ ...tool, enabled: config.tools.enabled.includes(tool.name) })), webSearch: { provider: config.tools.webSearch.provider, configuredProviders: Object.fromEntries(Object.entries(apiKeys).map(([name, key]) => [name, Boolean(key)])) } });
		}
		if (url.pathname === "/api/personas" && req.method === "GET") return json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		if (url.pathname === "/api/personas" && req.method === "POST") {
			const input = await body(req); const persona: PersonaConfig = { id: crypto.randomUUID(), name: String(input.name ?? "新人格").trim(), description: String(input.description ?? ""), systemPrompt: String(input.systemPrompt ?? "") };
			if (!persona.name || !persona.systemPrompt) return json(res, 400, { ok: false, message: "人格名称和系统提示词不能为空" });
			config.personas.push(persona); await saveConfig(); return json(res, 201, { personas: config.personas, activePersonaId: config.activePersonaId });
		}
		const personaMatch = url.pathname.match(/^\/api\/personas\/([^/]+)$/);
		if (personaMatch && req.method === "PUT") {
			const persona = config.personas.find((item) => item.id === decodeURIComponent(personaMatch[1] ?? ""));
			if (!persona) return json(res, 404, { ok: false, message: "人格不存在" });
			const input = await body(req); if (typeof input.name === "string") persona.name = input.name.trim(); if (typeof input.description === "string") persona.description = input.description; if (typeof input.systemPrompt === "string") persona.systemPrompt = input.systemPrompt;
			if (!persona.name || !persona.systemPrompt) return json(res, 400, { ok: false, message: "人格名称和系统提示词不能为空" });
			await saveConfig(); return json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		}
		if (personaMatch && req.method === "DELETE") {
			const id = decodeURIComponent(personaMatch[1] ?? ""); if (!config.personas.some((item) => item.id === id)) return json(res, 404, { ok: false, message: "人格不存在" });
			if (config.personas.length < 2) return json(res, 400, { ok: false, message: "至少保留一个人格" });
			config.personas = config.personas.filter((item) => item.id !== id); if (config.activePersonaId === id) config.activePersonaId = config.personas[0]?.id ?? ""; await saveConfig();
			return json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		}
		if (url.pathname === "/api/personas/active" && req.method === "PUT") {
			const input = await body(req); const id = String(input.id ?? ""); if (!config.personas.some((item) => item.id === id)) return json(res, 404, { ok: false, message: "人格不存在" });
			config.activePersonaId = id; await saveConfig(); log("INFO", `当前人格切换为：${config.personas.find((item) => item.id === id)?.name ?? id}`); return json(res, 200, { personas: config.personas, activePersonaId: id });
		}
		if (url.pathname === "/api/logs" && req.method === "GET") return json(res, 200, { logs: runtimeLogs.slice(-500).reverse() });
		if (url.pathname === "/api/peer-config" && (req.method === "GET" || req.method === "PUT")) {
			const input = req.method === "PUT" ? await body(req) : Object.fromEntries(url.searchParams.entries());
			const scope = input.scope;
			const peerId = String(input.peerId ?? "");
			const botId = String(input.botId ?? "");
			if ((scope !== "group" && scope !== "c2c") || !peerId || !botId) return json(res, 400, { ok: false, message: "缺少群/个人对象信息" });
			const current = getPeerConfig(scope, peerId, botId);
			if (req.method === "GET") {
				const defaults = getDefaultModel();
				return json(res, 200, { config: current ?? { botId, scope, peerId, personaId: config.activePersonaId || config.personas[0]?.id || "", providerId: defaults?.provider.id ?? "", modelId: defaults?.model.id ?? "", useTools: true, features: { activeReply: false, stickers: false, imageGeneration: false, tts: false } }, personas: config.personas, providers: config.providers.filter((item) => item.enabled && item.apiKey).map(({ id, name, models }) => ({ id, name, models: models.map(({ id: modelId, name: modelName }) => ({ id: modelId, name: modelName })) })) });
			}
			const personaId = String(input.personaId ?? "");
			const providerId = String(input.providerId ?? "");
			const modelId = String(input.modelId ?? "");
			const persona = config.personas.find((item) => item.id === personaId);
			const provider = config.providers.find((item) => item.id === providerId && item.enabled && item.apiKey);
			if (!persona || !provider || !provider.models.some((item) => item.id === modelId)) return json(res, 400, { ok: false, message: "请选择有效的人格、已启用提供商和模型" });
			const rawFeatures = typeof input.features === "object" && input.features !== null ? input.features as Record<string, unknown> : {};
			const next: PeerConfig = { botId, scope, peerId, personaId, providerId, modelId, useTools: input.useTools !== false, features: { activeReply: rawFeatures.activeReply === true, stickers: rawFeatures.stickers === true, imageGeneration: rawFeatures.imageGeneration === true, tts: rawFeatures.tts === true } };
			const index = peerConfigs.findIndex((item) => item.scope === scope && item.peerId === peerId && item.botId === botId);
			if (index >= 0) peerConfigs[index] = next; else peerConfigs.push(next);
			await savePeerConfigs();
			applyToolSettings();
			log("INFO", `已更新${scope === "group" ? "群聊" : "个人"}配置：${peerId}`);
			return json(res, 200, { ok: true, config: next });
		}
		if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, { sessions: sessions.map(publicSession) });
		const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
		if (sessionMatch && req.method === "GET") {
			const id = decodeURIComponent(sessionMatch[1] ?? ""); const session = sessions.find((item) => item.id === id); return session ? json(res, 200, { session }) : json(res, 404, { ok: false, message: "会话不存在" });
		}
		if (sessionMatch && req.method === "PUT") {
			const id = decodeURIComponent(sessionMatch[1] ?? ""); const session = sessions.find((item) => item.id === id); if (!session) return json(res, 404, { ok: false, message: "会话不存在" });
			const input = await body(req); if (typeof input.title === "string") session.title = input.title.trim() || session.title; if (typeof input.active === "boolean") { for (const other of sessions) if (other.scope === session.scope && other.peerId === session.peerId && other.botId === session.botId) other.active = other.id === session.id && input.active; session.active = input.active; }
			await saveSessions(); return json(res, 200, { session });
		}
		if (sessionMatch && req.method === "DELETE") {
			const id = decodeURIComponent(sessionMatch[1] ?? ""); if (!sessions.some((item) => item.id === id)) return json(res, 404, { ok: false, message: "会话不存在" }); sessions = sessions.filter((item) => item.id !== id); await saveSessions(); return json(res, 200, { ok: true });
		}
		if (url.pathname === "/api/providers/models" && req.method === "POST") {
			const input = await body(req);
			const provider = config.providers.find((item) => item.id === String(input.providerId ?? ""));
			const apiKey = String(input.apiKey ?? provider?.apiKey ?? "");
			if (!provider && (!input.baseUrl || !input.apiKey)) return json(res, 404, { ok: false, message: "请填写提供商 API 地址和 API Key" });
			if (!apiKey) return json(res, 400, { ok: false, message: "请先配置 API Key" });
			const baseUrl = String(input.baseUrl ?? provider?.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
			const isAnthropic = String(input.api ?? provider?.api ?? "") === "anthropic-messages";
			const modelsUrl = isAnthropic ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models` : `${baseUrl}/models`;
			const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
			try {
				const headers: Record<string, string> = isAnthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` };
				const response = await fetch(modelsUrl, { headers, signal: controller.signal });
				const data: unknown = await response.json();
				if (!response.ok) return json(res, 400, { ok: false, message: `模型列表接口返回 HTTP ${response.status}` });
				const models = typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data) ? (data as { data: Array<{ id?: unknown; name?: unknown; display_name?: unknown }> }).data.filter((item) => typeof item.id === "string").map((item) => ({ id: item.id as string, name: typeof item.name === "string" ? item.name : typeof item.display_name === "string" ? item.display_name : item.id as string })) : [];
				return json(res, 200, { ok: true, models });
			} finally { clearTimeout(timeout); }
		}
		if (url.pathname === "/api/providers/catalog" && req.method === "GET") return json(res, 200, { providers: config.providers.map(({ apiKey, ...provider }) => ({ ...provider, apiKeyConfigured: Boolean(apiKey) })) });
		if (url.pathname === "/api/qqbot/status" && req.method === "GET") return json(res, 200, { connections: config.qqBots.map((bot) => ({ id: bot.id, ...qqStates.get(bot.id) ?? { phase: "disconnected", appId: bot.appId, nickname: bot.nickname, avatarUrl: bot.avatarUrl }, enabled: bot.enabled })), qr: qrState });
		if (url.pathname === "/api/qqbot/bots" && req.method === "POST") {
			const input = await body(req); const appId = String(input.appId ?? "").trim(); const appSecret = String(input.appSecret ?? "").trim();
			const tested = await testQQ(appId, appSecret); if (!tested.ok) return json(res, 400, tested);
			const id = appId; if (config.qqBots.some((bot) => bot.id === id)) return json(res, 409, { ok: false, message: "该 AppID 已添加" });
			const bot: QqBotConfig = { id, nickname: String(input.nickname ?? "QQ Bot").trim() || "QQ Bot", avatarUrl: "", appId, appSecret, mode: "credentials", enabled: false };
			config.qqBots.push(bot); await activateBot(bot); return json(res, 201, publicConfig());
		}
		const botMatch = url.pathname.match(/^\/api\/qqbot\/bots\/([^/]+)$/);
		if (botMatch && req.method === "PUT") {
			const id = decodeURIComponent(botMatch[1] ?? ""); const bot = config.qqBots.find((item) => item.id === id);
			if (!bot) return json(res, 404, { ok: false, message: "机器人不存在" });
			const input = await body(req);
			if (typeof input.nickname === "string") bot.nickname = input.nickname.trim() || "QQ Bot";
			if (typeof input.enabled === "boolean") {
				bot.enabled = input.enabled;
				if (input.enabled) await activateBot(bot);
				else { stopQQ(id); await saveConfig(); }
			}
			if (input.nickname !== undefined) { await saveConfig(); const state = qqStates.get(id); if (state) qqStates.set(id, { ...state, nickname: bot.nickname }); }
			return json(res, 200, publicConfig());
		}
		if (botMatch && req.method === "DELETE") {
			const id = decodeURIComponent(botMatch[1] ?? ""); if (!config.qqBots.some((item) => item.id === id)) return json(res, 404, { ok: false, message: "机器人不存在" });
			stopQQ(id); config.qqBots = config.qqBots.filter((item) => item.id !== id); qqStates.delete(id); await saveConfig(); return json(res, 200, publicConfig());
		}
		if (url.pathname === "/api/qqbot/test" && req.method === "POST") {
			const input = await body(req); return json(res, 200, await testQQ(String(input.appId ?? ""), String(input.appSecret ?? "")));
		}
		if (url.pathname === "/api/qqbot/connect" && req.method === "POST") {
			const input = await body(req);
			const appId = String(input.appId ?? "").trim(); const appSecret = String(input.appSecret ?? "").trim();
			const tested = await testQQ(appId, appSecret);
			if (!tested.ok) return json(res, 400, tested);
			const existing = config.qqBots.find((bot) => bot.appId === appId);
			if (existing) { existing.appSecret = appSecret; existing.mode = "credentials"; await activateBot(existing); }
			else { const bot: QqBotConfig = { id: appId, nickname: "QQ Bot", avatarUrl: "", appId, appSecret, mode: "credentials", enabled: false }; config.qqBots.push(bot); await activateBot(bot); }
			return json(res, 202, { ok: true, message: "机器人已保存，正在连接 QQ 官方 Gateway" });
		}
		if (url.pathname === "/api/qqbot/qr/start" && req.method === "POST") { const input = await body(req); startQr(String(input.nickname ?? "QQ Bot")); return json(res, 202, qrState); }
		if (url.pathname === "/api/chat" && req.method === "POST") {
			const input = await body(req); const message = String(input.message ?? "");
			const result = await createChatCompletion(config, String(input.providerId ?? ""), String(input.modelId ?? ""), message, Array.isArray(input.messages) ? input.messages as ChatMessage[] : []);
			log(result.ok ? "INFO" : "ERROR", result.ok ? `调试台模型请求完成：${result.providerId}/${result.modelId}` : `调试台模型请求失败：${result.error ?? "未知错误"}`);
			return json(res, result.ok ? 200 : 400, result);
		}
		return json(res, 404, { ok: false, message: "Not found" });
	} catch (error) { return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) }); }
}

await loadConfig();
await loadRuntimeData();
const activeBot = config.qqBots.find((bot) => bot.enabled);
if (activeBot?.appId && activeBot.appSecret) void connectQQ(activeBot);
log("INFO", "Miubot Server 已启动");
createServer((req, res) => { void handler(req, res); }).listen(port, "127.0.0.1", () => console.log(`Miubot server listening on http://127.0.0.1:${port}`));
