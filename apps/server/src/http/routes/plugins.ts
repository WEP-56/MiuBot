import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginStatus } from "@miubot/plugin/host/index";
import type { PluginSettings } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { json } from "../response.ts";

/**
 * `/api/plugins`：插件清单、启停与重载。
 *
 * 这里只做「配置 + 宿主状态」的翻译：启停语义由 `PluginHost` 决定，白名单规则由
 * `config.plugins` 决定。两者必须一起改——只调宿主不改配置，重启后插件会按旧配置
 * 复活或再次被压制，用户会觉得「禁用没生效」。
 */

/** 配置层的放行结论，与服务启动时的过滤规则保持一致。 */
function isAllowedByConfig(settings: PluginSettings, status: PluginStatus): boolean {
	// 失效目录与重复 id 是诊断占位，无论如何都不会运行。
	if (status.source !== "plugin") return false;
	// `disabled` 始终优先；`enabled` 为空表示「全部放行」。
	if (settings.disabled.includes(status.id)) return false;
	return settings.enabled.length === 0 || settings.enabled.includes(status.id);
}

function snapshot(ctx: HttpContext) {
	const settings = ctx.config.get().plugins;
	return {
		plugins: ctx.plugins.list().map((status) => ({ ...status, enabled: isAllowedByConfig(settings, status) })),
		settings: { enabled: [...settings.enabled], disabled: [...settings.disabled] },
		directories: ctx.plugins.directories,
	};
}

export async function handlePluginRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/plugins" && req.method === "GET") {
		json(res, 200, snapshot(ctx));
		return true;
	}
	// 重新扫描插件目录：新放进去的插件不必重启服务就能出现在列表里。
	if (url.pathname === "/api/plugins/discover" && req.method === "POST") {
		await ctx.plugins.discover();
		json(res, 200, { ok: true, ...snapshot(ctx) });
		return true;
	}
	const action = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|reload)$/);
	if (!action || req.method !== "POST") return false;

	const id = decodeURIComponent(action[1]!);
	const kind = action[2] as "enable" | "disable" | "reload";
	const current = ctx.plugins.get(id);
	if (!current) {
		json(res, 404, { ok: false, message: "插件不存在" });
		return true;
	}
	if (current.source !== "plugin") {
		// 失效目录与重复 id 是诊断占位，启停它们没有意义，直接说明原因。
		json(res, 400, { ok: false, message: current.error ?? "该条目不可启停" });
		return true;
	}

	const settings = ctx.config.get().plugins;
	if (kind === "disable") {
		settings.disabled = [...new Set([...settings.disabled, id])].sort();
		settings.enabled = settings.enabled.filter((item) => item !== id);
		await ctx.config.save();
		await ctx.plugins.stop(id);
	} else if (kind === "enable") {
		settings.disabled = settings.disabled.filter((item) => item !== id);
		// 白名单非空时必须一并放行，否则这次能起来、下次启动又被过滤掉。
		if (settings.enabled.length > 0 && !settings.enabled.includes(id)) settings.enabled.push(id);
		await ctx.config.save();
		const started = await ctx.plugins.start(id);
		// `start()` 对已记录错误的条目不重试；换成一次干净的 stop→start，
		// 让刚修好 setup 的插件点「启用」就能起来，而不是必须再点重载。
		if (started && started.state !== "active") await ctx.plugins.reload(id);
	} else {
		// 重载会真的把插件跑起来。配置层既然禁用了它，就必须先启用——
		// 否则会出现「状态 active 但 enabled=false」这种下次启动就消失的假活。
		if (!isAllowedByConfig(settings, current)) {
			json(res, 409, { ok: false, message: "插件已在配置中禁用，请先启用再重载" });
			return true;
		}
		await ctx.plugins.reload(id);
	}

	json(res, 200, { ok: true, ...snapshot(ctx) });
	return true;
}
