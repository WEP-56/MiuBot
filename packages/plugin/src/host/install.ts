import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { entriesUnderRoot, findArchiveRoot, readZip } from "../archive.ts";
import { loadManifest, MANIFEST_FILE, type PluginManifest } from "./manifest.ts";

/**
 * 插件包的安装与卸载。
 *
 * 两条入口：本地目录（管理员已解压到磁盘）与 ZIP 上传（工作台选文件）。两者最终都落到
 * `<installDir>/<manifest id>`，共用同一套 `inspectPackage` 校验——**上传不等于可信**，
 * 解压出来的东西和手工放的目录要过同样的检查。
 *
 * 这一层只碰文件系统和 manifest；启停、配置清理、会话重建由宿主与路由编排。
 */

export type InstallIssue = { field: string; message: string };

/** 单个插件包的默认上限。超出的几乎肯定不是插件，而是把整个仓库目录填进来了。 */
export const DEFAULT_MAX_FILES = 2_000;
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export type PackageLimits = { maxFiles?: number; maxBytes?: number };

export type PackageInspection =
	| { ok: true; manifest: PluginManifest; entryPath: string; files: number; bytes: number }
	| { ok: false; issues: InstallIssue[] };

/**
 * 递归统计目录内容，顺便收集符号链接。
 *
 * 符号链接一律拒绝：`cp` 默认按链接本身复制，装完之后链接仍然指向源目录之外的位置，
 * 等于给了插件一条绕过 `entry` 路径校验的通道。可信包不需要符号链接。
 */
async function scanTree(
	root: string,
	limits: Required<PackageLimits>,
): Promise<{ ok: true; files: number; bytes: number } | { ok: false; issues: InstallIssue[] }> {
	const issues: InstallIssue[] = [];
	let files = 0;
	let bytes = 0;

	async function walk(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				issues.push({
					field: "package",
					message: `不支持符号链接：${full.slice(resolve(root).length + 1) || entry.name}`,
				});
				continue;
			}
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile()) {
				issues.push({ field: "package", message: `不支持的条目类型：${entry.name}` });
				continue;
			}
			files += 1;
			try {
				bytes += (await stat(full)).size;
			} catch {
				issues.push({ field: "package", message: `无法读取文件：${entry.name}` });
			}
			// 两个上限都在遍历中判断：等走完再报错，用户要先等一次完整扫描。
			if (files > limits.maxFiles) {
				issues.push({ field: "package", message: `文件数超过上限（${limits.maxFiles}）` });
				return;
			}
			if (bytes > limits.maxBytes) {
				issues.push({
					field: "package",
					message: `体积超过上限（${Math.round(limits.maxBytes / 1024 / 1024)} MB）`,
				});
				return;
			}
		}
	}

	try {
		await walk(root);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{ field: "$", message: `读取插件目录失败：${error instanceof Error ? error.message : String(error)}` },
			],
		};
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, files, bytes };
}

/**
 * 校验一个待安装的插件包。
 *
 * 只做「装了能不能跑起来」的判断：manifest 合法、入口文件真的存在、没有符号链接、
 * 没有超出体积上限。`id` 冲突、目标目录是否已存在由宿主判断——那需要知道已有的登记表。
 */
