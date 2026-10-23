import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPlatformEvent, PlatformEventHandler } from "@miubot/shared/platform/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilePluginConfig } from "../src/host/config.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Harness = {
	pluginsDir: string;
	storageDir: string;
	emit: (event: NormalizedPlatformEvent, signal?: AbortSignal) => Promise<void>;
	sendMessage: ReturnType<typeof vi.fn>;
	listenerCount: () => number;
	deps: PluginHostDependencies;
};

/** 组装一个只含最小依赖的宿主，事件源用手写分发器代替真实总线。 */
async function harness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "miubot-host-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	const storageDir = join(root, "storage");
	const configDir = join(root, "config");
	await mkdir(pluginsDir, { recursive: true });

	const handlers = new Map<string, Set<PlatformEventHandler>>();
	const sendMessage = vi.fn().mockResolvedValue(undefined);
	const deps: PluginHostDependencies = {
		pluginsDir,
		eventSource: {
			subscribe(type, handler) {
				const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
				set.add(handler);
				handlers.set(type, set);
				return () => {
					set.delete(handler);
					if (set.size === 0) handlers.delete(type);
				};
			},
		},
		sendMessage,
		storageFor: (pluginId) => createFileStorage({ root: storageDir, pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: configDir, pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	return {
		pluginsDir,
		storageDir,
		deps,
		sendMessage,
		emit: async (event, signal) => {
			for (const handler of [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])]) {
				await handler(event, signal ?? new AbortController().signal);
			}
		},
		listenerCount: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
	};
}

/** 写一个插件目录：manifest + 入口源码。 */
async function writePlugin(
	pluginsDir: string,
	options: {
		id?: string;
		entry?: string;
		source?: string;
		manifest?: Record<string, unknown>;
		directoryName?: string;
	} = {},
): Promise<string> {
	const id = options.id ?? "test.plugin";
	const directory = join(pluginsDir, options.directoryName ?? id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id,
			name: "Test Plugin",
			version: "0.1.0",
			entry: options.entry ?? "./index.ts",
			permissions: ["event:*", "message:send", "storage:read", "storage:write"],
			...options.manifest,
		}),
		"utf8",
	);
	await writeFile(join(directory, options.entry ?? "index.ts"), options.source ?? defaultSource(id), "utf8");
	return directory;
}

function defaultSource(id: string): string {
	return `
export default {
	id: ${JSON.stringify(id)},
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", async (event) => {
			await ctx.messages.sendText(event.botId, { scope: "group", targetId: event.peerId }, "欢迎");
		});
	},
};
`;
}

function addedEvent(overrides: Partial<NormalizedPlatformEvent> = {}): NormalizedPlatformEvent {
	return {
		eventId: "evt-1",
		type: "platform.group.bot_added",
		platform: "qq",
		botId: "bot-1",
		timestamp: "2026-10-22T00:00:00Z",
		scope: "group",
		peerId: "group-1",
		payload: {},
		...overrides,
	};
}

