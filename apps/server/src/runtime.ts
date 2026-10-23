import type { McpServerConfig } from "@miubot/plugin/tools/mcp/runtime";

export type ModelConfig = {
	id: string;
	name: string;
	api: string;
	baseUrl?: string;
	maxOutput: number;
	maxContext: number;
	compressionThreshold: number;
	supportsThinking: boolean;
	supportsVision: boolean;
	supportsTools: boolean;
};
export type ProviderConfig = {
	id: string;
	name: string;
	api: string;
	apiKey?: string;
	baseUrl?: string;
	models: ModelConfig[];
	enabled: boolean;
	ttsModel?: string;
	imageModel?: string;
};
export type ImageProviderConfig = {
	id: string;
	name: string;
	api: "openai-images";
	apiKey?: string;
	baseUrl?: string;
	model: string;
	enabled: boolean;
};
export type QqBotConfig = {
	id: string;
	nickname: string;
	avatarUrl: string;
	appId: string;
	appSecret: string;
	mode: "qr" | "credentials";
	enabled: boolean;
};
export type PersonaConfig = { id: string; name: string; description: string; systemPrompt: string };
export type WebSearchProvider = "tavily" | "brave" | "exa" | "serper";
/**
 * 入站访问控制。
 *
 * `allowedPeers` 是「谁能用这个 Bot」的唯一执行点：空数组表示不限制，保留这个默认值
 * 是为了升级后不会突然静默失联；公网部署应该把它填上。
 *
 * 键的格式是 `group:<群 ID>` / `c2c:<用户 ID>`，与 `peer-configs.json` 里的 scope + peerId
 * 一致（QQ 的 openid 本来就按 Bot 隔离，所以这里不再带 botId）。
 */
export type AccessSettings = {
	allowedPeers: string[];
};
export type ToolSettings = {
	enabled: string[];
	mcpEnabled: boolean;
	skillsEnabled: boolean;
	stickersEnabled: boolean;
	stickerAutoCollectProbability: number;
	stickerTaggerProviderId: string;
	stickerTaggerModelId: string;
	webSearch: { provider: WebSearchProvider; apiKeys: Record<WebSearchProvider, string> };
	/**
	 * `image_gen` 用哪个图像提供商。
	 *
	 * 图像提供商是**这个工具的依赖**，不是 Agent 的推理后端——所以它的选择放在工具配置里，
	 * 与 `webSearch.provider` 同层。空字符串 = 未选择，`image_gen` 直接不可用；
	 * 以前那种「挑第一个启用且有 Key 的」会让「换了提供商却没生效」变得无法解释。
	 */
	imageGen: { providerId: string };
};
export type ProactiveGateSettings = {
	enabled: boolean;
	mode: "smart" | "probability";
	probabilityPercent: number;
	dailyMessageLimit: number;
	quietStart: string;
	quietEnd: string;
	notifyOnLimit: boolean;
	aggregationSeconds: number;
	cooldownMinutes: number;
	judgeProviderId: string;
	judgeModelId: string;
};
/**
 * 插件启停配置。
 *
 * 只记录「管理员明确允许/禁止哪些插件运行」；插件自身的配置存在插件目录，业务数据存在存储命名空间。
 *
 * `enabled` 留空表示「所有已安装插件都启用」——装好插件却毫无反应比误启用更难排查。
 * 要禁止某个插件，把它列进 `disabled`。
 */
export type PluginSettings = {
	/** 白名单：仅在非空时生效，列出的插件才会启动。 */
	enabled: string[];
	/** 黑名单：始终优先于白名单。 */
	disabled: string[];
};
/**
 * 斜杠命令配置。
 *
 * `disabled` 与插件白名单同一个取向：留空表示全部启用。命令是「已经装在代码里的入口」，
 * 默认全关会让人以为命令坏了；要收口就显式列出来。
 */
