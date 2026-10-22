import type { PluginDefinition } from "@miubot/plugin/host/index";

/**
 * Bot 被拉进群聊后发送一条欢迎语。
 *
 * 注意：QQ 官方协议**没有**「新成员入群」事件，只有 `GROUP_ADD_ROBOT`（Bot 自己被拉进群）。
 * 所以这个插件在 QQ 上的语义是「Bot 入群时自我介绍」，不是「欢迎新成员」。
 *
 * 欢迎语存在插件私有存储里，改文案不需要重新加载插件；为了让它可配置而不引入
 * Config UI（阶段 C），这里在首次运行时写入默认值。
 */
const DEFAULT_WELCOME_TEXT = "大家好，我是 MiuBot。需要帮忙随时 @ 我。";
const STORAGE_KEY = "welcomeText";

export default {
	id: "miubot.welcome",
	async setup(ctx) {
		await ctx.storage.set(STORAGE_KEY, (await ctx.storage.get(STORAGE_KEY)) ?? DEFAULT_WELCOME_TEXT);

		ctx.events.subscribe("platform.group.bot_added", async (event) => {
			if (!event.peerId) return;
			// 事件本身不带回复锚点：Bot 刚入群时没有可供被动回复的消息。
			ctx.assertActive("发送欢迎语");
			const text = (await ctx.storage.get(STORAGE_KEY)) ?? DEFAULT_WELCOME_TEXT;
			try {
				await ctx.messages.sendText(event.botId, { scope: "group", targetId: event.peerId }, String(text));
				ctx.logger.info(`已在群 ${event.peerId} 发送欢迎语`);
			} catch (error) {
				// 发送失败不应影响其它插件，也不能让异常逃出事件处理。
				ctx.logger.warn(
					`欢迎语发送失败（${event.peerId}）：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	},
} satisfies PluginDefinition;
