import { describe, expect, it, vi } from "vitest";
import { createPluginConfigAccess } from "../src/host/config.ts";
import { createPluginContext } from "../src/host/context.ts";
import { createPluginLifecycle, PluginInactiveError } from "../src/host/lifecycle.ts";
import type { PluginPermission } from "../src/host/manifest.ts";

/** 生命周期测试只需要「能读到东西」，配置内容本身在 config 测试里覆盖。 */
function configAccess(): ReturnType<typeof createPluginConfigAccess> {
	return createPluginConfigAccess({
		schema: { type: "object", properties: { greeting: { type: "string", default: "hi" } } },
		read: async () => ({}),
	});
}

function setup(permissions: PluginPermission[] = []) {
	const lifecycle = createPluginLifecycle("test.plugin");
	lifecycle.begin();
	lifecycle.activate();
	const sendMessage = vi.fn().mockResolvedValue(undefined);
	const subscribes: Array<{ ownerId: string; type: string; handler: (event: never, signal: AbortSignal) => unknown }> =
		[];
	const unsubscribed: string[] = [];
	const context = createPluginContext({
		lifecycle,
		manifestId: "test.plugin",
		botIds: ["bot-1"],
		permissions: new Set(permissions),
		subscribePlatformEvent: (ownerId, type, handler) => {
			subscribes.push({ ownerId, type, handler: handler as never });
			return () => unsubscribed.push(type);
		},
		sendMessage,
		storage: {
			get: vi.fn().mockResolvedValue("value"),
			set: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			keys: vi.fn().mockResolvedValue(["a"]),
		},
		config: configAccess(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		registerTool: () => () => {},
		registerExtension: () => () => {},
		registerCommand: () => () => {},
	});
	return { lifecycle, context, sendMessage, subscribes, unsubscribed };
}

describe("plugin lifecycle", () => {
	it("starts inactive and rejects capability calls before activation", () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		expect(lifecycle.state).toBe("inactive");
		expect(() => lifecycle.assertActive("发送消息")).toThrow(PluginInactiveError);
	});

	it("allows capability registration during loading, since setup runs then", () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		// setup() 在 loading 阶段执行，必须能订阅事件、登记清理函数。
		expect(lifecycle.state).toBe("loading");
		expect(() => lifecycle.assertActive("订阅事件")).not.toThrow();
		lifecycle.track(() => {});
		expect(lifecycle.disposerCount).toBe(1);
	});

	it("still rejects calls after a failed load", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		await lifecycle.stop("setup 失败");
		lifecycle.fail("boom");
		expect(() => lifecycle.assertActive("发送消息")).toThrow(PluginInactiveError);
	});

	it("increments the generation on every stop so stale work is rejected", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		lifecycle.activate();
		const seen = lifecycle.generation;

		await lifecycle.stop("test");
		expect(lifecycle.state).toBe("inactive");
		expect(lifecycle.generation).toBe(seen + 1);
		// 跨越停用边界的异步任务必须被拒绝，即使它忽略了取消信号。
		expect(() => lifecycle.assertGeneration(seen, "发送消息")).toThrow(PluginInactiveError);
	});

	it("aborts the signal on stop and runs disposers in reverse order", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		const { signal } = lifecycle.begin();
		lifecycle.activate();
		const order: string[] = [];
		lifecycle.track(() => {
			order.push("first");
		});
		lifecycle.track(() => {
			order.push("second");
		});

		const { failures } = await lifecycle.stop("test");

		expect(signal.aborted).toBe(true);
		expect(order).toEqual(["second", "first"]);
		expect(failures).toHaveLength(0);
		expect(lifecycle.disposerCount).toBe(0);
	});

	it("keeps running the remaining disposers when one throws", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		lifecycle.activate();
		const order: string[] = [];
		lifecycle.track(() => {
			order.push("first");
		});
		lifecycle.track(() => {
			throw new Error("boom");
		});

		const { failures } = await lifecycle.stop("test");
		expect(order).toEqual(["first"]);
		expect(failures).toHaveLength(1);
	});

	it("supports a disposer that is withdrawn before stop", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		lifecycle.activate();
		const disposer = vi.fn();
		const untrack = lifecycle.track(disposer);
		untrack();
		await lifecycle.stop("test");
		expect(disposer).not.toHaveBeenCalled();
	});
});

