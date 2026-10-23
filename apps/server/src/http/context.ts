import type {
	ConfigIssue,
	InstallIssue,
	PluginConfigSnapshot,
	PluginConfigValues,
	PluginStatus,
} from "@miubot/plugin/host/index";
import type { McpRuntime } from "@miubot/plugin/tools/index";
import type { AgentHost, PeerConfig, RuntimeSession } from "../agent-host.ts";
import type { RuntimeLog } from "../logging.ts";
import type { ProactiveDecision, ProactiveMetrics } from "../proactive.ts";
import type { QqConnectionState, QrState } from "../qq/connection.ts";
import type { AppConfig, QqBotConfig } from "../runtime.ts";
import type { StickerStore } from "../stickers.ts";

/**
 * 管理 API 的依赖上下文。
 *
 * 路由模块只通过这些访问器读写运行时状态：`config` / `sessions` 会被整体替换
 * （例如 PUT /api/config、删除会话），因此必须走 get/replace，不能各自持有一份引用。
 */
export type HttpContext = {
	config: {
		get(): AppConfig;
		replace(next: AppConfig): void;
		save(): Promise<void>;
	};
	sessions: {
		get(): RuntimeSession[];
		replace(next: RuntimeSession[]): void;
		save(): Promise<void>;
		/** 为该对象新建会话，并把同对象旧会话置为非活跃。 */
		create(scope: RuntimeSession["scope"], peerId: string, peerName: string, botId: string): RuntimeSession;
	};
	peers: {
		get(): PeerConfig[];
		find(scope: PeerConfig["scope"], peerId: string, botId: string): PeerConfig | undefined;
		/** 取现有对象配置，没有则按默认值新建（不落盘）。 */
		ensure(scope: PeerConfig["scope"], peerId: string, botId: string, name: string): PeerConfig;
		save(): Promise<void>;
	};
	agentHost: AgentHost;
	mcpRuntime: McpRuntime;
	/**
	 * 插件宿主。启停由宿主负责，是否允许启停由配置里的 `plugins.enabled/disabled` 决定，
	 * 两者都要写——只改运行时状态的话，下次启动又会被配置翻回去。
	 */
	plugins: {
		list(): PluginStatus[];
		get(id: string): PluginStatus | undefined;
		discover(): Promise<PluginStatus[]>;
		start(id: string): Promise<PluginStatus | undefined>;
		stop(id: string): Promise<PluginStatus | undefined>;
		reload(id: string): Promise<PluginStatus | undefined>;
		/**
		 * Schema Config 读写。
		 *
		 * `inspect()` 已经剔除 secret 真值，路由直接返回即可——遮蔽是宿主的责任，
		 * 不该由每个入口各自记得处理。
		 */
		config: {
			inspect(id: string): Promise<PluginConfigSnapshot | undefined>;
			save(
				id: string,
				values: Record<string, unknown>,
			): Promise<{ ok: true; values: PluginConfigValues } | { ok: false; issues: ConfigIssue[] }>;
		};
		/** 插件根目录，按扫描优先级排列；工作台用它提示「插件该放哪里」。 */
		directories: string[];
		/** 从本地目录安装插件包。校验与复制都在宿主侧完成。 */
		install(sourceDir: string): Promise<{ ok: true; status: PluginStatus } | { ok: false; issues: InstallIssue[] }>;
		/** 卸载插件目录；数据与配置默认保留，要显式要求才删。 */
		uninstall(
			id: string,
			options: { deleteData?: boolean; deleteConfig?: boolean },
		): Promise<
			{ ok: true; directory: string; dataDeleted: boolean; configDeleted: boolean } | { ok: false; message: string }
		>;
	};
	stickers: {
		store: StickerStore;
		scheduleTagging(delayMs?: number): void;
		/** 打标模型变化后丢弃当前任务与重试计数，重新排期。 */
		resetTagging(): void;
	};
	proactive: {
		metrics: ProactiveMetrics;
		decisions: ProactiveDecision[];
		sentToday(): number;
	};
	qq: {
		states: Map<string, QqConnectionState>;
		qr(): QrState;
		test(appId: string, appSecret: string): Promise<{ ok: boolean; message: string }>;
		/** 启用该 Bot 并连接；同时停用其他 Bot。 */
		activate(bot: QqBotConfig): Promise<void>;
		stop(id: string): void;
		startQr(nickname: string): void;
	};
	logs: {
		list(): RuntimeLog[];
	};
	/** 技能安装目录（`admin/agent`），技能路由用它读写磁盘。 */
	agentDir: string;
	log(level: RuntimeLog["level"], text: string, sessionId?: string): void;
};
