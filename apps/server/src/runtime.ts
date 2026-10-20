export type ModelConfig = {
	id: string; name: string; api: string; baseUrl?: string; maxOutput: number; maxContext: number;
	compressionThreshold: number; supportsThinking: boolean; supportsVision: boolean; supportsTools: boolean;
};
export type ProviderConfig = { id: string; name: string; api: string; apiKey?: string; baseUrl?: string; models: ModelConfig[]; enabled: boolean; ttsModel?: string; imageModel?: string };
export type QqBotConfig = { id: string; nickname: string; avatarUrl: string; appId: string; appSecret: string; mode: "qr" | "credentials"; enabled: boolean };
export type PersonaConfig = { id: string; name: string; description: string; systemPrompt: string };
export type WebSearchProvider = "tavily" | "brave" | "exa" | "serper";
export type ToolSettings = { enabled: string[]; webSearch: { provider: WebSearchProvider; apiKeys: Record<WebSearchProvider, string> } };
export type ProactiveGateSettings = { enabled: boolean; mode: "smart" | "probability"; probabilityPercent: number; dailyMessageLimit: number; quietStart: string; quietEnd: string; notifyOnLimit: boolean; aggregationSeconds: number; cooldownMinutes: number; judgeProviderId: string; judgeModelId: string };
export type AppConfig = { qqBots: QqBotConfig[]; providers: ProviderConfig[]; personas: PersonaConfig[]; activePersonaId: string; tools: ToolSettings; proactiveGate: ProactiveGateSettings };
export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export function createDefaultConfig(): AppConfig {
	return {
		qqBots: [],
		providers: [{ id: "openai", name: "OpenAI 兼容", api: "openai-completions", apiKey: "", baseUrl: "https://api.openai.com/v1", enabled: true, ttsModel: "", imageModel: "", models: [{ id: "gpt-4o-mini", name: "GPT-4o mini", api: "openai-completions", maxOutput: 4096, maxContext: 128000, compressionThreshold: 100000, supportsThinking: false, supportsVision: true, supportsTools: true }] }],
		personas: [{ id: "default", name: "Miu", description: "温柔可靠的猫娘助手", systemPrompt: "你是 Miu，一只温柔、可靠的猫娘助手。用自然、友善的中文回复，适度使用语气词，不要声称自己执行了未执行的操作。" }],
		activePersonaId: "default",
		tools: { enabled: ["web_search"], webSearch: { provider: "tavily", apiKeys: { tavily: "", brave: "", exa: "", serper: "" } } },
		proactiveGate: { enabled: false, mode: "smart", probabilityPercent: 10, dailyMessageLimit: 0, quietStart: "00:00", quietEnd: "00:00", notifyOnLimit: false, aggregationSeconds: 8, cooldownMinutes: 10, judgeProviderId: "", judgeModelId: "" },
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

export async function createChatCompletion(config: AppConfig, providerId: string, modelId: string, message: string, history: ChatMessage[]): Promise<{ ok: boolean; text?: string; error?: string; providerId?: string; modelId?: string }> {
	const provider = config.providers.find((item) => item.id === providerId) ?? config.providers.find((item) => item.enabled);
	const model = provider?.models.find((item) => item.id === modelId) ?? provider?.models[0];
	if (!provider || !model) return { ok: false, error: "尚未配置可用的提供商和模型" };
	if (!provider.apiKey) return { ok: false, error: `提供商 ${provider.name} 尚未配置 API Key` };
	const messages = [...history, { role: "user" as const, content: message }];
	try {
		if (model.api === "anthropic-messages") {
			const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
			const response = await fetch(`${(provider.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: model.id, max_tokens: model.maxOutput, system, messages: messages.filter((item) => item.role !== "system") }) });
			const data: unknown = await response.json(); if (!response.ok) return { ok: false, error: JSON.stringify(data) };
			const content = (data as { content?: Array<{ text?: string }> }).content?.map((item) => item.text ?? "").join("") ?? "";
			return { ok: true, text: content, providerId: provider.id, modelId: model.id };
		}
		const response = await fetch(`${(provider.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model: model.id, messages, max_tokens: model.maxOutput, tools: model.supportsTools ? undefined : [] }) });
		const data: unknown = await response.json(); if (!response.ok) return { ok: false, error: JSON.stringify(data) };
		const text = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "";
		return { ok: true, text, providerId: provider.id, modelId: model.id };
	} catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
