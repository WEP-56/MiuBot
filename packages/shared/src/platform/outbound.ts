/**
 * 插件可见的出站契约（跨包稳定接口，不依赖任何平台 SDK）。
 *
 * 插件拿不到平台 SDK 客户端，也拿不到完整出站通道；宿主按插件权限包装后再注入。
 * 平台实现侧的分片、被动回复配额、媒体上传等保护由宿主桥接时统一执行。
 */

/** 发送目标。不含 `msgId`：被动/主动回复的判定由宿主桥接层负责。 */
export type MessageTarget = {
	scope: "group" | "c2c";
	targetId: string;
};

export type PluginTextOptions = {
	/** 以 Markdown 消息发送（平台支持时生效，否则由宿主回退为纯文本）。 */
	markdown?: boolean;
};

/**
 * 插件唯一允许的消息出口。
 *
 * 实现必须校验：插件当前处于启用状态、插件获得 `message:send` 权限、`botId` 在该插件的
 * 授权范围内。任何一项不满足都应抛错，而不是静默丢弃。
 */
export interface PluginMessageSender {
	sendText(botId: string, target: MessageTarget, text: string, options?: PluginTextOptions): Promise<void>;
}
