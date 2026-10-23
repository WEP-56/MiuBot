import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 插件 Schema Config。
 *
 * 插件在 manifest 里声明 `config`，宿主负责三件事：校验 schema 本身、按 schema 校验用户输入、
 * 把「已保存值 + 默认值」合成插件读到的配置。工作台只把 schema 渲染成表单，不参与任何校验
 * 决策——三处各自演化出不同形状是这个功能最常见的坏结局。
 *
 * 只支持**扁平一层**的标量字段。嵌套 object / array 会让「表单渲染、校验错误定位、secret
 * 遮蔽」三件事同时变复杂，而当前没有插件需要它；真有需要时再扩，而不是先支持一半。
 */

export type ConfigIssue = { field: string; message: string };

/** 支持的字段类型。`integer` 是 `number` 的整数约束版本，单独列出来是为了让表单知道该给整数输入。 */
export type PluginConfigFieldType = "string" | "number" | "integer" | "boolean";

export type PluginConfigWidget = "text" | "textarea" | "password" | "select" | "switch";

/** 纯展示元数据。宿主不认识的值会被忽略，不影响校验。 */
export type PluginConfigUi = {
	widget?: PluginConfigWidget;
	placeholder?: string;
	/** 表单分组名；同组字段渲染在一起。 */
	group?: string;
};

export type PluginConfigField = {
	type: PluginConfigFieldType;
	/** 表单标签；缺省用配置键名。 */
	title?: string;
	description?: string;
	default?: string | number | boolean;
	/** 候选值；出现在这里时按 `<select>` 渲染。仅支持 string / number / integer。 */
	enum?: (string | number)[];
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	/**
	 * 敏感值（API Key、密码）。
	 *
	 * 宿主据此在管理 API 响应里剔除真值、在日志里不打印。**不是**加密存储——文件仍是明文，
	 * 与 Miubot 自身的 `config.json` 一致；这里解决的是「不要把密钥回显到浏览器」。
	 */
	secret?: boolean;
	"x-ui"?: PluginConfigUi;
};

export type PluginConfigSchema = {
	type: "object";
	properties: Record<string, PluginConfigField>;
	/** 必填键名；必须是 `properties` 的子集。 */
	required?: string[];
};

export type PluginConfigValue = string | number | boolean;
export type PluginConfigValues = Record<string, PluginConfigValue>;

