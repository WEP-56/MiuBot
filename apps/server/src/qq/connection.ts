import type { PluginHost } from "@miubot/plugin/host/index";
import { type QrConnectCredentials, startQrConnect } from "@tencent-connect/qqbot-connector";
import { QQBot, type QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import QRCode from "qrcode";
import { attachQqBotEvents } from "../platform/qq-adapter.ts";
import type { createQqPlatform } from "../platform/runtime.ts";
import type { AppConfig, QqBotConfig } from "../runtime.ts";
import { isGlobalSilenceActive } from "../runtime.ts";

export type QqConnectionState = {
	phase: "disconnected" | "connecting" | "connected" | "error";
	appId?: string;
	error?: string;
	nickname?: string;
	avatarUrl?: string;
};

export type QrState = {
	phase: "idle" | "waiting" | "connected" | "failed";
	url?: string;
	qrSvg?: string;
	error?: string;
};

export type QqConnection = {
	/** Bot id → 连接状态，管理 API 直接读它。 */
	states: Map<string, QqConnectionState>;
	/** Bot id → SDK 客户端，供主动发言、插件发送等取用。 */
	client(botId: string): QQBot | undefined;
	qr(): QrState;
	connect(botConfig: QqBotConfig): Promise<void>;
	stop(id: string): void;
	/** 启用该 Bot 并连接；同时停用其他 Bot（同一进程只跑一条 Gateway 连接）。 */
	activate(bot: QqBotConfig): Promise<void>;
	test(appId: string, appSecret: string): Promise<{ ok: boolean; message: string }>;
	startQr(nickname: string): void;
};

/**
 * QQ Bot 连接的建立、断开与扫码登录。
 *
 * 入站消息不在这里处理：由调用方通过 `onMessage` 注入，避免连接层依赖消息流水线。
 */
export function createQqConnection(deps: {
	getConfig(): AppConfig;
	saveConfig(): Promise<void>;
	platform: ReturnType<typeof createQqPlatform>;
	pluginHost: PluginHost;
	onMessage(bot: QQBot, botConfig: QqBotConfig, message: QQBotInboundMessage): Promise<void>;
}): QqConnection {
	const { getConfig, saveConfig, platform, pluginHost, onMessage } = deps;
	const states = new Map<string, QqConnectionState>();
	const clients = new Map<string, QQBot>();
	let qrStop: (() => void) | undefined;
	let qrNickname = "QQ Bot";
	let qrState: QrState = { phase: "idle" };

	function stop(id: string): void {
		clients.get(id)?.stop();
		clients.delete(id);
		const bot = getConfig().qqBots.find((item) => item.id === id);
		states.set(id, {
			phase: "disconnected",
			appId: bot?.appId,
			nickname: bot?.nickname,
			avatarUrl: bot?.avatarUrl,
		});
	}

	async function connectQQ(botConfig: QqBotConfig): Promise<void> {
		const { id, appId, appSecret } = botConfig;
		states.set(id, { phase: "connecting", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl });
		try {
			stop(id);
			states.set(id, { phase: "connecting", appId, nickname: botConfig.nickname, avatarUrl: botConfig.avatarUrl });
			const bot = new QQBot({ appId, appSecret, transport: "websocket", logger: console } as ConstructorParameters<
				typeof QQBot
			>[0]);
			attachQqBotEvents({
				bot,
				botId: id,
				eventBus: platform.eventBus,
				onMessage: (message) => onMessage(bot, botConfig, message),
				acceptEvents: () => !isGlobalSilenceActive(getConfig().globalSilence),
				// 「有插件订阅了交互」不等于「这个按钮有人认领」：由插件宿主按启用状态判断。
				canHandleInteraction: () => pluginHost.hasActiveHandler("platform.interaction"),
				onReady: (readyBot) => {
					states.set(id, {
						phase: "connected",
						appId,
						nickname: botConfig.nickname,
						avatarUrl: botConfig.avatarUrl,
					});
					void readyBot.api
						.get<{ username?: string; nickname?: string; avatar?: string }>("/users/@me")
						.then((profile) => {
							const current = getConfig().qqBots.find((item) => item.id === id);
							if (!current) return;
							if (current.nickname === "QQ Bot")
								current.nickname = profile.nickname || profile.username || current.nickname;
							current.avatarUrl = profile.avatar || current.avatarUrl;
							states.set(id, {
								phase: "connected",
								appId,
								nickname: current.nickname,
								avatarUrl: current.avatarUrl,
							});
							void saveConfig();
						})
						.catch(() => {});
				},
				onError: (error) => {
					states.set(id, {
						phase: "error",
						appId,
						nickname: botConfig.nickname,
						avatarUrl: botConfig.avatarUrl,
						error: error instanceof Error ? error.message : String(error),
					});
				},
			});
			clients.set(id, bot);
			await bot.start();
		} catch (error) {
			states.set(id, {
				phase: "error",
				appId,
				nickname: botConfig.nickname,
				avatarUrl: botConfig.avatarUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function activate(bot: QqBotConfig): Promise<void> {
		for (const current of getConfig().qqBots) {
			if (current.id !== bot.id && current.enabled) {
				current.enabled = false;
				stop(current.id);
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
		qrStop = startQrConnect(
			{
				onQrDisplayed: (url: string) => {
					void QRCode.toString(url, { type: "svg", margin: 1 })
						.then((qrSvg) => {
							qrState = { phase: "waiting", url, qrSvg };
						})
						.catch((error: unknown) => {
							qrState = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
						});
				},
				onSuccess: (credentials: QrConnectCredentials[]) => {
					const credential = credentials[0];
					if (!credential) {
						qrState = { phase: "failed", error: "扫码未返回有效凭据" };
						return;
					}
					const config = getConfig();
					const existing = config.qqBots.find((bot) => bot.appId === credential.appId);
					const bot = existing ?? {
						id: credential.appId,
						nickname: qrNickname,
						avatarUrl: "",
						appId: credential.appId,
						appSecret: credential.appSecret,
						mode: "qr" as const,
						enabled: false,
					};
					bot.appSecret = credential.appSecret;
					bot.mode = "qr";
					if (!existing) config.qqBots.push(bot);
					qrState = { phase: "connected" };
					void activate(bot);
				},
				onFailure: (error: Error) => {
					qrState = { phase: "failed", error: error.message };
				},
				onQrExpired: () => {
					qrState = { phase: "failed", error: "二维码已过期，请刷新" };
				},
			},
			{ source: "miubot", displayQrCodeToConsole: false },
		);
	}

	async function test(appId: string, appSecret: string): Promise<{ ok: boolean; message: string }> {
		if (!appId || !appSecret) return { ok: false, message: "请填写 AppID 和 AppSecret" };
		try {
			const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ appId, clientSecret: appSecret }),
			});
			if (!response.ok) return { ok: false, message: `QQ 官方接口返回 HTTP ${response.status}` };
			const payload: unknown = await response.json();
			if (
				typeof payload !== "object" ||
				payload === null ||
				typeof (payload as { access_token?: unknown }).access_token !== "string"
			) {
				return { ok: false, message: "凭据无效或官方接口未返回 access_token" };
			}
			return { ok: true, message: "QQ 官方 Bot 凭据有效" };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	return {
		states,
		client: (botId) => clients.get(botId),
		qr: () => qrState,
		connect: connectQQ,
		stop,
		activate,
		test,
		startQr,
	};
}
