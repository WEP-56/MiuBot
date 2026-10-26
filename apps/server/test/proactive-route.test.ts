import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HttpContext } from "../src/http/context.ts";
import { handleProactiveRoutes } from "../src/http/routes/proactive.ts";
import { type AppConfig, createDefaultConfig } from "../src/runtime.ts";

type Call = { status: number; body: Record<string, unknown> };

/**
 * 只搭 `/api/proactive-gate` 需要的依赖。
 *
 * 聚合窗口与群级冷却都不设下限：0 就是「不聚合 / 不冷却」，冷却更不该被单位卡在 1 分钟。
 */
function harness() {
	let config: AppConfig = createDefaultConfig();
	const log = vi.fn();
	const ctx = {
		config: {
			get: () => config,
			replace: (next: AppConfig) => {
				config = next;
			},
			save: async () => undefined,
		},
		log,
	} as unknown as HttpContext;

	async function put(payload: unknown): Promise<Call> {
		const url = new URL("/api/proactive-gate", "http://127.0.0.1");
		const req = {
			method: "PUT",
			url: url.pathname,
			headers: {},
			async *[Symbol.asyncIterator]() {
				yield Buffer.from(JSON.stringify(payload));
			},
		} as unknown as IncomingMessage;
		let status = 0;
		let text = "";
		const res = {
			writeHead: (code: number) => {
				status = code;
				return res;
			},
			setHeader: () => res,
			end: (chunk?: string) => {
				text = chunk ?? "";
			},
		} as unknown as ServerResponse;
		const handled = await handleProactiveRoutes(ctx, req, res, url);
		if (!handled) throw new Error("路由未处理：PUT /api/proactive-gate");
		return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
	}

	return { put, config: () => config };
}

describe("proactive gate route", () => {
	it("accepts zero aggregation and a sub-minute cooldown", async () => {
		const { put, config } = harness();
		const result = await put({ mode: "probability", aggregationSeconds: 0, cooldownSeconds: 30 });

		expect(result.status).toBe(200);
		expect(config().proactiveGate.aggregationSeconds).toBe(0);
		expect(config().proactiveGate.cooldownSeconds).toBe(30);
	});

	it("keeps 1 second aggregation and 1 second cooldown", async () => {
		const { put, config } = harness();
		expect((await put({ mode: "probability", aggregationSeconds: 1, cooldownSeconds: 1 })).status).toBe(200);
		expect(config().proactiveGate.aggregationSeconds).toBe(1);
		expect(config().proactiveGate.cooldownSeconds).toBe(1);
	});

	it("rejects negative and oversized values", async () => {
		const { put } = harness();
		expect((await put({ mode: "probability", aggregationSeconds: -1 })).status).toBe(400);
		expect((await put({ mode: "probability", cooldownSeconds: -1 })).status).toBe(400);
		expect((await put({ mode: "probability", aggregationSeconds: 61 })).status).toBe(400);
		expect((await put({ mode: "probability", cooldownSeconds: 86_401 })).status).toBe(400);
	});
});