/** 字段键名：驼峰或下划线均可，避免出现 `/`、空格这类在表单和 URL 里都别扭的字符。 */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** 字段数量上限。超过这个量级表单已不可用，几乎肯定是把 schema 当数据库用了。 */
const MAX_FIELDS = 64;
const WIDGETS = new Set<string>(["text", "textarea", "password", "select", "switch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldType(value: unknown): value is PluginConfigFieldType {
	return value === "string" || value === "number" || value === "integer" || value === "boolean";
}

/** 默认值是否满足字段自身的类型与取值约束。schema 阶段就挡掉，避免运行时拿到非法默认值。 */
function checkValue(field: PluginConfigField, value: unknown, fieldPath: string): ConfigIssue[] {
	const issues: ConfigIssue[] = [];
	if (field.type === "string") {
		if (typeof value !== "string") return [{ field: fieldPath, message: "必须是字符串" }];
		if (field.minLength !== undefined && value.length < field.minLength)
			issues.push({ field: fieldPath, message: `长度不能少于 ${field.minLength}` });
		if (field.maxLength !== undefined && value.length > field.maxLength)
			issues.push({ field: fieldPath, message: `长度不能超过 ${field.maxLength}` });
	} else if (field.type === "boolean") {
		if (typeof value !== "boolean") return [{ field: fieldPath, message: "必须是布尔值" }];
	} else {
		if (typeof value !== "number" || !Number.isFinite(value)) return [{ field: fieldPath, message: "必须是数字" }];
		if (field.type === "integer" && !Number.isInteger(value)) return [{ field: fieldPath, message: "必须是整数" }];
		if (field.minimum !== undefined && value < field.minimum)
			issues.push({ field: fieldPath, message: `不能小于 ${field.minimum}` });
		if (field.maximum !== undefined && value > field.maximum)
			issues.push({ field: fieldPath, message: `不能大于 ${field.maximum}` });
	}
	if (field.enum && !field.enum.includes(value as string | number))
		issues.push({ field: fieldPath, message: `必须是以下之一：${field.enum.join(" / ")}` });
	return issues;
}

/**
 * 校验 manifest 里的 `config` 声明本身。
 *
 * 这一步和「校验用户填的值」分开：schema 写错是插件作者的问题，应该让插件加载失败并指出
 * 精确字段；用户填错是使用问题，应该只让保存失败。混在一起会导致一个坏 schema 让整个插件
 * 装不上却报错说「欢迎语不合法」。
 */
export function validateConfigSchema(
	raw: unknown,
): { ok: true; schema: PluginConfigSchema } | { ok: false; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	if (!isRecord(raw)) {
		return { ok: false, issues: [{ field: "config", message: "必须是对象" }] };
	}
	if (raw.type !== "object") issues.push({ field: "config.type", message: '必须是 "object"' });

	const properties: Record<string, PluginConfigField> = {};
	if (!isRecord(raw.properties)) {
		issues.push({ field: "config.properties", message: "必须是对象" });
	} else {
		const keys = Object.keys(raw.properties);
		if (keys.length > MAX_FIELDS)
			issues.push({ field: "config.properties", message: `字段数不能超过 ${MAX_FIELDS}` });

		for (const [key, value] of Object.entries(raw.properties)) {
			const fieldPath = `config.properties.${key}`;
			if (!KEY_PATTERN.test(key)) {
				issues.push({
					field: fieldPath,
					message: "键名只能是字母开头的字母、数字、下划线组合（最长 64）",
				});
				continue;
			}
			if (!isRecord(value)) {
				issues.push({ field: fieldPath, message: "必须是对象" });
				continue;
			}
			if (!isFieldType(value.type)) {
				issues.push({
					field: `${fieldPath}.type`,
					message: '必须是 "string" / "number" / "integer" / "boolean"',
				});
				continue;
			}

			const field: PluginConfigField = { type: value.type };

			for (const textKey of ["title", "description"] as const) {
				const text = value[textKey];
				if (text === undefined) continue;
				if (typeof text !== "string") {
					issues.push({ field: `${fieldPath}.${textKey}`, message: "必须是字符串" });
					continue;
				}
				field[textKey] = text;
			}

			for (const numberKey of ["minLength", "maxLength", "minimum", "maximum"] as const) {
				const number = value[numberKey];
				if (number === undefined) continue;
				if (typeof number !== "number" || !Number.isFinite(number)) {
					issues.push({ field: `${fieldPath}.${numberKey}`, message: "必须是数字" });
					continue;
				}
				field[numberKey] = number;
			}
			if (field.minLength !== undefined && field.type !== "string")
				issues.push({ field: `${fieldPath}.minLength`, message: "只对 string 有效" });
			if (field.maxLength !== undefined && field.type !== "string")
				issues.push({ field: `${fieldPath}.maxLength`, message: "只对 string 有效" });
			if (field.minimum !== undefined && field.type === "string")
				issues.push({ field: `${fieldPath}.minimum`, message: "只对 number / integer 有效" });
			if (field.maximum !== undefined && field.type === "string")
				issues.push({ field: `${fieldPath}.maximum`, message: "只对 number / integer 有效" });
			if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)
				issues.push({ field: `${fieldPath}.minLength`, message: "不能大于 maxLength" });
			if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
				issues.push({ field: `${fieldPath}.minimum`, message: "不能大于 maximum" });

			if (value.enum !== undefined) {
				if (!Array.isArray(value.enum) || value.enum.length === 0) {
					issues.push({ field: `${fieldPath}.enum`, message: "必须是非空数组" });
				} else if (value.type === "boolean") {
					issues.push({ field: `${fieldPath}.enum`, message: "不支持 boolean 枚举，改用 switch" });
				} else {
					const candidates: (string | number)[] = [];
					for (const [index, candidate] of value.enum.entries()) {
						const expected = value.type === "string" ? "string" : "number";
						if (typeof candidate !== expected) {
							issues.push({ field: `${fieldPath}.enum[${index}]`, message: `必须是 ${expected}` });
							continue;
						}
						if (value.type === "integer" && !Number.isInteger(candidate)) {
							issues.push({ field: `${fieldPath}.enum[${index}]`, message: "必须是整数" });
							continue;
						}
						candidates.push(candidate as string | number);
					}
					if (new Set(candidates).size !== candidates.length)
						issues.push({ field: `${fieldPath}.enum`, message: "存在重复候选值" });
					field.enum = candidates;
				}
			}

			if (value.secret !== undefined) {
				if (typeof value.secret !== "boolean") {
					issues.push({ field: `${fieldPath}.secret`, message: "必须是布尔值" });
				} else if (value.secret && value.type !== "string") {
					// 数字 / 布尔值遮蔽没有意义，也说明作者选错了类型。
					issues.push({ field: `${fieldPath}.secret`, message: "只对 string 有效" });
				} else {
					field.secret = value.secret;
				}
			}

			if (value["x-ui"] !== undefined) {
				const ui = value["x-ui"];
				if (!isRecord(ui)) {
					issues.push({ field: `${fieldPath}.x-ui`, message: "必须是对象" });
				} else {
					const parsed: PluginConfigUi = {};
					if (ui.widget !== undefined) {
						if (typeof ui.widget !== "string" || !WIDGETS.has(ui.widget)) {
							issues.push({
								field: `${fieldPath}.x-ui.widget`,
								message: "必须是 text / textarea / password / select / switch",
							});
						} else {
							parsed.widget = ui.widget as PluginConfigWidget;
						}
					}
					if (ui.placeholder !== undefined) {
						if (typeof ui.placeholder !== "string") {
							issues.push({ field: `${fieldPath}.x-ui.placeholder`, message: "必须是字符串" });
						} else {
							parsed.placeholder = ui.placeholder;
						}
					}
					if (ui.group !== undefined) {
						if (typeof ui.group !== "string") {
							issues.push({ field: `${fieldPath}.x-ui.group`, message: "必须是字符串" });
						} else {
							parsed.group = ui.group;
						}
					}
					field["x-ui"] = parsed;
				}
			}

			if (value.default !== undefined) {
				const defaultIssues = checkValue(field, value.default, `${fieldPath}.default`);
				issues.push(...defaultIssues);
				// 默认值类型都不对时不要登记，否则后续合并会拿它当合法值。
				if (defaultIssues.length === 0) field.default = value.default as PluginConfigValue;
			}

			properties[key] = field;
		}
	}

	const required: string[] = [];
	if (raw.required !== undefined) {
		if (!Array.isArray(raw.required)) {
			issues.push({ field: "config.required", message: "必须是字符串数组" });
		} else {
			for (const [index, key] of raw.required.entries()) {
				if (typeof key !== "string") {
					issues.push({ field: `config.required[${index}]`, message: "必须是字符串" });
					continue;
				}
				if (!(key in properties)) {
					issues.push({ field: `config.required[${index}]`, message: `未在 properties 中声明：${key}` });
					continue;
				}
				required.push(key);
			}
			if (new Set(required).size !== required.length)
				issues.push({ field: "config.required", message: "存在重复键" });
		}
	}

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		schema: {
			type: "object",
			properties,
			...(required.length > 0 ? { required } : {}),
		},
	};
}

