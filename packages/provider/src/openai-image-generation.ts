export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageQuality = "auto" | "low" | "medium" | "high";

export type OpenAIImageGenerationOptions = {
	apiKey: string;
	baseUrl?: string;
	model: string;
	prompt: string;
	size?: ImageSize;
	quality?: ImageQuality;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
};

export type GeneratedImage = { data: string; mimeType: string } | { url: string };

// "auto" means "let the server decide", so it is never sent: several OpenAI-compatible servers reject
// the literal value while omitting the field is equivalent.
function explicitOption<T extends string>(value: T | undefined): T | undefined {
	return value === "auto" ? undefined : value;
}

// Servers claiming the OpenAI images protocol differ in which optional fields they accept, and the
// rejection message is often generic ("invalid image generation request"). Treat those rejections as a
// compatibility signal and retry with progressively fewer optional fields before failing.
function generationAttempts(options: OpenAIImageGenerationOptions): Array<{ size?: ImageSize; quality?: ImageQuality }> {
	const size = explicitOption(options.size);
	const quality = explicitOption(options.quality);
	const attempts: Array<{ size?: ImageSize; quality?: ImageQuality }> = [];
	if (size && quality) attempts.push({ size, quality });
	if (size) attempts.push({ size });
	attempts.push({});
	return attempts;
}

function isRetryableRejection(status: number, payload: unknown): boolean {
	if (status === 400 || status === 422) return true;
	if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
	const error = (payload as { error?: { type?: unknown; code?: unknown } }).error;
	return error?.type === "invalid_request_error" || error?.code === "invalid_field_value";
}

function errorMessage(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null || !("error" in payload)) return undefined;
	const message = (payload as { error?: { message?: unknown } }).error?.message;
	return typeof message === "string" ? message : undefined;
}

function parseGeneratedImage(payload: unknown): GeneratedImage {
	const first = typeof payload === "object" && payload !== null && "data" in payload && Array.isArray(payload.data) ? payload.data[0] as { b64_json?: unknown; url?: unknown } | undefined : undefined;
	if (typeof first?.b64_json === "string" && first.b64_json) return { data: first.b64_json, mimeType: "image/png" };
	if (typeof first?.url === "string" && first.url) return { url: first.url };
	throw new Error("图像接口未返回 b64_json 或 url 图片数据");
}

export async function generateOpenAIImage(options: OpenAIImageGenerationOptions): Promise<GeneratedImage> {
	if (!options.apiKey.trim()) throw new Error("图像提供商尚未配置 API Key");
	const baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	const attempts = generationAttempts(options);
	let lastError: Error | undefined;
	for (const [index, attempt] of attempts.entries()) {
		const response = await (options.fetch ?? fetch)(`${baseUrl}/images/generations`, {
			method: "POST",
			headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: options.model, prompt: options.prompt, n: 1, ...attempt }),
			signal: options.signal,
		});
		const payload: unknown = await response.json();
		if (response.ok) return parseGeneratedImage(payload);
		const message = errorMessage(payload) ?? `图像接口返回 HTTP ${response.status}`;
		lastError = new Error(message);
		if (!isRetryableRejection(response.status, payload) || index === attempts.length - 1) throw lastError;
	}
	throw lastError ?? new Error("图像生成失败");
}
