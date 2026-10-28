import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServerConfig } from "@miubot/plugin/tools/index";
import type { WebSearchProvider } from "../../runtime.ts";
import { toolNames } from "../../tool-names.ts";
import type { HttpContext } from "../context.ts";
import { publicConfig, toolCatalog } from "../present.ts";
import { body, json } from "../response.ts";

/** `/api/tools` 与 `/api/mcp`：Tool 开关、搜索凭据、图像提供商选择、MCP 服务器配置。 */
export async function handleToolRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/tools" && req.method === "GET") {
		json(res, 200, {
			tools: toolCatalog.map((tool) => ({ ...tool, enabled: config.tools.enabled.includes(tool.name) })),
			mcpEnabled: config.tools.mcpEnabled,
			skillsEnabled: config.tools.skillsEnabled,
			stickersEnabled: config.tools.stickersEnabled,
			webSearch: {
				provider: config.tools.webSearch.provider,
				configuredProviders: Object.fromEntries(
					Object.entries(config.tools.webSearch.apiKeys).map(([name, key]) => [name, Boolean(key)]),
				),
			},
			// 与 `/api/config` 同一份投影：拆页面不拆接口，避免出现两个真相。
			imageGen: {
				providerId: config.tools.imageGen.providerId,
				providers: publicConfig(config).imageProviders,
			},
			timezone: config.tools.timezone,
		});
		return true;
	}
	if (url.pathname === "/api/mcp" && req.method === "GET") {
		json(res, 200, { mcpEnabled: config.tools.mcpEnabled, servers: ctx.mcpRuntime.getStatuses() });
		return true;
	}
	if (url.pathname === "/api/mcp" && req.method === "PUT") {
		const input = await body(req);
		if (!Array.isArray(input.servers)) {
			json(res, 400, { ok: false, message: "MCP 服务器列表无效" });
			return true;
		}
		const servers: McpServerConfig[] = [];
		const ids = new Set<string>();
		for (const item of input.servers) {
			if (typeof item !== "object" || item === null) {
				json(res, 400, { ok: false, message: "MCP 服务器配置无效" });
				return true;
			}
			const candidate = item as Record<string, unknown>;
			const id = String(candidate.id ?? "").trim();
			const name = String(candidate.name ?? "").trim();
			const transport = candidate.transport;
			if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || ids.has(id) || !name || name.length > 100) {
				json(res, 400, {
					ok: false,
					message: "MCP 服务器 ID 需唯一且仅包含字母、数字、下划线或短横线，名称不能为空",
				});
				return true;
			}
			ids.add(id);
			if (transport !== "stdio" && transport !== "http") {
				json(res, 400, { ok: false, message: `MCP 服务器 ${name} 的传输类型无效` });
				return true;
			}
			if (transport === "stdio") {
				const command = String(candidate.command ?? "").trim();
				const args = candidate.args;
				if (
					!command ||
					command.length > 500 ||
					(args !== undefined &&
						(!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.length > 2000)))
				) {
					json(res, 400, { ok: false, message: `MCP 服务器 ${name} 的命令或参数无效` });
					return true;
				}
				servers.push({
					id,
					name,
					transport,
					command,
					args: (args as string[] | undefined) ?? [],
					enabled: candidate.enabled === true,
				});
			} else {
				const rawUrl = String(candidate.url ?? "").trim();
				let parsed: URL;
				try {
					parsed = new URL(rawUrl);
				} catch {
					json(res, 400, { ok: false, message: `MCP 服务器 ${name} 的 URL 无效` });
					return true;
				}
				if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
					json(res, 400, { ok: false, message: `MCP 服务器 ${name} 必须使用不含内嵌凭据的 HTTPS URL` });
					return true;
				}
				servers.push({ id, name, transport, url: parsed.toString(), enabled: candidate.enabled === true });
			}
		}
		config.mcpServers = servers;
		if (typeof input.mcpEnabled === "boolean") config.tools.mcpEnabled = input.mcpEnabled;
		ctx.mcpRuntime.setGlobalToolsEnabled(config.tools.mcpEnabled);
		await ctx.mcpRuntime.replace(servers);
		await ctx.config.save();
		ctx.agentHost.rebuildAgentSessions();
		ctx.log("INFO", `MCP 服务器配置已更新（${servers.filter((server) => server.enabled).length} 个启用）`);
		json(res, 200, { ok: true, mcpEnabled: config.tools.mcpEnabled, servers: ctx.mcpRuntime.getStatuses() });
		return true;
	}
	if (url.pathname === "/api/tools" && req.method === "PUT") {
		const input = await body(req);
		if (
			!Array.isArray(input.enabled) ||
			input.enabled.some(
				(name) => typeof name !== "string" || !toolNames.includes(name as (typeof toolNames)[number]),
			)
		) {
			json(res, 400, { ok: false, message: "工具列表无效" });
			return true;
		}
		const search =
			typeof input.webSearch === "object" && input.webSearch !== null
				? (input.webSearch as Record<string, unknown>)
				: {};
		const provider = search.provider;
		if (provider !== undefined && !["tavily", "brave", "exa", "serper"].includes(String(provider))) {
			json(res, 400, { ok: false, message: "搜索提供商无效" });
			return true;
		}
		const submittedKeys =
			typeof search.apiKeys === "object" && search.apiKeys !== null
				? (search.apiKeys as Record<string, unknown>)
				: {};
		const apiKeys = { ...config.tools.webSearch.apiKeys };
		for (const name of ["tavily", "brave", "exa", "serper"] as const)
			if (typeof submittedKeys[name] === "string" && submittedKeys[name])
				apiKeys[name] = submittedKeys[name] as string;
		const previousSkillsEnabled = config.tools.skillsEnabled;
		const previousStickersEnabled = config.tools.stickersEnabled;
		const mcpEnabled = input.mcpEnabled === undefined ? config.tools.mcpEnabled : input.mcpEnabled === true;
		const skillsEnabled =
			input.skillsEnabled === undefined ? config.tools.skillsEnabled : input.skillsEnabled === true;
		const stickersEnabled =
			input.stickersEnabled === undefined ? config.tools.stickersEnabled : input.stickersEnabled === true;
		/**
		 * 图像提供商：与 `webSearch.provider` 同一个写入口，不再另开第二个。
		 *
		 * 选中的必须是「存在 + 已启用 + 有 Key」的提供商——放行一个用不了的选项，只会让
		 * `image_gen` 在真正调用时才报错，而那时用户已经在群里等了。
		 */
		const imageGenInput =
			typeof input.imageGen === "object" && input.imageGen !== null
				? (input.imageGen as Record<string, unknown>)
				: {};
		const imageGenProviderId =
			imageGenInput.providerId === undefined
				? config.tools.imageGen.providerId
				: String(imageGenInput.providerId ?? "").trim();
		const timezone = input.timezone === undefined ? config.tools.timezone : String(input.timezone).trim();
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
		} catch {
			json(res, 400, { ok: false, message: "时区无效，请使用 IANA 时区，例如 Asia/Shanghai" });
			return true;
		}
		if (imageGenProviderId) {
			const chosen = config.imageProviders.find((item) => item.id === imageGenProviderId);
			if (!chosen) {
				json(res, 400, { ok: false, message: `图像提供商不存在：${imageGenProviderId}` });
				return true;
			}
			if (!chosen.enabled) {
				json(res, 400, { ok: false, message: `图像提供商 ${chosen.name} 已停用，请先启用或换一个` });
				return true;
			}
			if (!chosen.apiKey) {
				json(res, 400, { ok: false, message: `图像提供商 ${chosen.name} 尚未配置 API Key` });
				return true;
			}
		}
		config.tools = {
			enabled: [...new Set(input.enabled as string[])],
			mcpEnabled,
			skillsEnabled,
			stickersEnabled,
			stickerAutoCollectProbability: config.tools.stickerAutoCollectProbability,
			stickerTaggerProviderId: config.tools.stickerTaggerProviderId,
			stickerTaggerModelId: config.tools.stickerTaggerModelId,
			webSearch: {
				provider: (provider as WebSearchProvider | undefined) ?? config.tools.webSearch.provider,
				apiKeys,
			},
			imageGen: { providerId: imageGenProviderId },
			timezone,
		};
		await ctx.config.save();
		if (skillsEnabled !== previousSkillsEnabled || stickersEnabled !== previousStickersEnabled)
			ctx.agentHost.rebuildAgentSessions();
		if (mcpEnabled !== ctx.mcpRuntime.getGlobalToolsEnabled()) {
			ctx.mcpRuntime.setGlobalToolsEnabled(mcpEnabled);
			ctx.agentHost.rebuildAgentSessions();
		}
		ctx.agentHost.applyToolSettings();
		json(res, 200, {
			ok: true,
			tools: toolCatalog.map((tool) => ({ ...tool, enabled: config.tools.enabled.includes(tool.name) })),
			mcpEnabled: config.tools.mcpEnabled,
			skillsEnabled: config.tools.skillsEnabled,
			stickersEnabled: config.tools.stickersEnabled,
			webSearch: {
				provider: config.tools.webSearch.provider,
				configuredProviders: Object.fromEntries(Object.entries(apiKeys).map(([name, key]) => [name, Boolean(key)])),
			},
			imageGen: {
				providerId: config.tools.imageGen.providerId,
				providers: publicConfig(config).imageProviders,
			},
			timezone: config.tools.timezone,
		});
		return true;
	}
	return false;
}