describe("plugin context permissions", () => {
	it("rejects sends without message:send", async () => {
		const { context, sendMessage } = setup([]);
		await expect(context.messages.sendText("bot-1", { scope: "group", targetId: "g-1" }, "hi")).rejects.toThrow(
			PluginInactiveError,
		);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("rejects sends to bots outside the manifest scope", async () => {
		const { context, sendMessage } = setup(["message:send"]);
		await context.messages.sendText("bot-1", { scope: "group", targetId: "g-1" }, "hi");
		expect(sendMessage).toHaveBeenCalledOnce();

		await expect(context.messages.sendText("bot-2", { scope: "group", targetId: "g-1" }, "hi")).rejects.toThrow(
			/未授权操作 Bot/,
		);
	});

	it("allows every bot when the manifest declares *", async () => {
		const lifecycle = createPluginLifecycle("test.plugin");
		lifecycle.begin();
		lifecycle.activate();
		const sendMessage = vi.fn().mockResolvedValue(undefined);
		const context = createPluginContext({
			lifecycle,
			manifestId: "test.plugin",
			botIds: ["*"],
			permissions: new Set<PluginPermission>(["message:send"]),
			subscribePlatformEvent: () => () => {},
			sendMessage,
			storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
			config: configAccess(),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerTool: () => () => {},
			registerExtension: () => () => {},
			registerCommand: () => () => {},
		});
		await context.messages.sendText("bot-9", { scope: "c2c", targetId: "u-1" }, "hi");
		expect(sendMessage).toHaveBeenCalledOnce();
	});

	it("rejects subscriptions outside the declared permissions", () => {
		const { context } = setup(["event:platform.group.bot_added"]);
		expect(() => context.events.subscribe("platform.friend.added", () => {})).toThrow(PluginInactiveError);
		expect(() => context.events.subscribe("platform.group.bot_added", () => {})).not.toThrow();
	});

	it("grants every event type with event:*", () => {
		const { context } = setup(["event:*"]);
		expect(() => context.events.subscribe("platform.friend.added", () => {})).not.toThrow();
		expect(() => context.events.subscribe("*", () => {})).not.toThrow();
	});

	it("gates storage by direction", async () => {
		const { context } = setup(["storage:read"]);
		await expect(context.storage.get("k")).resolves.toBe("value");
		await expect(context.storage.set("k", 1)).rejects.toThrow(/storage:write/);
		await expect(context.storage.delete("k")).rejects.toThrow(/storage:write/);
	});

	it("drops dispatch after the plugin stops even if the bus still holds the handler", async () => {
		const { lifecycle, context, subscribes } = setup(["event:platform.friend.added"]);
		const handler = vi.fn();
		context.events.subscribe("platform.friend.added", handler);

		const registered = subscribes[0];
		expect(registered).toBeDefined();
		// botId 必须落在 manifest 授权的范围内，否则会被 Bot 范围过滤挡掉。
		await registered?.handler({ botId: "bot-1" } as never, new AbortController().signal);
		expect(handler).toHaveBeenCalledOnce();

		await lifecycle.stop("test");
		await registered?.handler({ botId: "bot-1" } as never, new AbortController().signal);
		// 关键：总线里残留的包装必须自我屏蔽，不能把事件继续交给已停用的插件。
		expect(handler).toHaveBeenCalledOnce();
	});

	it("filters events from bots outside the manifest scope", async () => {
		const { context, subscribes } = setup(["event:*"]);
		const handler = vi.fn();
		context.events.subscribe("message.received", handler);

		const registered = subscribes[0];
		await registered?.handler({ botId: "bot-2" } as never, new AbortController().signal);
		// 声明只服务 bot-1 的插件不该看到 bot-2 的消息正文与群 OpenID。
		expect(handler).not.toHaveBeenCalled();

		await registered?.handler({ botId: "bot-1" } as never, new AbortController().signal);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("passes the self-origin flag through to the host", () => {
		const { context, subscribes } = setup(["event:*"]);
		context.events.subscribe("message.sent", () => {});
		context.events.subscribeIncludingSelfOrigin("message.sent", () => {});

		expect(subscribes[0]).toMatchObject({ ownerId: "test.plugin", type: "message.sent" });
		expect(subscribes).toHaveLength(2);
	});

	it("rejects sends after the plugin stops", async () => {
		const { lifecycle, context, sendMessage } = setup(["message:send"]);
		await lifecycle.stop("test");
		await expect(context.messages.sendText("bot-1", { scope: "group", targetId: "g-1" }, "hi")).rejects.toThrow(
			PluginInactiveError,
		);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("rejects sends from a stale context after the plugin is restarted", async () => {
		const { lifecycle, context, sendMessage } = setup(["message:send"]);
		const staleContext = context;

		// 模拟「停用 → 重新启用」：新实例处于 active，代次已递增。
		await lifecycle.stop("测试重启");
		lifecycle.begin();
		lifecycle.activate();
		expect(lifecycle.state).toBe("active");

		// 关键：旧实例的 Handler 跨越 await 后恢复执行，此时新实例是 active。
		// 只检查「当前是否 active」会放行，必须比较代次才能拒绝。
		await expect(staleContext.messages.sendText("bot-1", { scope: "group", targetId: "g-1" }, "hi")).rejects.toThrow(
			PluginInactiveError,
		);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("rejects storage access from a stale context after restart", async () => {
		const { lifecycle, context } = setup(["storage:read", "storage:write"]);
		const staleContext = context;

		await lifecycle.stop("测试重启");
		lifecycle.begin();
		lifecycle.activate();

		await expect(staleContext.storage.get("k")).rejects.toThrow(PluginInactiveError);
		await expect(staleContext.storage.set("k", 1)).rejects.toThrow(PluginInactiveError);
		await expect(staleContext.storage.keys()).rejects.toThrow(PluginInactiveError);
	});

	it("keeps the stale view of signal and generation", async () => {
		const { lifecycle, context } = setup(["event:*"]);
		const staleSignal = context.signal;
		expect(context.generation).toBe(0);

		await lifecycle.stop("测试重启");
		lifecycle.begin();
		lifecycle.activate();

		// 旧 Context 必须继续报告自己那一代，且信号保持 aborted，
		// 不能因为新实例启用而"复活"。
		expect(context.generation).toBe(0);
		expect(staleSignal.aborted).toBe(true);
		expect(lifecycle.generation).toBe(1);
	});

	it("rejects assertActive and onDispose from a stale context", async () => {
		const { lifecycle, context } = setup([]);
		const staleContext = context;

		await lifecycle.stop("测试重启");
		lifecycle.begin();
		lifecycle.activate();

		expect(() => staleContext.assertActive("处理事件")).toThrow(PluginInactiveError);
		expect(() => staleContext.onDispose(() => {})).toThrow(PluginInactiveError);
	});

	it("does not deliver events to a stale subscription after restart", async () => {
		const { lifecycle, context, subscribes } = setup(["event:*"]);
		const handler = vi.fn();
		context.events.subscribe("message.received", handler);
		const staleWrapper = subscribes[0];

		await lifecycle.stop("测试重启");
		lifecycle.begin();
		lifecycle.activate();

		// 旧包装仍被总线持有：即使新实例已启用，也不能把事件投递给旧代次。
		await staleWrapper?.handler({ botId: "bot-1" } as never, new AbortController().signal);
		expect(handler).not.toHaveBeenCalled();
	});

	it("unsubscribes tracked event handlers when the plugin stops", async () => {
		const { lifecycle, context, unsubscribed } = setup(["event:*"]);
		context.events.subscribe("platform.raw", () => {});
		await lifecycle.stop("test");
		expect(unsubscribed).toEqual(["platform.raw"]);
	});
});
