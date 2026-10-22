import type {
	NormalizedPlatformEvent,
	PlatformEventHandler,
	PlatformEventSubscriber,
	PlatformEventType,
} from "@miubot/shared/platform/events";
import type { MessageTarget, PluginMessageSender, PluginTextOptions } from "@miubot/shared/platform/outbound";
import type { PluginLifecycle } from "./lifecycle.ts";
import { PluginInactiveError } from "./lifecycle.ts";
import type { PluginPermission } from "./manifest.ts";

/** 插件持久化存储接口。按插件 id 隔离命名空间，插件拿不到其它插件或 Miubot 全局配置。 */
export interface PluginStorage {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
}

export type PluginLogger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
};

/** 插件可见的上下文。没有相应授权时，对应能力调用会抛错。 */
export type PluginContext = {
	readonly id: string;
	readonly botIds: readonly string[];
	readonly logger: PluginLogger;
	/** 只读事件订阅面：没有 `emit`，插件不能伪造平台事件。 */
	readonly events: PluginEventSubscriber;
	readonly messages: PluginMessageSender;
	readonly storage: PluginStorage;
	/** 登记清理函数，停用时按后进先出顺序执行。 */
	onDispose(disposer: () => void | Promise<void>): void;
	/** 插件被停用时触发。是**本实例**的信号，不会被后续重启覆盖。 */
	readonly signal: AbortSignal;
	/** 本实例的运行代次；异步任务恢复执行后可用 `assertActive()` 校验自身是否仍有效。 */
	readonly generation: number;
	/** 断言本实例仍然有效；跨越停用或重启边界后抛出 {@link PluginInactiveError}。 */
	assertActive(action?: string): void;
};

/** 插件专用的事件订阅面：在只读契约之上增加「是否接收自身来源」的开关。 */
export interface PluginEventSubscriber extends PlatformEventSubscriber {
	/**
	 * 同时接收本插件自己引发的事件（例如 `message.sent`）。
	 *
	 * 默认 {@link PlatformEventSubscriber.subscribe} 不接收，否则「监听发送事件再回复」
	 * 的插件会自我触发；统计类插件才需要这条通道。
	 */
	subscribeIncludingSelfOrigin(type: PlatformEventType | "*", handler: PlatformEventHandler): () => void;
}

export type PluginSetup = (ctx: PluginContext) => void | Promise<void>;

export type PluginDefinition = {
	id: string;
	setup: PluginSetup;
	/** 可选：停用时的额外清理。等价于在 setup 里调用 `ctx.onDispose()`。 */
	dispose?: () => void | Promise<void>;
};

export type PluginContextDependencies = {
	lifecycle: PluginLifecycle;
	manifestId: string;
	botIds: readonly string[];
	permissions: ReadonlySet<PluginPermission>;
	/** 平台事件订阅；由宿主包装，负责过滤插件无权订阅的事件类型。 */
	subscribePlatformEvent: (
		ownerId: string,
		type: PlatformEventType | "*",
		handler: PlatformEventHandler,
		options?: { includeSelfOrigin?: boolean },
	) => () => void;
	/** 出站发送；由宿主包装，负责权限、Bot 范围、代次与速率校验。第一个参数是插件 id。 */
	sendMessage: (
		pluginId: string,
		botId: string,
		target: MessageTarget,
		text: string,
		options?: PluginTextOptions,
	) => Promise<void>;
	storage: PluginStorage;
	logger: PluginLogger;
};

/** 订阅权限覆盖：`event:*` 授权全部事件类型。 */
function allowsEvent(permissions: ReadonlySet<PluginPermission>, type: PlatformEventType | "*"): boolean {
	if (permissions.has("event:*")) return true;
	return permissions.has(`event:${type}` as PluginPermission);
}

/** 插件是否被允许操作某个 Bot。manifest 未声明 `bots` 时视为全部允许。 */
export function allowsBot(botIds: readonly string[], botId: string): boolean {
	return botIds.includes("*") || botIds.includes(botId);
}

/**
 * 构造插件上下文。
 *
 * 所有能力都包了「启用状态 + 代次」校验：插件被停用后，即使旧 Handler 仍在后台运行，
 * 调用 `sendText()` 也会得到 {@link PluginInactiveError}，而不是悄悄发出消息。
 *
 * 代次与取消信号在**构造时捕获**，之后不再读取 lifecycle 的当前值。否则旧实例跨越
 * 「停用 → 重新启用」边界后，`assertActive()` 会看到新实例的 `active` 状态而放行，
 * 旧 Handler 就重新获得了已经被撤销的能力。
 */
