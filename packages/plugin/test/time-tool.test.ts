import { describe, expect, it } from "vitest";
import { createTimeTool } from "../src/tools/time.ts";

describe("time tool", () => {
	it("formats the current time using the configured timezone", async () => {
		const tool = createTimeTool(() => "Asia/Tokyo");
		const context = {} as Parameters<typeof tool.execute>[4];
		const result = await tool.execute("call-1", {}, undefined, undefined, context);
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		expect(text).toContain("Asia/Tokyo");
		expect(text).toContain("当前时间");
		expect(result.details).toMatchObject({ timezone: "Asia/Tokyo" });
	});

	it("reports an invalid timezone as a tool error", async () => {
		const tool = createTimeTool(() => "Invalid/Zone");
		const context = {} as Parameters<typeof tool.execute>[4];
		const result = await tool.execute("call-1", {}, undefined, undefined, context);
		expect(result.isError).toBe(true);
	});
});