/**
 * 把「磁盘上的原始值」合成为插件读到的配置。
 *
 * 容错策略：schema 已不再声明的键、类型已不匹配的值，都**不传给插件**，退回默认值。
 * 但不主动删除磁盘上的原值——schema 改坏了又改回来时，用户填的东西还在。
 */
export function resolveConfigValues(
	schema: PluginConfigSchema | undefined,
	stored: Record<string, unknown>,
): { values: PluginConfigValues; ignoredKeys: string[]; invalidKeys: string[] } {
	if (!schema) return { values: {}, ignoredKeys: Object.keys(stored).sort(), invalidKeys: [] };

	const values: PluginConfigValues = {};
	const ignoredKeys: string[] = [];
	const invalidKeys: string[] = [];

	for (const [key, value] of Object.entries(stored)) {
		const field = schema.properties[key];
		if (!field) {
			ignoredKeys.push(key);
			continue;
		}
		// 逐字段校验而非只看 typeof：`integer` 与枚举都要一起判。
		if (checkValue(field, value, key).length > 0) invalidKeys.push(key);
		else values[key] = value as PluginConfigValue;
	}

	// 默认值只填没被合法存值覆盖的键。
	for (const [key, field] of Object.entries(schema.properties)) {
		if (key in values || field.default === undefined) continue;
		values[key] = field.default;
	}

	return { values, ignoredKeys: ignoredKeys.sort(), invalidKeys: invalidKeys.sort() };
}

/**
 * 校验用户提交的配置并补齐默认值。
 *
 * 与 `resolveConfigValues` 的差别：这里对**坏值**报错（用户刚填的东西必须告诉他哪里不对），
 * 而那边对坏值静默退回默认（插件不能因为一条脏数据起不来）。
 */
