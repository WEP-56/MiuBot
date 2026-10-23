/**
 * 插件注册的斜杠命令。
 *
 * 与工具注册表同一套语义：命名冲突在这里挡、存活判定绑在宿主条目上、执行前再复核一次。
 * 差别在权限来源——命令的 `permission` 由插件自己声明，宿主只负责在分发前按
 * `config.admins` 判断调用者够不够格。
 */

/** 谁能触发这条命令。`admin` 只对管理员名单里的 QQ 用户生效。 */
export type PluginCommandPermission = "admin" | "all";

/** 命令执行时拿到的上下文。插件只能看到自己需要的字段。 */
export type PluginCommandContext = {
	readonly pluginId: string;
	readonly botId: string;
	readonly scope: "group" | "c2c";
	/** 群 ID 或私聊用户 ID（QQ openid）。 */
	readonly peerId: string;
	readonly peerName: string;
	/** 触发这条命令的 QQ 用户 openid。 */
	readonly senderId: string;
	/** 发送者是否在管理员名单里。 */
	readonly isAdmin: boolean;
	/** 命令名之后的原始参数文本（已 trim）。 */
	readonly args: string;
	/** 回复到触发本次命令的会话；宿主负责走被动回复锚点。 */
	reply(text: string): Promise<void>;
};

export type PluginCommandDefinition = {
	/** 命令名，不含前导斜杠；同时用于注册表去重。 */
	name: string;
	/** 工作台与 `/help` 里展示的说明。 */
	description: string;
	/** 必填：默认值会让「忘了写」变成静默提权或静默失效，两者都不好排查。 */
	permission: PluginCommandPermission;
	/**
	 * 返回字符串等价于 `reply(字符串)`；也可以自己多次调用 `reply`。
	 * 其它返回值一律忽略（`unknown` 而不是 `void`：允许同步实现，也允许什么都不返回）。
	 */
	run(ctx: PluginCommandContext): unknown;
};

export type PluginCommandRegistration = {
	pluginId: string;
	/** 注册时的插件代次；停用或重启后与当前代次不符即视为失效。 */
	generation: number;
	/** manifest 声明的 Bot 范围，用于按 Bot 过滤。 */
	botIds: readonly string[];
	definition: PluginCommandDefinition;
};

/** 分发时由宿主填写；插件拿到的只是其中的 `PluginCommandContext` 部分。 */
export type PluginCommandInvocation = {
	name: string;
	botId: string;
	scope: "group" | "c2c";
	peerId: string;
	peerName: string;
	senderId: string;
	isAdmin: boolean;
	args: string;
	reply(text: string): Promise<void>;
};

export type PluginCommandRegistryDependencies = {
	/**
	 * 已被内置命令占用的名字。
	 *
	 * 用回调而不是快照：内置命令随版本变化，快照会在插件注册时用上一份旧名单。
	 */
	reservedNames: () => Iterable<string>;
	/** 该插件当前是否仍可执行（启用中且代次一致）。 */
	isLive: (pluginId: string, generation: number) => boolean;
	logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
};

export type PluginCommandRegistry = {
	register(registration: PluginCommandRegistration): () => void;
	/** 摘掉某个插件的全部登记；停用时调用，避免条目随启停次数增长。 */
	removeOwner(pluginId: string): void;
	/** 某插件登记过的命令名（不判存活，供工作台展示）。 */
	namesOf(pluginId: string): string[];
	/** 在给定 Bot 上存活且可用的命令；未注册或已失效时返回 `undefined`。 */
	find(name: string, scope: { botId: string }): PluginCommandRegistration | undefined;
	/** 执行一条命令。命令已失效时抛错，而不是静默不响应。 */
	run(invocation: PluginCommandInvocation): Promise<void>;
	/** 全部存活登记（诊断用）。 */
	list(): Array<{ pluginId: string; name: string; description: string; permission: PluginCommandPermission }>;
};

/** 命令名规范：2–24 位小写字母、数字或短横线，且以字母开头。 */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;

