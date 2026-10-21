import { describe, expect, it } from "vitest";
import { parseStickerAnnotation, STICKER_TAGGING_PROMPT } from "../src/sticker-tagger.ts";

describe("sticker annotation parsing", () => {
	it("keeps annotations concise and removes duplicate tags", () => {
		expect(parseStickerAnnotation('{"description":"这是一只非常开心地挥手打招呼的小猫咪表情包","tags":["开心","挥手","开心","猫咪"]}')).toEqual({
			description: "这是一只非常开心地挥手打招呼的小猫咪表情包",
			tags: ["开心", "挥手", "猫咪"],
		});
	});

	it("accepts enough semantic tags to describe emotion, action, and intent", () => {
		expect(parseStickerAnnotation('{"description":"开心地鼓掌庆祝","tags":["开心","鼓掌","庆祝","赞同","热烈欢迎","多余标签"]}').tags).toEqual(["开心", "鼓掌", "庆祝", "赞同", "热烈欢迎"]);
	});

	it("rejects incomplete model output", () => {
		expect(() => parseStickerAnnotation("这是一张开心的猫咪表情包")).toThrow("不是有效 JSON");
		expect(() => parseStickerAnnotation('{"description":"猫猫","tags":[]}')).toThrow("为空");
	});

	it("prioritizes communicative meaning over visual appearance", () => {
		expect(STICKER_TAGGING_PROMPT).toContain("只输出 JSON");
		expect(STICKER_TAGGING_PROMPT).toContain("情绪、动作、互动用途");
		expect(STICKER_TAGGING_PROMPT).toContain("发色、发型、性别");
		expect(STICKER_TAGGING_PROMPT).toContain("不猜背景");
	});
});
