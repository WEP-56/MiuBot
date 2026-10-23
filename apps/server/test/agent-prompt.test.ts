import type { AgentSession } from "@miubot/session/agent-session";
import { describe, expect, it, vi } from "vitest";
import { FALLBACK_AFTER_FAILURES, promptWithFallback } from "../src/agent-prompt.ts";

/** 一轮 `prompt()` 的结果：成功、以 `stopReason: "error"` 结束、或直接抛错。 */
type Attempt = "ok" | "error" | "throw";

function model(id: string) {
	return { provider: "test-provider", id } as NonNullable<AgentSession["model"]>;
}

/**
 * 假会话。
 *
 * 关键点：provider 报错**不会**抛错，而是让 `prompt()` 正常返回并留下一条
 * `stopReason: "error"` 的 assistant 消息——这里如实模拟，否则测试会假绿。
 */
function fakeSession(attempts: Attempt[], initial = model("primary")) {
	const state = {
		model: initial as NonNullable<AgentSession["model"]> | undefined,
		messages: [] as Array<Record<string, unknown>>,
		index: 0,
		setModelCalls: [] as string[],
	};
	const session = {
		get model() {
			return state.model;
		},
		get messages() {
			return state.messages;
		},
		async prompt() {
			const outcome = attempts[state.index] ?? "ok";
			state.index += 1;
			if (outcome === "throw") throw new Error("缺少 API Key");
			state.messages.push(
				outcome === "error"
					? { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" }
					: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "好" }] },
			);
		},
		async setModel(next: NonNullable<AgentSession["model"]>) {
			state.setModelCalls.push(next.id);
			state.model = next;
		},
	};
	return { session: session as unknown as AgentSession, state };
}

function options(overrides: Partial<Parameters<typeof promptWithFallback>[0]> = {}) {
	const log = vi.fn();
	const onFailure = vi.fn();
	return { log, onFailure, base: { prompt: "你好", sessionId: "session-1", log, onFailure, ...overrides } };
}

describe("promptWithFallback", () => {
	it("成功时只调用一次，并记下实际使用的模型", async () => {
		const { session, state } = fakeSession(["ok"]);
		const { base, log } = options({ agentSession: session });

		const result = await promptWithFallback(base);

		expect(result).toEqual({ failures: 0, usedFallback: false, modelUsed: "test-provider/primary" });
		expect(state.setModelCalls).toEqual([]);
		expect(log).not.toHaveBeenCalled();
	});

	it("没有备用模型时失败即抛错（不重试）", async () => {
		const { session, state } = fakeSession(["error", "ok"]);
		const { base, onFailure } = options({ agentSession: session });

		await expect(promptWithFallback(base)).rejects.toThrow("429 Too Many Requests");
		// 只试了一次：没有备用模型时多试只会放大等待与计费。
		expect(state.index).toBe(1);
		expect(onFailure).toHaveBeenCalledOnce();
	});

	it("prompt 抛错也计入失败", async () => {
		const { session } = fakeSession(["throw"]);
		const { base } = options({ agentSession: session });

		await expect(promptWithFallback(base)).rejects.toThrow("缺少 API Key");
	});

	it("连续失败未满 3 次时不换模型", async () => {
		const { session, state } = fakeSession(["error", "ok"], model("primary"));
		const { base, log } = options({ agentSession: session, fallbackModel: model("backup") });

		const result = await promptWithFallback(base);

		expect(result).toEqual({ failures: 1, usedFallback: false, modelUsed: "test-provider/primary" });
		expect(state.setModelCalls).toEqual([]);
		expect(log).toHaveBeenCalledWith("WARN", expect.stringContaining("第 1/4 次"), "session-1");
	});

	it("第 3 次失败后换备用模型跑完本轮，并在结束后恢复主模型", async () => {
		const { session, state } = fakeSession(["error", "error", "error", "ok"], model("primary"));
		const { base, log, onFailure } = options({ agentSession: session, fallbackModel: model("backup") });

		const result = await promptWithFallback(base);

		expect(result).toEqual({ failures: 3, usedFallback: true, modelUsed: "test-provider/backup" });
		// 切换一次、恢复一次。
		expect(state.setModelCalls).toEqual(["backup", "primary"]);
		expect(onFailure).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith(
			"WARN",
			expect.stringContaining("本轮改用备用模型 test-provider/backup"),
			"session-1",
		);
		// 会话最终停在主模型上：备用只是单次调用内的临时替换。
		expect(state.model?.id).toBe("primary");
	});

	it("备用模型也失败时整轮失败，但主模型照样被恢复", async () => {
		const { session, state } = fakeSession(["error", "error", "error", "error"], model("primary"));
		const { base, log } = options({ agentSession: session, fallbackModel: model("backup") });

		await expect(promptWithFallback(base)).rejects.toThrow("429 Too Many Requests");
		expect(state.setModelCalls).toEqual(["backup", "primary"]);
		expect(state.model?.id).toBe("primary");
		// 每次失败都留痕：日志里能看出「一共发了 4 次请求」。
		expect(log.mock.calls.filter(([, text]) => String(text).includes("调用失败"))).toHaveLength(4);
	});

	it("失败次数上限是「3 次主模型 + 1 次备用」", async () => {
		const { session, state } = fakeSession(["error", "error", "error", "error", "ok"]);
		const { base } = options({ agentSession: session, fallbackModel: model("backup") });

		await expect(promptWithFallback(base)).rejects.toThrow();
		expect(state.index).toBe(FALLBACK_AFTER_FAILURES + 1);
	});
});
