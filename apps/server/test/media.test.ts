import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { prepareInboundMedia } from "../src/media.ts";

describe("QQ media adapter", () => {
	it("prepares image attachments for vision models and retains generic attachment context", async () => {
		const png = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
		const result = await prepareInboundMedia({
			attachments: [
				{ content_type: "image/png", url: "https://cdn.example/image.png", filename: "image.png" },
				{ content_type: "audio/ogg", url: "https://cdn.example/voice.ogg", asr_refer_text: "你好" },
			],
		}, { supportsVision: true, fetcher });

		expect(fetcher).toHaveBeenCalledOnce();
		expect(result.images).toHaveLength(1);
		expect(result.images[0]?.type).toBe("image");
		expect(result.attachments.map((attachment) => attachment.kind)).toEqual(["image", "audio"]);
		expect(result.context).toContain("语音识别文本：你好");
	});

	it("does not download images for models without vision support", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await prepareInboundMedia({
			attachments: [{ content_type: "image/jpeg", url: "https://cdn.example/image.jpg" }],
		}, { supportsVision: false, fetcher });

		expect(fetcher).not.toHaveBeenCalled();
		expect(result.images).toEqual([]);
		expect(result.context).toContain("不支持图片输入");
	});
});