export function validateConfigValues(
	schema: PluginConfigSchema,
	input: Record<string, unknown>,
): { ok: true; values: PluginConfigValues } | { ok: false; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const values: PluginConfigValues = {};

	for (const key of Object.keys(input)) {
		if (!(key in schema.properties)) issues.push({ field: key, message: "未在 schema 中声明，可能是拼写错误" });
	}

	for (const [key, field] of Object.entries(schema.properties)) {
		const submitted = input[key];
		if (submitted === undefined) {
			const isRequired = schema.required?.includes(key) ?? false;
			if (isRequired && field.default === undefined) issues.push({ field: key, message: "必填项不能为空" });
			else if (field.default !== undefined) values[key] = field.default;
			// 必填但有默认值：用默认值，不算错。
			continue;
		}
		const fieldIssues = checkValue(field, submitted, key);
		issues.push(...fieldIssues);
		if (fieldIssues.length === 0) values[key] = submitted as PluginConfigValue;
	}

	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, values };
}

/**
 * 只保留与默认值不同的键。
 *
 * 落盘时做减法，是为了让「插件把默认欢迎语改了一句」能对没设置过该键的用户生效——
 * 全量落盘会把旧默认值永久钉在用户身上。
 */
export function compactAgainstDefaults(schema: PluginConfigSchema, values: PluginConfigValues): PluginConfigValues {
	const compacted: PluginConfigValues = {};
	for (const [key, value] of Object.entries(values)) {
		const field = schema.properties[key];
		if (!field) continue;
		if (field.default !== undefined && field.default === value) continue;
		compacted[key] = value;
	}
	return compacted;
}

/** 哪些 secret 键当前已有非空值；工作台据此显示「已设置，留空保持不变」。 */
export function configuredSecretKeys(schema: PluginConfigSchema | undefined, values: PluginConfigValues): string[] {
	if (!schema) return [];
	return Object.entries(schema.properties)
		.filter(([key, field]) => field.secret === true && values[key] !== undefined && values[key] !== "")
		.map(([key]) => key)
		.sort();
}

/** 文件模式：每个插件一个 JSON 文件，与 `plugin-data/` 平级但目录分开。 */
export type FilePluginConfigOptions = {
	/** 配置根目录；实际文件为 `<root>/<pluginId>.json`。 */
	root: string;
	pluginId: string;
};

/** 插件 id 已由 manifest 校验过字符集，这里再挡一次路径分隔符。 */
function configFileName(pluginId: string): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) throw new Error(`插件 id 不合法：${pluginId}`);
	return `${pluginId}.json`;
}

/**
 * 配置的文件读写。
 *
 * 与插件存储 `storage.ts` 分开的理由：配置是「管理员在表单里填的少量设置」，业务数据是
 * 「插件自己维护的任意结构」。两者的备份、卸载、遮蔽策略都不同，混在一个文件里会让
 * 「卸载插件保留数据」这种操作顺手把配置也带走了。
 */
export function createFilePluginConfig(options: FilePluginConfigOptions) {
	const path = join(options.root, configFileName(options.pluginId));
	let queue: Promise<void> = Promise.resolve();

	async function read(): Promise<Record<string, unknown>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			return isRecord(parsed) ? parsed : {};
		} catch {
			// 文件不存在（还没配过）与内容损坏都按「没有配置」处理：配置文件比业务数据廉价，
			// 用户重新填一次即可，不值得因此让插件起不来。
			return {};
		}
	}

	/** 串行化写入，避免两次保存互相覆盖。 */
	function write(values: PluginConfigValues): Promise<void> {
		const next = queue.then(async () => {
			await mkdir(options.root, { recursive: true });
			await writeFile(path, JSON.stringify(values, null, 2), "utf8");
		});
		queue = next.catch(() => {});
		return next;
	}

	return { path, read, write };
}

/**
 * 插件侧读配置的接口（`ctx.config`）。
 *
 * 只读：写入是管理面的动作，插件不该在运行时改自己被管理员配置的值——那会让「界面上
 * 显示 A，实际跑的是 B」。
 */
export type PluginConfigAccess = {
	/** 当前生效的完整配置，已补齐默认值。 */
	all(): Promise<PluginConfigValues>;
	/** 单个键；未声明或未设置时返回 `undefined`。 */
	get<T = unknown>(key: string): Promise<T | undefined>;
};

export function createPluginConfigAccess(options: {
	schema: PluginConfigSchema | undefined;
	read: () => Promise<Record<string, unknown>>;
}): PluginConfigAccess {
	return {
		async all() {
			return resolveConfigValues(options.schema, await options.read()).values;
		},
		async get<T = unknown>(key: string) {
			const { values } = resolveConfigValues(options.schema, await options.read());
			return values[key] as T | undefined;
		},
	};
}
