import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateScheduledTaskInput } from "@miubot/plugin/tools/index";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

export async function handleSchedulerRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/scheduler" && req.method === "GET") {
		const sessions = ctx.sessions.get();
		json(res, 200, {
			tasks: ctx.scheduler.list(),
			sessions: sessions.map(({ id, title, scope, peerName, peerId, botId }) => ({
				id,
				title,
				scope,
				peerName,
				peerId,
				botId,
				tools: ctx.scheduler.allowedTools(id),
			})),
		});
		return true;
	}
	if (url.pathname === "/api/scheduler" && req.method === "POST") {
		const input = await body(req);
		const sessionId = String(input.sessionId ?? "");
		const session = ctx.sessions.get().find((item) => item.id === sessionId);
		if (!session) {
			json(res, 400, { ok: false, message: "请选择有效的绑定会话" });
			return true;
		}
		try {
			const task = await ctx.scheduler.createTask({
				name: String(input.name ?? ""),
				prompt: String(input.prompt ?? ""),
				schedule: input.schedule as CreateScheduledTaskInput["schedule"],
				allowedTools: Array.isArray(input.allowedTools) ? (input.allowedTools as string[]) : [],
				sessionId,
			});
			ctx.log("INFO", `创建定时任务：${task.name}`, sessionId);
			json(res, 201, { ok: true, task });
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	const match = url.pathname.match(/^\/api\/scheduler\/([^/]+)$/);
	if (match && req.method === "PATCH") {
		const input = await body(req);
		const task = await ctx.scheduler.updateTask(decodeURIComponent(match[1] ?? ""), {
			enabled: input.enabled === true,
		});
		json(res, task ? 200 : 404, task ? { ok: true, task } : { ok: false, message: "任务不存在" });
		return true;
	}
	if (match && req.method === "DELETE") {
		const deleted = await ctx.scheduler.deleteTask(decodeURIComponent(match[1] ?? ""));
		json(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, message: "任务不存在" });
		return true;
	}
	return false;
}
