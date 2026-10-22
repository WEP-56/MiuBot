import type { QQBot, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { describe, expect, it, vi } from "vitest";
import { chunkText, createOutboundChannel, createReplyLimiter } from "../src/platform/outbound.ts";

function fakeBot() {
	return {
		sendText: vi.fn().mockResolvedValue({ id: "sent-1" }),
		sendMarkdown: vi.fn().mockResolvedValue({ id: "sent-2" }),
		sendMedia: vi.fn().mockResolvedValue({ upload: { file_uuid: "u" } }),
	} as unknown as QQBot & {
		sendText: ReturnType<typeof vi.fn>;
		sendMarkdown: ReturnType<typeof vi.fn>;
		sendMedia: ReturnType<typeof vi.fn>;
	};
}

describe("chunkText", () => {
	it("keeps short text in one chunk", () => {
		expect(chunkText("hello")).toEqual(["hello"]);
		expect(chunkText("")).toEqual([""]);
	});

	it("splits on line boundaries without losing content", () => {
		const code = ["```", ...Array.from({ length: 10 }, (_, i) => `line ${i}`), "```"].join("\n");
		const text = `${"a".repeat(30)}\n${code}\n${"b".repeat(30)}`;
		const chunks = chunkText(text, 80);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(80);
		expect(chunks.join("\n")).toBe(text);
	});

	it("keeps GFM table rows together", () => {
		const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
		const chunks = chunkText(`${"x".repeat(40)}\n${table}`, 30);
		const tableChunk = chunks.find((chunk) => chunk.includes("| a | b |"));
		expect(tableChunk).toContain("| 1 | 2 |");
	});
});

describe("reply limiter", () => {
	it("allows proactive targets without tracking", () => {
		const limiter = createReplyLimiter({ limit: 2 });
		const target: ReplyTarget = { scope: "c2c", targetId: "user-1" };
		limiter.record(target);
		expect(limiter.canReply(target)).toBe(true);
		expect(limiter.remaining(target)).toBe(Number.POSITIVE_INFINITY);
	});

	it("exhausts the passive budget and expires stale entries", () => {
		let now = 0;
		const limiter = createReplyLimiter({ limit: 2, ttlMs: 1_000, now: () => now });
		const target: ReplyTarget = { scope: "group", targetId: "group-1", msgId: "msg-1" };
		expect(limiter.remaining(target)).toBe(2);
		limiter.record(target);
		limiter.record(target);
		expect(limiter.canReply(target)).toBe(false);
		now = 2_000;
		expect(limiter.canReply(target)).toBe(true);
	});

	it("bounds tracked messages", () => {
		const limiter = createReplyLimiter({ maxTracked: 2 });
		for (const id of ["a", "b", "c"]) limiter.record({ scope: "c2c", targetId: "u", msgId: id });
		expect(limiter.remaining({ scope: "c2c", targetId: "u", msgId: "a" })).toBe(4);
	});
});

describe("outbound channel", () => {
	it("splits long replies into several messages", async () => {
		const bot = fakeBot();
		const channel = createOutboundChannel({ bot });
		const result = await channel.sendText(
			{ scope: "c2c", targetId: "user-1", msgId: "msg-1" },
			`${"a".repeat(40)}\n${"b".repeat(40)}`,
			{ chunkLimit: 40 },
		);

		expect(result.messages).toBeGreaterThan(1);
		expect(bot.sendText).toHaveBeenCalledTimes(result.messages);
		expect(result.fallbackUsed).toBe(false);
	});

	it("falls back to proactive pushes when the passive budget is exhausted", async () => {
		const bot = fakeBot();
		const channel = createOutboundChannel({ bot, passiveReplyLimit: 1 });
		const target: ReplyTarget = { scope: "group", targetId: "group-1", msgId: "msg-1" };

		await channel.sendText(target, "first");
		await channel.sendText(target, "second");

		expect(bot.sendText.mock.calls[0]?.[0]).toMatchObject({ msgId: "msg-1" });
		expect(bot.sendText.mock.calls[1]?.[0]?.msgId).toBeUndefined();
	});

	it("refuses the fallback when it is disabled", async () => {
		const bot = fakeBot();
		const channel = createOutboundChannel({ bot, passiveReplyLimit: 1 });
		const target: ReplyTarget = { scope: "group", targetId: "group-1", msgId: "msg-1" };
		await channel.sendText(target, "first");
		await expect(channel.sendText(target, "second", { allowProactiveFallback: false })).rejects.toThrow(
			"不允许主动推送降级",
		);
	});

	it("sends markdown for single-chunk replies and media through upload", async () => {
		const bot = fakeBot();
		const channel = createOutboundChannel({ bot });
		await channel.sendMarkdown({ scope: "c2c", targetId: "user-1", msgId: "msg-1" }, "# hi");
		expect(bot.sendMarkdown).toHaveBeenCalledOnce();

		await channel.sendMedia(
			{ scope: "c2c", targetId: "user-1", msgId: "msg-1" },
			{ kind: "image", buffer: new Uint8Array([1, 2, 3]), fileName: "a.png" },
		);
		expect(bot.sendMedia).toHaveBeenCalledOnce();
		expect(bot.sendMedia.mock.calls[0]?.[0]).toMatchObject({ fileName: "a.png" });
	});

	it("reports successful sends for observation", async () => {
		const bot = fakeBot();
		const onSent = vi.fn();
		const channel = createOutboundChannel({ bot, onSent });
		await channel.sendText({ scope: "group", targetId: "g", msgId: "m" }, "hi");
		expect(onSent).toHaveBeenCalledWith({
			target: { scope: "group", targetId: "g", msgId: "m" },
			kind: "text",
			messages: 1,
			fallbackUsed: false,
		});
	});

	it("only opens streams for c2c replies with a msgId", async () => {
		const bot = fakeBot();
		const stream = {
			update: vi.fn().mockResolvedValue(undefined),
			complete: vi.fn().mockResolvedValue(undefined),
			cancel: vi.fn(),
		};
		(bot as unknown as { openStream: ReturnType<typeof vi.fn> }).openStream = vi.fn().mockReturnValue(stream);
		const channel = createOutboundChannel({ bot });

		expect(channel.openStream({ scope: "group", targetId: "g", msgId: "m" }).supported).toBe(false);
		expect(channel.openStream({ scope: "c2c", targetId: "u" }).supported).toBe(false);

		const supported = channel.openStream({ scope: "c2c", targetId: "u", msgId: "m" });
		expect(supported.supported).toBe(true);
		await supported.update("hello");
		await supported.complete();
		expect(stream.update).toHaveBeenCalledWith("hello");
		expect(stream.complete).toHaveBeenCalledOnce();
	});
});
