import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../src/agent-host.ts";
import { createAppState } from "../src/app-state.ts";
import type { createQqPlatform } from "../src/platform/runtime.ts";
import { createProactive } from "../src/proactive.ts";

const APP_ID = "102000000";
const BOT_ID = "bot-1";

describe("proactive interjection", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-proactive-"));
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await rm(dir, { recursive: true, force: true });
	});

	async function setup() {
		const state = createAppState({ dataDir: dir });
		await state.load();
		const base = state.getConfig();
		state.setConfig({
			...base,
			// 配了 Key 才会选中默认模型；视觉能力决定了图片会不会真的下载。
			providers: base.providers.map((provider) => ({ ...provider, apiKey: "test-key" })),
			proactiveGate: {
				...base.proactiveGate,
				enabled: true,
				mode: "probability",
				probabilityPercent: 100,
				aggregationSeconds: 0,
				cooldownSeconds: 0,
			},
		});

		const peer = state.registerPeer("group", "group-1", BOT_ID, "群 1");
		peer.features.activeReply = true;
		state.createSession("group", "group-1", "群 1", BOT_ID);

		const prompt = vi.fn(async () => {});
		const agentSession = { prompt, getLastAssistantText: () => "我插一句" };
		const agentHost = {
			getAgentSession: vi.fn(async () => agentSession),
		} as unknown as AgentHost;
		const sendText = vi.fn(async () => {});
		const platform = {
			channelFor: vi.fn(() => ({ sendText })),
		} as unknown as ReturnType<typeof createQqPlatform>;
		const log = vi.fn();

		const proactive = createProactive({
			state,
			agentHost,
			platform,
			getClient: () => undefined,
			log,
		});
		return { state, proactive, prompt, sendText, log };
	}

	it("hands aggregated images to the agent instead of only their placeholder", async () => {
		const { proactive, prompt, sendText, log } = await setup();
		const png = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
		const fetcher = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
		vi.stubGlobal("fetch", fetcher);

		proactive.queueGroupMessage({} as QQBot, { id: BOT_ID, appId: APP_ID } as never, "group-1", "小明", "user-1", "[图片]", [
			{ kind: "image", url: "https://cdn.example/a.png", mimeType: "image/png", fileName: "a.png" },
		]);

		// 等整条链路跑完（最后一行日志）再断言：提前返回时还在落盘，临时目录清理会撞上写文件。
		await vi.waitFor(() =>
			expect(log).toHaveBeenCalledWith("INFO", expect.stringContaining("智能插话已发送"), expect.any(String)),
		);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(prompt.mock.calls[0]?.[0]).toContain("[图片]");
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			images: [expect.objectContaining({ type: "image" })],
		});
		expect(sendText).toHaveBeenCalledWith({ scope: "group", targetId: "group-1" }, "我插一句");
	});

	it("keeps text-only windows image-free", async () => {
		const { proactive, prompt, log } = await setup();

		proactive.queueGroupMessage({} as QQBot, { id: BOT_ID, appId: APP_ID } as never, "group-1", "小明", "user-1", "今天吃什么", []);

		await vi.waitFor(() =>
			expect(log).toHaveBeenCalledWith("INFO", expect.stringContaining("智能插话已发送"), expect.any(String)),
		);
		expect(prompt).toHaveBeenCalledWith(expect.stringContaining("今天吃什么"), undefined);
	});
});
