import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createLoadSkillTool, installSkillFromGitHub, installSkillFromZip, listInstalledSkills, removeInstalledSkill } from "../src/skill-runtime.ts";

describe("load_skill tool", () => {
	it("loads a discovered skill by name and rejects unknown skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-skill-test-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const skillDir = join(agentDir, "skills", "release-notes");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes\n---\nUse concise headings.", "utf8");

		try {
			const tool = createLoadSkillTool(cwd, agentDir);
			const result = await tool.execute("call-1", { name: "release-notes" }, new AbortController().signal);
			expect(result.isError).not.toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text" });
			expect(result.content[0]?.type === "text" && result.content[0].text).toContain("Use concise headings.");

			const missing = await tool.execute("call-2", { name: "missing" }, new AbortController().signal);
			expect(missing.isError).toBe(true);
			expect(missing.content[0]?.type === "text" && missing.content[0].text).toContain("Skill not found");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("installs a single validated skill from a GitHub directory and removes it", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-skill-install-test-"));
		const agentDir = join(root, "agent");
		const sourceUrl = "https://github.com/example/skills/tree/main/skills/meeting-notes";
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("https://api.github.com/")) return Response.json({ tree: [
				{ path: "skills/meeting-notes/SKILL.md", type: "blob", mode: "100644" },
				{ path: "skills/meeting-notes/references/format.md", type: "blob", mode: "100644" },
				{ path: "skills/meeting-notes/link", type: "blob", mode: "120000" },
			] });
			if (url.endsWith("/SKILL.md")) return new Response("---\nname: meeting-notes\ndescription: Format meeting notes\n---\nUse a short summary.");
			if (url.endsWith("/format.md")) return new Response("Reference format");
			return new Response("not found", { status: 404 });
		};

		try {
			const skill = await installSkillFromGitHub(agentDir, sourceUrl, fetcher);
			expect(skill.name).toBe("meeting-notes");
			expect(listInstalledSkills(agentDir).map((item) => item.name)).toEqual(["meeting-notes"]);
			await removeInstalledSkill(agentDir, skill.name);
			expect(listInstalledSkills(agentDir)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("imports a skill from a ZIP archive and rejects invalid archives", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-skill-zip-test-"));
		const agentDir = join(root, "agent");
		const archive = zipSync({
			"skill-pack/meeting-agenda/SKILL.md": strToU8("---\nname: meeting-agenda\ndescription: Prepare meeting agendas\n---\nAsk for goals and attendees."),
			"skill-pack/meeting-agenda/references/template.md": strToU8("Agenda template"),
		});
		try {
			const skill = await installSkillFromZip(agentDir, archive);
			expect(skill.name).toBe("meeting-agenda");
			expect(listInstalledSkills(agentDir).map((item) => item.name)).toEqual(["meeting-agenda"]);
			await expect(installSkillFromZip(agentDir, new Uint8Array([1, 2, 3]))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
