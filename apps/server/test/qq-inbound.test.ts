import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../src/agent-host.ts";
import { createAppState } from "../src/app-state.ts";
import { createMessageDeduplicator } from "../src/platform/inbound.ts";
import { createInboundReferenceStore } from "../src/platform/plugin-bridge.ts";
import type { ProactiveRuntime } from "../src/proactive.ts";
import { createInboundHandler } from "../src/qq/inbound.ts";
import type { StickerTagging } from "../src/sticker-tagging.ts";
import { StickerStore } from "../src/stickers.ts";

const APP_ID = "102000000";
const BOT_ID = "bot-1";

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
	return {
		rawEventType: "GROUP_AT_MESSAGE_CREATE",
		kind: "group",
		senderId: "user-1",
		senderName: "小明",
		content: `<@!${APP_ID}> 你好`,
		messageId: "msg-1",
		timestamp: "2026-10-22T00:00:00Z",
		groupOpenid: "group-1",
		replyTarget: { scope: "group", targetId: "group-1", msgId: "msg-1" },
		mentions: [
			{ member_openid: "user-1", nickname: "小明", is_you: false },
			{ is_you: true, scope: "single" },
		],
		raw: {},
		...overrides,
	} as QQBotInboundMessage;
}

describe("QQ inbound pipeline", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-inbound-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function setup(overrides: { mentioned?: boolean } = {}) {
		const state = createAppState({ dataDir: dir });
		await state.load();
		const prompts: string[] = [];
		const agentSession = {
			prompt: vi.fn(async (text: string) => {
				prompts.push(text);
			}),
			subscribe: vi.fn(() => () => {}),
			getLastAssistantText: () => "收到啦",
			model: { provider: "p", id: "m" },
			compact: async () => ({ summary: "压缩结果" }),
		};
		const agentHost = {
			getAgentSession: vi.fn(async () => agentSession),
			applyPeerConfigToSession: vi.fn(),
			anyAgentLoopRunning: () => false,
		} as unknown as AgentHost;
		const sendText = vi.fn(async () => {});
		const channel = {
			sendText,
			openStream: () => ({ supported: false, update: async () => {}, complete: async () => {}, cancel: () => {} }),
		};
		const platform = {
			inboundDeduper: createMessageDeduplicator(),
			eventBus: { emit: vi.fn(async () => {}) },
			channelFor: vi.fn(() => channel),
		};
		const proactive = {
			metrics: {},
			decisions: [],
			sentToday: () => 0,
			queueGroupMessage: vi.fn(),
			cancelPendingWindow: vi.fn(),
			markGroupReplied: vi.fn(),
		} as unknown as ProactiveRuntime;
		const stickerTagging = {
			schedule: vi.fn(),
			notifyConversationActivity: vi.fn(),
			reset: vi.fn(),
		} satisfies StickerTagging;
		const log = vi.fn();

		const handler = createInboundHandler({
			state,
			agentHost,
			// 入站只需这几个成员，测试里按需最小化。
			platform: platform as unknown as Parameters<typeof createInboundHandler>[0]["platform"],
			stickerTagging,
			proactive,
			inboundReferences: createInboundReferenceStore(),
			stickerStore: new StickerStore(dir),
			log,
		});
		const bot = {} as unknown as QQBot;
		const botConfig = { id: BOT_ID, appId: APP_ID, nickname: "麦麦", avatarUrl: "", appSecret: "", mode: "qr", enabled: true };
		return { state, handler, bot, botConfig, prompts, sendText, proactive, stickerTagging, agentSession };
	}

	it("replies to a mentioned group message and persists both sides", async () => {
		const { state, handler, bot, botConfig, prompts, sendText, proactive, stickerTagging } = await setup();
		await handler(bot, botConfig as never, inbound());

		expect(prompts).toEqual(["你好"]);
		expect(sendText).toHaveBeenCalledWith(expect.anything(), "收到啦");
		expect(proactive.queueGroupMessage).not.toHaveBeenCalled();
		// 新消息要推进打标版本号（原本由 index.ts 里的两个语句完成）。
		expect(stickerTagging.notifyConversationActivity).toHaveBeenCalledOnce();

		const sessions = state.getSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(sessions[0]?.title).toBe("你好");
	});

	it("drops a duplicate delivery of the same message", async () => {
		const { handler, bot, botConfig, prompts } = await setup();
		await handler(bot, botConfig as never, inbound());
		await handler(bot, botConfig as never, inbound());
		expect(prompts).toEqual(["你好"]);
	});

	it("queues ordinary group chatter for the proactive window instead of replying", async () => {
		const { handler, bot, botConfig, prompts, sendText, proactive } = await setup();
		await handler(
			bot,
			botConfig as never,
			inbound({
				// 普通群消息：不是被 @ 的机器人消息事件。
				rawEventType: "GROUP_MESSAGE_CREATE",
				content: "今天吃什么",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
			}),
		);

		expect(prompts).toEqual([]);
		expect(sendText).not.toHaveBeenCalled();
		expect(proactive.queueGroupMessage).toHaveBeenCalledWith(
			bot,
			expect.anything(),
			"group-1",
			"小明",
			"user-1",
			"今天吃什么",
		);
	});

	it("starts a new session on /new and keeps the older one inactive", async () => {
		const { state, handler, bot, botConfig, sendText } = await setup();
		await handler(bot, botConfig as never, inbound());
		const first = state.getSessions()[0]?.id;
		await handler(bot, botConfig as never, inbound({ messageId: "msg-2", content: `<@!${APP_ID}> /new` }));

		const sessions = state.getSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.id).not.toBe(first);
		expect(sessions[1]?.active).toBe(false);
		expect(sendText).toHaveBeenLastCalledWith(expect.anything(), "已开始新会话。");
	});
});
