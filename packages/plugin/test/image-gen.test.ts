import { describe, expect, it, vi } from "vitest";
import { createImageGenTool } from "../src/tools/image-gen.ts";

describe("image_gen tool", () => {
	it("passes generation options through to the host", async () => {
		const generate = vi.fn().mockResolvedValue(undefined);
		const tool = createImageGenTool(generate);
		const context = {} as Parameters<typeof tool.execute>[4];
		const signal = new AbortController().signal;

		const result = await tool.execute("call-1", { prompt: "A blue cat", size: "1024x1024", quality: "high" }, signal, undefined, context);

		expect(generate).toHaveBeenCalledWith({ prompt: "A blue cat", size: "1024x1024", quality: "high", signal });
		expect(result.isError).not.toBe(true);
	});

	it("returns generation failures as tool errors", async () => {
		const tool = createImageGenTool(async () => { throw new Error("provider unavailable"); });
		const context = {} as Parameters<typeof tool.execute>[4];

		const result = await tool.execute("call-2", { prompt: "A blue cat" }, undefined, undefined, context);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: "provider unavailable" });
	});
});
