/**
 * 内置工具名的唯一来源。
 *
 * 这几组名字会被三处消费：`/api/tools` 的目录与开关校验、Agent 会话的激活集合、
 * 插件工具的重名保留集。分散成三份的话，新增一个内置工具只改一处就会出现
 * 「UI 能开、会话不认」或「插件悄悄覆盖了内置工具」。
 */

/** 文件与命令类工具；`config.tools.enabled` 只接受这些名字加上可配置的两项。 */
export const nativeToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

export type NativeToolName = (typeof nativeToolNames)[number];

/**
 * 是否属于「文件与命令类」工具。
 *
 * 这一组全部能读写服务器文件或执行命令，入口却是「任何能给 Bot 发消息的人」——
 * 一条精心构造的消息就是一次提示注入，注入成功即 RCE。公网部署下默认不该开，
 * 开了要在启动日志与工作台里明示；`MIUBOT_DISABLE_NATIVE_TOOLS=1` 可整体禁用。
 */
export function isNativeTool(name: string): boolean {
	return (nativeToolNames as readonly string[]).includes(name);
}

/** 有独立开关、但也在 `config.tools.enabled` 列表里的工具。 */
export const configurableToolNames = ["web_search", "image_gen", "schedule_task", "time"] as const;

/** 工作台「Tools」页可勾选的全部工具名（`PUT /api/tools` 的白名单）。 */
export const toolNames: string[] = [...nativeToolNames, ...configurableToolNames];

/**
 * 由独立开关控制、不出现在 `toolNames` 里的内置工具。
 *
 * 它们不会进 `config.tools.enabled`，但会话里可能出现，因此插件工具必须避让。
 */
export const auxiliaryToolNames = ["load_skill", "search_stickers", "send_sticker"] as const;
