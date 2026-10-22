import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { describe, expect, it, vi } from "vitest";
import type { PlatformEventBus } from "../src/platform/events.ts";
import { acceptInboundMessage, createMessageDeduplicator, describeQuoteContext } from "../src/platform/inbound.ts";
import { attachQqBotEvents } from "../src/platform/qq-adapter.ts";
import { createQqPlatform } from "../src/platform/runtime.ts";

const APP_ID = "102000000";

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
	return {
		rawEventType: "GROUP_AT_MESSAGE_CREATE",
		kind: "group",
		senderId: "user-1",
		senderName: "小明",
		content: `<@!${APP_ID}> 你好`,
		messageId: "msg-1",
		timestamp: "2026-10-21T00:00:00Z",
		groupOpenid: "group-1",
		mentions: [{ is_you: true }],
		raw: {},
		...overrides,
	} as QQBotInboundMessage;
}

function fakeQqBot() {
	const handlers = new Map<string, (ctx: never, event: never) => unknown>();
	const bot = {
		on: vi.fn((event: string, handler: (ctx: never, payload: never) => unknown) => {
			handlers.set(event, handler);
			return bot;
		}),
		acknowledgeInteraction: vi.fn().mockResolvedValue(undefined),
		sendText: vi.fn().mockResolvedValue({ id: "sent-1" }),
		sendMarkdown: vi.fn().mockResolvedValue({ id: "sent-2" }),
		sendMedia: vi.fn().mockResolvedValue({ id: "sent-3" }),
	};
	return { bot: bot as unknown as QQBot & typeof bot, handlers };
}

describe("inbound acceptance", () => {
	it("rejects unsupported scopes and bot senders", () => {
		const deduper = createMessageDeduplicator();
		expect(
			acceptInboundMessage({ botId: "bot-1", appId: APP_ID, message: inbound({ kind: "guild" }), deduper }),
		).toMatchObject({ status: "ignored", reason: "unsupported-scope" });
		expect(
			acceptInboundMessage({ botId: "bot-1", appId: APP_ID, message: inbound({ senderIsBot: true }), deduper }),
		).toMatchObject({ status: "ignored", reason: "sender-is-bot" });
	});

	it("deduplicates per bot and allows retry after failure", () => {
		const deduper = createMessageDeduplicator();
		const first = acceptInboundMessage({ botId: "bot-1", appId: APP_ID, message: inbound(), deduper });
		expect(first.status).toBe("accepted");
		if (first.status !== "accepted") throw new Error("unreachable");
		expect(first.dedupKey).toBe("bot-1:msg-1");

		expect(acceptInboundMessage({ botId: "bot-1", appId: APP_ID, message: inbound(), deduper })).toMatchObject({
			status: "duplicate",
			messageId: "msg-1",
			peerId: "group-1",
		});
		// 另一个 Bot 收到同一个 messageId 不属于重复投递。
		expect(acceptInboundMessage({ botId: "bot-2", appId: APP_ID, message: inbound(), deduper }).status).toBe(
			"accepted",
		);

		deduper.forget(first.dedupKey);
		expect(acceptInboundMessage({ botId: "bot-1", appId: APP_ID, message: inbound(), deduper }).status).toBe(
			"accepted",
		);
	});
});

describe("quote context", () => {
	it("renders nothing without a quote and describes attachment counts", () => {
		expect(describeQuoteContext(undefined)).toBe("");
		expect(
			describeQuoteContext({
				source: "msg_elements",
				refMsgIdx: "ref-1",
				text: "帮我画一只猫",
				attachments: [{ contentType: "audio/silk", url: "https://cdn.example/v.silk" }],
			}),
		).toContain("帮我画一只猫");
		expect(
			describeQuoteContext({ source: "msg_elements", refMsgIdx: "ref-1", text: "", attachments: [] }),
		).toContain("(被引用消息没有文本)");
	});
});

describe("qq platform assembly", () => {
	it("reuses one outbound channel per bot and emits message.sent", async () => {
		const { bot } = fakeQqBot();
		const platform = createQqPlatform({
			onEventError: vi.fn(),
			onSendError: vi.fn(),
			resolveBotId: () => "bot-1",
		});
		const events: string[] = [];
		platform.eventBus.subscribe("message.sent", (event) => {
			events.push(`${event.botId}:${event.payload.kind as string}`);
		});

		const channel = platform.channelFor(bot);
		expect(platform.channelFor(bot)).toBe(channel);
		await channel.sendText({ scope: "group", targetId: "group-1", msgId: "msg-1" }, "hi");
		expect(events).toEqual(["bot-1:text"]);
	});

	it("falls back to the default bot key and reports subscriber errors", async () => {
		const { bot } = fakeQqBot();
		const onEventError = vi.fn();
		const platform = createQqPlatform({ onEventError, onSendError: vi.fn(), resolveBotId: () => undefined });
		const sent: string[] = [];
		platform.eventBus.subscribe("message.sent", (event) => {
			sent.push(event.botId);
		});
		platform.eventBus.subscribe("message.sent", () => {
			throw new Error("boom");
		});
		await platform.channelFor(bot).sendText({ scope: "c2c", targetId: "user-1" }, "hi");
		expect(sent).toEqual(["default"]);
		expect(onEventError).toHaveBeenCalledOnce();
	});
});

