import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommandCatalogEntry } from "../../commands/index.ts";
import type { AppConfig } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** 管理员名单上限：够一个团队用，又不至于把配置文件写成几兆。 */
const MAX_ADMINS = 50;
/** 禁用清单上限：命令总数远小于这个数。 */
const MAX_DISABLED = 200;
/** 命令名规范，与内置命令、插件命令注册表保持一致。 */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function snapshot(ctx: HttpContext) {
	const config = ctx.config.get();
	return {
		commands: ctx.commands.list() satisfies CommandCatalogEntry[],
		admins: [...config.admins],
		disabled: [...config.commands.disabled],
		/** 空名单 = 没有人能执行管理员命令。工作台据此显示顶部提示。 */
		adminsConfigured: config.admins.length > 0,
	};
}

/**
 * `/api/commands`：斜杠命令总览与管理员名单。
 *
 * 命令的**注册**不在这里——内置命令随代码分发，插件命令随插件启停。这个端点只负责
 * 「哪些开着、谁是管理员」，也就是唯一需要管理员手填的部分。
 *
 * 管理员名单与入站白名单是两件事：前者决定「谁能让 Bot 做管理动作」，后者决定
 * 「谁能用这个 Bot」。混在一起会让一次白名单调整顺带提权。
 */
export async function handleCommandRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/commands") return false;
	if (req.method === "GET") {
		json(res, 200, snapshot(ctx));
		return true;
	}
	if (req.method !== "PUT") return false;

	const input = await body(req);
	const config = ctx.config.get();
	const next: AppConfig = { ...config };

	if (input.admins !== undefined) {
		if (!Array.isArray(input.admins)) {
			json(res, 400, { ok: false, message: "admins 必须是数组" });
			return true;
		}
		const admins: string[] = [];
		for (const entry of input.admins) {
			if (typeof entry !== "string") {
				json(res, 400, { ok: false, message: "管理员条目必须是字符串（QQ 用户 openid）" });
				return true;
			}
			const id = entry.trim();
			if (!id) continue;
			admins.push(id);
		}
		const unique = [...new Set(admins)];
		if (unique.length > MAX_ADMINS) {
			json(res, 400, { ok: false, message: `管理员最多 ${MAX_ADMINS} 人` });
			return true;
		}
		next.admins = unique;
	}

	if (input.disabled !== undefined) {
		if (!Array.isArray(input.disabled)) {
			json(res, 400, { ok: false, message: "disabled 必须是数组" });
			return true;
		}
		const disabled: string[] = [];
		for (const entry of input.disabled) {
			if (typeof entry !== "string") {
				json(res, 400, { ok: false, message: "禁用条目必须是命令名（不含斜杠）" });
				return true;
			}
			const name = entry.trim().replace(/^\//, "").toLowerCase();
			if (!name) continue;
			if (!COMMAND_NAME_PATTERN.test(name)) {
				json(res, 400, { ok: false, message: `命令名不合法：${name}` });
				return true;
			}
			disabled.push(name);
		}
		const unique = [...new Set(disabled)];
		if (unique.length > MAX_DISABLED) {
			json(res, 400, { ok: false, message: `禁用清单最多 ${MAX_DISABLED} 条` });
			return true;
		}
		next.commands = { ...config.commands, disabled: unique };
	}

	ctx.config.replace(next);
	await ctx.config.save();
	// 不把名单内容写进日志：QQ openid 是个人标识，日志页会被展示、也会随备份走。
	ctx.log("INFO", `斜杠命令配置已更新：管理员 ${next.admins.length} 人，禁用 ${next.commands.disabled.length} 条`);
	json(res, 200, { ok: true, ...snapshot(ctx) });
	return true;
}
