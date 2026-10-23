import type { AssistantMessage } from "@miubot/provider";
import type { AgentSession, PromptOptions } from "@miubot/session/agent-session";
import type { LogLevel } from "./logging.ts";

/**
 * 带备用模型的一轮对话。
 *
 * 语义（2026-10-23 定）：**同一轮** `prompt()` 里主模型连续失败 3 次后，本轮临时换用
 * 备用模型把这次对话跑完；本轮结束（`finally`）恢复主模型。备用只是单次调用内的替换，
 * 不是代替主模型的位置——`session.modelId` 始终是主模型。
 */

/** 主模型连续失败几次后改用备用模型。 */
export const FALLBACK_AFTER_FAILURES = 3;

type FallbackModel = NonNullable<AgentSession["model"]>;

export type PromptWithFallbackOptions = {
	agentSession: AgentSession;
	prompt: string;
	images?: PromptOptions["images"];
	/**
	 * 备用模型；未配置时为 `undefined`。
	 *
	 * 没有备用模型时**只跑一次**：多试几次只会放大等待与计费，换不来任何东西。
	 */
	fallbackModel?: FallbackModel;
	sessionId: string;
	/** 每次失败后回调：用来取消流式输出、清空已累积文本。 */
	onFailure?(message: string, failures: number): void;
	log(level: LogLevel, text: string, sessionId?: string): void;
};

export type PromptWithFallbackResult = {
	/** 本轮失败次数（0 = 一次成功）。 */
	failures: number;
	/** 是否真的用过备用模型。 */
	usedFallback: boolean;
	/** 真正给出回答的模型（`provider/model`），供工作台展示。 */
	modelUsed: string;
};

function modelLabel(model: FallbackModel | undefined): string {
	return model ? `${model.provider}/${model.id}` : "未选择模型";
}

/**
 * 取最近一条 assistant 消息里的失败原因。
 *
 * provider 报错**不会**让 `prompt()` 抛错：Agent Loop 把错误写进 assistant 消息的
 * `stopReason: "error"` 里然后正常结束。不看这一步，失败会被当成「空回复」静默吞掉。
 */
function lastAssistantFailure(agentSession: AgentSession): string | undefined {
	const messages = agentSession.messages;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "error") return assistant.errorMessage ?? "模型调用失败";
		// 最近一条 assistant 正常结束（或被用户中断）：这一轮不算失败。
		return undefined;
	}
	return undefined;
}

/**
 * 跑一轮对话，按需在主模型失败 3 次后临时换用备用模型。
 *
 * 失败一律抛错，由调用方回通用文案：静默失败（只留下空回复）比报错更难排查。
 */
export async function promptWithFallback(options: PromptWithFallbackOptions): Promise<PromptWithFallbackResult> {
	const { agentSession, fallbackModel } = options;
	const maxAttempts = fallbackModel ? FALLBACK_AFTER_FAILURES + 1 : 1;
	const primaryModel = agentSession.model;
	let failures = 0;
	let usedFallback = false;

	try {
		for (;;) {
			let failure: string | undefined;
			try {
				await agentSession.prompt(options.prompt, options.images ? { images: options.images } : undefined);
				failure = lastAssistantFailure(agentSession);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			if (!failure) {
				return {
					failures,
					usedFallback,
					modelUsed: modelLabel(agentSession.model ?? primaryModel),
				};
			}

			failures += 1;
			options.onFailure?.(failure, failures);
			options.log(
				"WARN",
				`Agent 调用失败（第 ${failures}/${maxAttempts} 次，模型 ${modelLabel(agentSession.model)}）：${failure}`,
				options.sessionId,
			);
			// 没有备用模型、已经用过备用模型、或次数用完：整轮失败。
			if (!fallbackModel || usedFallback || failures >= maxAttempts) throw new Error(failure);
			// 还没到 3 次：继续用主模型重试。第 3 次失败才换模型。
			if (failures < FALLBACK_AFTER_FAILURES) continue;

			// 第 3 次失败：本轮改用备用模型把这次对话跑完。
			usedFallback = true;
			options.log(
				"WARN",
				`主模型连续失败 ${failures} 次，本轮改用备用模型 ${modelLabel(fallbackModel)}` +
					`（已经发出 ${failures} 次请求，重试会计费）`,
				options.sessionId,
			);
			try {
				await agentSession.setModel(fallbackModel);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				options.log("ERROR", `切换到备用模型失败：${detail}`, options.sessionId);
				throw error;
			}
		}
	} finally {
		// 无论成败都恢复主模型：否则一次失败就把会话永久钉在备用模型上。
		if (usedFallback && primaryModel && agentSession.model !== primaryModel) {
			try {
				await agentSession.setModel(primaryModel);
			} catch (error) {
				options.log(
					"WARN",
					`恢复主模型失败，会话可能停在备用模型上：${error instanceof Error ? error.message : String(error)}`,
					options.sessionId,
				);
			}
		}
	}
}