describe("qq bot event attachment", () => {
	function setup(platform: { eventBus: PlatformEventBus }) {
		const { bot, handlers } = fakeQqBot();
		const onReady = vi.fn();
		const onError = vi.fn();
		attachQqBotEvents({
			bot,
			botId: "bot-1",
			eventBus: platform.eventBus,
			onMessage: vi.fn(),
			onReady,
			onError,
		});
		return { bot, handlers, onReady, onError };
	}

	it("normalizes lifecycle, interaction and raw events onto the bus", async () => {
		const platform = createQqPlatform({ onEventError: vi.fn(), onSendError: vi.fn(), resolveBotId: () => "bot-1" });
		const { bot, handlers, onReady } = setup(platform);
		const types: string[] = [];
		platform.eventBus.subscribe("*", (event) => {
			types.push(event.type);
		});

		handlers.get("ready")?.(undefined as never, undefined as never);
		expect(onReady).toHaveBeenCalledWith(bot);
		handlers.get("rawEvent")?.({ eventType: "FRIEND_ADD", data: { openid: "u-1" } } as never, undefined as never);
		handlers.get("resumed")?.({}, undefined as never);
		handlers.get("disconnected")?.({ code: 1000 } as never, undefined as never);
		await vi.waitFor(() => expect(types).toContain("platform.connection.lost"));

		expect(types).toContain("platform.connection.ready");
		expect(types).toContain("platform.friend.added");
		expect(types).toContain("platform.connection.resumed");
	});

	it("acknowledges interactions with 3 when nobody listens", async () => {
		const platform = createQqPlatform({ onEventError: vi.fn(), onSendError: vi.fn(), resolveBotId: () => "bot-1" });
		const { bot, handlers } = setup(platform);
		const event = { id: "interaction-1", scene: "c2c", user_openid: "u-1", data: { type: 11 } };

		await handlers.get("interaction")?.(undefined as never, event as never);
		expect(bot.acknowledgeInteraction).toHaveBeenLastCalledWith("interaction-1", 3);

		platform.eventBus.subscribe("platform.interaction", () => {});
		await handlers.get("interaction")?.(undefined as never, event as never);
		expect(bot.acknowledgeInteraction).toHaveBeenLastCalledWith("interaction-1", 0);
	});

	it("prefers the host decision over subscriber counts", async () => {
		const platform = createQqPlatform({ onEventError: vi.fn(), onSendError: vi.fn(), resolveBotId: () => "bot-1" });
		// 宿主永久注册分发包装：订阅者数量恒 ≥ 1，只有在没有任何插件能处理时才拒绝。
		platform.eventBus.subscribe("platform.interaction", () => {});
		const canHandleInteraction = vi.fn().mockReturnValue(false);
		const { bot, handlers } = fakeQqBot();
		attachQqBotEvents({
			bot,
			botId: "bot-1",
			eventBus: platform.eventBus,
			onMessage: vi.fn(),
			canHandleInteraction,
		});

		const event = { id: "interaction-2", scene: "group", group_openid: "g-1", data: { type: 11 } };
		await handlers.get("interaction")?.(undefined as never, event as never);

		expect(canHandleInteraction).toHaveBeenCalledWith({ id: "interaction-2", scope: "group" });
		expect(bot.acknowledgeInteraction).toHaveBeenLastCalledWith("interaction-2", 3);

		canHandleInteraction.mockReturnValue(true);
		await handlers.get("interaction")?.(undefined as never, event as never);
		expect(bot.acknowledgeInteraction).toHaveBeenLastCalledWith("interaction-2", 0);
	});

	it("forwards inbound messages and errors to the host", async () => {
		const platform = createQqPlatform({ onEventError: vi.fn(), onSendError: vi.fn(), resolveBotId: () => "bot-1" });
		const messages: QQBotInboundMessage[] = [];
		const onError = vi.fn();
		const { bot, handlers } = fakeQqBot();
		attachQqBotEvents({
			bot,
			botId: "bot-1",
			eventBus: platform.eventBus,
			onMessage: (message) => {
				messages.push(message);
			},
			onError,
		});

		await handlers.get("message")?.(undefined as never, inbound() as never);
		expect(messages.map((message) => message.messageId)).toEqual(["msg-1"]);

		const failure = new Error("gateway down");
		handlers.get("error")?.(failure as never, undefined as never);
		expect(onError).toHaveBeenCalledWith(failure);
	});
});
