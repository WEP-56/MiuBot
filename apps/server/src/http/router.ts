import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "./context.ts";
import { handleAccessRoutes } from "./routes/access.ts";
import { handleAuthRoutes } from "./routes/auth.ts";
import { handleChatRoutes } from "./routes/chat.ts";
import { handleCommandRoutes } from "./routes/commands.ts";
import { handleConfigRoutes } from "./routes/config.ts";
import { handleGlobalSilenceRoutes } from "./routes/global-silence.ts";
import { handleMemoryRoutes } from "./routes/memory.ts";
import { handleOverviewRoutes } from "./routes/overview.ts";
import { handlePersonaRoutes } from "./routes/personas.ts";
import { handlePluginRoutes } from "./routes/plugins.ts";
import { handleProactiveRoutes } from "./routes/proactive.ts";
import { handleProviderRoutes } from "./routes/providers.ts";
import { handleQqBotRoutes } from "./routes/qqbot.ts";
import { handleSchedulerRoutes } from "./routes/scheduler.ts";
import { handleSessionRoutes } from "./routes/sessions.ts";
import { handleSkillRoutes } from "./routes/skills.ts";
import { handleStickerRoutes } from "./routes/stickers.ts";
import { handleSystemRoutes } from "./routes/system.ts";
import { handleToolRoutes } from "./routes/tools.ts";

type RouteHandler = (ctx: HttpContext, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

/**
 * 路由表。顺序即匹配优先级：返回 `true` 表示已处理，不再继续。
 *
 * 新增管理端点在这里注册；认证、CORS、404 与错误边界由 `server.ts` 统一处理。
 */
const handlers: RouteHandler[] = [
	handleAuthRoutes,
	handleSystemRoutes,
	handleAccessRoutes,
	handleCommandRoutes,
	handleConfigRoutes,
	handleToolRoutes,
	handleOverviewRoutes,
	handleProactiveRoutes,
	handleGlobalSilenceRoutes,
	handleStickerRoutes,
	handleSchedulerRoutes,
	handleMemoryRoutes,
	handleSkillRoutes,
	handlePersonaRoutes,
	handleSessionRoutes,
	handleProviderRoutes,
	handleQqBotRoutes,
	handlePluginRoutes,
	handleChatRoutes,
];
export async function dispatch(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	for (const handle of handlers) {
		if (await handle(ctx, req, res, url)) return true;
	}
	return false;
}
