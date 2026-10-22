import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { OutboundChannel } from "./platform/outbound.ts";

export type StickerSendContext = {
	bot: QQBot;
	target: QQBotInboundMessage["replyTarget"];
	channel: OutboundChannel;
};

/**
 * 当前正在处理的对话所属的发送上下文。
 *
 * 工具（如 `image_gen`）需要知道「图该发到哪个会话」，由入站流程在跑 Agent 期间写入、结束即清除。
 */
export const stickerSendContexts = new Map<string, StickerSendContext>();

/** 当前对话的补充提示（发言人身份等），由 `agent-host` 拼进系统上下文。 */
export const sessionPromptContexts = new Map<string, string>();
