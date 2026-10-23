import type { CommandDefinition } from "./types.ts";

/** `/admin` 展示的运行状态；由组合根提供，命令本身不碰具体子系统。 */
export type RuntimeSummary = {
	bots: { connected: number; total: number };
	plugins: { active: number; total: number };
	admins: number;
};

export type BuiltinCommandDependencies = {
	version: string;
	/** 进程启动时间（毫秒时间戳），用于算运行时长。 */
	startedAt: number;
	summary(): RuntimeSummary;
	/** 测试里替换时钟。 */
	now?: () => number;
};

/** 人类可读的运行时长。只到「天/小时/分钟」这一级，够用又不啰嗦。 */
function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return "不足 1 分钟";
	const days = Math.floor(minutes / (60 * 24));
	const hours = Math.floor((minutes % (60 * 24)) / 60);
	const rest = minutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days} 天`);
	if (days > 0 || hours > 0) parts.push(`${hours} 小时`);
	parts.push(`${rest} 分钟`);
	return parts.join(" ");
}

/**
 * 内置命令。
 *
 * 四条都只做「会话编排」与「状态汇报」：命令不是工具，不该绕过 Agent 去改业务数据。
 * 权限最小化——`/admin` 是唯一需要管理员的一条，它只读不写。
 */
export function createBuiltinCommands(deps: BuiltinCommandDependencies): CommandDefinition[] {
	const now = deps.now ?? Date.now;

	const newCommand: CommandDefinition = {
		name: "new",
		description: "结束当前会话，开始一段新的对话",
		permission: "all",
		async run(invocation) {
			const session = await invocation.createSession();
			invocation.log(
				"INFO",
				`斜杠命令 /new：创建新会话（${invocation.isGroup ? "群聊" : "私聊"} ${invocation.peer.name}）`,
				session.id,
			);
			await invocation.reply("已开始新会话。");
		},
	};

	const compactCommand: CommandDefinition = {
		name: "compact",
		description: "把当前会话压缩成摘要，释放上下文空间",
		permission: "all",
		async run(invocation) {
			const session = invocation.session();
			if (!session) {
				await invocation.reply("当前还没有可压缩的会话。");
				return;
			}
			if (session.messages.length < 2) {
				await invocation.reply("当前会话内容较少，暂时不需要压缩。");
				return;
			}
			const agentSession = await invocation.agentHost.getAgentSession(session);
			const compacted = await agentSession.compact(
				"Summarize the conversation, preserving facts, preferences, decisions, and unfinished tasks.",
			);
			session.summary = compacted.summary;
			session.compactedThrough = Math.max(0, session.messages.length - 4);
			session.updatedAt = new Date().toISOString();
			await invocation.state.saveSessions();
			invocation.log("INFO", "上下文已压缩", session.id);
			await invocation.reply("上下文压缩完成。");
		},
	};

	const helpCommand: CommandDefinition = {
		name: "help",
		description: "列出当前可用的命令",
		permission: "all",
		async run(invocation) {
			// 清单已按调用者权限过滤：普通用户看不到只对管理员开放的命令，
			// 免得照着敲一遍才发现被拒。
			const lines = invocation.commands.map((command) => `/${command.name} — ${command.description}`);
			await invocation.reply(["可用命令：", ...lines].join("\n"));
		},
	};

	const adminCommand: CommandDefinition = {
		name: "admin",
		description: "查看运行状态（仅管理员）",
		permission: "admin",
		async run(invocation) {
			const summary = deps.summary();
			await invocation.reply(
				[
					`Miubot ${deps.version} · 已运行 ${formatDuration(now() - deps.startedAt)}`,
					`在线 Bot：${summary.bots.connected}/${summary.bots.total}；已启用插件：${summary.plugins.active}/${summary.plugins.total}`,
					`管理员：${summary.admins} 人；可用命令：${invocation.commands.length} 个`,
				].join("\n"),
			);
		},
	};

	return [newCommand, compactCommand, helpCommand, adminCommand];
}
