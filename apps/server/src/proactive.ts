import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { AgentHost } from "./agent-host.ts";
import type { AppState } from "./app-state.ts";
import type { LogLevel } from "./logging.ts";
import { type MediaAttachment, prepareMediaAttachments } from "./media.ts";
import type { createQqPlatform } from "./platform/runtime.ts";
import {
	type AppConfig,
	createChatCompletion,
	evaluateProactiveGate,
	isGlobalSilenceActive,
	type QqBotConfig,
} from "./runtime.ts";
import { sessionPromptContexts, stickerSendContexts } from "./session-context.ts";
import { enqueueForTarget } from "./target-queue.ts";
import { localDateKey } from "./util/time.ts";

export type ProactiveMetrics = {
	groupMessagesReceived: number;
	candidates: number;
	judgments: number;
	planned: number;
	sent: number;
	blocked: number;
};

export type ProactiveDecision = {
	time: string;
	groupId: string;
	sessionId?: string;
	result: string;
	reason: string;
};

const PROACTIVE_JUDGE_SYSTEM_PROMPT = `你是群聊插话时机判断器，只判断机器人现在是否值得回复，不生成回复正文，也不输出分析过程。

把输入的最近消息窗口当作可判断的完整上下文。它本来就只包含最近几条消息；没有更早聊天记录，不等于信息不足。

shouldReply=true 的情况：有人提出尚未回答的问题或明确求助；当前话题仍在进行，机器人能补充直接相关且不重复的信息；或可以用简短、自然的回应接住明显的玩笑、感谢、祝贺或情绪表达。只要话题可理解且有具体回应价值，倾向回复，不要求机器人必须解决整个话题。

shouldReply=false 仅用于：话题明显结束（如告别或问题已解决）；消息确实无法理解或缺少必要指代，无法形成任何具体回应；机器人刚刚已经答过同一问题；或此时发言明显不合时宜。不要仅因消息短、缺少更早背景、属于普通闲聊或担心轻微打断就判为 false。

reasonCode 用 helpful_answer、directly_relevant、conversation_closed、interruption_risk 或 no_context。no_context 只表示输入本身不可理解/无法回应，不能表示缺少聊天历史。shouldReply 必须填写不带引号的 JSON 布尔值 true 或 false。只输出一行 JSON，例如：{"shouldReply":true,"reasonCode":"helpful_answer","topic":"晚饭"}。`;

function createProactiveJudgePrompt(transcript: string): string {
	return `请根据下面的群聊最近消息判断是否插话。先看是否有未回答的问题、明确求助或仍在发展的可回应话题。不要因为窗口没有更早历史就判为 no_context。只输出系统要求的 JSON。\n\n群聊最近消息：\n${transcript}`;
}

export type ProactiveRuntime = {
	metrics: ProactiveMetrics;
	decisions: ProactiveDecision[];
	sentToday(): number;
	/** 非 @ 的群消息进入聚合窗口；窗口到期后判断是否插话。 */
	queueGroupMessage(
		bot: QQBot,
		botConfig: QqBotConfig,
		groupId: string,
		sender: string,
		senderId: string,
		content: string,
		attachments: MediaAttachment[],
	): void;
	/** 群里 @ 了 Bot：取消待发窗口，避免插话与正式回复撞车。 */
	cancelPendingWindow(botId: string, groupId: string): void;
	/** 正式回复了该群：开始插话冷却，避免紧接着再插一句。 */
	markGroupReplied(botId: string, groupId: string): void;
};

type WindowMessage = {
	sender: string;
	senderId: string;
	content: string;
	/** 消息自带的附件：插话时图片要真正交给模型，不能只留一句「收到附件」。 */
	attachments: MediaAttachment[];
};

type ReplyWindow = {
	bot: QQBot;
	botConfig: QqBotConfig;
	groupId: string;
	messages: WindowMessage[];
	timer: ReturnType<typeof setTimeout>;
};

/**
 * 群聊智能插话。
 *
 * 链路：普通群消息 → 聚合窗口 → 全局闸门（开关/静默/额度）→ 群级冷却 → 判断模型或概率抽样
 * → 走一次 Agent → 发送前复核。任何一个环节不满足都要落一条决策记录，便于界面解释「为什么没说话」。
 */
