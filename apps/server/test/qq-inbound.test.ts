import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../src/agent-host.ts";
import type { AgentSessionEvent } from "@miubot/session/agent-session";
import { createAppState } from "../src/app-state.ts";
import { createBuiltinCommands, createCommandDispatcher, createCommandRegistry } from "../src/commands/index.ts";
import { createMessageDeduplicator } from "../src/platform/inbound.ts";
import { createInboundReferenceStore } from "../src/platform/plugin-bridge.ts";
import type { ProactiveRuntime } from "../src/proactive.ts";
import { createInboundHandler } from "../src/qq/inbound.ts";
import type { StickerTagging } from "../src/sticker-tagging.ts";
import { StickerStore } from "../src/stickers.ts";

const APP_ID = "102000000";
const BOT_ID = "bot-1";

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
	return {
		rawEventType: "GROUP_AT_MESSAGE_CREATE",
		kind: "group",
		senderId: "user-1",
		senderName: "小明",
		content: `<@!${APP_ID}> 你好`,
		messageId: "msg-1",
		timestamp: "2026-10-22T00:00:00Z",
		groupOpenid: "group-1",
		replyTarget: { scope: "group", targetId: "group-1", msgId: "msg-1" },
		mentions: [
			{ member_openid: "user-1", nickname: "小明", is_you: false },
			{ is_you: true, scope: "single" },
		],
		raw: {},
		...overrides,
	} as QQBotInboundMessage;
}

/** 私聊消息：没有群，peerId 就是发送者。 */
function privateInbound(content: string, messageId = "msg-c2c"): QQBotInboundMessage {
	return inbound({
		rawEventType: "C2C_MESSAGE_CREATE",
		kind: "c2c",
		content,
		messageId,
		groupOpenid: undefined,
		replyTarget: { scope: "c2c", targetId: "user-1", msgId: messageId },
		mentions: [],
	} as Partial<QQBotInboundMessage>);
}

