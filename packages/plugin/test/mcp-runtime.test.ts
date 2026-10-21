import { describe, expect, it } from "vitest";
import { McpRuntime } from "../src/tools/mcp/runtime.ts";

describe("MCP runtime tool gates", () => {
	it("keeps disabled servers out of the agent tool set", async () => {
		const runtime = new McpRuntime([{ id: "disabled", name: "Disabled", transport: "stdio", command: "unused", enabled: false }], true);

		await runtime.startEnabled();

		expect(runtime.getStatuses()[0]?.state).toBe("disconnected");
		expect(runtime.getEnabledToolDefinitions()).toEqual([]);
		await runtime.close();
	});

	it("reports stdio connection failures without exposing tools", async () => {
		const runtime = new McpRuntime([{ id: "missing", name: "Missing", transport: "stdio", command: "miubot-mcp-command-that-does-not-exist", enabled: true }], true);

		await runtime.startEnabled();

		expect(runtime.getStatuses()[0]?.state).toBe("error");
		expect(runtime.getStatuses()[0]?.error).toBeTruthy();
		expect(runtime.getEnabledToolDefinitions()).toEqual([]);
		await runtime.close();
	});

	it("removes all MCP tools when global tools are disabled", () => {
		const runtime = new McpRuntime([], true);

		runtime.setGlobalToolsEnabled(false);

		expect(runtime.getEnabledToolDefinitions()).toEqual([]);
	});
});