export type CommandSettings = {
	/** 被禁用的命令名（不含前导斜杠）。 */
	disabled: string[];
};
export type AppConfig = {
	qqBots: QqBotConfig[];
	providers: ProviderConfig[];
	imageProviders: ImageProviderConfig[];
	personas: PersonaConfig[];
	activePersonaId: string;
	tools: ToolSettings;
	access: AccessSettings;
	mcpServers: McpServerConfig[];
	proactiveGate: ProactiveGateSettings;
	plugins: PluginSettings;
	/**
	 * 管理员名单：QQ 用户 openid。**空 = 没有人能执行管理员命令**（安全默认）。
	 *
	 * 不用 `config.access.allowedPeers` 兼任：那是「谁能用这个 Bot」，这里是「谁能让 Bot
	 * 做管理动作」，两件事的授权范围差一个数量级，混在一起会让一次白名单调整顺带提权。
	 */
	admins: string[];
	commands: CommandSettings;
};
export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export function createDefaultConfig(): AppConfig {
	return {
		qqBots: [],
		providers: [
			{
				id: "openai",
				name: "OpenAI 兼容",
				api: "openai-completions",
				apiKey: "",
				baseUrl: "https://api.openai.com/v1",
				enabled: true,
				ttsModel: "",
				imageModel: "",
				models: [
					{
						id: "gpt-4o-mini",
						name: "GPT-4o mini",
						api: "openai-completions",
						maxOutput: 4096,
						maxContext: 128000,
						compressionThreshold: 100000,
						supportsThinking: false,
						supportsVision: true,
						supportsTools: true,
					},
				],
			},
		],
		imageProviders: [
			{
				id: "openai-images",
				name: "OpenAI 图像生成",
				api: "openai-images",
				apiKey: "",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-image-1",
				enabled: true,
			},
		],
		personas: [
			{
				id: "default",
				name: "Miu",
				description: "温柔可靠的猫娘助手",
				systemPrompt:
					"你是 Miu，一只温柔、可靠的猫娘助手。用自然、友善的中文回复，适度使用语气词，不要声称自己执行了未执行的操作。",
			},
		],
		activePersonaId: "default",
		tools: {
			enabled: ["web_search"],
			mcpEnabled: false,
			skillsEnabled: false,
			stickersEnabled: false,
			stickerAutoCollectProbability: 0,
			stickerTaggerProviderId: "",
			stickerTaggerModelId: "",
			webSearch: { provider: "tavily", apiKeys: { tavily: "", brave: "", exa: "", serper: "" } },
			imageGen: { providerId: "" },
		},
		mcpServers: [],
		access: { allowedPeers: [] },
		proactiveGate: {
			enabled: false,
			mode: "smart",
			probabilityPercent: 10,
			dailyMessageLimit: 0,
			quietStart: "00:00",
			quietEnd: "00:00",
			notifyOnLimit: false,
			aggregationSeconds: 8,
			cooldownMinutes: 10,
			judgeProviderId: "",
			judgeModelId: "",
		},
		plugins: { enabled: [], disabled: [] },
		admins: [],
		commands: { disabled: [] },
	};
}

export function evaluateProactiveGate(settings: ProactiveGateSettings, sentToday: number, now = new Date()): string[] {
	const reasons: string[] = [];
	if (!settings.enabled) reasons.push("disabled");
	if (settings.dailyMessageLimit > 0 && sentToday >= settings.dailyMessageLimit) reasons.push("daily-limit");
	if (settings.quietStart !== settings.quietEnd) {
		const current = now.getHours() * 60 + now.getMinutes();
		const [startHour, startMinute] = settings.quietStart.split(":").map(Number);
		const [endHour, endMinute] = settings.quietEnd.split(":").map(Number);
		const start = startHour * 60 + startMinute;
		const end = endHour * 60 + endMinute;
		const quiet = start < end ? current >= start && current < end : current >= start || current < end;
		if (quiet) reasons.push("quiet-hours");
	}
	return reasons;
}

export async function createChatCompletion(
	config: AppConfig,
	providerId: string,
	modelId: string,
	message: string,
	history: ChatMessage[],
): Promise<{ ok: boolean; text?: string; error?: string; providerId?: string; modelId?: string }> {
	const provider =
		config.providers.find((item) => item.id === providerId) ?? config.providers.find((item) => item.enabled);
	const model = provider?.models.find((item) => item.id === modelId) ?? provider?.models[0];
	if (!provider || !model) return { ok: false, error: "尚未配置可用的提供商和模型" };
	if (!provider.apiKey) return { ok: false, error: `提供商 ${provider.name} 尚未配置 API Key` };
	const messages = [...history, { role: "user" as const, content: message }];
	try {
		if (model.api === "anthropic-messages") {
			const system = messages
				.filter((item) => item.role === "system")
				.map((item) => item.content)
				.join("\n\n");
			const response = await fetch(
				`${(provider.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": provider.apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: model.id,
						max_tokens: model.maxOutput,
						system,
						messages: messages.filter((item) => item.role !== "system"),
					}),
				},
			);
			const data: unknown = await response.json();
			if (!response.ok) return { ok: false, error: JSON.stringify(data) };
			const content =
				(data as { content?: Array<{ text?: string }> }).content?.map((item) => item.text ?? "").join("") ?? "";
			return { ok: true, text: content, providerId: provider.id, modelId: model.id };
		}
		const response = await fetch(
			`${(provider.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
				body: JSON.stringify({
					model: model.id,
					messages,
					max_tokens: model.maxOutput,
					tools: model.supportsTools ? undefined : [],
				}),
			},
		);
		const data: unknown = await response.json();
		if (!response.ok) return { ok: false, error: JSON.stringify(data) };
		const text =
			(data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
		return { ok: true, text, providerId: provider.id, modelId: model.id };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
