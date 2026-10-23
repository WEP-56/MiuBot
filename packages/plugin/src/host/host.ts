import { readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createDeduplicator, type Deduplicator } from "@miubot/shared/platform/dedup";
import type {
	NormalizedPlatformEvent,
	PlatformEventHandler,
	PlatformEventSubscriber,
	PlatformEventType,
} from "@miubot/shared/platform/events";
import type { MessageTarget, PluginTextOptions } from "@miubot/shared/platform/outbound";
import {
	type ConfigIssue,
	compactAgainstDefaults,
	configuredSecretKeys,
	createPluginConfigAccess,
	type PluginConfigSchema,
	type PluginConfigValues,
	resolveConfigValues,
	validateConfigValues,
} from "./config.ts";
import { createPluginContext, type PluginContext, type PluginLogger, type PluginStorage } from "./context.ts";
import {
	createPluginExtensionRegistry,
	type PluginExtensionFactory,
	type PluginExtensionRegistry,
} from "./extensions.ts";
import { copyPackage, deletePackage, extractPackage, type InstallIssue, inspectPackage } from "./install.ts";
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
	/** 该插件贡献的对话钩子名（停用后清空）。 */
	extensions: string[];
	/** manifest 是否声明了 `config`；工作台据此决定要不要显示「配置」按钮。 */
	hasConfig: boolean;
	/** 插件目录的绝对路径；内置目录与用户安装目录据此区分。 */
	directory: string;
	/** 是否可以卸载：内置插件随代码分发，只能从仓库里删。 */
	removable: boolean;
	/**
	 * 条目来源。
	 *
	 * `invalid` / `duplicate` 是诊断占位：它们代表「某个目录坏了」或「某个目录被同 id 的
	 * 插件压住了」，本身没有可运行的实现。管理界面据此禁用启停按钮，避免用户对着一个
	 * 永远失败的行反复点「启用」。
	 */
	source: "plugin" | "invalid" | "duplicate";
};

/**
 * 管理面的配置快照：schema + 可见值 + 已设置的 secret 键。
 *
 * `values` 里**不含** secret 真值；想知道某个 secret 有没有设过，看 `secretKeys`。
 */
