import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { describe, expect, it } from "vitest";
import { createMessageDeduplicator, normalizeInboundMessage, stripBotMention } from "../src/platform/inbound.ts";

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
		mentions: [
			{ member_openid: "user-1", nickname: "小明", is_you: false },
			{ is_you: true, scope: "single" },
		],
		raw: {},
		...overrides,
	} as QQBotInboundMessage;
}

describe("inbound normalization", () => {
	it("strips the bot mention and keeps all mention participants", () => {
		const normalized = normalizeInboundMessage("bot-1", APP_ID, inbound());
		expect(normalized?.text).toBe("你好");
		expect(normalized?.rawText).toContain("102000000");
		expect(normalized?.mentionedBot).toBe(true);
		expect(normalized?.mentions).toHaveLength(2);
		expect(normalized?.mentions[0]).toMatchObject({ openId: "user-1", name: "小明", isBot: false });
		expect(normalized?.mentions[1]).toMatchObject({ isBot: true, isAll: false });
	});

	it("resolves quoted message content from msg_elements", () => {
		const normalized = normalizeInboundMessage(
			"bot-1",
			APP_ID,
			inbound({
				content: "继续刚才那个",
				msgType: 103,
				refMsgIdx: "ref-1",
				msgElements: [
					{
						msg_idx: "ref-1",
						content: "帮我画一只猫",
						attachments: [
							{ content_type: "audio/silk", url: "https://cdn.example/v.silk", asr_refer_text: "帮我画一只猫" },
						],
					},
					{ msg_idx: "cur-1", content: "继续刚才那个" },
				],
			}),
		);
		expect(normalized?.quote).toMatchObject({ source: "msg_elements", refMsgIdx: "ref-1", text: "帮我画一只猫" });
		expect(normalized?.quote?.attachments[0]).toMatchObject({
			contentType: "audio/silk",
			transcript: "帮我画一只猫",
		});
	});

	it("exposes attachments with voice wav fallback and segments", () => {
		const normalized = normalizeInboundMessage(
			"bot-1",
			APP_ID,
			inbound({
				content: "",
				rawEventType: "GROUP_MESSAGE_CREATE",
				mentions: [],
				attachments: [
					{ content_type: "image/png", url: "https://cdn.example/a.png", filename: "a.png" },
					{
						content_type: "audio/silk",
						url: "https://cdn.example/v.silk",
						voice_wav_url: "https://cdn.example/v.wav",
					},
					{ content_type: "application/pdf", url: "https://cdn.example/a.pdf", filename: "a.pdf" },
				],
			}),
		);
		expect(normalized?.mentionedBot).toBe(false);
		expect(normalized?.attachments.map((attachment) => attachment.kind)).toEqual(["image", "audio", "file"]);
		expect(normalized?.attachments[1]?.wavUrl).toBe("https://cdn.example/v.wav");
		expect(normalized?.segments.map((segment) => segment.type)).toEqual(["image", "audio", "file"]);
	});

	it("drops messages without a peer and keeps c2c scope", () => {
		expect(
			normalizeInboundMessage("bot-1", APP_ID, inbound({ groupOpenid: undefined, senderId: "" })),
		).toBeUndefined();
		const c2c = normalizeInboundMessage(
			"bot-1",
			APP_ID,
			inbound({
				kind: "c2c",
				rawEventType: "C2C_MESSAGE_CREATE",
				content: "hi",
				mentions: [],
				groupOpenid: undefined,
			}),
		);
		expect(c2c?.scope).toBe("c2c");
		expect(c2c?.peerId).toBe("user-1");
	});

	it("strips both mention forms", () => {
		expect(stripBotMention(`<@${APP_ID}> hi <@!${APP_ID}>`, APP_ID)).toBe("hi");
	});
});

describe("message deduplicator", () => {
	it("rejects duplicates and allows retry after forget", () => {
		const dedupe = createMessageDeduplicator();
		expect(dedupe.shouldProcess("msg-1")).toBe(true);
		expect(dedupe.shouldProcess("msg-1")).toBe(false);
		dedupe.forget("msg-1");
		expect(dedupe.shouldProcess("msg-1")).toBe(true);
	});

	it("expires entries by ttl and bounds memory", () => {
		let now = 0;
		const dedupe = createMessageDeduplicator({ ttlMs: 1_000, maxEntries: 2, now: () => now });
		expect(dedupe.shouldProcess("a")).toBe(true);
		now = 1_500;
		expect(dedupe.shouldProcess("a")).toBe(true);

		now = 2_000;
		dedupe.shouldProcess("b");
		dedupe.shouldProcess("c");
		dedupe.shouldProcess("d");
		expect(dedupe.size).toBeLessThanOrEqual(2);
	});
});