describe("QQ inbound pipeline", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-inbound-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function setup(
		overrides: {
			mentioned?: boolean;
			allowedPeers?: string[];
			admins?: string[];
			disabled?: string[];
			/** 配了 Key 才会选中默认模型，视觉能力也跟着生效。 */
			apiKey?: string;
		} = {},
	) {
		const state = createAppState({ dataDir: dir });
		await state.load();
		if (overrides.apiKey) {
			const current = state.getConfig();
			state.setConfig({
				...current,
				providers: current.providers.map((provider) => ({ ...provider, apiKey: overrides.apiKey ?? "" })),
			});
		}
		if (overrides.admins || overrides.disabled) {
			state.setConfig({
				...state.getConfig(),
				...(overrides.admins ? { admins: overrides.admins } : {}),
				...(overrides.disabled ? { commands: { disabled: overrides.disabled } } : {}),
			});
		}
		const prompts: string[] = [];
		let eventListener: ((event: AgentSessionEvent) => void) | undefined;
		const agentSession = {
			prompt: vi.fn(async (text: string) => {
				prompts.push(text);
				// 成功的一轮会留下一条正常的 assistant 消息；失败判定读的就是它。
				agentSession.messages.push({ role: "assistant", stopReason: "stop", content: [] });
			}),
			messages: [] as Array<Record<string, unknown>>,
			subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
				eventListener = listener;
				return () => {
					eventListener = undefined;
				};
			}),
			getLastAssistantText: () => "收到啦",
			model: { provider: "p", id: "m" },
			setModel: vi.fn(async () => {}),
			compact: async () => ({ summary: "压缩结果" }),
		};
		const agentHost = {
			getAgentSession: vi.fn(async () => agentSession),
			getFallbackModel: vi.fn(async () => undefined),
			applyPeerConfigToSession: vi.fn(),
			anyAgentLoopRunning: () => false,
		} as unknown as AgentHost;
		const sendText = vi.fn<(target: unknown, text: string) => Promise<void>>(async () => {});
		const streamUpdates: string[][] = [];
		const streamCompletions: number[] = [];
		const openStream = vi.fn(() => {
			const updates: string[] = [];
			streamUpdates.push(updates);
			return {
				supported: true,
				update: async (text: string) => {
					updates.push(text);
				},
				complete: async () => {
					streamCompletions.push(1);
				},
				cancel: () => {},
			};
		});
		const channel = {
			sendText,
			openStream,
		};
		const platform = {
			inboundDeduper: createMessageDeduplicator(),
			eventBus: { emit: vi.fn(async () => {}) },
			channelFor: vi.fn(() => channel),
		};
		const proactive = {
			metrics: {},
			decisions: [],
			sentToday: () => 0,
			queueGroupMessage: vi.fn(),
			cancelPendingWindow: vi.fn(),
			markGroupReplied: vi.fn(),
		} as unknown as ProactiveRuntime;
		const stickerTagging = {
			schedule: vi.fn(),
			notifyConversationActivity: vi.fn(),
			reset: vi.fn(),
		} satisfies StickerTagging;
		const log = vi.fn();
		const audit = { record: vi.fn(), list: async () => [], flush: async () => {} };

		// 命令链路用真实实现：`/new` 的行为就是「解析 → 权限 → 建会话」这条路径本身。
		const builtins = createBuiltinCommands({
			version: "0.0.0-test",
			startedAt: Date.now() - 60_000,
			summary: () => ({
				bots: { connected: 1, total: 1 },
				plugins: { active: 0, total: 0 },
				admins: state.getConfig().admins.length,
			}),
		});
		const commandRegistry = createCommandRegistry({
			builtins,
			plugins: { list: () => [], find: () => undefined },
			isDisabled: (name) => state.getConfig().commands.disabled.includes(name),
		});
		const commandDispatcher = createCommandDispatcher({
			state,
			agentHost,
			pluginCommands: { run: vi.fn(async () => {}) },
			audit,
			log,
		});

		const handler = createInboundHandler({
			state,
			agentHost,
			// 入站只需这几个成员，测试里按需最小化。
			platform: platform as unknown as Parameters<typeof createInboundHandler>[0]["platform"],
			stickerTagging,
			proactive,
			inboundReferences: createInboundReferenceStore(),
			stickerStore: new StickerStore(dir),
			commandRegistry,
			commandDispatcher,
			allowedPeers: () => overrides.allowedPeers ?? [],
			log,
		});
		const bot = {} as unknown as QQBot;
		const botConfig = { id: BOT_ID, appId: APP_ID, nickname: "麦麦", avatarUrl: "", appSecret: "", mode: "qr", enabled: true };
		return {
			state,
			handler,
			bot,
			botConfig,
			prompts,
			sendText,
			proactive,
			stickerTagging,
			agentSession,
			audit,
			emitAgentEvent: (event: AgentSessionEvent) => eventListener?.(event),
			openStream,
			streamUpdates,
			streamCompletions,
		};
	}

	function assistantEnd(text: string): AgentSessionEvent {
		return {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }] },
		} as unknown as AgentSessionEvent;
	}

	function assistantStart(): AgentSessionEvent {
		return { type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent;
	}

	function assistantTextDelta(delta: string): AgentSessionEvent {
		return {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", delta },
		} as unknown as AgentSessionEvent;
	}

	it("sends and persists each completed Assistant message separately", async () => {
		const { state, handler, bot, botConfig, sendText, agentSession, emitAgentEvent } = await setup();
		vi.mocked(agentSession.prompt).mockImplementation(async () => {
			emitAgentEvent(assistantStart());
			emitAgentEvent(assistantEnd("天气不错呀"));
			emitAgentEvent(assistantStart());
			emitAgentEvent(assistantEnd("我看看温度和湿度"));
			agentSession.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		});

		await handler(bot, botConfig as never, inbound());

		expect(sendText.mock.calls.map((call) => call[1])).toEqual(["天气不错呀", "我看看温度和湿度"]);
		expect(state.getSessions()[0]?.messages.filter((item) => item.role === "assistant").map((item) => item.content)).toEqual([
			"天气不错呀",
			"我看看温度和湿度",
		]);
	});

	it("opens and completes one C2C stream per Assistant message", async () => {
		const { handler, bot, botConfig, agentSession, emitAgentEvent, openStream, streamUpdates, streamCompletions } = await setup();
		vi.mocked(agentSession.prompt).mockImplementation(async () => {
			emitAgentEvent(assistantStart());
			emitAgentEvent(assistantTextDelta("天气"));
			emitAgentEvent(assistantTextDelta("不错"));
			emitAgentEvent(assistantEnd("天气不错"));
			emitAgentEvent(assistantStart());
			emitAgentEvent(assistantTextDelta("我看看"));
			emitAgentEvent(assistantEnd("我看看"));
			agentSession.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		});

		await handler(bot, botConfig as never, privateInbound("今天天气怎么样"));

		expect(openStream).toHaveBeenCalledTimes(2);
		expect(streamUpdates).toEqual([
			["天气", "天气不错"],
			["我看看"],
		]);
		expect(streamCompletions).toHaveLength(2);
	});

	it("records tool activity and optionally sends translated progress to QQ", async () => {
		const { state, handler, bot, botConfig, sendText, agentSession, emitAgentEvent } = await setup();
		state.registerPeer("group", "group-1", BOT_ID, "测试群").features.showToolActivity = true;
		vi.mocked(agentSession.prompt).mockImplementation(async () => {
			emitAgentEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "web_search", args: {} } as AgentSessionEvent);
			emitAgentEvent({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "web_search",
				result: {},
				isError: false,
				durationMs: 1250,
			} as AgentSessionEvent);
			emitAgentEvent(assistantStart());
			emitAgentEvent(assistantEnd("查到了。"));
			agentSession.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		});

		await handler(bot, botConfig as never, inbound());

		expect(sendText.mock.calls.map((call) => call[1])).toEqual([
			"正在使用「网页搜索」…",
			"「网页搜索」执行成功（1.3 秒）",
			"查到了。",
		]);
		expect(state.getSessions()[0]?.activities).toEqual([
			expect.objectContaining({ id: "call-1", label: "网页搜索", status: "success", durationMs: 1250 }),
		]);
	});

	it("keeps translated tool progress off QQ by default while retaining it in the session", async () => {
		const { state, handler, bot, botConfig, sendText, agentSession, emitAgentEvent } = await setup();
		vi.mocked(agentSession.prompt).mockImplementation(async () => {
			emitAgentEvent({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: {} } as AgentSessionEvent);
			emitAgentEvent({
				type: "tool_execution_end",
				toolCallId: "call-2",
				toolName: "read",
				result: {},
				isError: false,
				durationMs: 200,
			} as AgentSessionEvent);
			agentSession.messages.push({ role: "assistant", stopReason: "stop", content: [] });
		});

		await handler(bot, botConfig as never, inbound());

		expect(sendText.mock.calls.map((call) => call[1])).toEqual(["收到啦"]);
		expect(state.getSessions()[0]?.activities?.[0]).toEqual(
			expect.objectContaining({ id: "call-2", label: "读取文件", status: "success" }),
		);
	});

	it("replies to a mentioned group message and persists both sides", async () => {
		const { state, handler, bot, botConfig, prompts, sendText, proactive, stickerTagging } = await setup();
		await handler(bot, botConfig as never, inbound());

		expect(prompts).toEqual(["你好"]);
		expect(sendText).toHaveBeenCalledWith(expect.anything(), "收到啦");
		expect(proactive.queueGroupMessage).not.toHaveBeenCalled();
		// 新消息要推进打标版本号（原本由 index.ts 里的两个语句完成）。
		expect(stickerTagging.notifyConversationActivity).toHaveBeenCalledOnce();

		const sessions = state.getSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(sessions[0]?.title).toBe("你好");
	});

	it("drops a duplicate delivery of the same message", async () => {
		const { handler, bot, botConfig, prompts } = await setup();
		await handler(bot, botConfig as never, inbound());
		await handler(bot, botConfig as never, inbound());
		expect(prompts).toEqual(["你好"]);
	});

	it("queues ordinary group chatter for the proactive window instead of replying", async () => {
		const { handler, bot, botConfig, prompts, sendText, proactive } = await setup();
		await handler(
			bot,
			botConfig as never,
			inbound({
				// 普通群消息：不是被 @ 的机器人消息事件。
				rawEventType: "GROUP_MESSAGE_CREATE",
				content: "今天吃什么",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
			}),
		);

		expect(prompts).toEqual([]);
		expect(sendText).not.toHaveBeenCalled();
		expect(proactive.queueGroupMessage).toHaveBeenCalledWith(
			bot,
			expect.anything(),
			"group-1",
			"小明",
			"user-1",
			"今天吃什么",
			[],
		);
	});

	it("hands a group image to the proactive window instead of a placeholder", async () => {
		const { handler, bot, botConfig, proactive } = await setup();
		await handler(
			bot,
			botConfig as never,
			inbound({
				rawEventType: "GROUP_MESSAGE_CREATE",
				messageId: "msg-image",
				content: "",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
				attachments: [{ content_type: "image/png", url: "https://cdn.example/a.png", filename: "a.png" }],
			}),
		);

		// 附件跟着消息进窗口，插话时才可能真的把图片交给模型。
		expect(proactive.queueGroupMessage).toHaveBeenCalledWith(
			bot,
			expect.anything(),
			"group-1",
			"小明",
			"user-1",
			"[图片]",
			[expect.objectContaining({ kind: "image", url: "https://cdn.example/a.png" })],
		);
	});

	it("passes a quoted image into the proactive window", async () => {
		const { handler, bot, botConfig, proactive } = await setup();
		await handler(
			bot,
			botConfig as never,
			inbound({
				rawEventType: "GROUP_MESSAGE_CREATE",
				messageId: "msg-quote-proactive",
				content: "",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
				refMsgIdx: "ref-1",
				msgElements: [
					{
						msg_idx: "ref-1",
						content: "",
						attachments: [{ content_type: "image/png", url: "https://cdn.example/q.png", filename: "q.png" }],
					},
					{ msg_idx: "cur-1", content: "" },
				],
			}),
		);

		const [content, attachments] = vi.mocked(proactive.queueGroupMessage).mock.calls[0]?.slice(5) ?? [];
		expect(content).toContain("被引用消息的附件：图片 q.png");
		expect(attachments).toEqual([expect.objectContaining({ kind: "image", url: "https://cdn.example/q.png" })]);
	});

	it("passes a quoted image to the model instead of a placeholder", async () => {
		const { handler, bot, botConfig, prompts, agentSession } = await setup({ apiKey: "test-key" });
		const png = await readFile(new URL("../../../packages/provider/test/data/red-circle.png", import.meta.url));
		const fetcher = vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } }));
		vi.stubGlobal("fetch", fetcher);
		try {
			await handler(
				bot,
				botConfig as never,
				inbound({
					messageId: "msg-quote",
					content: `<@!${APP_ID}> 这是什么`,
					refMsgIdx: "ref-1",
					msgElements: [
						{
							msg_idx: "ref-1",
							content: "",
							attachments: [
								{ content_type: "image/png", url: "https://cdn.example/quoted.png", filename: "quoted.png" },
							],
						},
						{ msg_idx: "cur-1", content: "这是什么" },
					],
				}),
			);
		} finally {
			vi.unstubAllGlobals();
		}

		expect(fetcher).toHaveBeenCalledOnce();
		expect(prompts[0]).toContain("被引用消息的附件：图片 quoted.png");
		expect(prompts[0]).toContain("被引用消息中的 1 张图片已作为附图提供");
		expect(agentSession.prompt).toHaveBeenCalledWith(expect.any(String), {
			images: [expect.objectContaining({ type: "image" })],
		});
	});

	it("starts a new session on /new and keeps the older one inactive", async () => {
		const { state, handler, bot, botConfig, sendText } = await setup();
		await handler(bot, botConfig as never, inbound());
		const first = state.getSessions()[0]?.id;
		await handler(bot, botConfig as never, inbound({ messageId: "msg-2", content: `<@!${APP_ID}> /new` }));

		const sessions = state.getSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.id).not.toBe(first);
		expect(sessions[1]?.active).toBe(false);
		expect(sendText).toHaveBeenLastCalledWith(expect.anything(), "已开始新会话。");
	});

	it("handles /new in a group without a mention", async () => {
		// 曾经的缺陷：群聊闸门排在命令判定之前，非 @ 的 `/new` 到不了命令分支。
		const { state, handler, bot, botConfig, sendText, proactive, prompts } = await setup();
		await handler(bot, botConfig as never, inbound());
		const first = state.getSessions()[0]?.id;
		await handler(
			bot,
			botConfig as never,
			inbound({
				rawEventType: "GROUP_MESSAGE_CREATE",
				messageId: "msg-2",
				content: "/new",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
			}),
		);

		const sessions = state.getSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.id).not.toBe(first);
		expect(sendText).toHaveBeenLastCalledWith(expect.anything(), "已开始新会话。");
		// 命中命令即接管：不排队插话，也不进 Agent。
		expect(proactive.queueGroupMessage).not.toHaveBeenCalled();
		expect(prompts).toEqual(["你好"]);
	});

	it("lists only the commands the caller may use on /help", async () => {
		const { handler, bot, botConfig, sendText } = await setup();
		await handler(bot, botConfig as never, privateInbound("/help"));

		const text = sendText.mock.calls.at(-1)?.[1] ?? "";
		expect(text).toContain("/new");
		expect(text).toContain("/help");
		// 非管理员看不到管理员命令，免得照着敲一遍才发现被拒。
		expect(text).not.toContain("/admin");
	});

	it("rejects an admin command from a non-admin and records it", async () => {
		const { handler, bot, botConfig, sendText, audit } = await setup();
		await handler(bot, botConfig as never, privateInbound("/admin"));

		expect(sendText).toHaveBeenLastCalledWith(expect.anything(), "这个命令只有管理员能用。");
		expect(audit.record).toHaveBeenCalledWith(
			expect.objectContaining({ action: "command.denied", actor: "user-1" }),
		);
	});

	it("lets a configured admin run /admin", async () => {
		const { handler, bot, botConfig, sendText } = await setup({ admins: ["user-1"] });
		await handler(bot, botConfig as never, privateInbound("/admin"));

		const text = sendText.mock.calls.at(-1)?.[1] ?? "";
		expect(text).toContain("Miubot 0.0.0-test");
		expect(text).toContain("在线 Bot：1/1");
	});

	it("treats a disabled command as ordinary text", async () => {
		const { handler, bot, botConfig, prompts, sendText } = await setup({ disabled: ["new"] });
		await handler(bot, botConfig as never, inbound({ messageId: "msg-9", content: `<@!${APP_ID}> /new` }));

		// 关掉的命令当作不存在：消息按普通聊天进 Agent。
		expect(prompts).toEqual(["/new"]);
		expect(sendText).not.toHaveBeenCalledWith(expect.anything(), "已开始新会话。");
	});

	it("leaves unknown slash text to the proactive window in groups", async () => {
		const { handler, bot, botConfig, proactive } = await setup();
		await handler(
			bot,
			botConfig as never,
			inbound({
				rawEventType: "GROUP_MESSAGE_CREATE",
				messageId: "msg-3",
				content: "/foo 你好",
				mentions: [{ member_openid: "user-1", nickname: "小明", is_you: false }],
			}),
		);

		// 只接管已注册的命令，否则会误吞群友的消息。
		expect(proactive.queueGroupMessage).toHaveBeenCalled();
	});

	it("ignores peers outside the whitelist without leaving a trace", async () => {
		const { state, handler, bot, botConfig, prompts, sendText, proactive } = await setup({
			allowedPeers: ["group:some-other-group"],
		});
		await handler(bot, botConfig as never, inbound());

		// 不回复、不进 Agent、不排插话，也不建对象记录与会话。
		expect(prompts).toEqual([]);
		expect(sendText).not.toHaveBeenCalled();
		expect(proactive.queueGroupMessage).not.toHaveBeenCalled();
		expect(state.getSessions()).toHaveLength(0);
		expect(state.getPeers()).toHaveLength(0);
	});

	it("lets a whitelisted peer through", async () => {
		const { handler, bot, botConfig, prompts } = await setup({ allowedPeers: ["group:group-1"] });
		await handler(bot, botConfig as never, inbound());

		expect(prompts).toEqual(["你好"]);
	});
});
