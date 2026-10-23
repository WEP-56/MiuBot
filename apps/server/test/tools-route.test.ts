import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HttpContext } from "../src/http/context.ts";
import { handleToolRoutes } from "../src/http/routes/tools.ts";
import { type AppConfig, createDefaultConfig } from "../src/runtime.ts";

type Call = { status: number; body: Record<string, unknown> };

/**
 * `/api/tools` 现在同时管「图像生成用哪个提供商」。
 *
 * 它和 `webSearch.provider` 是同一层：工具级配置只回答「用哪一个」，
 * 提供商本身（baseUrl / model / Key）仍归 `/api/config`。
 */
function harness() {
	let config: AppConfig = createDefaultConfig();
	config.imageProviders = [
		{ id: "img-a", name: "A 家", api: "openai-images", apiKey: "sk-a", baseUrl: "https://a.example/v1", model: "a-1", enabled: true },
		{ id: "img-b", name: "B 家", api: "openai-images", apiKey: "", baseUrl: "https://b.example/v1", model: "b-1", enabled: true },
	];
	config.tools.enabled = ["web_search"];
	const mcpEnabled = { value: false };
	const log = vi.fn();
	const rebuild = vi.fn();
	const applyToolSettings = vi.fn();
	const ctx = {
		config: {
			get: () => config,
			replace: (next: AppConfig) => {
				config = next;
			},
			save: async () => undefined,
		},
		mcpRuntime: {
			getGlobalToolsEnabled: () => mcpEnabled.value,
			setGlobalToolsEnabled: (next: boolean) => {
				mcpEnabled.value = next;
			},
			replace: async () => undefined,
			getStatuses: () => [],
		},
		agentHost: { rebuildAgentSessions: rebuild, applyToolSettings },
		log,
	} as unknown as HttpContext;

	async function call(method: "GET" | "PUT", payload?: unknown): Promise<Call> {
		const url = new URL("/api/tools", "http://127.0.0.1");
		const req = {
			method,
			url: "/api/tools",
			headers: {},
			async *[Symbol.asyncIterator]() {
				if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
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
		const handled = await handleToolRoutes(ctx, req, res, url);
		if (!handled) throw new Error(`路由未处理：${method} /api/tools`);
		return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
	}

	const base = { enabled: ["web_search"] };
	return { call, base, config: () => config };
}

type ImageGenPayload = { providerId: string; providers: Array<{ id: string; apiKeyConfigured: boolean }> };

describe("/api/tools 的图像提供商选择", () => {
	it("GET 返回当前选择与提供商清单，且不回传密钥", async () => {
		const h = harness();
		const { status, body } = await h.call("GET");
		const imageGen = body.imageGen as ImageGenPayload;

		expect(status).toBe(200);
		expect(imageGen.providerId).toBe("");
		expect(imageGen.providers.map((item) => item.id)).toEqual(["img-a", "img-b"]);
		expect(imageGen.providers.find((item) => item.id === "img-a")?.apiKeyConfigured).toBe(true);
		// 只回「有没有配」，不回密钥本身。
		expect(JSON.stringify(body)).not.toContain("sk-a");
	});

	it("选中一个可用提供商并落盘", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { ...h.base, imageGen: { providerId: "img-a" } });

		expect(status).toBe(200);
		expect((body.imageGen as ImageGenPayload).providerId).toBe("img-a");
		expect(h.config().tools.imageGen.providerId).toBe("img-a");
	});

	it("不传 imageGen 时保留原选择", async () => {
		const h = harness();
		h.config().tools.imageGen.providerId = "img-a";
		const { status, body } = await h.call("PUT", { ...h.base, enabled: ["web_search", "image_gen"] });

		expect(status).toBe(200);
		expect((body.imageGen as ImageGenPayload).providerId).toBe("img-a");
	});

	it("传空字符串表示取消选择", async () => {
		const h = harness();
		h.config().tools.imageGen.providerId = "img-a";
		const { body } = await h.call("PUT", { ...h.base, imageGen: { providerId: "" } });
		expect((body.imageGen as ImageGenPayload).providerId).toBe("");
	});

	it("拒绝不存在的提供商", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { ...h.base, imageGen: { providerId: "img-x" } });
		expect(status).toBe(400);
		expect(String(body.message)).toContain("不存在");
	});

	it("拒绝没有 API Key 的提供商", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { ...h.base, imageGen: { providerId: "img-b" } });
		expect(status).toBe(400);
		expect(String(body.message)).toContain("API Key");
	});

	it("拒绝已停用的提供商", async () => {
		const h = harness();
		h.config().imageProviders[0]!.enabled = false;
		const { status, body } = await h.call("PUT", { ...h.base, imageGen: { providerId: "img-a" } });
		expect(status).toBe(400);
		expect(String(body.message)).toContain("已停用");
	});
});
