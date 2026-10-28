import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../src/tools/memory.ts";

describe("memory tools", () => {
	it("exposes read and save tools through the injected object-scoped operations", async () => {
		const read = vi.fn(async (query?: string) => `matches for ${query ?? "all"}`);
		const save = vi.fn(async (input: { title: string; area: string }) => ({ title: input.title, area: input.area }));
		const tools = createMemoryTools({ read, save });
		const readTool = tools.find((tool) => tool.name === "read_memory");
		const saveTool = tools.find((tool) => tool.name === "save_memory");
		expect(readTool).toBeDefined();
		expect(saveTool).toBeDefined();
		if (!readTool || !saveTool) throw new Error("memory tools were not registered");

		const context = {} as Parameters<typeof readTool.execute>[4];
		const readResult = await readTool.execute(
			"read-1",
			{ query: "project" } as Parameters<typeof readTool.execute>[1],
			undefined,
			undefined,
			context,
		);
		expect(read).toHaveBeenCalledWith("project");
		expect(readResult.content).toContainEqual({ type: "text", text: "matches for project" });

		const saveInput = { area: "personal", category: "user", title: "Preference", content: "Short answers" };
		const saveResult = await saveTool.execute(
			"save-1",
			saveInput as Parameters<typeof saveTool.execute>[1],
			undefined,
			undefined,
			context,
		);
		expect(save).toHaveBeenCalledWith(saveInput);
		expect(saveResult.content).toContainEqual({ type: "text", text: "已保存长期记忆「Preference」（personal）。" });
	});

	it("returns operation failures as tool errors", async () => {
		const tools = createMemoryTools({
			read: async () => {
				throw new Error("object access denied");
			},
			save: async () => {
				throw new Error("object access denied");
			},
		});
		const readTool = tools[0];
		if (!readTool) throw new Error("read_memory was not registered");
		const context = {} as Parameters<typeof readTool.execute>[4];
		const result = await readTool.execute(
			"read-1",
			{} as Parameters<typeof readTool.execute>[1],
			undefined,
			undefined,
			context,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContainEqual({ type: "text", text: "object access denied" });
	});
});
