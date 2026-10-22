import type { IncomingMessage, ServerResponse } from "node:http";
import {
	installSkillFromGitHub,
	installSkillFromZip,
	listInstalledSkills,
	removeInstalledSkill,
} from "@miubot/plugin/tools/index";
import type { HttpContext } from "../context.ts";
import { binaryBody, body, json } from "../response.ts";

/** `/api/skills`：Agent 技能目录的列出、安装与删除。 */
export async function handleSkillRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname === "/api/skills" && req.method === "GET") {
		json(res, 200, { skills: listInstalledSkills(ctx.agentDir), enabled: ctx.config.get().tools.skillsEnabled });
		return true;
	}
	if (url.pathname === "/api/skills" && req.method === "POST") {
		const input = await body(req);
		if (typeof input.sourceUrl !== "string" || input.sourceUrl.length > 2000) {
			json(res, 400, { ok: false, message: "请提供有效的 GitHub 技能目录链接" });
			return true;
		}
		try {
			const skill = await installSkillFromGitHub(ctx.agentDir, input.sourceUrl);
			if (ctx.config.get().tools.skillsEnabled) ctx.agentHost.rebuildAgentSessions();
			json(res, 201, { ok: true, skill, skills: listInstalledSkills(ctx.agentDir) });
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	if (url.pathname === "/api/skills/import" && req.method === "POST") {
		if (!req.headers["content-type"]?.toLowerCase().includes("application/zip")) {
			json(res, 415, { ok: false, message: "请上传 ZIP 文件" });
			return true;
		}
		try {
			const archive = await binaryBody(req, 20_000_000);
			const skill = await installSkillFromZip(ctx.agentDir, archive);
			if (ctx.config.get().tools.skillsEnabled) ctx.agentHost.rebuildAgentSessions();
			json(res, 201, { ok: true, skill, skills: listInstalledSkills(ctx.agentDir) });
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
	if (skillMatch && req.method === "DELETE") {
		try {
			await removeInstalledSkill(ctx.agentDir, decodeURIComponent(skillMatch[1]!));
			if (ctx.config.get().tools.skillsEnabled) ctx.agentHost.rebuildAgentSessions();
			json(res, 200, { ok: true, skills: listInstalledSkills(ctx.agentDir) });
		} catch (error) {
			json(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}
	return false;
}
