import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginStatus } from "@miubot/plugin/host/index";
import type { PluginSettings } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

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

	/**
	 * 从本地目录安装插件包。
	 *
	 * 只接受磁盘上已解压的目录（不做网页上传 / zip / 远程下载）：管理员就在这台机器上，
	 * 而解压需要额外依赖。全部校验在宿主侧完成，这里只翻译结果。
	 */
	if (url.pathname === "/api/plugins/install" && req.method === "POST") {
		const payload = await body(req);
		const sourceDir = typeof payload.path === "string" ? payload.path.trim() : "";
		if (!sourceDir) {
			json(res, 400, { ok: false, message: "path 必须是插件目录的绝对路径" });
			return true;
		}
		const installed = await ctx.plugins.install(sourceDir);
		if (!installed.ok) {
			json(res, 400, { ok: false, message: "插件包未通过校验", issues: installed.issues });
			return true;
		}
		// 装完由这里决定起不起来：宿主不读配置，配置策略只活在管理面。
		const settings = ctx.config.get().plugins;
		const allowed = isAllowedByConfig(settings, installed.status);
		if (allowed) await ctx.plugins.start(installed.status.id);
		// 新插件的工具要进已有会话，否则要等会话自然过期才生效。
		if (allowed) ctx.agentHost.rebuildAgentSessions();
		json(res, 200, { ok: true, installed: installed.status.id, started: allowed, ...snapshot(ctx) });
		return true;
	}

	/**
	 * Schema Config：`GET` 取 schema 与当前值，`PUT` 保存并让运行中的插件重新读取。
	 *
	 * 配置在插件 `setup()` 时读取，因此改完必须重启插件才生效。这里只重启**本来就在运行**
	 * 的插件：已停用的插件不该因为保存一次配置就自己起来（那与 `disabled` 的语义冲突），
	 * 它下次启动时自然会读到新值。
	 */
	const configAction = url.pathname.match(/^\/api\/plugins\/([^/]+)\/config$/);
	if (configAction && (req.method === "GET" || req.method === "PUT")) {
		const id = decodeURIComponent(configAction[1]!);
		const current = ctx.plugins.get(id);
		if (!current) {
			json(res, 404, { ok: false, message: "插件不存在" });
			return true;
		}
		if (current.source !== "plugin") {
			json(res, 400, { ok: false, message: current.error ?? "该条目不可配置" });
			return true;
		}
		const settings = ctx.config.get().plugins;

		if (req.method === "GET") {
			const config = await ctx.plugins.config.inspect(id);
			if (!config) {
				json(res, 404, { ok: false, message: "插件不存在" });
				return true;
			}
			json(res, 200, { ok: true, id, enabled: isAllowedByConfig(settings, current), ...config });
			return true;
		}

		const payload = await body(req);
		// 没有 schema 时直接说明，而不是让 `save()` 回一句「校验失败」——后者会让人
		// 以为是填错了值，实际上是这个插件根本没有可配置项。
		if (!current.hasConfig) {
			json(res, 400, { ok: false, message: "插件未在 manifest 中声明 config" });
			return true;
		}
		const values = payload.values;
		if (typeof values !== "object" || values === null || Array.isArray(values)) {
			json(res, 400, { ok: false, message: "values 必须是对象" });
			return true;
		}
		const saved = await ctx.plugins.config.save(id, values as Record<string, unknown>);
		if (!saved.ok) {
			// 逐字段返回而不是一句「保存失败」：表单要能把错误标在具体输入框上。
			json(res, 400, { ok: false, message: "配置未通过校验", issues: saved.issues });
			return true;
		}

		/**
		 * 重启才能让新配置生效（插件在 `setup()` 里读配置）。
		 *
		 * 重启后插件工具与对话钩子会以新代次重新注册，已有会话里还是旧代次的定义，
		 * 一调用就会被「插件已停用」挡掉。所以和启停一样重建一次会话——这里偷懒省掉
		 * 这一步，用户看到的现象是「改完欢迎语，Agent 的插件工具突然不好使了」。
		 */
		const restarted = current.state === "active" && isAllowedByConfig(settings, current);
		if (restarted) {
			await ctx.plugins.reload(id);
			ctx.agentHost.rebuildAgentSessions();
		}
		// 回读而不是回显 `saved.values`：后者含 secret 明文。
		const config = await ctx.plugins.config.inspect(id);
		json(res, 200, { ok: true, id, restarted, ...config });
		return true;
	}

	/**
	 * 卸载：停用 → 删插件目录 → 清配置 → 从登记表移除。
	 *
	 * 数据与配置默认保留。删代码是明确动作，删用户数据不是；要删必须显式勾选，
	 * 而且要分开勾——「保留数据但清掉配置」是合理需求。
	 */
	const uninstallAction = url.pathname.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
	if (uninstallAction && req.method === "POST") {
		const id = decodeURIComponent(uninstallAction[1]!);
		if (!ctx.plugins.get(id)) {
			json(res, 404, { ok: false, message: "插件不存在" });
			return true;
		}
		const payload = await body(req);
		const removed = await ctx.plugins.uninstall(id, {
			deleteData: payload.deleteData === true,
			deleteConfig: payload.deleteConfig === true,
		});
		if (!removed.ok) {
			json(res, 400, { ok: false, message: removed.message });
			return true;
		}
		// 配置里的 enabled / disabled 必须一起清，否则会留下一个永远不存在的 id。
		const settings = ctx.config.get().plugins;
		const enabled = settings.enabled.filter((item) => item !== id);
		const disabled = settings.disabled.filter((item) => item !== id);
		if (enabled.length !== settings.enabled.length || disabled.length !== settings.disabled.length) {
			settings.enabled = enabled;
			settings.disabled = disabled;
			await ctx.config.save();
		}
		ctx.agentHost.rebuildAgentSessions();
		json(res, 200, { ok: true, removed: removed.directory, ...snapshot(ctx) });
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

	/**
	 * 插件启停会改变它注册的工具集合，而工具是在会话创建时注入的。
	 * 这里直接重建会话：插件启停是低频管理动作，正确性比省一次重建重要。
	 * （与 MCP 配置变更走同一条路径：`routes/tools.ts` 也是重建。）
	 */
	ctx.agentHost.rebuildAgentSessions();

	json(res, 200, { ok: true, ...snapshot(ctx) });
	return true;
}