export async function inspectPackage(sourceDir: string, limits: PackageLimits = {}): Promise<PackageInspection> {
	const resolved = resolve(sourceDir);
	// 相对路径会按服务进程的 cwd 解析，用户以为是仓库根、实际是 `apps/server`。
	// 安装是低频动作，要求绝对路径比让两边各猜一个基准更省事。
	if (!isAbsolute(sourceDir)) {
		return { ok: false, issues: [{ field: "path", message: "必须是绝对路径" }] };
	}

	let info: Awaited<ReturnType<typeof stat>> | undefined;
	try {
		info = await stat(resolved);
	} catch {
		return { ok: false, issues: [{ field: "path", message: `目录不存在：${resolved}` }] };
	}
	// 指到单个文件时报错说明，而不是让 loadManifest 去拼一个不存在的路径。
	if (!info.isDirectory()) {
		return { ok: false, issues: [{ field: "path", message: `不是目录：${resolved}` }] };
	}

	const manifest = await loadManifest(resolved);
	if (!manifest.ok) {
		return {
			ok: false,
			issues: manifest.issues.map((issue) => ({ field: `manifest.${issue.field}`, message: issue.message })),
		};
	}

	// `resolveEntryPath` 挡住了字符串层面的逃逸，但文件可能根本不存在——那种包装上去
	// 只会在启用时报「加载失败」，不如在安装时就说明白。
	try {
		const entryInfo = await stat(manifest.entryPath);
		if (!entryInfo.isFile()) {
			return { ok: false, issues: [{ field: "entry", message: "入口不是文件" }] };
		}
	} catch {
		return {
			ok: false,
			issues: [{ field: "entry", message: `入口文件不存在：${manifest.manifest.entry}` }],
		};
	}

	const tree = await scanTree(resolved, {
		maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
		maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES,
	});
	if (!tree.ok) return tree;

	return {
		ok: true,
		manifest: manifest.manifest,
		entryPath: manifest.entryPath,
		files: tree.files,
		bytes: tree.bytes,
	};
}

/** 把插件包复制到目标目录。目标必须不存在，避免覆盖已装的插件。 */
export async function copyPackage(sourceDir: string, targetDir: string): Promise<void> {
	await mkdir(dirname(resolve(targetDir)), { recursive: true });
	await cp(resolve(sourceDir), resolve(targetDir), {
		recursive: true,
		force: false,
		errorOnExist: true,
		// 校验阶段已拒绝符号链接，这里保持默认的「不解引用」把语义固定下来。
		dereference: false,
	});
}

/** 删除插件目录。整个目录一起删——插件代码脱离 manifest 没有保留价值。 */
export async function deletePackage(directory: string): Promise<void> {
	await rm(resolve(directory), { recursive: true, force: true });
}

/**
 * 把 ZIP 解到 `targetParent` 下的临时目录，返回该目录。
 *
 * 临时目录用 `.incoming-` 前缀放在安装目录**内部**：宿主的 `discover()` 跳过隐藏目录，
 * 解压途中不会被登记成一个「manifest 合法但文件还没写完」的插件；同一分区也保证后续
 * `rename` 是原子的，不会出现「复制一半」的插件。
 *
 * 这里不判断 id 冲突、不做启停——那些需要宿主的登记表。
 */
export async function extractPackage(
	archive: Uint8Array,
	targetParent: string,
): Promise<{ ok: true; directory: string } | { ok: false; issues: InstallIssue[] }> {
	let entries: Awaited<ReturnType<typeof readZip>>;
	try {
		// 插件包比技能包宽松：可能带图标、字体这类静态资源。
		entries = readZip(archive, { maxFiles: DEFAULT_MAX_FILES, maxTotalBytes: DEFAULT_MAX_BYTES });
	} catch (error) {
		return { ok: false, issues: [{ field: "zip", message: error instanceof Error ? error.message : String(error) }] };
	}

	const marker = findArchiveRoot(entries, MANIFEST_FILE);
	if (!marker) {
		return { ok: false, issues: [{ field: "zip", message: `ZIP 中没有 ${MANIFEST_FILE}` }] };
	}
	if (marker.matches > 1) {
		return {
			ok: false,
			issues: [{ field: "zip", message: `ZIP 中包含多个 ${MANIFEST_FILE}，请每次只导入一个插件` }],
		};
	}

	const directory = join(resolve(targetParent), `.incoming-${randomUUID()}`);
	try {
		for (const file of entriesUnderRoot(entries, marker.root)) {
			const destination = join(directory, file.path);
			// `readZip` 已经挡掉 `..` 与绝对路径，这里再确认落点确实在临时目录内：
			// 解压是外来字节写本地文件，多一道判断比事后排查便宜。
			const rel = relative(directory, destination);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`ZIP 包含无效路径：${file.path}`);
			}
			await mkdir(dirname(destination), { recursive: true });
			// `wx` 拒绝覆盖：重名条目在 `readZip` 已拦，这里防的是大小写不敏感文件系统上的撞名。
			await writeFile(destination, file.bytes, { flag: "wx" });
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		return { ok: false, issues: [{ field: "zip", message: error instanceof Error ? error.message : String(error) }] };
	}

	return { ok: true, directory };
}
