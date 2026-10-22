import type { AgentToolResult } from "@miubot/agent";
import { type TSchema, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * 插件注册的 Agent Tool。
 *
 * 这里是「插件想暴露给模型的工具」的唯一权威来源：注册、命名冲突检查、启停联动的存活判定
 * 都在这一层完成。会话侧拿到的是已经绑好作用域的 {@link ToolDefinition}，不需要再知道
 * 插件是谁。
 */

/** 插件可声明的最小参数结构。只支持标量：复杂 schema 由插件自己在 execute 里校验。 */
export type PluginToolParameter = {
	type: "string" | "number" | "integer" | "boolean";
	description?: string;
};

export type PluginToolParameters = {
	properties?: Record<string, PluginToolParameter>;
	/** 必填字段名；不在列表里的字段一律可选。 */
	required?: string[];
};

/** 插件工具的执行结果。字符串等价于 `{ text }`。 */
export type PluginToolResult = {
	/** 交给模型看的文本，不能为空。 */
	text: string;
	/** 结构化细节，只用于日志与诊断，不发给模型。 */
	details?: unknown;
	/** 以「失败」而非「成功」呈现给模型；不会中断整轮对话。 */
	isError?: boolean;
};

export type PluginToolContext = {
	readonly pluginId: string;
	/** 工具被取消（会话中断、超时或插件停用）时触发。 */
	readonly signal: AbortSignal;
	readonly logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
};

export type PluginToolDefinition = {
	/** 暴露给模型的名字，同时用于注册表去重。 */
	name: string;
	/** 给模型看的说明；空字符串会让模型无法判断何时调用。 */
	description: string;
	/** 工作台展示名，缺省等于 `name`。 */
	label?: string;
	parameters?: PluginToolParameters;
	/** 单次执行上限，毫秒。缺省 30 秒，上限 2 分钟。 */
	timeoutMs?: number;
	execute(input: Record<string, unknown>, ctx: PluginToolContext): Promise<PluginToolResult | string>;
};

export type PluginToolRegistration = {
	pluginId: string;
	/** 注册时的插件代次；停用或重启后与当前代次不符即视为失效。 */
	generation: number;
	/** manifest 声明的 Bot 范围，用于按会话过滤。 */
	botIds: readonly string[];
	definition: PluginToolDefinition;
};

/** 工具名规范：小写蛇形，3–48 字符。既好读，也不容易和内置工具撞名。 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,47}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export type PluginToolRegistryDependencies = {
	/**
	 * 已被内置工具 / MCP 工具占用的名字。
	 *
	 * 用回调而不是快照：MCP 服务器是运行时才连上的，快照会漏掉后来出现的工具名。
	 */
	reservedNames: () => Iterable<string>;
	/** 该插件当前是否仍可执行（启用中且代次一致）。 */
	isLive: (pluginId: string, generation: number) => boolean;
	logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
};

export type PluginToolRegistry = {
	register(registration: PluginToolRegistration): () => void;
	/** 摘掉某个插件的全部登记；停用时调用，避免条目随启停次数增长。 */
	removeOwner(pluginId: string): void;
	/** 某插件登记过的工具名（不判存活，供工作台展示）。 */
	namesOf(pluginId: string): string[];
	/** 当前存活且允许在该 Bot 上使用的工具，转成会话可直接消费的定义。 */
	definitionsFor(scope: { botId: string }): ToolDefinition[];
	/** 与 `definitionsFor` 同名同序，便于算「当前会话该激活哪些工具名」。 */
	namesFor(scope: { botId: string }): string[];
	/** 全部存活登记（诊断用）。 */
	list(): Array<{ pluginId: string; name: string; description: string }>;
};

/** 把插件声明的扁平参数结构转成 TypeBox schema。 */
function toParameterSchema(parameters: PluginToolParameters | undefined): TSchema {
	const properties: Record<string, TSchema> = {};
	const required = new Set(parameters?.required ?? []);
	for (const [name, parameter] of Object.entries(parameters?.properties ?? {})) {
		const options = parameter.description ? { description: parameter.description } : {};
		const schema =
			parameter.type === "number"
				? Type.Number(options)
				: parameter.type === "integer"
					? Type.Integer(options)
					: parameter.type === "boolean"
						? Type.Boolean(options)
						: Type.String(options);
		properties[name] = required.has(name) ? schema : Type.Optional(schema);
	}
	// `additionalProperties: false`：模型多塞字段时尽早报错，而不是让插件自己收到意料外的输入。
	return Type.Object(properties, { additionalProperties: false });
}

/** 校验注册参数。抛出即让插件 setup 失败——静默忽略比失败更难排查。 */
export function validatePluginTool(definition: PluginToolDefinition): string[] {
	const issues: string[] = [];
	if (typeof definition.name !== "string" || !TOOL_NAME_PATTERN.test(definition.name)) {
		issues.push(`工具名 ${String(definition.name)} 不合法：需为 3–48 位小写字母、数字或下划线，且以字母开头`);
	}
	if (typeof definition.description !== "string" || !definition.description.trim()) {
		issues.push("工具描述不能为空：模型靠它判断何时调用");
	} else if (definition.description.length > 2000) {
		issues.push("工具描述最多 2000 个字符");
	}
	if (definition.label !== undefined && (typeof definition.label !== "string" || definition.label.length > 100)) {
		issues.push("工具展示名最多 100 个字符");
	}
	if (
		definition.timeoutMs !== undefined &&
		(typeof definition.timeoutMs !== "number" ||
			!Number.isFinite(definition.timeoutMs) ||
			definition.timeoutMs < MIN_TIMEOUT_MS ||
			definition.timeoutMs > MAX_TIMEOUT_MS)
	) {
		issues.push(`工具超时需在 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 毫秒之间`);
	}
	if (typeof definition.execute !== "function") issues.push("工具缺少 execute 函数");
	return issues;
}

