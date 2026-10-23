import type { ExtensionAPI } from "../extensions/types.ts";

/**
 * 插件贡献的 Pi Extension 工厂。
 *
 * 桥接的是**钩子**（`pi.on("before_agent_start" | "tool_call" | "message_*" | ...)`）：
 * 插件想在每轮对话前补提示词、在工具调用前后观察/干预，就走这里。
 *
 * 工具注册不在这一层——`pi.registerTool()` 会被挡住，统一改用 `ctx.tools.register()`。
 * 两套注册路径会让重名检查、工作台展示和启停联动各算一套，最后必然出现
 * 「UI 里看不到、但模型能调」的工具。
 */

export type PluginExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type PluginExtensionRegistration = {
	pluginId: string;
	/** 注册时的插件代次；停用或重启后与当前代次不符即视为失效。 */
	generation: number;
	/** manifest 声明的 Bot 范围，用于按会话过滤。 */
	botIds: readonly string[];
	/** 插件内唯一短名；最终扩展路径为 `plugin:{pluginId}/{name}`。 */
	name: string;
	factory: PluginExtensionFactory;
};

/** 交给 `DefaultResourceLoader` 的形状。 */
export type PluginExtensionEntry = { name: string; factory: PluginExtensionFactory };

export type PluginExtensionRegistryDependencies = {
	/** 该插件当前是否仍可执行（启用中且代次一致）。 */
	isLive: (pluginId: string, generation: number) => boolean;
	logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
};

export type PluginExtensionRegistry = {
	register(registration: PluginExtensionRegistration): () => void;
	removeOwner(pluginId: string): void;
	namesOf(pluginId: string): string[];
	/** 当前存活且允许在该 Bot 上使用的扩展，转成资源加载器可直接消费的形状。 */
	factoriesFor(scope: { botId: string }): PluginExtensionEntry[];
	list(): Array<{ pluginId: string; name: string; path: string }>;
};

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** 扩展路径：`<inline:plugin:{pluginId}/{name}>`，服务端自己的工厂用 `miubot-*`，不会撞。 */
export function extensionPathOf(pluginId: string, name: string): string {
	return `plugin:${pluginId}/${name}`;
}

/** 校验登记参数；抛出让插件 setup 失败，好过静默丢弃。 */
export function validatePluginExtension(pluginId: string, name: string, factory: unknown): string[] {
	const issues: string[] = [];
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		issues.push(`扩展名 ${String(name)} 不合法：需为 2–32 位小写字母、数字或短横线，且以字母开头`);
	}
	if (typeof factory !== "function") issues.push(`插件 ${pluginId} 的扩展 ${name} 缺少 factory 函数`);
	return issues;
}

/**
 * 包一层 `pi`：插件扩展只能挂钩子，不能注册工具。
 *
 * `ExtensionAPI` 的方法都是闭包，展开后覆盖单个方法不会破坏其它能力。
 */
function guardExtensionApi(pi: ExtensionAPI, pluginId: string, name: string): ExtensionAPI {
	return {
		...pi,
		registerTool(): never {
			throw new Error(
				`插件 ${pluginId} 的扩展 ${name} 不能注册工具：请改用 ctx.tools.register()，` +
					"否则重名检查、工作台展示与启停联动都会漏掉它",
			);
		},
	};
}

export function createPluginExtensionRegistry(deps: PluginExtensionRegistryDependencies): PluginExtensionRegistry {
	/** 以扩展路径为键：同一插件内重名、跨插件重名都在这里挡住。 */
	const registrations = new Map<string, PluginExtensionRegistration>();

	function isAllowedOnBot(registration: PluginExtensionRegistration, botId: string): boolean {
		return registration.botIds.includes("*") || registration.botIds.includes(botId);
	}

	function liveRegistrations(): PluginExtensionRegistration[] {
		return [...registrations.values()].filter((item) => deps.isLive(item.pluginId, item.generation));
	}

	function register(registration: PluginExtensionRegistration): () => void {
		const { pluginId, name, factory } = registration;
		const issues = validatePluginExtension(pluginId, name, factory);
		if (issues.length > 0) throw new Error(`插件 ${pluginId} 注册扩展失败：${issues.join("；")}`);
		const path = extensionPathOf(pluginId, name);
		const existing = registrations.get(path);
		if (existing) {
			throw new Error(`插件 ${pluginId} 注册扩展失败：扩展名 ${name} 已被占用（${path}）`);
		}
		registrations.set(path, registration);
		deps.logger.info(`插件 ${pluginId} 注册扩展 ${path}`);
		return () => {
			// 只删自己那一条：中间可能已被重启的实例重新登记过同名扩展。
			if (registrations.get(path) === registration) registrations.delete(path);
		};
	}

	return {
		register,
		removeOwner(pluginId) {
			for (const [path, registration] of registrations) {
				if (registration.pluginId === pluginId) registrations.delete(path);
			}
		},
		namesOf(pluginId) {
			return [...registrations.values()]
				.filter((registration) => registration.pluginId === pluginId)
				.map((registration) => registration.name)
				.sort();
		},
		factoriesFor(scope) {
			return liveRegistrations()
				.filter((registration) => isAllowedOnBot(registration, scope.botId))
				.map((registration) => ({
					name: extensionPathOf(registration.pluginId, registration.name),
					// 每次装载都包一层：守卫要带上这次的插件身份，不能缓存到登记对象上。
					factory: (pi: ExtensionAPI) =>
						registration.factory(guardExtensionApi(pi, registration.pluginId, registration.name)),
				}));
		},
		list() {
			return liveRegistrations().map((registration) => ({
				pluginId: registration.pluginId,
				name: registration.name,
				path: extensionPathOf(registration.pluginId, registration.name),
			}));
		},
	};
}
