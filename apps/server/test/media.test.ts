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

	it("feeds quoted images to the vision model instead of a placeholder", async () => {
		const png = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
		const result = await prepareInboundMedia(
			{ attachments: [] },
			{
				supportsVision: true,
				quote: {
					source: "msg_elements",
					refMsgIdx: "ref-1",
					text: "",
					attachments: [{ contentType: "image/png", url: "https://cdn.example/quoted.png", fileName: "quoted.png" }],
				},
				fetcher,
			},
		);

		expect(fetcher).toHaveBeenCalledOnce();
		expect(result.images).toHaveLength(1);
		expect(result.context).toContain("被引用消息中的 1 张图片已作为附图提供");
	});

	it("explains quoted images that the model cannot see", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await prepareInboundMedia(
			{ attachments: [] },
			{
				supportsVision: false,
				quote: {
					source: "msg_elements",
					refMsgIdx: "ref-1",
					text: "",
					attachments: [{ contentType: "image/png", url: "https://cdn.example/quoted.png" }],
				},
				fetcher,
			},
		);

		expect(fetcher).not.toHaveBeenCalled();
		expect(result.images).toEqual([]);
		expect(result.context).toContain("被引用消息包含图片，但当前会话模型不支持图片输入");
	});
});