/** 校验注册参数。抛出即让插件 setup 失败——静默忽略比失败更难排查。 */
export function validatePluginCommand(definition: PluginCommandDefinition): string[] {
	const issues: string[] = [];
	if (typeof definition.name !== "string" || !COMMAND_NAME_PATTERN.test(definition.name)) {
		issues.push(`命令名 ${String(definition.name)} 不合法：需为 2–24 位小写字母、数字或短横线，且以字母开头`);
	}
	if (typeof definition.description !== "string" || !definition.description.trim()) {
		issues.push("命令说明不能为空：它同时用于 `/help` 与工作台展示");
	} else if (definition.description.length > 200) {
		issues.push("命令说明最多 200 个字符");
	}
	if (definition.permission !== "admin" && definition.permission !== "all") {
		issues.push("命令权限必须是 admin 或 all（不设默认值：写错就失败，而不是静默提权）");
	}
	if (typeof definition.run !== "function") issues.push("命令缺少 run 函数");
	return issues;
}

export function createPluginCommandRegistry(deps: PluginCommandRegistryDependencies): PluginCommandRegistry {
	/** 以命令名为键：用户输入的就是名字，重名必须在这里挡住。 */
	const registrations = new Map<string, PluginCommandRegistration>();

	function isAllowedOnBot(registration: PluginCommandRegistration, botId: string): boolean {
		return registration.botIds.includes("*") || registration.botIds.includes(botId);
	}

	function liveRegistrations(): PluginCommandRegistration[] {
		return [...registrations.values()].filter((item) => deps.isLive(item.pluginId, item.generation));
	}

	function register(registration: PluginCommandRegistration): () => void {
		const { definition, pluginId } = registration;
		const issues = validatePluginCommand(definition);
		if (issues.length > 0) throw new Error(`插件 ${pluginId} 注册命令失败：${issues.join("；")}`);
		if (new Set(deps.reservedNames()).has(definition.name)) {
			throw new Error(`插件 ${pluginId} 注册命令失败：命令名 /${definition.name} 已被内置命令占用`);
		}
		const existing = registrations.get(definition.name);
		if (existing) {
			// 同名覆盖会让用户敲同一个命令却打到另一个插件的实现上，必须显式失败。
			throw new Error(
				`插件 ${pluginId} 注册命令失败：命令名 /${definition.name} 已被插件 ${existing.pluginId} 占用`,
			);
		}
		registrations.set(definition.name, registration);
		deps.logger.info(`插件 ${pluginId} 注册命令 /${definition.name}`);
		return () => {
			// 只删自己那一条：中间可能已被重启的实例重新登记过同名命令。
			if (registrations.get(definition.name) === registration) registrations.delete(definition.name);
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
		find(name, scope) {
			const registration = registrations.get(name);
			if (!registration) return undefined;
			// 存活与 Bot 范围都要在分发时复核：登记可能发生在插件被停用之前。
			if (!deps.isLive(registration.pluginId, registration.generation)) return undefined;
			if (!isAllowedOnBot(registration, scope.botId)) return undefined;
			return registration;
		},
		async run(invocation) {
			const registration = registrations.get(invocation.name);
			if (!registration) throw new Error(`命令 /${invocation.name} 未注册`);
			if (!deps.isLive(registration.pluginId, registration.generation)) {
				throw new Error(`插件 ${registration.pluginId} 已停用，命令 /${invocation.name} 不可用`);
			}
			const { definition } = registration;
			const result = await definition.run({
				pluginId: registration.pluginId,
				botId: invocation.botId,
				scope: invocation.scope,
				peerId: invocation.peerId,
				peerName: invocation.peerName,
				senderId: invocation.senderId,
				isAdmin: invocation.isAdmin,
				args: invocation.args,
				reply: invocation.reply,
			});
			if (typeof result === "string" && result.trim()) await invocation.reply(result);
		},
		list() {
			return liveRegistrations().map((registration) => ({
				pluginId: registration.pluginId,
				name: registration.definition.name,
				description: registration.definition.description,
				permission: registration.definition.permission,
			}));
		},
	};
}
