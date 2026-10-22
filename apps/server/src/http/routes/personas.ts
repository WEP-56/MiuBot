import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersonaConfig } from "../../runtime.ts";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** `/api/personas`：人格的增删改与切换。 */
export async function handlePersonaRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/personas" && req.method === "GET") {
		json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		return true;
	}
	if (url.pathname === "/api/personas" && req.method === "POST") {
		const input = await body(req);
		const persona: PersonaConfig = {
			id: crypto.randomUUID(),
			name: String(input.name ?? "新人格").trim(),
			description: String(input.description ?? ""),
			systemPrompt: String(input.systemPrompt ?? ""),
		};
		if (!persona.name || !persona.systemPrompt) {
			json(res, 400, { ok: false, message: "人格名称和系统提示词不能为空" });
			return true;
		}
		config.personas.push(persona);
		await ctx.config.save();
		json(res, 201, { personas: config.personas, activePersonaId: config.activePersonaId });
		return true;
	}
	// 必须排在 `/api/personas/:id` 之前：否则 `active` 会被当成人格 id 匹配走。
	if (url.pathname === "/api/personas/active" && req.method === "PUT") {
		const input = await body(req);
		const id = String(input.id ?? "");
		if (!config.personas.some((item) => item.id === id)) {
			json(res, 404, { ok: false, message: "人格不存在" });
			return true;
		}
		config.activePersonaId = id;
		await ctx.config.save();
		ctx.log("INFO", `当前人格切换为：${config.personas.find((item) => item.id === id)?.name ?? id}`);
		json(res, 200, { personas: config.personas, activePersonaId: id });
		return true;
	}
	const personaMatch = url.pathname.match(/^\/api\/personas\/([^/]+)$/);
	if (personaMatch && req.method === "PUT") {
		const persona = config.personas.find((item) => item.id === decodeURIComponent(personaMatch[1] ?? ""));
		if (!persona) {
			json(res, 404, { ok: false, message: "人格不存在" });
			return true;
		}
		const input = await body(req);
		if (typeof input.name === "string") persona.name = input.name.trim();
		if (typeof input.description === "string") persona.description = input.description;
		if (typeof input.systemPrompt === "string") persona.systemPrompt = input.systemPrompt;
		if (!persona.name || !persona.systemPrompt) {
			json(res, 400, { ok: false, message: "人格名称和系统提示词不能为空" });
			return true;
		}
		await ctx.config.save();
		json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		return true;
	}
	if (personaMatch && req.method === "DELETE") {
		const id = decodeURIComponent(personaMatch[1] ?? "");
		if (!config.personas.some((item) => item.id === id)) {
			json(res, 404, { ok: false, message: "人格不存在" });
			return true;
		}
		if (config.personas.length < 2) {
			json(res, 400, { ok: false, message: "至少保留一个人格" });
			return true;
		}
		config.personas = config.personas.filter((item) => item.id !== id);
		if (config.activePersonaId === id) config.activePersonaId = config.personas[0]?.id ?? "";
		await ctx.config.save();
		json(res, 200, { personas: config.personas, activePersonaId: config.activePersonaId });
		return true;
	}
	return false;
}
