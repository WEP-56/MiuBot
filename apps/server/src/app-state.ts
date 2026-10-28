import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PeerConfig, RuntimeSession } from "./agent-host.ts";
import {
	type AppConfig,
	createDefaultConfig,
	type ModelConfig,
	type ProactiveGateSettings,
	type ProviderConfig,
} from "./runtime.ts";
import { restrictFileMode, writeJsonAtomic } from "./storage.ts";

function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}

export type ProactiveUsage = { date: string; sent: number };

export type AppState = {
	/** 读配置 + 会话 + 对象配置 + 主动发言额度；日志由调用方自行恢复。 */
	load(): Promise<void>;
	getConfig(): AppConfig;
	setConfig(next: AppConfig): void;
	saveConfig(): Promise<void>;
	getSessions(): RuntimeSession[];
	setSessions(next: RuntimeSession[]): void;
	saveSessions(): Promise<void>;
	/** 为该对象新建会话，并把同对象旧会话置为非活跃。不落盘。 */
	createSession(scope: RuntimeSession["scope"], peerId: string, peerName: string, botId: string): RuntimeSession;
	getPeers(): PeerConfig[];
	getPeerConfig(scope: PeerConfig["scope"], peerId: string, botId: string): PeerConfig | undefined;
	/** 按默认值构造对象配置，不落盘。 */
	createPeerConfig(scope: PeerConfig["scope"], peerId: string, botId: string, name: string): PeerConfig;
	/** 取对象配置，没有就新建并加入列表。不落盘。 */
	registerPeer(scope: PeerConfig["scope"], peerId: string, botId: string, name: string): PeerConfig;
	savePeers(): Promise<void>;
	/** 第一个「已启用且有 API Key」的提供商的第一个模型。 */
	getDefaultModel(): { provider: ProviderConfig; model: ModelConfig } | undefined;
	getProactiveUsage(): ProactiveUsage;
	setProactiveUsage(next: ProactiveUsage): void;
	saveProactiveUsage(): Promise<void>;
};

/**
 * 主动行为闸门的兼容处理。
 *
 * 群级冷却曾经以分钟为单位（`cooldownMinutes`），取整等于「最小 1 分钟」；现在统一按秒存。
 * 旧配置必须 ×60 迁移，否则升级后冷却会突然变成 0 秒——等于悄悄取消了这个保护。
 */
function migrateProactiveGate(
	defaults: ProactiveGateSettings,
	saved: (Partial<ProactiveGateSettings> & { cooldownMinutes?: number }) | undefined,
): ProactiveGateSettings {
	if (!saved) return defaults;
	const { cooldownMinutes, ...rest } = saved;
	const gate: ProactiveGateSettings = { ...defaults, ...rest };
	if (typeof rest.cooldownSeconds !== "number" && typeof cooldownMinutes === "number")
		gate.cooldownSeconds = Math.max(0, cooldownMinutes) * 60;
	return gate;
}

/**
 * 运行时内存状态及其持久化。
 *
 * `config` 与 `sessions` 会被整体替换（保存配置、删除会话），调用方必须走 get/set，
 * 不要各自缓存引用。所有写盘都是「当前状态全量覆盖」，与历史实现保持一致。
 */
