import type { PluginCommandInvocation } from "@miubot/plugin/host/index";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AgentHost, PeerConfig, RuntimeSession } from "../agent-host.ts";
import type { AppState } from "../app-state.ts";
import type { AuditLog } from "../audit.ts";
import type { LogLevel } from "../logging.ts";
import type { OutboundChannel } from "../platform/outbound.ts";
import type { QqBotConfig } from "../runtime.ts";
import type { ParsedCommand } from "./parse.ts";
import type { ResolvedCommand } from "./registry.ts";
import type { CommandInvocation, CommandSummary } from "./types.ts";

export type CommandDispatcherDependencies = {
	state: AppState;
	agentHost: AgentHost;
	/** 插件命令执行入口（插件宿主的 `commands.run`）。 */
	pluginCommands: { run(invocation: PluginCommandInvocation): Promise<void> };
	/** 管理员命令被越权调用时要留痕。 */
	audit: Pick<AuditLog, "record">;
	log(level: LogLevel, text: string, sessionId?: string): void;
};

/** 一次已命中的命令调用；由入站流程在解析之后填好。 */
export type CommandRequest = {
	parsed: ParsedCommand;
	resolved: ResolvedCommand;
	bot: QQBot;
	botConfig: QqBotConfig;
	message: QQBotInboundMessage;
	channel: OutboundChannel;
	peer: PeerConfig;
	isGroup: boolean;
	senderId: string;
	senderName: string;
	isAdmin: boolean;
	/** 当前调用者可用的命令（已按权限过滤），`/help` 直接用它。 */
	commands: CommandSummary[];
};

/**
 * 命令分发。
 *
 * 权限判定是**唯一**的执行点：内置命令与插件命令都从这里过一遍，不因为来源不同而放宽。
 * 越权与执行失败都要留痕——命令是外部输入直接触达的动作，静默失败比报错更难查。
 */
export function createCommandDispatcher(deps: CommandDispatcherDependencies) {
	return async function runCommand(request: CommandRequest): Promise<void> {
		const { parsed, resolved, peer, botConfig } = request;
		const scope = request.isGroup ? "group" : "c2c";

		function findSession(): RuntimeSession | undefined {
			return deps.state
				.getSessions()
				.find(
					(item) =>
						item.active && item.botId === botConfig.id && item.scope === scope && item.peerId === peer.peerId,
				);
		}

		async function reply(text: string): Promise<void> {
			await request.channel.sendText(request.message.replyTarget, text);
		}

		if (resolved.permission === "admin" && !request.isAdmin) {
			// 越权尝试要单独记一条：公网部署里「谁在试管理员命令」比命令本身更值得看。
			deps.audit.record({
				action: "command.denied",
				actor: request.senderId,
				detail: `斜杠命令 /${resolved.name} 需要管理员权限（${scope}:${peer.peerId}）`,
			});
			deps.log("WARN", `拒绝非管理员执行 /${resolved.name}：${request.senderId}（${peer.peerId}）`);
			await reply("这个命令只有管理员能用。");
			return;
		}

		const invocation: CommandInvocation = {
			name: parsed.name,
			args: parsed.args,
			bot: request.bot,
			botConfig,
			message: request.message,
			channel: request.channel,
			peer,
			isGroup: request.isGroup,
			senderId: request.senderId,
			senderName: request.senderName,
			isAdmin: request.isAdmin,
			state: deps.state,
			agentHost: deps.agentHost,
			session: findSession,
			createSession: async () => {
				const session = deps.state.createSession(scope, peer.peerId, peer.name, botConfig.id);
				await deps.state.saveSessions();
				return session;
			},
			reply,
			commands: request.commands,
			log: deps.log,
		};

		try {
			if (resolved.source === "builtin") {
				await resolved.definition.run(invocation);
				return;
			}
			await deps.pluginCommands.run({
				name: resolved.name,
				botId: botConfig.id,
				scope,
				peerId: peer.peerId,
				peerName: peer.name,
				senderId: request.senderId,
				isAdmin: request.isAdmin,
				args: parsed.args,
				reply,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// 对外只回通用文案：插件或会话的报错常带路径、账号之类的内部信息。
			deps.log("ERROR", `斜杠命令 /${resolved.name} 执行失败：${detail}`, findSession()?.id);
			await reply("执行这条命令时出错了，已经记在运行日志里。").catch(() => undefined);
		}
	};
}

export type CommandDispatcher = ReturnType<typeof createCommandDispatcher>;
