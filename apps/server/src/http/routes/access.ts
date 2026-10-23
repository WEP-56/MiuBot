import type { IncomingMessage, ServerResponse } from "node:http";
import { isPeerKey } from "../../peer-key.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** 白名单条目上限：够覆盖一个 Bot 的常用群，又不至于把配置文件写成几兆。 */
const MAX_ENTRIES = 200;

/**
 * `/api/access`：入站白名单。
 *
 * 空数组 = 不限制（旧行为）。设了 `MIUBOT_ALLOWED_PEERS` 时以环境变量为准，
 * 这里只读展示并拒绝写入——否则工作台改完重启就变回环境变量的值，很难排查。
 */
export async function handleAccessRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/access") return false;
	const envPeers = ctx.envAllowedPeers;
	const config = ctx.config.get();
	if (req.method === "GET") {
		json(res, 200, {
			allowedPeers: envPeers ?? config.access.allowedPeers,
			source: envPeers ? "env" : "config",
		});
		return true;
	}
	if (req.method !== "PUT") return false;
	if (envPeers) {
		json(res, 409, {
			ok: false,
			message: "入站白名单由 MIUBOT_ALLOWED_PEERS 环境变量指定，请在部署配置里修改后重启。",
		});
		return true;
	}
	const input = await body(req);
	if (!Array.isArray(input.allowedPeers)) {
		json(res, 400, { ok: false, message: "allowedPeers 必须是数组" });
		return true;
	}
	const peers: string[] = [];
	for (const entry of input.allowedPeers) {
		if (typeof entry !== "string") {
			json(res, 400, { ok: false, message: "白名单条目必须是字符串" });
			return true;
		}
		const key = entry.trim();
		if (!key) continue;
		if (!isPeerKey(key)) {
			json(res, 400, { ok: false, message: `白名单条目格式无效：${key}（应为 group:<群 ID> 或 c2c:<用户 ID>）` });
			return true;
		}
		peers.push(key);
	}
	const unique = [...new Set(peers)];
	if (unique.length > MAX_ENTRIES) {
		json(res, 400, { ok: false, message: `白名单最多 ${MAX_ENTRIES} 条` });
		return true;
	}
	ctx.config.replace({ ...config, access: { allowedPeers: unique } });
	await ctx.config.save();
	ctx.log(
		"INFO",
		unique.length ? `入站白名单已更新：${unique.length} 个会话` : "入站白名单已清空：不限制谁能触发 Agent",
	);
	json(res, 200, { ok: true, allowedPeers: unique, source: "config" });
	return true;
}
