import type { IncomingMessage, ServerResponse } from "node:http";
import { type ChatMessage, createChatCompletion } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** `/api/chat`：调试台直接打一次模型请求，不经过会话与 Agent Loop。 */
export async function handleChatRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/chat" || req.method !== "POST") return false;
	const input = await body(req);
	const message = String(input.message ?? "");
	const result = await createChatCompletion(
		ctx.config.get(),
		String(input.providerId ?? ""),
		String(input.modelId ?? ""),
		message,
		Array.isArray(input.messages) ? (input.messages as ChatMessage[]) : [],
	);
	ctx.log(
		result.ok ? "INFO" : "ERROR",
		result.ok
			? `调试台模型请求完成：${result.providerId}/${result.modelId}`
			: `调试台模型请求失败：${result.error ?? "未知错误"}`,
	);
	json(res, result.ok ? 200 : 400, result);
	return true;
}
