import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { PeerConfig, RuntimeSession } from "../src/agent-host.ts";
import type { HttpContext } from "../src/http/context.ts";
import { handleSessionRoutes } from "../src/http/routes/sessions.ts";
import { type AppConfig, createDefaultConfig } from "../src/runtime.ts";

type Call = { status: number; body: Record<string, unknown> };

/**
 * 只搭 `/api/peer-config` 需要的依赖。
 *
 * 对象配置是「群 / 私聊细粒度配置」的唯一写入口：备用模型与工具覆盖都必须在这里
 * 校验并落盘，运行时（`agent-host`）只按读到的值执行。
 */
function harness() {
	let config: AppConfig = createDefaultConfig();
	config.providers = [
		{
			id: "p1",
			name: "主提供商",
			api: "openai-completions",
			apiKey: "sk-1",
			enabled: true,
			models: [
				{
					id: "m1",
					name: "主模型",
					api: "openai-completions",
					maxOutput: 1024,
					maxContext: 8000,
					compressionThreshold: 6000,
					supportsThinking: false,
					supportsVision: false,
					supportsTools: true,
				},
				{
					id: "m2",
					name: "备用模型",
					api: "openai-completions",
					maxOutput: 1024,
					maxContext: 8000,
					compressionThreshold: 6000,
					supportsThinking: false,
					supportsVision: false,
					supportsTools: true,
				},
			],
		},
		{
			id: "p2",
			name: "无 Key 提供商",
			api: "openai-completions",
			apiKey: "",
			enabled: true,
			models: [
				{
					id: "m9",
					name: "不可用模型",
					api: "openai-completions",
					maxOutput: 1024,
					maxContext: 8000,
					compressionThreshold: 6000,
					supportsThinking: false,
					supportsVision: false,
					supportsTools: true,
				},
			],
		},
	];
	config.tools.enabled = ["read", "web_search"];

	const peers: PeerConfig[] = [];
	let saves = 0;
	const sessions: RuntimeSession[] = [];
	const applyPeerConfigToSession = vi.fn();
	const applyToolSettings = vi.fn();
	const log = vi.fn();

	const ctx = {
		config: {
			get: () => config,
			replace: (next: AppConfig) => {
				config = next;
			},
			save: async () => undefined,
		},
		peers: {
			get: () => peers,
			find: (scope: PeerConfig["scope"], peerId: string, botId: string) =>
				peers.find((item) => item.scope === scope && item.peerId === peerId && item.botId === botId),
			ensure: (scope: PeerConfig["scope"], peerId: string, botId: string, name: string) => ({
				botId,
				scope,
				peerId,
				name,
				personaId: "default",
				providerId: "p1",
				modelId: "m1",
				fallbackProviderId: "",
				fallbackModelId: "",
				useTools: true,
				toolsOverride: null,
				features: { activeReply: false },
			}),
			save: async () => {
				saves += 1;
			},
		},
		sessions: {
			get: () => sessions,
			replace: () => undefined,
			save: async () => undefined,
			create: () => sessions[0] as RuntimeSession,
		},
		agentHost: { applyPeerConfigToSession, applyToolSettings },
		log,
	} as unknown as HttpContext;

	async function call(method: "GET" | "PUT", payload?: unknown): Promise<Call> {
		const search = "?botId=bot-1&scope=group&peerId=group-1";
		const url = new URL(`/api/peer-config${search}`, "http://127.0.0.1");
		const req = {
			method,
			url: url.pathname + url.search,
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
		const handled = await handleSessionRoutes(ctx, req, res, url);
		if (!handled) throw new Error(`路由未处理：${method} /api/peer-config`);
		return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
	}

	const base = {
		botId: "bot-1",
		scope: "group",
		peerId: "group-1",
		name: "测试群",
		personaId: "default",
		providerId: "p1",
		modelId: "m1",
		useTools: true,
		features: { activeReply: false },
	};
	return { call, base, peers, log, saves: () => saves, config: () => config, applyToolSettings };
}

describe("/api/peer-config 细粒度配置", () => {
	it("GET 同时返回对象配置、工具目录与全局启用清单", async () => {
		const h = harness();
		const { status, body } = await h.call("GET");

		expect(status).toBe(200);
		expect((body.config as PeerConfig).toolsOverride).toBeNull();
		expect((body.tools as Array<{ name: string }>).map((item) => item.name)).toContain("web_search");
		// 切到「自定义」时的初始勾选就是当前全局生效的那几个。
		expect(body.globalTools).toEqual(["read", "web_search"]);
	});

	it("保存备用模型与工具覆盖", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", {
			...h.base,
			fallbackProviderId: "p1",
			fallbackModelId: "m2",
			toolsOverride: ["web_search", "web_search"],
		});

		expect(status).toBe(200);
		const saved = body.config as PeerConfig;
		expect(saved.fallbackModelId).toBe("m2");
		// 去重后落盘。
		expect(saved.toolsOverride).toEqual(["web_search"]);
		expect(h.peers[0]?.fallbackModelId).toBe("m2");
		expect(h.saves()).toBe(1);
		// 工具集变了要立刻应用到已有会话。
		expect(h.applyToolSettings).toHaveBeenCalledOnce();
	});

	it("toolsOverride 传 null 表示继承全局", async () => {
		const h = harness();
		const { body } = await h.call("PUT", { ...h.base, toolsOverride: null });
		expect((body.config as PeerConfig).toolsOverride).toBeNull();
	});

	it("备用模型只填一半时拒绝", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { ...h.base, fallbackProviderId: "p1", fallbackModelId: "" });

		expect(status).toBe(400);
		expect(String(body.message)).toContain("备用模型");
		expect(h.saves()).toBe(0);
	});

	it("备用模型指向没有 Key 的提供商时拒绝", async () => {
		const h = harness();
		const { status } = await h.call("PUT", { ...h.base, fallbackProviderId: "p2", fallbackModelId: "m9" });
		expect(status).toBe(400);
	});

	it("拒绝未知的内置工具名", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { ...h.base, toolsOverride: ["bash2"] });

		expect(status).toBe(400);
		expect(String(body.message)).toContain("未知的内置工具");
		expect(h.saves()).toBe(0);
	});

	it("拒绝非数组的 toolsOverride", async () => {
		const h = harness();
		const { status } = await h.call("PUT", { ...h.base, toolsOverride: "web_search" });
		expect(status).toBe(400);
	});
});
