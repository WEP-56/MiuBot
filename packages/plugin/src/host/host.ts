import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDeduplicator, type Deduplicator } from "@miubot/shared/platform/dedup";
import type {
	NormalizedPlatformEvent,
	PlatformEventHandler,
	PlatformEventSubscriber,
	PlatformEventType,
} from "@miubot/shared/platform/events";
import type { MessageTarget, PluginTextOptions } from "@miubot/shared/platform/outbound";
import { createPluginContext, type PluginContext, type PluginLogger, type PluginStorage } from "./context.ts";
import { createPluginLifecycle, type PluginLifecycle, type PluginLifecycleState } from "./lifecycle.ts";
import { loadPluginEntry } from "./loader.ts";
import { loadManifest, MANIFEST_FILE, type PluginManifest } from "./manifest.ts";
import { createSendRateLimiter, type SendRateLimitOptions } from "./rate-limit.ts";
import { createPluginToolRegistry, type PluginToolDefinition, type PluginToolRegistry } from "./tools.ts";

/** 一个已安装插件的状态快照，用于工作台与日志展示。 */
export type PluginStatus = {
	id: string;
	name: string;
	version: string;
	description?: string;
	state: PluginLifecycleState;
	error?: string;
	permissions: string[];
	/** 当前持有的清理函数数量，用于诊断资源泄漏。 */
	disposers: number;
	/** 该插件当前登记的工具名（停用后清空）。 */
	tools: string[];
	/**
	 * 条目来源。
	 *
	 * `invalid` / `duplicate` 是诊断占位：它们代表「某个目录坏了」或「某个目录被同 id 的
	 * 插件压住了」，本身没有可运行的实现。管理界面据此禁用启停按钮，避免用户对着一个
	 * 永远失败的行反复点「启用」。
	 */
	source: "plugin" | "invalid" | "duplicate";
};

export type PluginHostDependencies = {
	/**
	 * 插件根目录；每个子目录是一个插件。
	 *
	 * 允许传多个目录，按顺序扫描；同一个 `id` 只认第一个（内置优先于用户目录），
	 * 重复的会在状态里报冲突，避免同名插件互相覆盖。
	 */
	pluginsDir: string | string[];
	/** 平台事件订阅入口；宿主在这里注入分发包装。 */
	eventSource: PlatformEventSubscriber;
	/** 出站发送；宿主在这里注入权限校验与 `OutboundChannel`。第一个参数是插件 id。 */
	sendMessage: (
		pluginId: string,
		botId: string,
		target: MessageTarget,
		text: string,
		options?: PluginTextOptions,
	) => Promise<void>;
	/** 按插件 id 取存储实例。 */
	storageFor: (pluginId: string) => PluginStorage;
	logger: PluginLogger;
	/** 未在 manifest 声明 `bots` 时的默认 Bot 范围。 */
	defaultBotIds?: string[];
	/** 事件级去重；缺省使用共享去重器。 */
	eventDeduper?: Deduplicator;
	/** 插件出站速率限制；缺省使用宽松默认值（每会话 10s / 5 次）。 */
	sendRateLimit?: SendRateLimitOptions;
	/** `setup()` 的超时上限，避免插件初始化挂起阻塞启动。默认 10 秒。 */
	setupTimeoutMs?: number;
	/**
	 * 已被内置 / MCP 工具占用的名字。
	 *
	 * 插件工具不能覆盖它们，否则「模型以为在调用内置工具、实际跑了插件代码」。
	 * 传回调而不是快照：MCP 服务器是运行时才连上的。
	 */
	reservedToolNames?: () => Iterable<string>;
};

type PluginEntry = {
	manifest: PluginManifest;
	directory: string;
	lifecycle: PluginLifecycle;
	/** 与 `PluginStatus.source` 同义，内部保留一份供状态快照使用。 */
	source: PluginStatus["source"];
	context?: PluginContext;
	error?: string;
};

/** 一条已登记的事件订阅；`ownerId` 用于在派发时隔离插件自身来源。 */
type RegisteredHandler = {
	ownerId: string;
	handler: PlatformEventHandler;
	/** 是否也接收本插件自己引发的事件（默认否，避免自激）。 */
	includeSelfOrigin: boolean;
};

/**
 * 服务级插件宿主。
 *
 * 一份实例服务所有会话：插件的 `setup()` 只在启停时执行，不会因为多个 QQ 会话而重复。
 * 这里只做事件插件相关的事，不接触 Agent Tool。
 */