export function createPluginToolRegistry(deps: PluginToolRegistryDependencies): PluginToolRegistry {
	/** 以工具名为键：模型按名字调用，重名必须在这里就挡住。 */
	const registrations = new Map<string, PluginToolRegistration>();

	function isAllowedOnBot(registration: PluginToolRegistration, botId: string): boolean {
		return registration.botIds.includes("*") || registration.botIds.includes(botId);
	}

	function liveRegistrations(): PluginToolRegistration[] {
		return [...registrations.values()].filter((item) => deps.isLive(item.pluginId, item.generation));
	}

	function register(registration: PluginToolRegistration): () => void {
		const { definition, pluginId } = registration;
		const issues = validatePluginTool(definition);
		if (issues.length > 0) {
			throw new Error(`插件 ${pluginId} 注册工具失败：${issues.join("；")}`);
		}
		const reserved = new Set(deps.reservedNames());
		if (reserved.has(definition.name)) {
			throw new Error(`插件 ${pluginId} 注册工具失败：工具名 ${definition.name} 已被内置或 MCP 工具占用`);
		}
		const existing = registrations.get(definition.name);
		if (existing) {
			// 同名覆盖会让模型按名字调用时打到另一个插件的实现上，必须显式失败。
			throw new Error(`插件 ${pluginId} 注册工具失败：工具名 ${definition.name} 已被插件 ${existing.pluginId} 占用`);
		}
		registrations.set(definition.name, registration);
		deps.logger.info(`插件 ${pluginId} 注册工具 ${definition.name}`);
		return () => {
			// 只删自己那一条：中间可能已经被重启的实例重新登记过同名工具。
			const current = registrations.get(definition.name);
			if (current === registration) registrations.delete(definition.name);
		};
	}

	/** 组装成会话可直接使用的 ToolDefinition；作用域与存活判定都封装在 execute 里。 */
	function toToolDefinition(registration: PluginToolRegistration): ToolDefinition {
		const { definition, pluginId, generation } = registration;
		const parameters = toParameterSchema(definition.parameters);
		return {
			name: definition.name,
			label: definition.label ?? definition.name,
			description: definition.description,
			parameters,
			// 调用前再核一次：会话可能创建于插件启用期间，之后插件被停用或重启。
			async execute(toolCallId, params, signal, _onUpdate, _ctx): Promise<AgentToolResult<unknown>> {
				if (!deps.isLive(pluginId, generation)) {
					throw new Error(`插件 ${pluginId} 已停用，工具 ${definition.name} 不可用`);
				}
				if (signal?.aborted) throw new Error(`工具 ${definition.name} 调用已被取消`);
				const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
				const controller = new AbortController();
				const forwardAbort = () => controller.abort(signal?.reason);
				signal?.addEventListener("abort", forwardAbort, { once: true });
				// 计时器不阻塞进程退出；插件不理会信号时由 race 兜底，不会挂住整轮对话。
				const timer = setTimeout(() => controller.abort(new Error(`工具执行超时（${timeoutMs}ms）`)), timeoutMs);
				timer.unref?.();
				const aborted = new Promise<never>((_, reject) => {
					controller.signal.addEventListener(
						"abort",
						() =>
							reject(
								controller.signal.reason instanceof Error
									? controller.signal.reason
									: new Error("工具执行已取消"),
							),
						{ once: true },
					);
				});
				try {
					const value = await Promise.race([
						definition.execute(params as Record<string, unknown>, {
							pluginId,
							signal: controller.signal,
							logger: {
								info: (message) => deps.logger.info(`[${pluginId}:${definition.name}] ${message}`),
								warn: (message) => deps.logger.warn(`[${pluginId}:${definition.name}] ${message}`),
								error: (message) => deps.logger.error(`[${pluginId}:${definition.name}] ${message}`),
							},
						}),
						aborted,
					]);
					const result: PluginToolResult = typeof value === "string" ? { text: value } : value;
					const text = typeof result?.text === "string" ? result.text : "";
					if (!text.trim()) {
						// 空结果对模型毫无信息量，直接判失败比让它继续猜更好。
						return {
							content: [{ type: "text", text: `工具 ${definition.name} 没有返回内容` }],
							details: undefined,
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text }],
						details: result.details,
						...(result.isError === true ? { isError: true } : {}),
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					deps.logger.warn(`插件 ${pluginId} 的工具 ${definition.name} 执行失败：${message}（${toolCallId}）`);
					throw error;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", forwardAbort);
				}
			},
		};
	}

	return {
		register,
		removeOwner(pluginId) {
			for (const [name, registration] of registrations) {
				if (registration.pluginId === pluginId) registrations.delete(name);
			}
		},
		namesOf(pluginId) {
			return [...registrations.values()]
				.filter((registration) => registration.pluginId === pluginId)
				.map((registration) => registration.definition.name)
				.sort();
		},
		definitionsFor(scope) {
			return liveRegistrations()
				.filter((registration) => isAllowedOnBot(registration, scope.botId))
				.map(toToolDefinition);
		},
		namesFor(scope) {
			return liveRegistrations()
				.filter((registration) => isAllowedOnBot(registration, scope.botId))
				.map((registration) => registration.definition.name);
		},
		list() {
			return liveRegistrations().map((registration) => ({
				pluginId: registration.pluginId,
				name: registration.definition.name,
				description: registration.definition.description,
			}));
		},
	};
}