export type PluginConfigSnapshot = {
	schema?: PluginConfigSchema;
	values: PluginConfigValues;
	secretKeys: string[];
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
	/**
	 * 按插件 id 取配置的读写入口。
	 *
	 * 与 `storageFor` 分开注入：两者的备份与卸载语义不同（删数据不等于删配置），
	 * 宿主也不该知道配置文件放在哪个目录。
	 */
	configFor: (pluginId: string) => {
		read(): Promise<Record<string, unknown>>;
		write(values: PluginConfigValues): Promise<void>;
	};
	/**
	 * 安装目标目录：本地插件包复制到这里。
	 *
	 * 单独声明而不是取 `pluginsDir` 的最后一个：内置目录在仓库里，装进去的东西会被 git
	 * 看见、升级时被覆盖。缺省时 `install()` 直接报错，而不是猜一个位置写文件。
	 */
	installDir?: string;
	/**
	 * 删除插件的持久化资源（`uninstall` 用）。
	 *
	 * 文件布局由组合根决定，宿主只传「要不要删」：这样「保留数据但清掉配置」这类组合
	 * 不需要宿主知道两个目录分别在哪。
	 */
	deleteAssets?: (pluginId: string, options: { data: boolean; config: boolean }) => Promise<void>;
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
	/** 插件贡献的对话钩子；与工具注册表同源，存活判定都绑在 `entries` 上。 */
	const extensions: PluginExtensionRegistry = createPluginExtensionRegistry({
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

	/**
	 * 插件目录是否位于可写安装目录内。
	 *
	 * 用 `relative` 判断而不是字符串前缀：`.../plugins-evil` 以 `.../plugins` 开头，
	 * 前缀比较会把它误判成子目录。
	 */
	function isInstalledDirectory(directory: string): boolean {
		if (!deps.installDir) return false;
		const relativePath = relative(resolve(deps.installDir), resolve(directory));
		return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
	}

	async function pathExists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
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
			extensions: extensions.namesOf(entry.manifest.id),
			hasConfig: entry.manifest.config !== undefined,
			directory: entry.directory,
			removable: entry.source === "plugin" && isInstalledDirectory(entry.directory),
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
				// 跳过隐藏目录：`.incoming-*` 是 ZIP 解压的临时目录，还带着 manifest，
				// 被登记进去就会出现「manifest 合法但文件没写完」的坏条目。
				directories = entriesInDir
					.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
					.map((entry) => entry.name);
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
		// 配置每次读盘而不是缓存：保存配置后宿主会重启插件，`setup()` 里拿到的必然是新值；
		// 缓存反而会让「重启了但还是旧配置」这种问题看起来像插件写错了。
		const configStore = deps.configFor(manifest.id);
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
			config: createPluginConfigAccess({ schema: manifest.config, read: () => configStore.read() }),
			logger: deps.logger,
			registerTool: (pluginId, generation, definition: PluginToolDefinition) =>
				tools.register({ pluginId, generation, botIds, definition }),
			registerExtension: (pluginId, generation, name, factory: PluginExtensionFactory) =>
				extensions.register({ pluginId, generation, botIds, name, factory }),
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
		extensions.removeOwner(id);
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

	/**
	 * 管理面读配置：补齐默认值、剔除 secret 真值，只回报「哪些 secret 已设置」。
	 *
	 * 剔除放在宿主而不是路由：将来多一个入口（CLI、另一个前端）时，遮蔽语义不该靠
	 * 每个调用方各自记得处理。插件自己走 `ctx.config`，那条路径拿的是明文。
	 */
	async function inspectConfig(id: string): Promise<PluginConfigSnapshot | undefined> {
		const entry = entries.get(id);
		if (!entry) return undefined;
		const schema = entry.manifest.config;
		const { values } = resolveConfigValues(schema, await deps.configFor(id).read());
		const visible: PluginConfigValues = {};
		for (const [key, value] of Object.entries(values)) {
			if (schema?.properties[key]?.secret === true) continue;
			visible[key] = value;
		}
		return {
			...(schema ? { schema } : {}),
			values: visible,
			secretKeys: configuredSecretKeys(schema, values),
		};
	}

	/**
	 * 校验并落盘配置。**不负责重启插件**——那是管理面的编排动作（`reload`），
	 * 宿主只保证「写进去的值是合法的」。
	 *
	 * secret 的三态语义（避开「留空就把密钥清掉了」这类误操作）：
	 * - 缺省 / 空字符串：保持原值
	 * - `null`：清除
	 * - 有值：覆盖
	 */
	async function saveConfig(
		id: string,
		input: Record<string, unknown>,
	): Promise<{ ok: true; values: PluginConfigValues } | { ok: false; issues: ConfigIssue[] }> {
		const entry = entries.get(id);
		if (!entry) return { ok: false, issues: [{ field: "$", message: "插件不存在" }] };
		if (entry.source !== "plugin") return { ok: false, issues: [{ field: "$", message: "该条目不可配置" }] };
		// `reload()` 会替换 manifest，这里每次取当前值而不是缓存的 schema。
		const schema = entry.manifest.config;
		if (!schema) return { ok: false, issues: [{ field: "config", message: "插件未在 manifest 中声明 config" }] };

		const store = deps.configFor(id);
		const current = resolveConfigValues(schema, await store.read()).values;
		/**
		 * 只合并 schema 声明过的键。
		 *
		 * 提交里出现未知键时**静默丢弃**而不是报错：schema 删掉一个字段后，旧前端缓存或
		 * 手工 curl 仍可能带着它，为此让保存失败只会挡住与它无关的修改。
		 */
		const merged: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(schema.properties)) {
			const submitted = input[key];
			if (field.secret === true) {
				if (submitted === null) continue;
				if (submitted === undefined || submitted === "") {
					if (current[key] !== undefined) merged[key] = current[key];
					continue;
				}
			}
			if (submitted !== undefined) merged[key] = submitted;
		}

		const validated = validateConfigValues(schema, merged);
		if (!validated.ok) return validated;
		await store.write(compactAgainstDefaults(schema, validated.values));
		// 只报事件不报内容：配置里可能有密钥。
		deps.logger.info(`插件 ${id} 配置已更新`);
		return validated;
	}

	/**
	 * 目标 id 与目标路径是否可用。
	 *
	 * 目录安装与 ZIP 导入必须用同一套判断：两边各写一次，迟早出现「目录装得上、上传装不上」。
	 */
	async function reserveTarget(
		id: string,
	): Promise<{ ok: true; target: string } | { ok: false; issues: InstallIssue[] }> {
		if (!deps.installDir) {
			return { ok: false, issues: [{ field: "installDir", message: "宿主未配置可写插件目录，无法安装" }] };
		}
		const existing = entries.get(id);
		if (existing) {
			// 内置同名插件也走这里：装上去了也会被 discover 的「首个目录优先」压住，
			// 表现为「装成功了却看不到」，不如直接说明冲突。
			return { ok: false, issues: [{ field: "id", message: `插件 ${id} 已存在：${existing.directory}` }] };
		}
		const target = join(resolve(deps.installDir), id);
		// 目录可能已存在但 manifest 是坏的（因此没被登记成合法插件），此时同样不能覆盖。
		if (await pathExists(target)) {
			return { ok: false, issues: [{ field: "id", message: `目标目录已存在：${target}` }] };
		}
		return { ok: true, target };
	}

	/** 装完登记并回读状态；两条安装入口共用。 */
	async function finishInstall(
		id: string,
		origin: string,
	): Promise<{ ok: true; status: PluginStatus } | { ok: false; issues: InstallIssue[] }> {
		await discover();
		const status = get(id);
		if (!status) {
			return { ok: false, issues: [{ field: "$", message: "已写入但未能登记，请重新扫描" }] };
		}
		deps.logger.info(`插件已安装：${id}（${origin}）`);
		return { ok: true, status };
	}

	/**
	 * 安装一个本地目录插件包。
	 *
	 * 校验（manifest、入口存在、无符号链接、体积上限）在 `inspectPackage` 里做，这里只负责
	 * 「装到哪、会不会撞车」。**装完不启动**：起不起来取决于配置里的白名单与 `disabled`，
	 * 那是管理面的策略，由调用方在同一次请求里决定——宿主自己启动会造出「配置里禁用、
	 * 却跑着的实例」，下次重启就消失。
	 *
	 * 同样**不覆盖已存在的插件**：升级要先卸载，否则一次手滑就把在用的插件换成半成品。
	 */
	async function install(
		sourceDir: string,
	): Promise<{ ok: true; status: PluginStatus } | { ok: false; issues: InstallIssue[] }> {
		const inspected = await inspectPackage(sourceDir);
		if (!inspected.ok) return inspected;

		const reserved = await reserveTarget(inspected.manifest.id);
		if (!reserved.ok) return reserved;

		try {
			await copyPackage(sourceDir, reserved.target);
		} catch (error) {
			return {
				ok: false,
				issues: [{ field: "$", message: `复制失败：${error instanceof Error ? error.message : String(error)}` }],
			};
		}

		return finishInstall(inspected.manifest.id, `目录 ${sourceDir}`);
	}

	/**
	 * 从 ZIP 归档导入插件包。
	 *
	 * 解压到安装目录下的隐藏临时目录 → 过与目录安装**完全相同的** `inspectPackage` 校验 →
	 * 原子 `rename` 到目标位置。上传不等于可信：工作台能上传，攻击面就只在「谁能调管理 API」，
	 * 所以校验强度必须和手工放目录一样，不能因为是「我们自己解压的」就放松。
	 */
	async function importArchive(
		archive: Uint8Array,
	): Promise<{ ok: true; status: PluginStatus } | { ok: false; issues: InstallIssue[] }> {
		if (!deps.installDir) {
			return { ok: false, issues: [{ field: "installDir", message: "宿主未配置可写插件目录，无法安装" }] };
		}
		const extracted = await extractPackage(archive, resolve(deps.installDir));
		if (!extracted.ok) return extracted;

		try {
			const inspected = await inspectPackage(extracted.directory);
			if (!inspected.ok) return inspected;
			const reserved = await reserveTarget(inspected.manifest.id);
			if (!reserved.ok) return reserved;
			try {
				// 同分区 rename 是原子的，不会留下「复制了一半」的插件目录。
				await rename(extracted.directory, reserved.target);
			} catch (error) {
				return {
					ok: false,
					issues: [{ field: "$", message: `写入失败：${error instanceof Error ? error.message : String(error)}` }],
				};
			}
			return await finishInstall(inspected.manifest.id, `ZIP ${archive.byteLength} 字节`);
		} finally {
			// 已经 rename 走的话这里是空操作；校验失败时负责清掉临时目录。
			await rm(extracted.directory, { recursive: true, force: true });
		}
	}

	/**
	 * 卸载一个已安装的插件。
	 *
	 * 顺序：先停（撤销能力），再删目录，最后删资源。反过来会留下一个「目录没了但条目还在」
	 * 的僵尸状态，用户得重启服务才能清掉。
	 *
	 * 数据与配置**默认都保留**：删代码是明确的，删用户数据不是。两者要分别显式要求。
	 */
	async function uninstall(
		id: string,
		options: { deleteData?: boolean; deleteConfig?: boolean } = {},
	): Promise<
		{ ok: true; directory: string; dataDeleted: boolean; configDeleted: boolean } | { ok: false; message: string }
	> {
		const entry = entries.get(id);
		if (!entry) return { ok: false, message: "插件不存在" };
		if (entry.source !== "plugin") return { ok: false, message: "该条目不是可安装的插件" };
		if (!isInstalledDirectory(entry.directory)) {
			return { ok: false, message: "内置插件随代码分发，只能在仓库中删除" };
		}

		await stop(id);
		try {
			await deletePackage(entry.directory);
		} catch (error) {
			// 删不掉就把条目留着，用户还能重试；删了一半的状态比「什么都没删」更难收拾。
			return {
				ok: false,
				message: `删除插件目录失败：${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const dataDeleted = options.deleteData === true;
		const configDeleted = options.deleteConfig === true;
		if (deps.deleteAssets && (dataDeleted || configDeleted)) {
			await deps.deleteAssets(id, { data: dataDeleted, config: configDeleted });
		}

		entries.delete(id);
		if (eventHandlers.size === 0) releaseSubscription();
		deps.logger.info(`插件已卸载：${id}`);
		return { ok: true, directory: entry.directory, dataDeleted, configDeleted };
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
		/** 当前存活扩展工厂，形状与 `DefaultResourceLoader.extensionFactories` 一致。 */
		extensions: {
			factoriesFor: extensions.factoriesFor,
			list: extensions.list,
		},
		/** manifest 声明的配置 schema；未声明时为 `undefined`。 */
		config: {
			schemaOf: (id: string): PluginConfigSchema | undefined => entries.get(id)?.manifest.config,
			inspect: inspectConfig,
			save: saveConfig,
		},
		install,
		importArchive,
		uninstall,
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
