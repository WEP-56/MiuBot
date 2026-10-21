import { join } from "node:path";
import { createBuiltinTools, type McpRuntime } from "@miubot/plugin/tools/index";
import { createAgentSession } from "@miubot/session/sdk";
import type { AgentSession } from "@miubot/session/agent-session";
import { DefaultResourceLoader } from "@miubot/session/resource-loader";
import { ModelRuntime } from "@miubot/session/model-runtime";
import { SessionManager } from "@miubot/session/session-manager";
import type { AppConfig, ModelConfig, PersonaConfig, ProviderConfig } from "./runtime.ts";
import { extensionForMime, type Sticker, type StickerStore } from "./stickers.ts";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { downloadImage, sendQQMedia } from "./media.ts";
import { generateOpenAIImage } from "@miubot/provider";

export type RuntimeMessage = { role: "user" | "assistant"; content: string; sender?: string; timestamp: string };
export type RuntimeSession = { id: string; scope: "group" | "c2c"; peerId: string; peerName: string; botId: string; title: string; personaId: string; personaName: string; personaPrompt: string; providerId: string; modelId: string; summary: string; compactedThrough: number; messages: RuntimeMessage[]; createdAt: string; updatedAt: string; active: boolean };
export type PeerConfig = { botId: string; scope: "group" | "c2c"; peerId: string; name: string; personaId: string; providerId: string; modelId: string; useTools: boolean; features: { activeReply: boolean } };

type AgentHostDependencies = {
	dataDir: string;
	agentDir: string;
	getConfig: () => AppConfig;
	getPeerConfig: (scope: PeerConfig["scope"], peerId: string, botId: string) => PeerConfig | undefined;
	getPromptContext: (sessionId: string) => string | undefined;
	getStickerContext: (sessionId: string) => { bot: QQBot; target: QQBotInboundMessage["replyTarget"] } | undefined;
	getSessions: () => RuntimeSession[];
	stickerStore: StickerStore;
	mcpRuntime: McpRuntime;
};