export function createProactive(deps: {
	state: AppState;
	agentHost: AgentHost;
	platform: ReturnType<typeof createQqPlatform>;
	getClient(botId: string): QQBot | undefined;
	log(level: LogLevel, text: string, sessionId?: string): void;
}): ProactiveRuntime {
	const { state, agentHost, platform, getClient, log } = deps;
	const metrics: ProactiveMetrics = {
		groupMessagesReceived: 0,
		candidates: 0,
		judgments: 0,
		planned: 0,
		sent: 0,
		blocked: 0,
	};
	const decisions: ProactiveDecision[] = [];
	const windows = new Map<string, ReplyWindow>();
	const cooldowns = new Map<string, number>();
	const gateNoticeDates = new Map<string, string>();

	function record(entry: ProactiveDecision): void {
		decisions.unshift(entry);
		if (decisions.length > 100) decisions.pop();
	}

	const config = (): AppConfig => state.getConfig();

	async function checkGate(groupId: string, notify: boolean): Promise<boolean> {
		const today = localDateKey();
		if (state.getProactiveUsage().date !== today) state.setProactiveUsage({ date: today, sent: 0 });
		const reasons = evaluateProactiveGate(config().proactiveGate, state.getProactiveUsage().sent);
		if (reasons.length === 0) return true;
		metrics.blocked++;
		record({ time: new Date().toISOString(), groupId, result: "blocked", reason: reasons.join(", ") });
		log("INFO", `智能插话被全局闸门拦截：${reasons.join(", ")}`);
		if (
			notify &&
			config().proactiveGate.notifyOnLimit &&
			reasons.includes("daily-limit") &&
			!reasons.includes("quiet-hours") &&
			gateNoticeDates.get(groupId) !== today
		) {
			gateNoticeDates.set(groupId, today);
			const bot = config().qqBots.find((item) => item.enabled);
			const client = bot ? getClient(bot.id) : undefined;
			if (client)
				await platform
					.channelFor(client)
					.sendText({ scope: "group", targetId: groupId }, "MiuBot 的主动发言限制已触发，今天将暂时保持安静。")
					.catch(() => {});
		}
		return false;
	}

	async function evaluateWindow(key: string): Promise<void> {
		if (isGlobalSilenceActive(config().globalSilence)) {
			const pending = windows.get(key);
			if (pending) clearTimeout(pending.timer);
			windows.delete(key);
			return;
		}
		const window = windows.get(key);
		if (!window) return;
		windows.delete(key);
		const { bot, botConfig, groupId, messages } = window;
		const peerConfig = state.getPeerConfig("group", groupId, botConfig.id);
		const session = state
			.getSessions()
			.find(
				(item) => item.active && item.scope === "group" && item.peerId === groupId && item.botId === botConfig.id,
			);
		if (!config().proactiveGate.enabled || !peerConfig?.features.activeReply || !session) {
			const reason = !config().proactiveGate.enabled
				? "global-disabled"
				: !peerConfig?.features.activeReply
					? "group-not-opted-in"
					: "no-active-session";
			metrics.blocked++;
			record({ time: new Date().toISOString(), groupId, result: "blocked", reason });
			log("INFO", `智能插话未执行：${reason} (${groupId})`);
			return;
		}
		if (!(await checkGate(groupId, true))) return;
		const cooldownKey = `${botConfig.id}:group:${groupId}`;
		const lastReply = cooldowns.get(cooldownKey) ?? 0;
		if (Date.now() - lastReply < config().proactiveGate.cooldownSeconds * 1000) {
			metrics.blocked++;
			record({
				time: new Date().toISOString(),
				groupId,
				sessionId: session.id,
				result: "blocked",
				reason: "cooldown",
			});
			log("INFO", `智能插话被群级冷却拦截：${groupId}`, session.id);
			return;
		}
		if (!(await checkGate(groupId, false))) return;
		const transcript = messages
			.map((message) => `${message.sender}（平台用户 ID/OpenID: ${message.senderId}）：${message.content}`)
			.join("\n");
		let decision: { shouldReply?: boolean; reasonCode?: string; topic?: string };
		if (config().proactiveGate.mode === "probability") {
			if (Math.random() * 100 >= config().proactiveGate.probabilityPercent) {
				metrics.blocked++;
				record({
					time: new Date().toISOString(),
					groupId,
					sessionId: session.id,
					result: "quiet",
					reason: "probability-sample",
				});
				log(
					"INFO",
					`智能插话概率抽样未命中：${groupId} (${config().proactiveGate.probabilityPercent}%)`,
					session.id,
				);
				return;
			}
			decision = { shouldReply: true, reasonCode: "probability-sample", topic: "群聊讨论" };
			log("INFO", `智能插话概率抽样命中：${groupId} (${config().proactiveGate.probabilityPercent}%)`, session.id);
		} else {
			const provider = config().providers.find(
				(item) => item.id === config().proactiveGate.judgeProviderId && item.enabled && item.apiKey,
			);
			const model = provider?.models.find((item) => item.id === config().proactiveGate.judgeModelId);
			if (!provider || !model) {
				metrics.blocked++;
				record({
					time: new Date().toISOString(),
					groupId,
					sessionId: session.id,
					result: "blocked",
					reason: "judge-model-unavailable",
				});
				log("WARN", `智能插话判断模型不可用：${groupId}`, session.id);
				return;
			}
			metrics.judgments++;
			log("INFO", `智能插话调用判断模型：${provider.id}/${model.id}；窗口 ${messages.length} 条`, session.id);
			const decisionResult = await createChatCompletion(
				config(),
				provider.id,
				model.id,
				createProactiveJudgePrompt(transcript),
				[
					{
						role: "system",
						content: PROACTIVE_JUDGE_SYSTEM_PROMPT,
					},
				],
			);
			if (!decisionResult.ok || !decisionResult.text) {
				metrics.blocked++;
				record({
					time: new Date().toISOString(),
					groupId,
					sessionId: session.id,
					result: "blocked",
					reason: "judge-failed",
				});
				log("WARN", `智能插话判断失败，静默处理：${decisionResult.error ?? "空结果"}`, session.id);
				return;
			}
			try {
				const raw = decisionResult.text.match(/\{[\s\S]*\}/)?.[0];
				if (!raw) throw new Error("判断结果不是 JSON");
				decision = JSON.parse(raw) as typeof decision;
			} catch (error) {
				metrics.blocked++;
				record({
					time: new Date().toISOString(),
					groupId,
					sessionId: session.id,
					result: "blocked",
					reason: "invalid-judge-response",
				});
				log("WARN", `智能插话判断结果无效：${error instanceof Error ? error.message : String(error)}`, session.id);
				return;
			}
		}
		if (decision.shouldReply !== true) {
			metrics.blocked++;
			record({
				time: new Date().toISOString(),
				groupId,
				sessionId: session.id,
				result: "quiet",
				reason: decision.reasonCode ?? "no_context",
			});
			log(
				"INFO",
				`智能插话判定保持安静：${decision.reasonCode ?? "no_context"}；${decision.topic ?? "未提供主题"}`,
				session.id,
			);
			return;
		}
		metrics.planned++;
		const currentPeerConfig = state.getPeerConfig("group", groupId, botConfig.id);
		if (
			!config().proactiveGate.enabled ||
			!currentPeerConfig?.features.activeReply ||
			!session.active ||
			!(await checkGate(groupId, true)) ||
			Date.now() - (cooldowns.get(cooldownKey) ?? 0) < config().proactiveGate.cooldownSeconds * 1000
		) {
			log("INFO", `智能插话发送前复核拦截：${groupId}`, session.id);
			return;
		}
		const sessionProvider = config().providers.find((item) => item.id === session.providerId);
		const sessionModel = sessionProvider?.models.find((item) => item.id === session.modelId);
		const media = await prepareMediaAttachments(
			messages.flatMap((message) => message.attachments),
			{ supportsVision: sessionModel?.supportsVision === true },
		);
		const prompt = `群聊话题：${decision.topic ?? "最近讨论"}\n以下是刚刚聚合到的群聊消息：\n${transcript}\n${media.context ? `${media.context}\n` : ""}请自然、简洁地参与讨论。不要提及你在分析是否插话，也不要复述整段消息。`;
		try {
			const agentSession = await agentHost.getAgentSession(session);
			stickerSendContexts.set(session.id, {
				bot,
				target: { scope: "group", targetId: groupId },
				channel: platform.channelFor(bot),
			});
			sessionPromptContexts.set(
				session.id,
				`本次待处理群消息包含以下发言人及平台 ID：\n${messages.map((message) => `${message.sender}（${message.senderId}）`).join("\n")}`,
			);
			try {
				await agentSession.prompt(prompt, media.images.length > 0 ? { images: media.images } : undefined);
			} finally {
				stickerSendContexts.delete(session.id);
				sessionPromptContexts.delete(session.id);
			}
			const answer = agentSession.getLastAssistantText()?.trim();
			if (!answer) {
				log("WARN", `智能插话 Agent 未生成文本：${groupId}`, session.id);
				return;
			}
			if (
				!config().proactiveGate.enabled ||
				!state.getPeerConfig("group", groupId, botConfig.id)?.features.activeReply ||
				!session.active ||
				!(await checkGate(groupId, true))
			) {
				log("INFO", `智能插话生成后复核拦截：${groupId}`, session.id);
				return;
			}
			const today = localDateKey();
			if (state.getProactiveUsage().date !== today) state.setProactiveUsage({ date: today, sent: 0 });
			state.setProactiveUsage({ date: today, sent: state.getProactiveUsage().sent + 1 });
			await state.saveProactiveUsage();
			try {
				await platform.channelFor(bot).sendText({ scope: "group", targetId: groupId }, answer);
			} catch (error) {
				state.setProactiveUsage({ date: today, sent: Math.max(0, state.getProactiveUsage().sent - 1) });
				await state.saveProactiveUsage();
				throw error;
			}
			cooldowns.set(cooldownKey, Date.now());
			metrics.sent++;
			record({
				time: new Date().toISOString(),
				groupId,
				sessionId: session.id,
				result: "sent",
				reason: decision.reasonCode ?? "helpful_answer",
			});
			session.messages.push(
				{ role: "user", content: prompt, sender: "群聊聚合", timestamp: new Date().toISOString() },
				{ role: "assistant", content: answer, timestamp: new Date().toISOString() },
			);
			if (session.title === "新会话") session.title = (decision.topic ?? "群聊主动插话").slice(0, 36);
			session.updatedAt = new Date().toISOString();
			await state.saveSessions();
			log(
				"INFO",
				`智能插话已发送；主题：${decision.topic ?? "未分类"}；累计 ${state.getProactiveUsage().sent} 条`,
				session.id,
			);
		} catch (error) {
			log("ERROR", `智能插话执行失败并静默：${error instanceof Error ? error.message : String(error)}`, session.id);
		}
	}

	return {
		metrics,
		decisions,
		sentToday: () => (state.getProactiveUsage().date === localDateKey() ? state.getProactiveUsage().sent : 0),
		queueGroupMessage(bot, botConfig, groupId, sender, senderId, content, attachments) {
			const peerConfig = state.getPeerConfig("group", groupId, botConfig.id);
			metrics.groupMessagesReceived++;
			log(
				"INFO",
				`收到普通群消息事件 ${groupId}：global=${config().proactiveGate.enabled}, groupOptIn=${peerConfig?.features.activeReply === true}`,
			);
			if (!config().proactiveGate.enabled || !peerConfig?.features.activeReply) {
				const reason = !config().proactiveGate.enabled ? "global-disabled" : "group-not-opted-in";
				metrics.blocked++;
				record({ time: new Date().toISOString(), groupId, result: "skipped", reason });
				log("INFO", `普通群消息未进入插话聚合：${reason} (${groupId})`);
				return;
			}
			const key = `${botConfig.id}:group:${groupId}`;
			const existing = windows.get(key);
			if (existing) {
				existing.messages.push({ sender, senderId, content: content.slice(0, 500), attachments });
				if (existing.messages.length > 12) existing.messages.shift();
				return;
			}
			windows.set(key, {
				bot,
				botConfig,
				groupId,
				messages: [{ sender, senderId, content: content.slice(0, 500), attachments }],
				timer: setTimeout(() => {
					void enqueueForTarget(key, () => evaluateWindow(key));
				}, config().proactiveGate.aggregationSeconds * 1000),
			});
			metrics.candidates++;
			log("INFO", `智能插话聚合窗口开始：${groupId}`);
		},
		cancelPendingWindow(botId, groupId) {
			const key = `${botId}:group:${groupId}`;
			const pending = windows.get(key);
			if (!pending) return;
			clearTimeout(pending.timer);
			windows.delete(key);
			log("INFO", `智能插话窗口因 Bot 被 @ 而取消：${groupId}`);
		},
		markGroupReplied(botId, groupId) {
			cooldowns.set(`${botId}:group:${groupId}`, Date.now());
		},
	};
}
