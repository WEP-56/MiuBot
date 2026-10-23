import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHost, PeerConfig } from "../src/agent-host.ts";
import { type AppState, createAppState } from "../src/app-state.ts";
import {
	type CommandRequest,
	createBuiltinCommands,
	createCommandDispatcher,
	createCommandRegistry,
	parseCommand,
} from "../src/commands/index.ts";
import type { PluginCommandView } from "../src/commands/registry.ts";

describe("parseCommand", () => {
	it("parses a bare command", () => {
		expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
	});

	it("keeps the argument text verbatim", () => {
		expect(parseCommand("/foo  a b  ")).toEqual({ name: "foo", args: "a b" });
	});

	it("lowercases the command name", () => {
		// QQ 手机端首字母容易自动大写，`/New` 不该变成「未知命令」。
		expect(parseCommand("/New")?.name).toBe("new");
	});

	it("allows hyphens in names", () => {
		expect(parseCommand("/auto-reply now")).toEqual({ name: "auto-reply", args: "now" });
	});

	it("rejects text that is not a command", () => {
		expect(parseCommand("你好")).toBeUndefined();
		expect(parseCommand("请 /new 一下")).toBeUndefined();
		expect(parseCommand("/ 你好")).toBeUndefined();
		expect(parseCommand("/")).toBeUndefined();
		expect(parseCommand("/1abc")).toBeUndefined();
	});
});

describe("command registry", () => {
	const builtins = createBuiltinCommands({
		version: "0.0.0-test",
		startedAt: 0,
		summary: () => ({ bots: { connected: 0, total: 0 }, plugins: { active: 0, total: 0 }, admins: 0 }),
	});
	const pluginCommand: PluginCommandView = {
		pluginId: "test.commands",
		name: "ping",
		description: "回一句 pong",
		permission: "all",
	};

	function registry(options: { disabled?: string[]; plugins?: PluginCommandView[] } = {}) {
		const plugins = options.plugins ?? [pluginCommand];
		return createCommandRegistry({
			builtins,
			plugins: {
				list: () => plugins,
				find: (name) => plugins.find((item) => item.name === name),
			},
			isDisabled: (name) => (options.disabled ?? []).includes(name),
		});
	}

	it("resolves builtin commands", () => {
		const resolved = registry().resolve("new", { botId: "bot-1" });
		expect(resolved?.source).toBe("builtin");
		expect(resolved?.permission).toBe("all");
	});

	it("resolves plugin commands with their owner", () => {
		const resolved = registry().resolve("ping", { botId: "bot-1" });
		expect(resolved).toMatchObject({ source: "plugin", pluginId: "test.commands", permission: "all" });
	});

	it("treats a disabled command as unknown", () => {
		expect(registry({ disabled: ["new"] }).resolve("new", { botId: "bot-1" })).toBeUndefined();
	});

	it("returns undefined for unregistered names", () => {
		expect(registry().resolve("nope", { botId: "bot-1" })).toBeUndefined();
	});

	it("lists builtin and plugin commands with their enabled state", () => {
		const entries = registry({ disabled: ["compact"] }).list();
		expect(entries.map((entry) => entry.name)).toEqual(["new", "compact", "help", "admin", "ping"]);
		expect(entries.find((entry) => entry.name === "compact")?.enabled).toBe(false);
		expect(entries.find((entry) => entry.name === "ping")?.source).toBe("plugin");
	});

	it("hides admin commands from non-admins", () => {
		const names = (isAdmin: boolean) => registry().available(isAdmin).map((entry) => entry.name);
		expect(names(false)).not.toContain("admin");
		expect(names(true)).toContain("admin");
		// 被禁用的命令不在可用清单里。
		expect(registry({ disabled: ["help"] }).available(true).map((entry) => entry.name)).not.toContain("help");
	});
});

