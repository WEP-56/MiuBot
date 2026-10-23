import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PlatformEventType } from "@miubot/shared/platform/events";
import { type PluginConfigSchema, validateConfigSchema } from "./config.ts";

/** Manifest 文件名。一个插件目录只认这一个文件。 */
export const MANIFEST_FILE = "miubot.plugin.json";

/** 当前支持的 manifest 结构版本。结构变化时递增，加载器据此拒绝未来版本。 */
export const MANIFEST_SCHEMA_VERSION = 1;

/** 插件可声明的能力。声明是「需求」，不等于自动授予；宿主仍需按配置放行。 */
export type PluginPermission =
	| "message:send"
	| `event:${PlatformEventType}`
	| "event:*"
	| "storage:read"
	| "storage:write"
	/** 允许注册 Agent Tool（`ctx.tools.register()`）。 */
	| "tool:register"
	/** 允许注册对话钩子（`ctx.extensions.register()`）。 */
	| "extension:register";

const KNOWN_PERMISSIONS = new Set<string>([
	"message:send",
	"storage:read",
	"storage:write",
	"tool:register",
	"extension:register",
	"event:*",
	"event:message.received",
	"event:message.sent",
	"event:platform.interaction",
	"event:platform.group.bot_added",
	"event:platform.group.bot_removed",
	"event:platform.group.message_rejected",
	"event:platform.group.message_allowed",
	"event:platform.c2c.message_rejected",
	"event:platform.c2c.message_allowed",
	"event:platform.friend.added",
	"event:platform.friend.removed",
	"event:platform.guild.member_added",
	"event:platform.guild.member_removed",
	"event:platform.reaction.added",
	"event:platform.reaction.removed",
	"event:platform.connection.ready",
	"event:platform.connection.resumed",
	"event:platform.connection.lost",
	"event:platform.raw",
]);

export type PluginManifest = {
	schemaVersion: number;
	id: string;
	name: string;
	version: string;
	entry: string;
	description?: string;
	permissions: PluginPermission[];
	/** 允许操作的 Bot id 列表；`["*"]` 表示全部。缺省视为 `["*"]`（单 Bot 场景）。 */
	bots?: string[];
	/** 配置声明；声明后工作台才会为它渲染表单，插件才能从 `ctx.config` 读到值。 */
	config?: PluginConfigSchema;
};

export type ManifestIssue = { field: string; message: string };

export type ManifestResult =
	| { ok: true; manifest: PluginManifest; directory: string; entryPath: string }
	| { ok: false; issues: ManifestIssue[]; directory: string };

/** 插件 id 只允许小写字母、数字、点、下划线与短横线，且必须以字母或数字开头。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 版本号：语义化版本的宽松形式，够用即可，不引入 semver 依赖。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** 入口只允许相对路径，防止 `../` 逃逸插件目录。 */
const ENTRY_PATTERN = /^\.{0,2}\/?[\w./@-]+\.(?:ts|js|mts|mjs|cts|cjs)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 校验入口路径并解析为绝对路径。
 *
 * 拒绝绝对路径、盘符、以及解析后仍在插件目录之外的情况。符号链接不在这里处理——
 * 插件目录本身由管理员放置，`realpath` 校验留给安装器（阶段 C）。
 */
export function resolveEntryPath(
	directory: string,
	entry: string,
): { ok: true; path: string } | { ok: false; message: string } {
	if (isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) {
		return { ok: false, message: "entry 必须是插件目录内的相对路径" };
	}
	const base = resolve(directory);
	const target = resolve(base, entry);
	const relativePath = relative(base, target);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		return { ok: false, message: "entry 解析后位于插件目录之外" };
	}
	if (relativePath.split(sep).includes("..")) {
		return { ok: false, message: "entry 不允许路径穿越" };
	}
	return { ok: true, path: target };
}

