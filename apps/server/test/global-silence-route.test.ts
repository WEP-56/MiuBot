import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HttpContext } from "../src/http/context.ts";
import { handleGlobalSilenceRoutes } from "../src/http/routes/global-silence.ts";
import { createDefaultConfig, type AppConfig } from "../src/runtime.ts";

function harness() {
	let config: AppConfig = createDefaultConfig();
	const save = vi.fn(async () => {});
	const ctx = {
		config: { get: () => config, replace: (next: AppConfig) => (config = next), save },
		log: vi.fn(),
	} as unknown as HttpContext;
	async function request(method: string, payload?: unknown) {
		const url = new URL("/api/global-silence", "http://127.0.0.1");
		const req = {
			method,
			url: url.pathname,
			headers: {},
			async *[Symbol.asyncIterator]() {
				if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
			},
		} as unknown as IncomingMessage;
		let status = 0;
		let text = "";
		const res = {
			writeHead: (code: number) => ((status = code), res),
			setHeader: () => res,
			end: (chunk?: string) => (text = chunk ?? ""),
		} as unknown as ServerResponse;
		const handled = await handleGlobalSilenceRoutes(ctx, req, res, url);
		if (!handled) throw new Error(`路由未处理：${method} /api/global-silence`);
		return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
	}
	return { config: () => config, request, save };
}

describe("global silence route", () => {
	it("reads and persists the configured daily window", async () => {
		const test = harness();
		const read = await test.request("GET");
		expect(read.status).toBe(200);
		expect(read.body.globalSilence).toEqual({ quietStart: "00:00", quietEnd: "00:00" });

		const saved = await test.request("PUT", { quietStart: "23:00", quietEnd: "07:30" });
		expect(saved.status).toBe(200);
		expect(test.config().globalSilence).toEqual({ quietStart: "23:00", quietEnd: "07:30" });
		expect(test.save).toHaveBeenCalledOnce();
	});

	it("rejects invalid times without changing the setting", async () => {
		const test = harness();
		const result = await test.request("PUT", { quietStart: "25:00", quietEnd: "07:00" });
		expect(result.status).toBe(400);
		expect(test.config().globalSilence).toEqual({ quietStart: "00:00", quietEnd: "00:00" });
		expect(test.save).not.toHaveBeenCalled();
	});
});
