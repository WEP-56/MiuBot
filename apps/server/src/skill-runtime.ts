import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { loadSkills, loadSkillsFromDir } from "@miubot/context/skills";
import { Type } from "typebox";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import type { ToolDefinition } from "@miubot/plugin/extensions/index";

const skillSchema = Type.Object({ name: Type.String({ description: "Skill name from the available skills list" }) });

export interface InstalledSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

interface SkillFile {
	relativePath: string;
	bytes: Uint8Array;
}

async function installSkillFiles(agentDir: string, files: SkillFile[]): Promise<InstalledSkill> {
	const skillsDir = resolve(agentDir, "skills");
	await mkdir(skillsDir, { recursive: true });
	const tempDir = join(skillsDir, `.install-${crypto.randomUUID()}`);
	try {
		for (const file of files) {
			const destination = resolve(tempDir, file.relativePath);
			if (!destination.startsWith(`${tempDir}${sep}`)) throw new Error("Skill 包含无效路径");
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, file.bytes, { flag: "wx" });
		}
		const skill = loadSkills({ cwd: skillsDir, agentDir, skillPaths: [tempDir], includeDefaults: false }).skills[0];
		if (!skill) throw new Error("SKILL.md 格式无效或缺少有效的 name/description");
		if (!/^[a-z0-9-]{1,64}$/.test(skill.name) || skill.name.startsWith("-") || skill.name.endsWith("-") || skill.name.includes("--")) throw new Error("Skill name 必须使用小写字母、数字和单个短横线");
		const target = join(skillsDir, skill.name);
		try { await readdir(target); throw new Error(`Skill ${skill.name} 已安装`); }
		catch (error) { if (error instanceof Error && error.message === `Skill ${skill.name} 已安装`) throw error; }
		await rename(tempDir, target);
		const installed = listInstalledSkills(agentDir).find((item) => item.name === skill.name);
		if (!installed) throw new Error("Skill 已复制，但无法重新加载");
		return installed;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function extractSkillZip(archive: Uint8Array): SkillFile[] {
	if (archive.byteLength === 0 || archive.byteLength > 20_000_000) throw new Error("ZIP 文件为空或超过 20 MB");
	const extracted = new Map<string, Uint8Array[]>();
	let fileCount = 0;
	let totalSize = 0;
	let failure: Error | undefined;
	const unzip = new Unzip((file) => {
		fileCount++;
		if (fileCount > 100) failure = new Error("ZIP 文件数量超过 100 个");
		const name = file.name.replace(/\\/g, "/");
		if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").some((part) => part === ".." || part === ".")) failure = new Error("ZIP 包含无效路径");
		if (!name.endsWith("/")) extracted.set(name, []);
		file.ondata = (error, chunk) => {
			if (error) { failure = new Error("ZIP 解压失败"); return; }
			totalSize += chunk.byteLength;
			if (totalSize > 10_000_000) { failure = new Error("解压后的 ZIP 超过 10 MB"); return; }
			if (!name.endsWith("/")) extracted.get(name)?.push(chunk);
		};
		try { file.start(); } catch { failure = new Error("ZIP 使用了不支持的压缩格式"); }
	});
	unzip.register(UnzipInflate);
	unzip.register(UnzipPassThrough);
	try { unzip.push(archive, true); } catch { failure ??= new Error("ZIP 文件损坏或压缩格式不受支持"); }
	if (failure) throw failure;
	if (fileCount === 0 || extracted.size === 0) throw new Error("ZIP 中没有文件");
	const skillFiles = [...extracted.keys()].filter((name) => name === "SKILL.md" || name.endsWith("/SKILL.md"));
	if (skillFiles.length !== 1) throw new Error(skillFiles.length === 0 ? "ZIP 中没有 SKILL.md" : "ZIP 中包含多个 Skill，请每次导入一个技能");
	const skillRoot = dirname(skillFiles[0]!).replace(/\\/g, "/");
	return [...extracted.entries()].filter(([name]) => (skillRoot === "." ? !name.includes("/") : name.startsWith(`${skillRoot}/`))).map(([name, chunks]) => {
		const relativePath = skillRoot === "." ? name : name.slice(skillRoot.length + 1);
		const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		return { relativePath, bytes };
	});
}

export async function installSkillFromZip(agentDir: string, archive: Uint8Array): Promise<InstalledSkill> {
	return installSkillFiles(agentDir, extractSkillZip(archive));
}

export function listInstalledSkills(agentDir: string): InstalledSkill[] {
	return loadSkillsFromDir({ dir: join(agentDir, "skills"), source: "user" }).skills;
}

export async function removeInstalledSkill(agentDir: string, name: string): Promise<void> {
	if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("Skill 名称无效");
	const skillsDir = resolve(agentDir, "skills");
	const matches = listInstalledSkills(agentDir).filter((skill) => skill.name === name);
	if (matches.length !== 1) throw new Error(matches.length === 0 ? "未找到已安装的 Skill" : "存在重复 Skill 名称，请先手动处理冲突");
	const target = resolve(matches[0]!.baseDir);
	if (!target.startsWith(`${skillsDir}${sep}`)) throw new Error("Skill 路径无效");
	await rm(target, { recursive: true, force: true });
}

export async function installSkillFromGitHub(agentDir: string, sourceUrl: string, fetcher: typeof fetch = fetch): Promise<InstalledSkill> {
	const url = new URL(sourceUrl);
	const parts = url.pathname.split("/").filter(Boolean);
	if (url.hostname !== "github.com" || url.protocol !== "https:" || parts.length < 5 || parts[2] !== "tree") {
		throw new Error("请提供 GitHub 技能目录链接，格式为 https://github.com/owner/repo/tree/branch/path/to/skill");
	}
	const [owner, repo, , branch, ...pathParts] = parts;
	if (!owner || !repo || !branch || pathParts.length === 0 || parts.some((part) => part === "." || part === "..")) throw new Error("GitHub 技能目录链接无效");
	const repository = repo.replace(/\.git$/, "");
	const prefix = pathParts.join("/");
	const treeResponse = await fetcher(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: { accept: "application/vnd.github+json", "user-agent": "miubot" } });
	if (!treeResponse.ok) throw new Error(`读取 GitHub 仓库失败（HTTP ${treeResponse.status}）`);
	const tree = await treeResponse.json() as { truncated?: boolean; tree?: Array<{ path: string; type: string; mode: string }> };
	if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GitHub 仓库目录过大，无法安全安装");
	const skillFiles = tree.tree.filter((entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md") && (entry.path === `${prefix}/SKILL.md` || entry.path.startsWith(`${prefix}/`)));
	if (skillFiles.length !== 1) throw new Error(skillFiles.length === 0 ? "该目录中没有 SKILL.md" : "链接目录包含多个 Skill，请提供单个 Skill 的目录链接");
	const skillRoot = dirname(skillFiles[0]!.path).replace(/\\/g, "/");
	const files = tree.tree.filter((entry) => entry.type === "blob" && entry.mode === "100644" && entry.path.startsWith(`${skillRoot}/`));
	if (files.length > 100 || files.reduce((total, file) => total + file.path.length, 0) > 100_000) throw new Error("Skill 文件数量超出限制");
	const rawRoot = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${branch}`;
	const downloaded = await Promise.all(files.map(async (file) => {
		const relativePath = file.path.slice(skillRoot.length + 1);
		if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Skill 包含无效路径");
		const response = await fetcher(`${rawRoot}/${file.path.split("/").map(encodeURIComponent).join("/")}`, { headers: { "user-agent": "miubot" } });
		if (!response.ok) throw new Error(`下载 ${relativePath} 失败（HTTP ${response.status}）`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > 2_000_000) throw new Error(`Skill 文件过大：${relativePath}`);
		return { relativePath, bytes };
	}));
	if (downloaded.reduce((total, file) => total + file.bytes.byteLength, 0) > 10_000_000) throw new Error("Skill 包超过 10 MB");
	return installSkillFiles(agentDir, downloaded);
}

export function createLoadSkillTool(cwd: string, agentDir: string): ToolDefinition<typeof skillSchema> {
	return {
		name: "load_skill",
		label: "Load Skill",
		description: "Load full instructions for a matching skill.",
		promptSnippet: "Load specialized skill instructions when a task matches an available skill",
		parameters: skillSchema,
		async execute(_id, params) {
			const skill = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills.find((item) => item.name === params.name);
			if (!skill) return { content: [{ type: "text", text: `Skill not found: ${params.name}` }], details: {}, isError: true };
			try {
				const content = await readFile(skill.filePath, "utf8");
				return { content: [{ type: "text", text: `Skill: ${skill.name}\nReferences are relative to ${skill.baseDir}.\n\n${content}` }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
			}
		},
	};
}