/** 校验一份已解析的 manifest 对象。`directory` 用于校验 entry 是否落在插件目录内。 */
export function validateManifest(
	raw: unknown,
	directory: string,
	options: { supportedSchemaVersion?: number } = {},
): ManifestResult {
	const supported = options.supportedSchemaVersion ?? MANIFEST_SCHEMA_VERSION;
	const issues: ManifestIssue[] = [];

	if (!isRecord(raw)) {
		return { ok: false, issues: [{ field: "$", message: "manifest 必须是 JSON 对象" }], directory };
	}

	const schemaVersion = raw.schemaVersion;
	if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
		issues.push({ field: "schemaVersion", message: "必须是从 1 开始的整数" });
	} else if (schemaVersion > supported) {
		issues.push({
			field: "schemaVersion",
			message: `结构版本 ${schemaVersion} 高于当前支持的 ${supported}，请升级 Miubot`,
		});
	}

	const id = readString(raw, "id");
	if (!id) issues.push({ field: "id", message: "不能为空" });
	else if (!ID_PATTERN.test(id))
		issues.push({
			field: "id",
			message: "只能包含小写字母、数字、点、下划线与短横线，且以字母或数字开头（最长 64）",
		});

	const name = readString(raw, "name");
	if (!name) issues.push({ field: "name", message: "不能为空" });
	else if (name.length > 100) issues.push({ field: "name", message: "最长 100 个字符" });

	const version = readString(raw, "version");
	if (!version) issues.push({ field: "version", message: "不能为空" });
	else if (!VERSION_PATTERN.test(version)) issues.push({ field: "version", message: "需为语义化版本，如 0.1.0" });

	const entry = readString(raw, "entry");
	let entryPath: string | undefined;
	if (!entry) {
		issues.push({ field: "entry", message: "不能为空" });
	} else if (!ENTRY_PATTERN.test(entry)) {
		issues.push({
			field: "entry",
			message: "必须是插件目录内的相对路径，扩展名为 .ts / .js / .mts / .mjs / .cts / .cjs",
		});
	} else {
		const resolved = resolveEntryPath(directory, entry);
		if (resolved.ok) entryPath = resolved.path;
		else issues.push({ field: "entry", message: resolved.message });
	}

	const permissions: PluginPermission[] = [];
	if (raw.permissions !== undefined) {
		if (!Array.isArray(raw.permissions)) {
			issues.push({ field: "permissions", message: "必须是字符串数组" });
		} else {
			for (const [index, permission] of raw.permissions.entries()) {
				if (typeof permission !== "string") {
					issues.push({ field: `permissions[${index}]`, message: "必须是字符串" });
					continue;
				}
				if (!KNOWN_PERMISSIONS.has(permission)) {
					issues.push({ field: `permissions[${index}]`, message: `未知权限：${permission}` });
					continue;
				}
				permissions.push(permission as PluginPermission);
			}
			if (new Set(permissions).size !== permissions.length)
				issues.push({ field: "permissions", message: "存在重复权限" });
		}
	}

	let bots: string[] | undefined;
	if (raw.bots !== undefined) {
		if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
			issues.push({ field: "bots", message: "必须是非空字符串数组" });
		} else if (raw.bots.some((item) => typeof item !== "string" || !item.trim())) {
			issues.push({ field: "bots", message: "必须是非空字符串数组" });
		} else {
			bots = [...new Set(raw.bots.map((item) => (item as string).trim()))];
			if (bots.includes("*") && bots.length > 1)
				issues.push({ field: "bots", message: "`*` 不能与具体 Bot id 混用" });
		}
	}

	// 先校验原始值再收窄类型，避免把 unknown 原样透出，也避免非法值被静默忽略。
	let description: string | undefined;
	if (raw.description !== undefined) {
		if (typeof raw.description !== "string" || raw.description.length > 500) {
			issues.push({ field: "description", message: "必须是不超过 500 字符的字符串" });
		} else {
			description = raw.description;
		}
	}

	// schema 写错属于插件作者的问题，必须让加载失败并指出精确字段：
	// 放行一个坏 schema 会让工作台渲染出半截表单，报错却落在「保存配置失败」上。
	let config: PluginConfigSchema | undefined;
	if (raw.config !== undefined) {
		const parsed = validateConfigSchema(raw.config);
		if (parsed.ok) config = parsed.schema;
		else issues.push(...parsed.issues);
	}

	if (
		issues.length > 0 ||
		!entryPath ||
		!id ||
		!name ||
		!version ||
		!entry ||
		typeof schemaVersion !== "number" ||
		!Number.isInteger(schemaVersion)
	) {
		return { ok: false, issues, directory };
	}

	return {
		ok: true,
		directory,
		entryPath,
		manifest: {
			schemaVersion,
			id,
			name,
			version,
			entry,
			permissions,
			...(description ? { description } : {}),
			...(bots ? { bots } : {}),
			...(config ? { config } : {}),
		},
	};
}

/** 读取并校验插件目录下的 manifest。文件缺失或 JSON 解析失败都归为可读的错误。 */
export async function loadManifest(
	directory: string,
	options: { supportedSchemaVersion?: number } = {},
): Promise<ManifestResult> {
	const path = join(directory, MANIFEST_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { ok: false, issues: [{ field: "$", message: `未找到 ${MANIFEST_FILE}` }], directory };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					field: "$",
					message: `manifest 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
				},
			],
			directory,
		};
	}
	return validateManifest(parsed, directory, options);
}
