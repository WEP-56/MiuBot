import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AgentHost, PeerConfig, RuntimeSession } from "../agent-host.ts";
import type { AppState } from "../app-state.ts";
import type { LogLevel } from "../logging.ts";
import type { OutboundChannel } from "../platform/outbound.ts";
import type { QqBotConfig } from "../runtime.ts";

/**
 * 斜杠命令契约。
 *
 * 命令是**入站消息的一类**，不是工具也不是插件能力：解析发生在去重与白名单之后、
 * 群聊插话闸门之前，命中即接管这条消息——不进插话窗口、不进 Agent、不计入上下文。
 */

/** 谁能触发这条命令。`admin` 只对 `config.admins` 里的 QQ 用户生效。 */
export type CommandPermission = "admin" | "all";

/** 命令来自哪里。工作台据此区分「内置」与「某个插件注册的」。 */
export type CommandSource = "builtin" | "plugin";

/** 一条命令的公开信息（`/help` 与工作台共用）。 */
export type CommandSummary = {
	name: string;
	description: string;
	permission: CommandPermission;
	source: CommandSource;
	/** 插件命令的来源插件 id；内置命令没有。 */
	pluginId?: string;
};

/** 工作台清单项：在 `CommandSummary` 之上多一个「是否被配置禁用」。 */
export type CommandCatalogEntry = CommandSummary & { enabled: boolean };

/** 命令执行时能拿到的运行时上下文。 */
export type CommandInvocation = {
	/** 命令名，不含前导斜杠。 */
	name: string;
	/** 命令名之后的原始参数文本（已 trim）。 */
	args: string;
	bot: QQBot;
	botConfig: QqBotConfig;
	message: QQBotInboundMessage;
	channel: OutboundChannel;
	/** 触发命令的对象配置（群或私聊）。 */
	peer: PeerConfig;
	isGroup: boolean;
	senderId: string;
	senderName: string;
	/** 发送者是否在管理员名单里。命令被真正执行时这个值一定是「够格」的。 */
	isAdmin: boolean;
	state: AppState;
	agentHost: AgentHost;
	/** 当前活跃会话；没有时返回 `undefined`（命令自己决定要不要新建）。 */
	session(): RuntimeSession | undefined;
	/** 新建会话并落盘，旧会话被置为非活跃。 */
	createSession(): Promise<RuntimeSession>;
	/** 回复到触发这条命令的会话（走被动回复锚点）。 */
	reply(text: string): Promise<void>;
	/** 当前调用者可用的命令（管理员能看到管理员命令，普通用户看不到）。 */
	commands: CommandSummary[];
	log(level: LogLevel, text: string, sessionId?: string): void;
};

/** 内置命令定义。 */
export type CommandDefinition = {
	/** 命令名，不含前导斜杠。 */
	name: string;
	/** `/help` 与工作台里的一行说明。 */
	description: string;
	permission: CommandPermission;
	run(invocation: CommandInvocation): Promise<void>;
};
