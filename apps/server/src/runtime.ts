export type ModelConfig = {
	id: string; name: string; api: string; baseUrl?: string; maxOutput: number; maxContext: number;
	compressionThreshold: number; supportsThinking: boolean; supportsVision: boolean; supportsTools: boolean;
};
export type ProviderConfig = { id: string; name: string; api: string; apiKey?: string; baseUrl?: string; models: ModelConfig[]; enabled: boolean; ttsModel?: string; imageModel?: string };
export type QqBotConfig = { id: string; nickname: string; avatarUrl: string; appId: string; appSecret: string; mode: "qr" | "credentials"; enabled: boolean };
export type AppConfig = { qqBots: QqBotConfig[]; providers: ProviderConfig[] };
export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export function createDefaultConfig(): AppConfig {
	return { qqBots: [], providers: [{ id: "openai", name: "OpenAI 兼容", api: "openai-completions", apiKey: "", baseUrl: "https://api.openai.com/v1", enabled: true, ttsModel: "", imageModel: "", models: [{ id: "gpt-4o-mini", name: "GPT-4o mini", api: "openai-completions", maxOutput: 4096, maxContext: 128000, compressionThreshold: 100000, supportsThinking: false, supportsVision: true, supportsTools: true }] }] };
}

export async function createChatCompletion(config: AppConfig, providerId: string, modelId: string, message: string, history: ChatMessage[]): Promise<{ ok: boolean; text?: string; error?: string; providerId?: string; modelId?: string }> {
	const provider = config.providers.find((item) => item.id === providerId) ?? config.providers.find((item) => item.enabled);
	const model = provider?.models.find((item) => item.id === modelId) ?? provider?.models[0];
	if (!provider || !model) return { ok: false, error: "尚未配置可用的提供商和模型" };
	if (!provider.apiKey) return { ok: false, error: `提供商 ${provider.name} 尚未配置 API Key` };
	const messages = [...history, { role: "user" as const, content: message }];
	try {
		if (model.api === "anthropic-messages") {
			const response = await fetch(`${(provider.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: model.id, max_tokens: model.maxOutput, messages: messages.filter((item) => item.role !== "system") }) });
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
