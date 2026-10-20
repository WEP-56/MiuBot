import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { startQrConnect, type QrConnectCredentials } from "@tencent-connect/qqbot-connector";
import QRCode from "qrcode";
import { createChatCompletion, createDefaultConfig, type AppConfig, type ChatMessage, type ModelConfig, type ProviderConfig, type QqBotConfig } from "./runtime.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, ".miubot");
const configPath = join(dataDir, "config.json");
const port = Number(process.env.MIUBOT_PORT ?? 8787);

let config: AppConfig = createDefaultConfig();
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
		config = { ...createDefaultConfig(), ...current, qqBots: qqBots.map((bot) => ({ ...bot, nickname: bot.nickname || "QQ Bot", avatarUrl: bot.avatarUrl || "" })) };
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

async function saveConfig(): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
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
		bot.on("message", async (_context, message) => {
			const text = message.content.trim();
			if (!text) return;
			const provider = config.providers.find((item) => item.enabled);
			const model = provider?.models[0];
			const result = await createChatCompletion(config, provider?.id ?? "", model?.id ?? "", text, []);
			await bot.sendText(message.replyTarget, result.ok ? result.text ?? "" : `模型调用失败：${result.error ?? "未知错误"}`);
		});
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
			return json(res, result.ok ? 200 : 400, result);
		}
		return json(res, 404, { ok: false, message: "Not found" });
	} catch (error) { return json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) }); }
}

await loadConfig();
const activeBot = config.qqBots.find((bot) => bot.enabled);
if (activeBot?.appId && activeBot.appSecret) void connectQQ(activeBot);
createServer((req, res) => { void handler(req, res); }).listen(port, "127.0.0.1", () => console.log(`Miubot server listening on http://127.0.0.1:${port}`));