export function createPluginHost(deps: PluginHostDependencies) {
	const entries = new Map<string, PluginEntry>();
	const eventDeduper = deps.eventDeduper ?? createDeduplicator();
	const setupTimeoutMs = deps.setupTimeoutMs ?? 10_000;
	/**
	 * 每个插件的生命周期操作队列。
	 *
	 * 启停是异步的多步过程（加载入口、执行 setup、跑清理），管理界面连点「启用」
	 * 会让同一个插件的 `setup()` 并发执行。按插件串行化而不是加全局锁：不同插件
	 * 之间的启停互不阻塞。
	 */
	const operationQueues = new Map<string, Promise<unknown>>();
	/**
	 * 插件工具注册表。
	 *
	 * 存活判定绑在 `entries` 上而不是另存一份状态：插件停用或重启后，
	 * 代次对不上就自动失效，不会出现「注册表说还有、实际已经停了」的错位。
	 */
	const tools: PluginToolRegistry = createPluginToolRegistry({
		reservedNames: () => deps.reservedToolNames?.() ?? [],
		isLive: (pluginId, generation) => {
			const entry = entries.get(pluginId);
			return Boolean(entry && entry.lifecycle.state === "active" && entry.lifecycle.generation === generation);
		},
		logger: deps.logger,
	});
	/**
	 * 插件对平台事件的订阅包装。宿主只注册这一个订阅者，再自行扇出。
	 *
	 * 条目带上所属插件 id，才能在派发时过滤掉插件自己引发的事件。
	 */
	const eventHandlers = new Map<PlatformEventType | "*", Set<RegisteredHandler>>();
	let subscribed = false;
	/** 总线订阅的取消函数；`releaseSubscription()` 用它断开。 */
	let busUnsubscribe: (() => void) | undefined;

	/** 把操作排入该插件的队列，保证生命周期转换不并发。 */
	function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
		const previous = operationQueues.get(id) ?? Promise.resolve();
		// 用 catch 兜住前一个操作的失败，否则一次启动失败会卡死后续排队。
		const next = previous.catch(() => undefined).then(task);
		operationQueues.set(
			id,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * 把一条平台事件扇出给各插件的订阅者。
	 *
	 * 返回 Promise 而不是 fire-and-forget：这样事件总线的超时与取消信号仍然覆盖插件处理，
	 * A0 建立的 `signal` 契约不会在宿主这一层被架空。单个插件抛错被隔离，不影响其它插件。
	 */
	async function dispatch(event: NormalizedPlatformEvent, signal: AbortSignal): Promise<void> {
		// 只有平台给出稳定标识的事件才强制去重；其余事件宁可重复进入插件。
		if (event.dedupKey && !eventDeduper.shouldProcess(`${event.botId}:${event.dedupKey}`)) return;
		const targets = [...(eventHandlers.get(event.type) ?? []), ...(eventHandlers.get("*") ?? [])];
		if (targets.length === 0) return;
		await Promise.allSettled(
			targets.map(async (target) => {
				// 默认不把插件自己引发的事件回送给它，避免「监听 message.sent 再回复」自激。
				// 统计类插件可显式选择接收自身来源。
				if (!target.includeSelfOrigin && event.origin === "plugin" && event.originPluginId === target.ownerId) {
					return;
				}
				try {
					await target.handler(event, signal);
				} catch (error) {
					deps.logger.error(
						`插件事件处理失败（${event.type} / ${event.eventId} / ${target.ownerId}）：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
	}

	/**
	 * 首个插件启用时才接入总线，避免空数组也常驻一个订阅者。
	 *
	 * 保存取消函数：`stopAll()` 后总线里不应继续留着宿主的包装订阅。
	 */
	function ensureSubscribed(): void {
		if (subscribed) return;
		busUnsubscribe = deps.eventSource.subscribe("*", (event, signal) => dispatch(event, signal));
		subscribed = true;
	}

	/** 与总线断开：所有插件都停用后调用，避免空转分发。 */
	function releaseSubscription(): void {
		if (!subscribed) return;
		busUnsubscribe?.();
		busUnsubscribe = undefined;
		subscribed = false;
	}

	function subscribePlatformEvent(
		ownerId: string,
		type: PlatformEventType | "*",
		handler: PlatformEventHandler,
		options: { includeSelfOrigin?: boolean } = {},
	): () => void {
		ensureSubscribed();
		const entry: RegisteredHandler = {
			ownerId,
			handler,
			includeSelfOrigin: options.includeSelfOrigin === true,
		};
		const set = eventHandlers.get(type) ?? new Set<RegisteredHandler>();
		set.add(entry);
		eventHandlers.set(type, set);
		return () => {
			const current = eventHandlers.get(type);
			if (!current) return;
			current.delete(entry);
			if (current.size === 0) eventHandlers.delete(type);
		};
	}

	function statusOf(entry: PluginEntry): PluginStatus {
		return {
			id: entry.manifest.id,
			name: entry.manifest.name,
			version: entry.manifest.version,
			...(entry.manifest.description ? { description: entry.manifest.description } : {}),
			state: entry.lifecycle.state,
			...(entry.error ? { error: entry.error } : {}),
			permissions: [...entry.manifest.permissions],
			disposers: entry.lifecycle.disposerCount,
			tools: tools.namesOf(entry.manifest.id),
			source: entry.source,
		};
	}

	/** 扫描插件目录，只登记 manifest 合法的插件。非法插件的错误保留在状态里而非抛出。 */
	async function discover(): Promise<PluginStatus[]> {
		const roots = Array.isArray(deps.pluginsDir) ? deps.pluginsDir : [deps.pluginsDir];
		for (const root of roots) {
			let directories: string[];
			try {
				const entriesInDir = await readdir(root, { withFileTypes: true });
				directories = entriesInDir.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			} catch {
				// 目录不存在是正常情况（例如还没放用户插件），继续扫下一个根。
				continue;
			}
			for (const name of directories.sort()) {
				await registerDirectory(join(root, name), name);
			}
		}
		return [...entries.values()].map(statusOf);
	}

	/** 登记一个插件目录；同一个 id 只认第一个，重复时保留原条目并记录冲突。 */
	async function registerDirectory(directory: string, name: string): Promise<void> {
		const result = await loadManifest(directory);
		if (!result.ok) {
			// 用目录名占位，让工作台能看到「这个目录坏了」而不是静默忽略。
			const id = `invalid:${name}`;
			const message = result.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
			const existing = entries.get(id);
			if (existing) {
				existing.error = message;
				return;
			}
			const lifecycle = createPluginLifecycle(id);
			lifecycle.fail(message);
			entries.set(id, {
				manifest: {
					schemaVersion: 0,
					id,
					name,
					version: "-",
					entry: "-",
					permissions: [],
				},
				directory,
				lifecycle,
				source: "invalid",
				error: message,
			});
			return;
		}
		if (entries.has(result.manifest.id)) {
			const winner = entries.get(result.manifest.id)!;
			// 同一个目录被再次扫描：这是重复调用 `discover()`，不是真冲突。
			// 忽略而不是登记重复项，否则「重新扫描」会把每个插件都标成重复。
			if (winner.directory === result.directory) return;
			// 同一个 id 只认先扫描到的目录；重复项单独登记为诊断条目，
			// 既不覆盖获胜者，也不静默吞掉冲突。
			const id = `duplicate:${name}`;
			if (entries.has(id)) return;
			const message = `插件 id ${result.manifest.id} 与 ${winner.directory} 重复，已忽略 ${directory}`;
			const lifecycle = createPluginLifecycle(id);
			lifecycle.fail(message);
			entries.set(id, {
				manifest: {
					schemaVersion: 0,
					id,
					name: result.manifest.name,
					version: result.manifest.version,
					entry: "-",
					permissions: [],
				},
				directory,
				lifecycle,
				source: "duplicate",
				error: message,
			});
			return;
		}
		entries.set(result.manifest.id, {
			manifest: result.manifest,
			directory: result.directory,
			source: "plugin",
			lifecycle: createPluginLifecycle(result.manifest.id, {
				onStateChange: (state, detail) => {
					if (detail?.error) deps.logger.error(`插件 ${result.manifest.id} ${state}：${detail.error}`);
				},
			}),
		});
	}

	/** 启用一个已发现的插件。重复启用是幂等的；并发调用会被队列串行化。 */
	async function start(id: string): Promise<PluginStatus | undefined> {
		return serialize(id, () => startNow(id));
	}

	async function startNow(id: string): Promise<PluginStatus | undefined> {
		const entry = entries.get(id);
		if (!entry) return undefined;
		if (entry.error) return statusOf(entry);
		if (entry.lifecycle.state === "active") return statusOf(entry);

		const { manifest, directory } = entry;
		const botIds = manifest.bots ?? deps.defaultBotIds ?? ["*"];
		const loaded = await loadPluginEntry(join(directory, manifest.entry));
		if (!loaded.ok) {
			entry.error = loaded.message;
			entry.lifecycle.fail(loaded.message);
			deps.logger.error(`插件 ${id} 加载失败：${loaded.message}`);
			return statusOf(entry);
		}
		if (loaded.definition.id !== manifest.id) {
			const message = `入口导出的 id（${loaded.definition.id}）与 manifest（${manifest.id}）不一致`;
			entry.error = message;
			entry.lifecycle.fail(message);
			deps.logger.error(`插件 ${id} 拒绝加载：${message}`);
			return statusOf(entry);
		}

		const { signal } = entry.lifecycle.begin();
		// 限流器随实例创建：插件重启后额度自动清零。
		const rateLimiter = createSendRateLimiter(manifest.id, deps.sendRateLimit);
		const context = createPluginContext({
			lifecycle: entry.lifecycle,
			manifestId: manifest.id,
			botIds,
			permissions: new Set(manifest.permissions),
			subscribePlatformEvent,
			sendMessage: async (pluginId, botId, target, text, options) => {
				// 在真正触达 OutboundChannel 之前拒绝，避免超限消息真的发到群里。
				rateLimiter.assertWithinLimit(botId, target);
				await deps.sendMessage(pluginId, botId, target, text, options);
			},
			storage: deps.storageFor(manifest.id),
			logger: deps.logger,
			registerTool: (pluginId, generation, definition: PluginToolDefinition) =>
				tools.register({ pluginId, generation, botIds, definition }),
		});
		entry.context = context;
		// 插件自定义的 dispose 登记在最前，因此清理时最后执行——此时能力已撤销，
		// 它只能释放自己持有的外部资源（定时器、连接），不能继续发消息。
		if (loaded.definition.dispose) {
			const dispose = loaded.definition.dispose;
			context.onDispose(() => dispose());
		}

		try {
			await Promise.race([
				loaded.definition.setup(context),
				new Promise<never>((_, reject) => {
					// 取消信号能打断等待，但插件若完全不理会信号，单靠它仍会永久挂起。
					signal.addEventListener("abort", () => reject(new Error("插件 setup 被中止")), { once: true });
				}),
				// 独立超时：setup 一直不返回时也要放行启动流程。
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`插件 setup 超时（${setupTimeoutMs}ms）`)),
						setupTimeoutMs,
					);
					// 超时器不阻塞进程退出。
					timer.unref?.();
				}),
			]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			entry.error = message;
			deps.logger.error(`插件 ${id} setup 失败：${message}`);
			await entry.lifecycle.stop("setup 失败");
			entry.lifecycle.fail(message);
			return statusOf(entry);
		}

		entry.lifecycle.activate();
		deps.logger.info(`插件已启用：${manifest.name}（${id} v${manifest.version}）`);
		return statusOf(entry);
	}

	/**
	 * 停用一个插件。
	 *
	 * 顺序：先撤销能力（abort + 代次递增 + 标记 inactive），再执行清理。
	 * 反过来会让插件在 `dispose()` 执行期间仍保有发送与存储能力——而 `dispose()`
	 * 可能很慢甚至卡住，停用请求就形同没有生效。
	 */
	async function stop(id: string): Promise<PluginStatus | undefined> {
		return serialize(id, () => stopNow(id));
	}

	async function stopNow(id: string): Promise<PluginStatus | undefined> {
		const entry = entries.get(id);
		if (!entry) return undefined;
		// 插件自定义的 dispose 已登记为清理函数，与订阅取消一起按后进先出执行。
		const { failures } = await entry.lifecycle.stop("请求停用");
		entry.context = undefined;
		// 清理函数已逐个撤销，这里再兜一层：插件若在 dispose 里重新注册，也不会留到停用之后。
		tools.removeOwner(id);
		for (const failure of failures) deps.logger.warn(`插件 ${id} 清理失败：${failure.error}`);
		deps.logger.info(`插件已停用：${id}`);
		// 没有剩余订阅者时断开总线，避免空转分发。
		if (eventHandlers.size === 0) releaseSubscription();
		return statusOf(entry);
	}

	/**
	 * 重新启用：先停再启。
	 *
	 * 整体排进队列，避免 `stop` 与 `start` 之间被另一个操作插入。
	 */
	async function restart(id: string): Promise<PluginStatus | undefined> {
		return serialize(id, async () => {
			await stopNow(id);
			const entry = entries.get(id);
			if (!entry) return undefined;
			entry.error = undefined;
			return startNow(id);
		});
	}

	/**
	 * 重新加载：先停，重读磁盘上的 manifest，再启。
	 *
	 * 与 `restart()` 的差别只在中间那一步——改了名称、版本、权限或入口的插件，
	 * 不重启进程也能生效。只更新已登记的条目，不新增也不搬迁：`id` 变了意味着
	 * 目录里放的是另一个插件，那是重新扫描（`discover()`）的事，不能让路由手里的
	 * id 和条目 key 悄悄失配。
	 */
	async function reload(id: string): Promise<PluginStatus | undefined> {
		return serialize(id, async () => {
			await stopNow(id);
			const entry = entries.get(id);
			if (!entry) return undefined;
			// 诊断占位条目没有可运行的实现，重读只会得到同一个错误。
			if (entry.source !== "plugin") return statusOf(entry);
			const result = await loadManifest(entry.directory);
			if (!result.ok) {
				const message = result.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
				entry.error = message;
				entry.lifecycle.fail(message);
				deps.logger.error(`插件 ${id} 重载失败：${message}`);
				return statusOf(entry);
			}
			if (result.manifest.id !== id) {
				const message = `manifest 的 id 已改为 ${result.manifest.id}，需要重启服务才能重新登记`;
				entry.error = message;
				deps.logger.error(`插件 ${id} 重载失败：${message}`);
				return statusOf(entry);
			}
			entry.manifest = result.manifest;
			entry.error = undefined;
			return startNow(id);
		});
	}

	/**
	 * 发现并启动插件。
	 *
	 * 传 `only` 时只启动这些 id（配置白名单）；不传则启动全部合法插件。
	 */
	async function startAll(only?: readonly string[]): Promise<PluginStatus[]> {
		await discover();
		const allow = only ? new Set(only) : undefined;
		for (const [id, entry] of entries) {
			if (entry.error || entry.lifecycle.state === "active") continue;
			if (allow && !allow.has(id)) continue;
			await start(id);
		}
		return [...entries.values()].map(statusOf);
	}

	async function stopAll(): Promise<void> {
		for (const id of [...entries.keys()]) await stop(id);
		// 全部停用后与总线断开，避免留着空转的包装订阅。
		releaseSubscription();
	}

	function list(): PluginStatus[] {
		return [...entries.values()].map(statusOf);
	}

	function get(id: string): PluginStatus | undefined {
		const entry = entries.get(id);
		return entry ? statusOf(entry) : undefined;
	}

	return {
		discover,
		start,
		stop,
		restart,
		reload,
		startAll,
		stopAll,
		list,
		get,
		/** 当前存活工具，按会话的 Bot 作用域过滤。 */
		tools: {
			definitionsFor: tools.definitionsFor,
			namesFor: tools.namesFor,
			list: tools.list,
		},
		/**
		 * 是否存在订阅了该事件类型的启用插件。
		 *
		 * 只回答「有没有人可能在听」，不回答「他是否真能处理这一条」——精确匹配
		 * （例如按 `buttonId` 前缀）必须由宿主在 `canHandleInteraction` 里自行实现。
		 * 插件停用后，其订阅已从 `eventHandlers` 中移除，因此这里不会虚报。
		 */
		hasActiveHandler(type: PlatformEventType): boolean {
			return (eventHandlers.get(type)?.size ?? 0) > 0 || (eventHandlers.get("*")?.size ?? 0) > 0;
		},
	};
}

export type PluginHost = ReturnType<typeof createPluginHost>;

/** 列出插件目录下的候选子目录名，供诊断使用。 */
export async function listPluginDirectories(pluginsDir: string): Promise<string[]> {
	try {
		const items = await readdir(pluginsDir, { withFileTypes: true });
		const result: string[] = [];
		for (const item of items) {
			if (!item.isDirectory()) continue;
			try {
				await stat(join(pluginsDir, item.name, MANIFEST_FILE));
				result.push(item.name);
			} catch {
				// 没有 manifest 的目录不是插件。
			}
		}
		return result.sort();
	} catch {
		return [];
	}
}