export function createAppState(options: { dataDir: string }): AppState {
	const configPath = join(options.dataDir, "config.json");
	const sessionsPath = join(options.dataDir, "sessions.json");
	const peersPath = join(options.dataDir, "peer-configs.json");
	const usagePath = join(options.dataDir, "proactive-usage.json");

	let config: AppConfig = createDefaultConfig();
	let sessions: RuntimeSession[] = [];
	let peers: PeerConfig[] = [];
	let usage: ProactiveUsage = { date: "", sent: 0 };

	async function saveConfig(): Promise<void> {
		await writeJsonAtomic(configPath, config);
	}

	async function saveSessions(): Promise<void> {
		await writeJsonAtomic(sessionsPath, sessions);
	}

	async function savePeers(): Promise<void> {
		await writeJsonAtomic(peersPath, peers);
	}

	async function saveProactiveUsage(): Promise<void> {
		await writeJsonAtomic(usagePath, usage);
	}

	function getDefaultModel(): { provider: ProviderConfig; model: ModelConfig } | undefined {
		for (const provider of config.providers) {
			if (!provider.enabled || !provider.apiKey) continue;
			const model = provider.models[0];
			if (model) return { provider, model };
		}
		return undefined;
	}

	function getPeerConfig(scope: PeerConfig["scope"], peerId: string, botId: string): PeerConfig | undefined {
		return peers.find((item) => item.scope === scope && item.peerId === peerId && item.botId === botId);
	}

	function createPeerConfig(scope: PeerConfig["scope"], peerId: string, botId: string, name: string): PeerConfig {
		const defaults = getDefaultModel();
		return {
			botId,
			scope,
			peerId,
			name,
			personaId: config.activePersonaId || config.personas[0]?.id || "",
			providerId: defaults?.provider.id ?? "",
			modelId: defaults?.model.id ?? "",
			fallbackProviderId: "",
			fallbackModelId: "",
			useTools: true,
			toolsOverride: null,
			features: { activeReply: false, showToolActivity: false },
		};
	}

	async function loadConfig(): Promise<void> {
		try {
			const stored = JSON.parse(await readFile(configPath, "utf8")) as Partial<AppConfig> & {
				qq?: { appId?: string; appSecret?: string; mode?: "qr" | "credentials" };
			};
			const qqBots =
				stored.qqBots ??
				(stored.qq?.appId && stored.qq.appSecret
					? [
							{
								id: stored.qq.appId,
								nickname: "QQ Bot",
								avatarUrl: "",
								appId: stored.qq.appId,
								appSecret: stored.qq.appSecret,
								mode: stored.qq.mode ?? "credentials",
								enabled: true,
							},
						]
					: []);
			const { qq: _legacyQq, ...current } = stored;
			const defaults = createDefaultConfig();
			const savedTools = current.tools as Partial<AppConfig["tools"]> | undefined;
			const imageProviders = Array.isArray(current.imageProviders)
				? current.imageProviders
				: defaults.imageProviders;
			/**
			 * 老配置没有 `tools.imageGen`：把**当时真正生效**的那个记下来。
			 *
			 * 旧逻辑是「第一个启用且有 Key 的图像提供商」，不迁移的话升级后 `image_gen`
			 * 会突然变成「未配置」，而用户什么都没改。
			 */
			const legacyImageProviderId = imageProviders.find((item) => item.enabled && item.apiKey)?.id ?? "";
			config = {
				...defaults,
				...current,
				qqBots: qqBots.map((bot) => ({
					...bot,
					nickname: bot.nickname || "QQ Bot",
					avatarUrl: bot.avatarUrl || "",
				})),
				tools: {
					enabled: Array.isArray(savedTools?.enabled) ? savedTools.enabled : defaults.tools.enabled,
					mcpEnabled:
						typeof savedTools?.mcpEnabled === "boolean" ? savedTools.mcpEnabled : defaults.tools.mcpEnabled,
					skillsEnabled:
						typeof savedTools?.skillsEnabled === "boolean"
							? savedTools.skillsEnabled
							: defaults.tools.skillsEnabled,
					stickersEnabled:
						typeof savedTools?.stickersEnabled === "boolean"
							? savedTools.stickersEnabled
							: defaults.tools.stickersEnabled,
					stickerAutoCollectProbability:
						typeof savedTools?.stickerAutoCollectProbability === "number"
							? Math.max(0, Math.min(100, savedTools.stickerAutoCollectProbability))
							: defaults.tools.stickerAutoCollectProbability,
					stickerTaggerProviderId:
						typeof savedTools?.stickerTaggerProviderId === "string"
							? savedTools.stickerTaggerProviderId
							: defaults.tools.stickerTaggerProviderId,
					stickerTaggerModelId:
						typeof savedTools?.stickerTaggerModelId === "string"
							? savedTools.stickerTaggerModelId
							: defaults.tools.stickerTaggerModelId,
					webSearch: {
						provider: savedTools?.webSearch?.provider ?? defaults.tools.webSearch.provider,
						apiKeys: { ...defaults.tools.webSearch.apiKeys, ...savedTools?.webSearch?.apiKeys },
					},
					imageGen: {
						providerId:
							typeof savedTools?.imageGen?.providerId === "string"
								? savedTools.imageGen.providerId
								: legacyImageProviderId,
					},
					timezone:
						typeof savedTools?.timezone === "string" && isValidTimeZone(savedTools.timezone)
							? savedTools.timezone
							: defaults.tools.timezone,
				},
				imageProviders,
				access: {
					allowedPeers: Array.isArray(current.access?.allowedPeers)
						? current.access.allowedPeers.filter((key): key is string => typeof key === "string")
						: defaults.access.allowedPeers,
				},
				proactiveGate: migrateProactiveGate(defaults.proactiveGate, current.proactiveGate),
				mcpServers: Array.isArray(current.mcpServers) ? current.mcpServers : defaults.mcpServers,
				plugins: {
					enabled: Array.isArray(current.plugins?.enabled)
						? current.plugins.enabled.filter((id): id is string => typeof id === "string")
						: defaults.plugins.enabled,
					disabled: Array.isArray(current.plugins?.disabled)
						? current.plugins.disabled.filter((id): id is string => typeof id === "string")
						: defaults.plugins.disabled,
				},
				// 管理员名单缺失时保持空数组：老配置升级上来时不该凭空多出管理员。
				admins: Array.isArray(current.admins)
					? current.admins.filter((id): id is string => typeof id === "string")
					: defaults.admins,
				commands: {
					disabled: Array.isArray(current.commands?.disabled)
						? current.commands.disabled.filter((name): name is string => typeof name === "string")
						: defaults.commands.disabled,
				},
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

	async function loadSessions(): Promise<void> {
		try {
			const stored = JSON.parse(await readFile(sessionsPath, "utf8")) as Array<
				Partial<RuntimeSession> &
					Pick<
						RuntimeSession,
						| "id"
						| "scope"
						| "peerId"
						| "peerName"
						| "botId"
						| "title"
						| "personaId"
						| "createdAt"
						| "updatedAt"
						| "active"
					>
			>;
			sessions = stored.map((session) => {
				const persona = config.personas.find((item) => item.id === session.personaId);
				const defaultModel = getDefaultModel();
				return {
					...session,
					personaName: session.personaName ?? persona?.name ?? "已删除的人格",
					personaPrompt: session.personaPrompt ?? persona?.systemPrompt ?? "你是一个友善的中文聊天助手。",
					providerId: session.providerId ?? defaultModel?.provider.id ?? "",
					modelId: session.modelId ?? defaultModel?.model.id ?? "",
					summary: session.summary ?? "",
					compactedThrough: session.compactedThrough ?? 0,
					messages: session.messages ?? [],
					activities: session.activities ?? [],
				};
			});
		} catch {
			sessions = [];
		}
	}

	async function loadPeers(): Promise<void> {
		try {
			const stored = JSON.parse(await readFile(peersPath, "utf8")) as Array<
				Partial<PeerConfig> &
					Pick<PeerConfig, "botId" | "scope" | "peerId" | "personaId" | "providerId" | "modelId">
			>;
			peers = Array.isArray(stored)
				? stored.map((item) => ({
						...item,
						name:
							item.name ||
							sessions.find(
								(session) =>
									session.botId === item.botId &&
									session.scope === item.scope &&
									session.peerId === item.peerId,
							)?.peerName ||
							`${item.scope === "group" ? "群" : "用户"} ${item.peerId}`,
						useTools: item.useTools ?? true,
						// 老配置没有这两项：缺省 = 不启用备用模型、继承全局工具。
						fallbackProviderId: typeof item.fallbackProviderId === "string" ? item.fallbackProviderId : "",
						fallbackModelId: typeof item.fallbackModelId === "string" ? item.fallbackModelId : "",
						toolsOverride: Array.isArray(item.toolsOverride)
							? item.toolsOverride.filter((name): name is string => typeof name === "string")
							: null,
						features: {
							activeReply:
								typeof item.features === "object" &&
								item.features !== null &&
								(item.features as { activeReply?: unknown }).activeReply === true,
							showToolActivity:
								typeof item.features === "object" &&
								item.features !== null &&
								(item.features as { showToolActivity?: unknown }).showToolActivity === true,
						},
					}))
				: [];
		} catch {
			peers = [];
		}
		// 有会话但没有对象配置时补齐，否则界面里点不进这些会话。
		for (const session of sessions) {
			if (
				!peers.some(
					(item) => item.botId === session.botId && item.scope === session.scope && item.peerId === session.peerId,
				)
			) {
				const defaults = getDefaultModel();
				peers.push({
					botId: session.botId,
					scope: session.scope,
					peerId: session.peerId,
					name: session.peerName,
					personaId: config.activePersonaId || config.personas[0]?.id || "",
					providerId: defaults?.provider.id ?? "",
					modelId: defaults?.model.id ?? "",
					fallbackProviderId: "",
					fallbackModelId: "",
					useTools: true,
					toolsOverride: null,
					features: { activeReply: false, showToolActivity: false },
				});
			}
		}
		await savePeers();
	}

	return {
		async load() {
			await loadConfig();
			await loadSessions();
			await loadPeers();
			try {
				usage = JSON.parse(await readFile(usagePath, "utf8")) as ProactiveUsage;
			} catch {
				usage = { date: "", sent: 0 };
			}
			// 旧版本写下的文件是 umask 默认权限（典型 0644），升级后第一次启动顺手收紧。
			await Promise.all([configPath, sessionsPath, peersPath, usagePath].map(restrictFileMode));
		},
		getConfig: () => config,
		setConfig: (next) => {
			config = next;
		},
		saveConfig,
		getSessions: () => sessions,
		setSessions: (next) => {
			sessions = next;
		},
		saveSessions,
		createSession(scope, peerId, peerName, botId) {
			const now = new Date().toISOString();
			const peerConfig = getPeerConfig(scope, peerId, botId);
			const persona =
				config.personas.find((item) => item.id === peerConfig?.personaId) ??
				config.personas.find((item) => item.id === config.activePersonaId) ??
				config.personas[0];
			const modelConfig =
				peerConfig &&
				config.providers
					.find((item) => item.id === peerConfig.providerId && item.enabled && item.apiKey)
					?.models.find((item) => item.id === peerConfig.modelId);
			const defaultModel = modelConfig
				? {
						provider: config.providers.find((item) => item.id === peerConfig?.providerId) as ProviderConfig,
						model: modelConfig,
					}
				: getDefaultModel();
			const session: RuntimeSession = {
				id: crypto.randomUUID(),
				scope,
				peerId,
				peerName,
				botId,
				title: "新会话",
				personaId: persona?.id ?? "default",
				personaName: persona?.name ?? "默认人格",
				personaPrompt: persona?.systemPrompt ?? "你是一个友善的中文聊天助手。",
				providerId: defaultModel?.provider.id ?? "",
				modelId: defaultModel?.model.id ?? "",
				summary: "",
				compactedThrough: 0,
				messages: [],
				activities: [],
				createdAt: now,
				updatedAt: now,
				active: true,
			};
			for (const item of sessions)
				if (item.scope === scope && item.peerId === peerId && item.botId === botId) item.active = false;
			sessions.unshift(session);
			return session;
		},
		getPeers: () => peers,
		getPeerConfig,
		createPeerConfig,
		registerPeer(scope, peerId, botId, name) {
			const existing = getPeerConfig(scope, peerId, botId);
			if (existing) {
				if (name && (existing.name === `${scope === "group" ? "群" : "用户"} ${peerId}` || !existing.name))
					existing.name = name;
				return existing;
			}
			const peer = createPeerConfig(scope, peerId, botId, name || `${scope === "group" ? "群" : "用户"} ${peerId}`);
			peers.push(peer);
			return peer;
		},
		savePeers,
		getDefaultModel,
		getProactiveUsage: () => usage,
		setProactiveUsage: (next) => {
			usage = next;
		},
		saveProactiveUsage,
	};
}
