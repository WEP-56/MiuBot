export type ParsedCommand = { name: string; args: string };

/**
 * 解析一条斜杠命令。
 *
 * 只有「整条消息以 `/` 开头且紧跟合法命令名」才算命令：`/new` 是，`/ 你好` 不是。
 * 命令名大小写不敏感（QQ 手机端首字母容易自动大写），参数原样保留。
 *
 * 解析放在群聊闸门之前，所以群里不 @ 机器人也能用命令；但只有**已注册**的命令会被接管，
 * 其余以 `/` 开头的普通聊天仍按插话处理——否则会误吞群友的消息。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const match = /^\/([A-Za-z][A-Za-z0-9-]{0,31})(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match?.[1]) return undefined;
	return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}