export function createAgentHost(deps: AgentHostDependencies) {
	const agentSessions = new Map<string, AgentSession>();
	let modelRuntime: ModelRuntime | undefined;
	const config = deps.getConfig;

	async function getModelRuntime(): Promise<ModelRuntime> {
		modelRuntime ??= await ModelRuntime.create({ authPath: join(deps.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		return modelRuntime;
	}

	async function getPiModel(provider: ProviderConfig, modelConfig: ModelConfig) {
		const runtime = await getModelRuntime();
		runtime.registerProvider(provider.id, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey,
			models: [{ id: modelConfig.id, name: modelConfig.name || modelConfig.id, api: modelConfig.api as "openai-completions", input: modelConfig.supportsVision ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: modelConfig.supportsThinking, contextWindow: modelConfig.maxContext, maxTokens: modelConfig.maxOutput }],
		});
		if (provider.apiKey) await runtime.setRuntimeApiKey(provider.id, provider.apiKey);
		const model = runtime.getModel(provider.id, modelConfig.id);
		if (!model) throw new Error(`无法在 Pi ModelRuntime 中注册模型 ${provider.id}/${modelConfig.id}`);
		return model;
	}

	function applyPeerConfigToSession(session: RuntimeSession, peer: PeerConfig | undefined): void {
		if (!peer) return;
		const persona = config().personas.find((item) => item.id === peer.personaId);
		session.peerName = peer.name;
		session.personaId = persona?.id ?? session.personaId;
		session.personaName = persona?.name ?? session.personaName;
		session.personaPrompt = persona?.systemPrompt ?? session.personaPrompt;
		session.providerId = peer.providerId;
		session.modelId = peer.modelId;
	}

	function enabledToolNames(runtimeSession: RuntimeSession): string[] {
		const current = config();
		const nativeToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "web_search", "image_gen"];
		const peer = deps.getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId);
		if (peer?.useTools === false) return [];
		return [
			...current.tools.enabled.filter((name) => nativeToolNames.includes(name)),
			...(current.tools.skillsEnabled ? ["load_skill"] : []),
			...(current.tools.stickersEnabled ? ["search_stickers", "send_sticker"] : []),
			...deps.mcpRuntime.getEnabledToolDefinitions().map((tool) => tool.name),
		];
	}

	function applyToolSettings(): void {
		for (const [sessionId, session] of agentSessions) {
			const runtimeSession = deps.getSessions().find((item) => item.id === sessionId);
			if (runtimeSession) session.setActiveToolsByName(enabledToolNames(runtimeSession));
		}
	}

	function rebuildAgentSessions(): void {
		for (const session of agentSessions.values()) session.dispose();
		agentSessions.clear();
	}

	async function getAgentSession(runtimeSession: RuntimeSession): Promise<AgentSession> {
		applyPeerConfigToSession(runtimeSession, deps.getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId));
		const current = config();
		const provider = current.providers.find((item) => item.id === runtimeSession.providerId && item.enabled && item.apiKey);
		const modelConfig = provider?.models.find((item) => item.id === runtimeSession.modelId);
		if (!provider || !modelConfig) throw new Error("该会话使用的模型已不可用，请创建新会话或更新对象配置");
		const model = await getPiModel(provider, modelConfig);
		const existing = agentSessions.get(runtimeSession.id);
		if (existing) {
			if (existing.model?.provider !== model.provider || existing.model.id !== model.id) await existing.setModel(model);
			existing.setActiveToolsByName(enabledToolNames(runtimeSession));
			return existing;
		}
		const customTools = createBuiltinTools({
			webSearch: () => config().tools.webSearch,
			...(current.tools.skillsEnabled ? { skills: { cwd: deps.dataDir, agentDir: deps.agentDir } } : {}),
			...(current.tools.stickersEnabled ? { stickers: { store: deps.stickerStore, canUse: () => {
				const latestPeer = deps.getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId);
				return config().tools.stickersEnabled && latestPeer?.useTools !== false;
			}, send: async (sticker: Sticker) => {
				const context = deps.getStickerContext(runtimeSession.id);
				if (!context) throw new Error("当前没有可用的 QQ 回复目标");
				const image = await deps.stickerStore.image(sticker.id);
				if (!image) throw new Error("表情包文件不存在");
				const extension = extensionForMime(sticker.mimeType);
				await sendQQMedia(context.bot, context.target, { kind: "image", buffer: image, fileName: `${sticker.id}${extension}` });
			} } } : {}),
			imageGen: { generate: async ({ prompt, size, quality, signal }) => {
				const imageProvider = config().imageProviders.find((item) => item.enabled && item.apiKey);
				if (!imageProvider) throw new Error("请先在提供商页面配置并启用图像生成提供商");
				const context = deps.getStickerContext(runtimeSession.id);
				if (!context) throw new Error("当前没有可用的 QQ 回复目标");
				const image = await generateOpenAIImage({ apiKey: imageProvider.apiKey ?? "", baseUrl: imageProvider.baseUrl, model: imageProvider.model, prompt, size, quality, signal });
				const downloaded = "url" in image ? await downloadImage(image.url) : { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType };
				const extension = downloaded.mimeType === "image/jpeg" ? ".jpg" : downloaded.mimeType === "image/webp" ? ".webp" : ".png";
				await sendQQMedia(context.bot, context.target, { kind: "image", buffer: Buffer.from(downloaded.bytes), fileName: `generated-${Date.now()}${extension}` });
			} },
			mcp: deps.mcpRuntime,
		});
		const resourceLoader = new DefaultResourceLoader({ cwd: deps.dataDir, agentDir: deps.agentDir, skillsOverride: (base) => ({ ...base, skills: config().tools.skillsEnabled ? base.skills : [] }), extensionFactories: [{ name: "miubot-qq-scene", factory: (pi) => {
			pi.on("before_agent_start", (event) => {
				const peer = deps.getPeerConfig(runtimeSession.scope, runtimeSession.peerId, runtimeSession.botId);
				const persona = config().personas.find((item) => item.id === peer?.personaId);
				const botName = config().qqBots.find((item) => item.id === runtimeSession.botId)?.nickname ?? "MiuBot";
				const scene = `当前 QQ 对话环境：${runtimeSession.scope === "group" ? "群聊" : "私聊"}；${runtimeSession.scope === "group" ? "群" : "对象"}名称：${peer?.name ?? runtimeSession.peerName}；平台对象 ID（OpenID）：${runtimeSession.peerId}；Bot：${botName}（${runtimeSession.botId}）。${deps.getPromptContext(runtimeSession.id) ?? ""}`;
				const personaPrompt = persona?.systemPrompt ?? runtimeSession.personaPrompt;
				const prior = runtimeSession.messages.slice(runtimeSession.compactedThrough).slice(-20).map((item) => `${item.role === "user" ? item.sender ?? "用户" : "助手"}: ${item.content}`).join("\n");
				const history = [runtimeSession.summary ? `此前会话摘要：\n${runtimeSession.summary}` : "", prior ? `此前对话记录：\n${prior}` : ""].filter(Boolean).join("\n\n");
				const configured = [personaPrompt ? `当前对象人格设定：\n${personaPrompt}` : "", scene, history].filter(Boolean).join("\n\n");
				event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, configured].filter(Boolean).join("\n\n");
			});
		} }] });
		await resourceLoader.reload();
		const runtime = await getModelRuntime();
		const created = await createAgentSession({ cwd: deps.dataDir, agentDir: deps.agentDir, modelRuntime: runtime, model, customTools, resourceLoader, sessionManager: SessionManager.inMemory(deps.dataDir) });
		created.session.setActiveToolsByName(enabledToolNames(runtimeSession));
		agentSessions.set(runtimeSession.id, created.session);
		return created.session;
	}

	function anyAgentLoopRunning(): boolean {
		return [...agentSessions.values()].some((session) => session.isStreaming);
	}

	function disposeSession(sessionId: string): void {
		agentSessions.get(sessionId)?.dispose();
		agentSessions.delete(sessionId);
	}

	function disposePeer(botId: string, scope: PeerConfig["scope"], peerId: string, currentSessions: RuntimeSession[]): void {
		for (const [sessionId, session] of agentSessions) {
			const runtimeSession = currentSessions.find((item) => item.id === sessionId);
			if (runtimeSession?.botId === botId && runtimeSession.scope === scope && runtimeSession.peerId === peerId) disposeSession(sessionId);
		}
	}

	return { getModelRuntime, getPiModel, applyPeerConfigToSession, applyToolSettings, rebuildAgentSessions, getAgentSession, anyAgentLoopRunning, disposeSession, disposePeer };
}
