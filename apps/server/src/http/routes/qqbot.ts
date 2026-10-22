import type { IncomingMessage, ServerResponse } from "node:http";
import type { QqBotConfig } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { publicConfig } from "../present.ts";
import { body, json } from "../response.ts";

/** `/api/qqbot/*`：Bot 凭据、连接状态、扫码登录。 */
export async function handleQqBotRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/qqbot/status" && req.method === "GET") {
		json(res, 200, {
			connections: config.qqBots.map((bot) => ({
				id: bot.id,
				...(ctx.qq.states.get(bot.id) ?? {
					phase: "disconnected",
					appId: bot.appId,
					nickname: bot.nickname,
					avatarUrl: bot.avatarUrl,
				}),
				enabled: bot.enabled,
			})),
			qr: ctx.qq.qr(),
		});
		return true;
	}
	if (url.pathname === "/api/qqbot/bots" && req.method === "POST") {
		const input = await body(req);
		const appId = String(input.appId ?? "").trim();
		const appSecret = String(input.appSecret ?? "").trim();
		const tested = await ctx.qq.test(appId, appSecret);
		if (!tested.ok) {
			json(res, 400, tested);
			return true;
		}
		const id = appId;
		if (config.qqBots.some((bot) => bot.id === id)) {
			json(res, 409, { ok: false, message: "该 AppID 已添加" });
			return true;
		}
		const bot: QqBotConfig = {
			id,
			nickname: String(input.nickname ?? "QQ Bot").trim() || "QQ Bot",
			avatarUrl: "",
			appId,
			appSecret,
			mode: "credentials",
			enabled: false,
		};
		config.qqBots.push(bot);
		await ctx.qq.activate(bot);
		json(res, 201, publicConfig(config));
		return true;
	}
	const botMatch = url.pathname.match(/^\/api\/qqbot\/bots\/([^/]+)$/);
	if (botMatch && req.method === "PUT") {
		const id = decodeURIComponent(botMatch[1] ?? "");
		const bot = config.qqBots.find((item) => item.id === id);
		if (!bot) {
			json(res, 404, { ok: false, message: "机器人不存在" });
			return true;
		}
		const input = await body(req);
		if (typeof input.nickname === "string") bot.nickname = input.nickname.trim() || "QQ Bot";
		if (typeof input.enabled === "boolean") {
			bot.enabled = input.enabled;
			if (input.enabled) await ctx.qq.activate(bot);
			else {
				ctx.qq.stop(id);
				await ctx.config.save();
			}
		}
		if (input.nickname !== undefined) {
			await ctx.config.save();
			const state = ctx.qq.states.get(id);
			if (state) ctx.qq.states.set(id, { ...state, nickname: bot.nickname });
		}
		json(res, 200, publicConfig(config));
		return true;
	}
	if (botMatch && req.method === "DELETE") {
		const id = decodeURIComponent(botMatch[1] ?? "");
		if (!config.qqBots.some((item) => item.id === id)) {
			json(res, 404, { ok: false, message: "机器人不存在" });
			return true;
		}
		ctx.qq.stop(id);
		config.qqBots = config.qqBots.filter((item) => item.id !== id);
		ctx.qq.states.delete(id);
		await ctx.config.save();
		json(res, 200, publicConfig(config));
		return true;
	}
	if (url.pathname === "/api/qqbot/test" && req.method === "POST") {
		const input = await body(req);
		json(res, 200, await ctx.qq.test(String(input.appId ?? ""), String(input.appSecret ?? "")));
		return true;
	}
	if (url.pathname === "/api/qqbot/connect" && req.method === "POST") {
		const input = await body(req);
		const appId = String(input.appId ?? "").trim();
		const appSecret = String(input.appSecret ?? "").trim();
		const tested = await ctx.qq.test(appId, appSecret);
		if (!tested.ok) {
			json(res, 400, tested);
			return true;
		}
		const existing = config.qqBots.find((bot) => bot.appId === appId);
		if (existing) {
			existing.appSecret = appSecret;
			existing.mode = "credentials";
			await ctx.qq.activate(existing);
		} else {
			const bot: QqBotConfig = {
				id: appId,
				nickname: "QQ Bot",
				avatarUrl: "",
				appId,
				appSecret,
				mode: "credentials",
				enabled: false,
			};
			config.qqBots.push(bot);
			await ctx.qq.activate(bot);
		}
		json(res, 202, { ok: true, message: "机器人已保存，正在连接 QQ 官方 Gateway" });
		return true;
	}
	if (url.pathname === "/api/qqbot/qr/start" && req.method === "POST") {
		const input = await body(req);
		ctx.qq.startQr(String(input.nickname ?? "QQ Bot"));
		json(res, 202, ctx.qq.qr());
		return true;
	}
	return false;
}
