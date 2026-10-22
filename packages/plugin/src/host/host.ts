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
};

type PluginEntry = {
	manifest: PluginManifest;
	directory: string;
	lifecycle: PluginLifecycle;
	context?: PluginContext;
	dispose?: () => void | Promise<void>;
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
	/**
	 * 插件对平台事件的订阅包装。宿主只注册这一个订阅者，再自行扇出。
	 *
	 * 条目带上所属插件 id，才能在派发时过滤掉插件自己引发的事件。
	 */
	const eventHandlers = new Map<PlatformEventType | "*", Set<RegisteredHandler>>();
	let subscribed = false;

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

	/** 首个插件启用时才接入总线，避免空数组也常驻一个订阅者。 */
	function ensureSubscribed(): void {
		if (subscribed) return;
		deps.eventSource.subscribe("*", (event, signal) => dispatch(event, signal));
		subscribed = true;
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
				error: message,
			});
			return;
		}
		if (entries.has(result.manifest.id)) {
			// 同一个 id 只认先扫描到的目录；重复项单独登记为诊断条目，
			// 既不覆盖获胜者，也不静默吞掉冲突。
			const winner = entries.get(result.manifest.id);
			const id = `duplicate:${name}`;
			if (entries.has(id)) return;
			const message = `插件 id ${result.manifest.id} 与 ${winner?.directory ?? "另一个目录"} 重复，已忽略 ${directory}`;
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
				error: message,
			});
			return;
		}
		entries.set(result.manifest.id, {
			manifest: result.manifest,
			directory: result.directory,
			lifecycle: createPluginLifecycle(result.manifest.id, {
				onStateChange: (state, detail) => {
					if (detail?.error) deps.logger.error(`插件 ${result.manifest.id} ${state}：${detail.error}`);
				},
			}),
		});
	}

	/** 启用一个已发现的插件。重复启用是幂等的，先停用再重建上下文。 */
	async function start(id: string): Promise<PluginStatus | undefined> {
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
		});
		entry.context = context;
		entry.dispose = loaded.definition.dispose;

		try {
			await Promise.race([
				loaded.definition.setup(context),
				new Promise<never>((_, reject) => {
					// setup 卡住时不能阻塞整个服务启动流程。
					signal.addEventListener("abort", () => reject(new Error("插件 setup 被中止")), { once: true });
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

	/** 停用一个插件：取消信号 + 递增代次 + 执行清理。 */
	async function stop(id: string): Promise<PluginStatus | undefined> {
		const entry = entries.get(id);
		if (!entry) return undefined;
		const dispose = entry.dispose;
		entry.dispose = undefined;
		if (dispose) {
			try {
				await dispose();
			} catch (error) {
				deps.logger.warn(`插件 ${id} dispose 异常：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const { failures } = await entry.lifecycle.stop("请求停用");
		entry.context = undefined;
		for (const failure of failures) deps.logger.warn(`插件 ${id} 清理失败：${failure.error}`);
		deps.logger.info(`插件已停用：${id}`);
		return statusOf(entry);
	}

	/** 重新启用：先停再启，运行代次自动递增。 */
	async function restart(id: string): Promise<PluginStatus | undefined> {
		await stop(id);
		const entry = entries.get(id);
		if (!entry) return undefined;
		entry.error = undefined;
		return start(id);
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
		startAll,
		stopAll,
		list,
		get,
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
