import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { describe, expect, it } from "vitest";
import {
	normalizeConnectionEvent,
	normalizeInteractionEvent,
	normalizeMessageEvent,
	normalizeRawEvent,
} from "../src/platform/events.ts";

describe("platform event normalization", () => {
	it("maps known lifecycle events to standard types with scope and peer", () => {
		const added = normalizeRawEvent("bot-1", "GROUP_ADD_ROBOT", {
			group_openid: "group-1",
			op_member_openid: "user-1",
			timestamp: "2026-10-21T00:00:00Z",
		});
		expect(added.type).toBe("platform.group.bot_added");
		expect(added.scope).toBe("group");
		expect(added.peerId).toBe("group-1");
		expect(added.senderId).toBe("user-1");
		expect(added.eventId).toBeTruthy();

		const friend = normalizeRawEvent("bot-1", "FRIEND_ADD", { openid: "user-2", timestamp: "2026-10-21T00:00:00Z" });
		expect(friend.type).toBe("platform.friend.added");
		expect(friend.scope).toBe("c2c");
		expect(friend.peerId).toBe("user-2");
	});

	it("keeps unknown raw events instead of dropping them", () => {
		const event = normalizeRawEvent("bot-1", "SOME_NEW_EVENT", { id: "evt-9", timestamp: "2026-10-21T00:00:00Z" });
		expect(event.type).toBe("platform.raw");
		expect(event.dedupKey).toBe("evt-9");
		expect(event.payload).toMatchObject({ rawEventType: "SOME_NEW_EVENT" });
	});

	it("normalizes button interactions", () => {
		const event = normalizeInteractionEvent("bot-1", {
			id: "interaction-1",
			type: 11,
			scene: "group",
			group_openid: "group-1",
			user_openid: "user-1",
			group_member_openid: "user-1",
			version: 1,
			timestamp: "2026-10-21T00:00:00Z",
			data: { type: 11, resolved: { button_data: "approve:42", button_id: "btn-1", message_id: "msg-1" } },
		});
		expect(event.type).toBe("platform.interaction");
		expect(event.scope).toBe("group");
		expect(event.peerId).toBe("group-1");
		expect(event.payload).toMatchObject({ buttonData: "approve:42", buttonId: "btn-1", messageId: "msg-1" });
		expect(event.dedupKey).toBe("interaction-1");
	});

	it("normalizes connection events and inbound messages", () => {
		expect(normalizeConnectionEvent("bot-1", "platform.connection.ready").type).toBe("platform.connection.ready");

		const message = normalizeMessageEvent("bot-1", {
			rawEventType: "GROUP_AT_MESSAGE_CREATE",
			kind: "group",
			senderId: "user-1",
			content: "hello",
			messageId: "msg-1",
			timestamp: "2026-10-21T00:00:00Z",
			groupOpenid: "group-1",
			mentions: [{ is_you: true }],
			raw: {},
		} as QQBotInboundMessage);
		expect(message.type).toBe("message.received");
		expect(message.peerId).toBe("group-1");
		expect(message.payload).toMatchObject({ text: "hello", mentionedBot: true });
		expect(message.dedupKey).toBe("msg-1");
	});

	it("only sets dedupKey when the platform gives a stable identifier", () => {
		// 没有 id 时不能编造幂等键：两条真实事件可能拥有完全相同的 payload。
		const anonymous = normalizeRawEvent("bot-1", "GROUP_ADD_ROBOT", { group_openid: "group-1", timestamp: "T" });
		expect(anonymous.dedupKey).toBeUndefined();
		expect(anonymous.eventId).toBeTruthy();

		// 相同输入两次归一化得到彼此独立的 eventId，但 fingerprint 一致。
		const again = normalizeRawEvent("bot-1", "GROUP_ADD_ROBOT", { group_openid: "group-1", timestamp: "T" });
		expect(again.eventId).not.toBe(anonymous.eventId);
		expect(again.fingerprint).toBe(anonymous.fingerprint);
	});

	it("never deduplicates connection state changes", () => {
		const ready = normalizeConnectionEvent("bot-1", "platform.connection.ready");
		const lost = normalizeConnectionEvent("bot-1", "platform.connection.lost", { code: 1000 });
		expect(ready.dedupKey).toBeUndefined();
		expect(lost.dedupKey).toBeUndefined();
		expect(ready.origin).toBe("platform");
	});
});