export function createPluginContext(deps: PluginContextDependencies): PluginContext {
	const { lifecycle, permissions } = deps;
	/** 本 Context 所属的插件实例代次；跨代次调用一律拒绝。 */
	const generation = lifecycle.generation;
	/** 本实例的取消信号；停用后旧 Handler 看到的是自己那个已 abort 的信号。 */
	const signal = lifecycle.signal;

	function guard(action: string): void {
		lifecycle.assertGeneration(generation, action);
	}

	/** 订阅的公共部分：代次、权限、Bot 范围三重校验，外加取消登记。 */
	function createSubscription(
		type: PlatformEventType | "*",
		handler: PlatformEventHandler,
		options: { includeSelfOrigin?: boolean },
	): () => void {
		// 订阅必须在启用期间完成；停用后订阅即失效，避免遗留监听。
		guard(`订阅事件 ${type}`);
		if (!allowsEvent(permissions, type)) {
			throw new PluginInactiveError(deps.manifestId, `未声明权限 event:${type}`);
		}
		const unsubscribe = deps.subscribePlatformEvent(
			deps.manifestId,
			type,
			(event: NormalizedPlatformEvent, eventSignal) => {
				// 派发时再次校验：订阅可能在插件停用后仍被事件总线持有。
				// 与捕获的代次比较，跨代次一律不投递。
				if (lifecycle.generation !== generation || lifecycle.state !== "active") return;
				// Bot 范围校验：订阅路径同样受 manifest 的 `bots` 约束，
				// 否则声明只服务某个 Bot 的插件仍会收到其它 Bot 的消息正文与群 OpenID。
				if (!allowsBot(deps.botIds, event.botId)) return;
				return handler(event, eventSignal);
			},
			options,
		);
		const untrack = lifecycle.track(unsubscribe);
		return () => {
			untrack();
			unsubscribe();
		};
	}

	return {
		id: deps.manifestId,
		botIds: deps.botIds,
		logger: {
			info: (message) => deps.logger.info(`[${deps.manifestId}] ${message}`),
			warn: (message) => deps.logger.warn(`[${deps.manifestId}] ${message}`),
			error: (message) => deps.logger.error(`[${deps.manifestId}] ${message}`),
		},
		events: {
			subscribe(type, handler) {
				return createSubscription(type, handler, {});
			},
			/**
			 * 同时接收本插件自己引发的事件（例如「已发送」观察）。
			 *
			 * 默认不接收：否则「监听 message.sent 再回复」的插件会自我触发。
			 * 统计类插件可用它统计自己发出的消息——但要注意出站限流仍然生效。
			 */
			subscribeIncludingSelfOrigin(type, handler) {
				return createSubscription(type, handler, { includeSelfOrigin: true });
			},
		},
		messages: {
			async sendText(botId, target, text, options) {
				guard(`发送消息到 ${target.scope}:${target.targetId}`);
				if (!permissions.has("message:send")) {
					throw new PluginInactiveError(deps.manifestId, "未声明权限 message:send");
				}
				if (!allowsBot(deps.botIds, botId)) {
					throw new PluginInactiveError(deps.manifestId, `未授权操作 Bot ${botId}`);
				}
				await deps.sendMessage(deps.manifestId, botId, target, text, options);
			},
		},
		storage: {
			async get(key) {
				guard("读取存储");
				if (!permissions.has("storage:read")) {
					throw new PluginInactiveError(deps.manifestId, "未声明权限 storage:read");
				}
				return deps.storage.get(key);
			},
			async set(key, value) {
				guard("写入存储");
				if (!permissions.has("storage:write")) {
					throw new PluginInactiveError(deps.manifestId, "未声明权限 storage:write");
				}
				return deps.storage.set(key, value);
			},
			async delete(key) {
				guard("删除存储");
				if (!permissions.has("storage:write")) {
					throw new PluginInactiveError(deps.manifestId, "未声明权限 storage:write");
				}
				return deps.storage.delete(key);
			},
			async keys() {
				guard("列举存储");
				if (!permissions.has("storage:read")) {
					throw new PluginInactiveError(deps.manifestId, "未声明权限 storage:read");
				}
				return deps.storage.keys();
			},
		},
		onDispose: (disposer) => {
			// 与其它能力一致：跨越停用边界后，旧实例不得再登记新的清理函数。
			guard("登记清理函数");
			lifecycle.track(disposer);
		},
		// 暴露本实例自己的信号与代次，而不是 lifecycle 的当前值。
		signal,
		get generation() {
			return generation;
		},
		assertActive: (action = "执行操作") => guard(action),
	};
}
