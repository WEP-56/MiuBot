/**
 * 平台事件契约（跨包稳定接口，不依赖任何平台 SDK）。
 *
 * QQ / OneBot 等适配器把自己的协议事件归一成这里的结构，插件宿主只消费标准事件。
 * 平台专有的映射表与归一化函数留在各自的适配器实现里。
 */

/** 平台标识。新增适配器时扩展这个联合。 */
export type PlatformId = "qq";

/** 标准平台事件类型。 */
export type PlatformEventType =
	| "message.received"
	| "message.sent"
	| "platform.interaction"
	| "platform.group.bot_added"
	| "platform.group.bot_removed"
	| "platform.group.message_rejected"
	| "platform.group.message_allowed"
	| "platform.c2c.message_rejected"
	| "platform.c2c.message_allowed"
	| "platform.friend.added"
	| "platform.friend.removed"
	| "platform.guild.member_added"
	| "platform.guild.member_removed"
	| "platform.reaction.added"
	| "platform.reaction.removed"
	| "platform.connection.ready"
	| "platform.connection.resumed"
	| "platform.connection.lost"
	| "platform.raw";

export type PlatformScope = "group" | "c2c" | "guild" | "dm";

/** 事件的引发者。用于避免插件被自己发出的消息自激，并限制事件触发链。 */
export type EventOrigin = "platform" | "agent" | "plugin" | "system";

export type NormalizedPlatformEvent = {
	/** 本次归一化事件的唯一标识。重投时会不同，不能当作幂等键。 */
	eventId: string;
	type: PlatformEventType;
	platform: PlatformId;
	botId: string;
	timestamp: string;
	scope?: PlatformScope;
	/** 会话对象 ID：群 OpenID 或用户 OpenID。 */
	peerId?: string;
	senderId?: string;
	payload: Record<string, unknown>;
	/**
	 * 可靠识别同一平台事件的键，仅在平台确实提供了稳定标识时填写。
	 *
	 * 没有它就不要强制去重：宁可让无法识别的重投事件再次进入插件，
	 * 也不要静默丢弃合法事件。连接类事件永远不带这个字段。
	 */
	dedupKey?: string;
	/** 内容哈希，只用于日志与诊断，不能代替 `dedupKey`。 */
	fingerprint?: string;
	/** 引发者。缺省表示宿主自身、来源未知。 */
	origin?: EventOrigin;
	/** `origin` 为 `plugin` 时的插件 id，由宿主填写，插件不能自行声明。 */
	originPluginId?: string;
	/** 触发本事件的父事件 `eventId`，用于限制事件触发链深度。 */
	causationId?: string;
	/** 原始平台数据，字段不稳定，仅供诊断与高级订阅。 */
	raw?: unknown;
};

/**
 * 事件处理函数。
 *
 * `signal` 代表当前处理任务已被请求取消（超时或插件停用），不保证异步处理已经停止——
 * 宿主必须在能力接口层拒绝已失效插件的后续操作。
 */
export type PlatformEventHandler = (event: NormalizedPlatformEvent, signal: AbortSignal) => void | Promise<void>;

/** 插件宿主可见的只读订阅面：没有 `emit`，插件不能伪造平台事件。 */
export interface PlatformEventSubscriber {
	subscribe(type: PlatformEventType | "*", handler: PlatformEventHandler): () => void;
}

export type PlatformEventBusOptions = {
	/** 单个订阅者的超时，超时只记录不阻断其它订阅者。 */
	timeoutMs?: number;
	onError?: (error: unknown, event: NormalizedPlatformEvent, type: string) => void;
};

/**
 * 服务级事件总线。
 *
 * 一个订阅者抛错或超时不影响其它订阅者，也不阻断主消息流水线——插件与业务逻辑共享这条契约。
 * 超时会同时 `abort()` 该订阅者的 `signal`；订阅者忽略信号也不会挂住主循环。
 */
export function createPlatformEventBus(options: PlatformEventBusOptions = {}) {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const handlers = new Map<string, Set<PlatformEventHandler>>();

	function subscribe(type: PlatformEventType | "*", handler: PlatformEventHandler): () => void {
		const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
		set.add(handler);
		handlers.set(type, set);
		return () => {
			const current = handlers.get(type);
			if (!current) return;
			current.delete(handler);
			if (current.size === 0) handlers.delete(type);
		};
	}

	async function runHandler(
		event: NormalizedPlatformEvent,
		type: string,
		handler: PlatformEventHandler,
	): Promise<void> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve(handler(event, controller.signal)),
				new Promise<void>((resolve) => {
					timer = setTimeout(() => {
						const error = new Error(`事件订阅者超时 ${timeoutMs}ms（${type}）`);
						// 先发取消信号，再报告超时：忽略信号的订阅者也会收到中止。
						controller.abort(error);
						options.onError?.(error, event, type);
						resolve();
					}, timeoutMs);
				}),
			]);
		} catch (error) {
			options.onError?.(error, event, type);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async function emit(event: NormalizedPlatformEvent): Promise<void> {
		const targets = [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])];
		await Promise.all(targets.map((handler) => runHandler(event, event.type, handler)));
	}

	function listenerCount(type: PlatformEventType | "*"): number {
		return handlers.get(type)?.size ?? 0;
	}

	return { subscribe, emit, listenerCount };
}

/** 平台内部使用的完整总线：带 `emit`。插件只应拿到 {@link PlatformEventSubscriber}。 */
export type PlatformEventBus = ReturnType<typeof createPlatformEventBus>;
