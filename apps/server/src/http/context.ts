import type { McpRuntime } from "@miubot/plugin/tools/index";
import type { createAgentHost, PeerConfig, RuntimeSession } from "../agent-host.ts";
import type { RuntimeLog } from "../logging.ts";
import type { AppConfig, QqBotConfig } from "../runtime.ts";
import type { StickerStore } from "../stickers.ts";

export type AgentHost = ReturnType<typeof createAgentHost>;

export type QqConnectionState = {
	phase: "disconnected" | "connecting" | "connected" | "error";
	appId?: string;
	error?: string;
	nickname?: string;
	avatarUrl?: string;
};

export type QrState = {
	phase: "idle" | "waiting" | "connected" | "failed";
	url?: string;
	qrSvg?: string;
	error?: string;
};

export type ProactiveMetrics = {
	groupMessagesReceived: number;
	candidates: number;
	judgments: number;
	planned: number;
	sent: number;
	blocked: number;
};

export type ProactiveDecision = {
	time: string;
	groupId: string;
	sessionId?: string;
	result: string;
	reason: string;
};

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