describe("command dispatcher", () => {
	let dir: string;
	let state: AppState;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "miubot-commands-"));
		state = createAppState({ dataDir: dir });
		await state.load();
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const peer: PeerConfig = {
		botId: "bot-1",
		scope: "group",
		peerId: "group-1",
		name: "群 group-1",
		personaId: "default",
		providerId: "p",
		modelId: "m",
		useTools: true,
		features: { activeReply: false },
	};

	function harness(options: { pluginRun?: (input: unknown) => Promise<void> } = {}) {
		const sendText = vi.fn<(target: unknown, text: string) => Promise<void>>(async () => {});
		const audit = { record: vi.fn(), list: async () => [], flush: async () => {} };
		const log = vi.fn();
		const pluginRun = vi.fn(options.pluginRun ?? (async () => {}));
		const dispatcher = createCommandDispatcher({
			state,
			agentHost: {} as AgentHost,
			pluginCommands: { run: pluginRun },
			audit,
			log,
		});
		const request = (overrides: Partial<CommandRequest> = {}): CommandRequest => ({
			parsed: { name: "help", args: "" },
			resolved: {
				source: "builtin",
				name: "help",
				description: "列出当前可用的命令",
				permission: "all",
				definition: {
					name: "help",
					description: "列出当前可用的命令",
					permission: "all",
					run: async (invocation) => {
						await invocation.reply(invocation.commands.map((item) => `/${item.name}`).join(" "));
					},
				},
			},
			bot: {} as never,
			botConfig: {
				id: "bot-1",
				appId: "app",
				nickname: "麦麦",
				avatarUrl: "",
				appSecret: "",
				mode: "qr",
				enabled: true,
			},
			message: { replyTarget: { scope: "group", targetId: "group-1", msgId: "m-1" } } as never,
			channel: { sendText } as never,
			peer,
			isGroup: true,
			senderId: "user-1",
			senderName: "小明",
			isAdmin: false,
			commands: [
				{ name: "help", description: "列出当前可用的命令", permission: "all", source: "builtin" },
				{ name: "ping", description: "回一句 pong", permission: "all", source: "plugin", pluginId: "test" },
			],
			...overrides,
		});
		return { dispatcher, request, sendText, audit, log, pluginRun };
	}

	it("runs a builtin command with the caller-visible catalog", async () => {
		const { dispatcher, request, sendText } = harness();
		await dispatcher(request());

		expect(sendText).toHaveBeenCalledWith(expect.anything(), "/help /ping");
	});

	it("refuses an admin command for a non-admin and audits the attempt", async () => {
		const { dispatcher, request, sendText, audit, log } = harness();
		await dispatcher(
			request({
				parsed: { name: "admin", args: "" },
				resolved: {
					source: "builtin",
					name: "admin",
					description: "查看运行状态",
					permission: "admin",
					definition: {
						name: "admin",
						description: "查看运行状态",
						permission: "admin",
						run: async () => {
							throw new Error("不该被执行");
						},
					},
				},
			}),
		);

		expect(sendText).toHaveBeenCalledWith(expect.anything(), "这个命令只有管理员能用。");
		expect(audit.record).toHaveBeenCalledWith(
			expect.objectContaining({ action: "command.denied", actor: "user-1" }),
		);
		expect(log).toHaveBeenCalledWith("WARN", expect.stringContaining("拒绝非管理员执行 /admin"));
	});

	it("delegates plugin commands with the inbound context", async () => {
		const { dispatcher, request, pluginRun } = harness();
		await dispatcher(
			request({
				parsed: { name: "ping", args: "now" },
				resolved: {
					source: "plugin",
					name: "ping",
					description: "回一句 pong",
					permission: "all",
					pluginId: "test.commands",
				},
				isAdmin: true,
			}),
		);

		expect(pluginRun).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "ping",
				botId: "bot-1",
				scope: "group",
				peerId: "group-1",
				senderId: "user-1",
				isAdmin: true,
				args: "now",
			}),
		);
	});

	it("turns a command failure into a generic reply plus a log entry", async () => {
		const { dispatcher, request, sendText, log } = harness();
		await dispatcher(
			request({
				parsed: { name: "boom", args: "" },
				resolved: {
					source: "builtin",
					name: "boom",
					description: "总是失败",
					permission: "all",
					definition: {
						name: "boom",
						description: "总是失败",
						permission: "all",
						run: async () => {
							throw new Error("内部细节：/secret/path");
						},
					},
				},
			}),
		);

		// 对外不泄露内部报错，细节只进日志。
		expect(sendText).toHaveBeenCalledWith(expect.anything(), "执行这条命令时出错了，已经记在运行日志里。");
		expect(log).toHaveBeenCalledWith("ERROR", expect.stringContaining("/secret/path"), undefined);
	});

	it("creates a session for /new", async () => {
		const builtins = createBuiltinCommands({
			version: "0.0.0-test",
			startedAt: 0,
			summary: () => ({ bots: { connected: 0, total: 0 }, plugins: { active: 0, total: 0 }, admins: 0 }),
		});
		const newCommand = builtins.find((command) => command.name === "new");
		expect(newCommand).toBeDefined();
		const { dispatcher, request, sendText } = harness();
		await dispatcher(
			request({
				parsed: { name: "new", args: "" },
				resolved: {
					source: "builtin",
					name: "new",
					description: "结束当前会话",
					permission: "all",
					definition: newCommand!,
				},
			}),
		);

		expect(state.getSessions()).toHaveLength(1);
		expect(sendText).toHaveBeenCalledWith(expect.anything(), "已开始新会话。");
	});
});
