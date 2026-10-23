import type { CommandCatalogEntry, CommandDefinition, CommandPermission, CommandSummary } from "./types.ts";

/** 插件命令的只读视图。执行仍走插件宿主的 `run()`，注册表只负责「有没有、能不能用」。 */
export type PluginCommandView = {
	pluginId: string;
	name: string;
	description: string;
	permission: CommandPermission;
};

/** 命中的命令：内置命令带完整定义，插件命令带来源插件 id。 */
export type ResolvedCommand =
	| {
			source: "builtin";
			name: string;
			description: string;
			permission: CommandPermission;
			definition: CommandDefinition;
	  }
	| {
			source: "plugin";
			name: string;
			description: string;
			permission: CommandPermission;
			pluginId: string;
	  };

export type CommandRegistryDependencies = {
	builtins: readonly CommandDefinition[];
	/** 插件命令视图；存活与 Bot 作用域已由插件宿主过滤。 */
	plugins: {
		list(): PluginCommandView[];
		find(name: string, scope: { botId: string }): PluginCommandView | undefined;
	};
	/** 该命令是否被 `config.commands.disabled` 关掉。 */
	isDisabled(name: string): boolean;
};

export type CommandRegistry = {
	/** 命中且启用的命令；未注册或被禁用时返回 `undefined`（调用方按普通消息继续处理）。 */
	resolve(name: string, scope: { botId: string }): ResolvedCommand | undefined;
	/** 工作台清单：内置 + 存活插件命令，带启用状态。 */
	list(): CommandCatalogEntry[];
	/** 某个调用者能用的命令（已按权限过滤），供 `/help` 使用。 */
	available(isAdmin: boolean): CommandSummary[];
};

/**
 * 命令注册表。
 *
 * 两件事只在这里做：**内置优先**（插件不能覆盖内置命令，注册时已被宿主挡住，这里再兜一层）
 * 与**配置禁用**。权限判定不在这里——它需要知道调用者是谁，属于分发环节。
 */
export function createCommandRegistry(deps: CommandRegistryDependencies): CommandRegistry {
	/** 插件命令按名字排序：`/help` 的输出顺序不该随加载顺序漂移。 */
	function pluginCommands(): PluginCommandView[] {
		return [...deps.plugins.list()].sort((left, right) => left.name.localeCompare(right.name));
	}

	function list(): CommandCatalogEntry[] {
		return [
			...deps.builtins.map((definition) => ({
				name: definition.name,
				description: definition.description,
				permission: definition.permission,
				source: "builtin" as const,
				enabled: !deps.isDisabled(definition.name),
			})),
			...pluginCommands().map((command) => ({
				name: command.name,
				description: command.description,
				permission: command.permission,
				source: "plugin" as const,
				pluginId: command.pluginId,
				enabled: !deps.isDisabled(command.name),
			})),
		];
	}

	return {
		resolve(name, scope) {
			// 被禁用的命令当作不存在：消息继续按普通聊天处理（群里非 @ 的仍走插话）。
			if (deps.isDisabled(name)) return undefined;
			const builtin = deps.builtins.find((item) => item.name === name);
			if (builtin) {
				return {
					source: "builtin",
					name: builtin.name,
					description: builtin.description,
					permission: builtin.permission,
					definition: builtin,
				};
			}
			const plugin = deps.plugins.find(name, scope);
			if (!plugin) return undefined;
			return {
				source: "plugin",
				name: plugin.name,
				description: plugin.description,
				permission: plugin.permission,
				pluginId: plugin.pluginId,
			};
		},
		list,
		available(isAdmin) {
			return list()
				.filter((entry) => entry.enabled && (isAdmin || entry.permission !== "admin"))
				.map((entry) => ({
					name: entry.name,
					description: entry.description,
					permission: entry.permission,
					source: entry.source,
					...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
				}));
		},
	};
}