describe("plugin host", () => {
	it("discovers, starts and lists a plugin written in TypeScript", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);

		const statuses = await host.startAll();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({ id: "test.plugin", state: "active", version: "0.1.0" });
	});

	it("sends a message when the subscribed event fires", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(addedEvent());

		expect(h.sendMessage).toHaveBeenCalledWith(
			"test.plugin",
			"bot-1",
			{ scope: "group", targetId: "group-1" },
			"欢迎",
			undefined,
		);
	});

	it("subscribes to the bus exactly once regardless of plugin count", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, { id: "test.one" });
		await writePlugin(h.pluginsDir, { id: "test.two" });
		const host = createPluginHost(h.deps);
		await host.startAll();

		// 宿主只注册一个 "*" 订阅者，再自行扇出。
		expect(h.listenerCount()).toBe(1);
	});

	it("does not duplicate subscriptions after a restart", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.restart("test.plugin");

		await h.emit(addedEvent());
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("revokes capabilities before running dispose", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		// dispose() 拿不到 setup 的参数，因此在 setup 里把 ctx 存起来。
		globalThis.__disposeCtx = ctx;
		globalThis.__disposeSaw = [];
	},
	async dispose() {
		// 停用顺序的关键断言：dispose 执行时能力必须已经撤销。
		// 若宿主先跑 dispose 再撤销，这两次调用都会成功。
		try {
			await globalThis.__disposeCtx.messages.sendText("bot-1", { scope: "group", targetId: "group-1" }, "清理期发送");
			globalThis.__disposeSaw.push("send-ok");
		} catch (error) {
			globalThis.__disposeSaw.push(error.name);
		}
		try {
			await globalThis.__disposeCtx.storage.set("k", 1);
			globalThis.__disposeSaw.push("storage-ok");
		} catch (error) {
			globalThis.__disposeSaw.push(error.name);
		}
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.stop("test.plugin");

		expect(h.sendMessage).not.toHaveBeenCalled();
		const seen = (globalThis as { __disposeSaw?: string[] }).__disposeSaw;
		expect(seen).toEqual(["PluginInactiveError", "PluginInactiveError"]);
	});

	it("runs plugin dispose when stopped", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		globalThis.__disposeCalls = 0;
		ctx.onDispose(() => {
			globalThis.__disposeCalls += 1;
		});
	},
	async dispose() {
		globalThis.__disposeCalls += 1;
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.stop("test.plugin");

		// onDispose 登记与 manifest 的 dispose 都应执行。
		expect((globalThis as { __disposeCalls?: number }).__disposeCalls).toBe(2);
	});

	it("serializes concurrent start calls for the same plugin", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	async setup() {
		globalThis.__setups = (globalThis.__setups ?? 0) + 1;
		await new Promise((resolve) => setTimeout(resolve, 20));
	},
};
`,
		});
		(globalThis as { __setups?: number }).__setups = 0;
		const host = createPluginHost(h.deps);
		await host.discover();

		// 管理界面连点「启用」：并发调用不能让 setup 重复执行。
		await Promise.all([host.start("test.plugin"), host.start("test.plugin"), host.start("test.plugin")]);

		expect((globalThis as { __setups?: number }).__setups).toBe(1);
		expect(host.get("test.plugin")?.state).toBe("active");
	});

	it("serializes start and stop without interleaving", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	async setup() {
		await new Promise((resolve) => setTimeout(resolve, 10));
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		// 同时发起停止与重启：若交错执行，最终状态不确定。
		await Promise.all([host.stop("test.plugin"), host.restart("test.plugin")]);
		const state = host.get("test.plugin")?.state;
		expect(["active", "inactive"]).toContain(state);
	});

	it("times out a setup that never settles", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup() {
		return new Promise(() => {});
	},
};
`,
		});
		const host = createPluginHost({ ...h.deps, setupTimeoutMs: 30 });
		const statuses = await host.startAll();

		// 插件初始化一直挂起时不能阻塞启动流程。
		const status = statuses.find((item) => item.id === "test.plugin");
		expect(status?.state).not.toBe("active");
		expect(status?.error).toContain("超时");
	});

	it("unsubscribes from the bus once every plugin is stopped", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();
		expect(h.listenerCount()).toBeGreaterThan(0);

		await host.stopAll();
		expect(h.listenerCount()).toBe(0);
	});

	it("stops delivering after the plugin is disabled", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.stop("test.plugin");

		await h.emit(addedEvent());
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(host.get("test.plugin")?.state).toBe("inactive");
	});

	it("keeps other plugins working when one handler throws", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			id: "test.broken",
			source: `
export default {
	id: "test.broken",
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", () => {
			throw new Error("boom");
		});
	},
};
`,
		});
		await writePlugin(h.pluginsDir, { id: "test.healthy" });
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(addedEvent());

		expect(h.sendMessage).toHaveBeenCalledOnce();
		expect(h.deps.logger.error).toHaveBeenCalled();
	});

	it("rejects a plugin whose entry id disagrees with the manifest", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			id: "test.plugin",
			source: `export default { id: "other.id", setup() {} };`,
		});
		const host = createPluginHost(h.deps);
		const statuses = await host.startAll();

		expect(statuses[0]).toMatchObject({ id: "test.plugin", state: "failed" });
		expect(statuses[0]?.error).toContain("不一致");
	});

	it("records setup failures without throwing", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `export default { id: "test.plugin", setup() { throw new Error("setup exploded"); } };`,
		});
		const host = createPluginHost(h.deps);
		const statuses = await host.startAll();

		expect(statuses[0]).toMatchObject({ state: "failed" });
		expect(statuses[0]?.error).toContain("setup exploded");
	});

	it("scans several plugin roots and lets the first one win", async () => {
		const h = await harness();
		const secondRoot = join(h.pluginsDir, "..", "plugins-second");
		await mkdir(secondRoot, { recursive: true });
		await writePlugin(h.pluginsDir, { id: "test.builtin", directoryName: "builtin" });
		await writePlugin(secondRoot, { id: "test.user", directoryName: "user" });
		// 同名插件放在第二个根里，应被第一个根里的定义压过。
		await writePlugin(secondRoot, { id: "test.builtin", directoryName: "shadowed" });

		const host = createPluginHost({ ...h.deps, pluginsDir: [h.pluginsDir, secondRoot] });
		const statuses = await host.startAll();

		const loaded = statuses.filter((status) => !status.id.startsWith("duplicate:"));
		expect(loaded.map((status) => status.id).sort()).toEqual(["test.builtin", "test.user"]);
		// 先扫描到的目录获胜，且冲突被显式记录而不是静默吞掉。
		expect(statuses.find((status) => status.id === "test.builtin")?.state).toBe("active");
		expect(statuses.some((status) => status.id.startsWith("duplicate:") && status.error?.includes("重复"))).toBe(
			true,
		);
	});

	it("skips a missing plugin root without failing discovery", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost({ ...h.deps, pluginsDir: [join(h.pluginsDir, "nope"), h.pluginsDir] });

		const statuses = await host.startAll();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.state).toBe("active");
	});

	it("starts only allowlisted plugins when a list is given", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, { id: "test.one" });
		await writePlugin(h.pluginsDir, { id: "test.two" });
		const host = createPluginHost(h.deps);

		const statuses = await host.startAll(["test.one"]);
		expect(statuses.find((status) => status.id === "test.one")?.state).toBe("active");
		expect(statuses.find((status) => status.id === "test.two")?.state).toBe("inactive");
	});

	it("reports broken directories instead of silently skipping them", async () => {
		const h = await harness();
		await mkdir(join(h.pluginsDir, "broken"), { recursive: true });
		await writeFile(join(h.pluginsDir, "broken", "miubot.plugin.json"), "{ nope", "utf8");
		const host = createPluginHost(h.deps);

		const statuses = await host.startAll();
		expect(statuses.some((status) => status.id === "invalid:broken")).toBe(true);
	});

	it("awaits plugin handlers before resolving the dispatch", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", async (event) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await ctx.messages.sendText(event.botId, { scope: "group", targetId: event.peerId }, "慢回复");
		});
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		// 分发必须等插件处理完，否则事件总线的超时与取消契约在宿主层被架空。
		await h.emit(addedEvent());
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("delivers the bus signal to plugin handlers", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", async (_event, signal) => {
			await ctx.storage.set("signalAborted", signal.aborted);
		});
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		const controller = new AbortController();
		controller.abort(new Error("timeout"));
		await h.emit(addedEvent(), controller.signal);

		const storage = createFileStorage({ root: h.storageDir, pluginId: "test.plugin" });
		await expect(storage.get("signalAborted")).resolves.toBe(true);
	});

	it("does not echo a plugin's own sends back to itself", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribe("message.sent", async (event) => {
			// 若收不到自身事件，这里永远不会被触发，循环就断开了。
			await ctx.messages.sendText(event.botId, { scope: "group", targetId: "group-1" }, "回音");
		});
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(
			addedEvent({
				type: "message.sent",
				origin: "plugin",
				originPluginId: "test.plugin",
				payload: { kind: "text" },
			}),
		);
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("still delivers other plugins' sends", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			id: "test.observer",
			source: `
export default {
	id: "test.observer",
	setup(ctx) {
		ctx.events.subscribe("message.sent", async (event) => {
			await ctx.storage.set("sawSent", event.originPluginId ?? "none");
		});
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(addedEvent({ type: "message.sent", origin: "plugin", originPluginId: "someone.else", payload: {} }));

		const storage = createFileStorage({ root: h.storageDir, pluginId: "test.observer" });
		await expect(storage.get("sawSent")).resolves.toBe("someone.else");
	});

	it("delivers own sends when the plugin opts in", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribeIncludingSelfOrigin("message.sent", async (event) => {
			await ctx.storage.set("selfSeen", event.payload.kind ?? "?");
		});
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(
			addedEvent({
				type: "message.sent",
				origin: "plugin",
				originPluginId: "test.plugin",
				payload: { kind: "text" },
			}),
		);

		const storage = createFileStorage({ root: h.storageDir, pluginId: "test.plugin" });
		await expect(storage.get("selfSeen")).resolves.toBe("text");
	});

	it("refuses sends beyond the per-target rate limit", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", async (event) => {
			const results = [];
			for (let i = 0; i < 5; i += 1) {
				try {
					await ctx.messages.sendText(event.botId, { scope: "group", targetId: event.peerId }, "x");
					results.push("ok");
				} catch (error) {
					results.push(error.name);
				}
			}
			await ctx.storage.set("results", results);
		});
	},
};
`,
		});
		const host = createPluginHost({ ...h.deps, sendRateLimit: { maxSends: 2, windowMs: 60_000 } });
		await host.startAll();

		await h.emit(addedEvent());

		// 限流在出站层拒绝：真实发送只有 2 次，其余被 PluginRateLimitedError 挡下。
		expect(h.sendMessage).toHaveBeenCalledTimes(2);
		const storage = createFileStorage({ root: h.storageDir, pluginId: "test.plugin" });
		await expect(storage.get("results")).resolves.toEqual([
			"ok",
			"ok",
			"PluginRateLimitedError",
			"PluginRateLimitedError",
			"PluginRateLimitedError",
		]);
	});

	it("counts rate limits per target so other groups are unaffected", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	setup(ctx) {
		ctx.events.subscribe("platform.group.bot_added", async (event) => {
			await ctx.messages.sendText(event.botId, { scope: "group", targetId: event.peerId }, "a");
		});
	},
};
`,
		});
		const host = createPluginHost({ ...h.deps, sendRateLimit: { maxSends: 1, windowMs: 60_000 } });
		await host.startAll();

		await h.emit(addedEvent({ eventId: "e-1", peerId: "group-1" }));
		await h.emit(addedEvent({ eventId: "e-2", peerId: "group-1" }));
		await h.emit(addedEvent({ eventId: "e-3", peerId: "group-2" }));

		// group-1 第二次被限流，group-2 不受影响。
		expect(h.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("resets the rate limit budget when the plugin restarts", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost({ ...h.deps, sendRateLimit: { maxSends: 1, windowMs: 60_000 } });
		await host.startAll();

		await h.emit(addedEvent({ eventId: "e-1" }));
		await h.emit(addedEvent({ eventId: "e-2" }));
		expect(h.sendMessage).toHaveBeenCalledOnce();

		await host.restart("test.plugin");
		await h.emit(addedEvent({ eventId: "e-3" }));
		expect(h.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("deduplicates only events that carry a stable dedupKey", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(addedEvent({ dedupKey: "stable-1" }));
		await h.emit(addedEvent({ dedupKey: "stable-1" }));
		expect(h.sendMessage).toHaveBeenCalledOnce();

		// 没有 dedupKey 的事件不强制去重：宁可重复进入插件，也不静默丢弃。
		await h.emit(addedEvent({ eventId: "evt-2" }));
		await h.emit(addedEvent({ eventId: "evt-3" }));
		expect(h.sendMessage).toHaveBeenCalledTimes(3);
	});

	it("persists storage per plugin namespace", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir, {
			source: `
export default {
	id: "test.plugin",
	async setup(ctx) {
		await ctx.storage.set("count", 1);
	},
};
`,
		});
		const host = createPluginHost(h.deps);
		await host.startAll();

		const storage = createFileStorage({ root: h.storageDir, pluginId: "test.plugin" });
		await expect(storage.get("count")).resolves.toBe(1);
	});

	it("reports whether any active plugin could handle an event type", async () => {
		const h = await harness();
		await writePlugin(h.pluginsDir);
		const host = createPluginHost(h.deps);
		await host.startAll();

		expect(host.hasActiveHandler("platform.group.bot_added")).toBe(true);
		await host.stop("test.plugin");
		expect(host.hasActiveHandler("platform.group.bot_added")).toBe(false);
	});
});
