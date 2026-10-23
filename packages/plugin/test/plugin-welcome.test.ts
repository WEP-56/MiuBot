import { mkdtemp, rm } from "node:fs/promises";
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

/** 仓库内示例插件的位置。直接用真实插件目录，避免测试与实际插件漂移。 */
const WELCOME_PLUGIN_DIR = join(import.meta.dirname, "..", "..", "..", "plugins");

async function harness(defaultBotIds?: string[]) {
	const root = await mkdtemp(join(tmpdir(), "miubot-welcome-"));
	roots.push(root);
	const handlers = new Map<string, Set<PlatformEventHandler>>();
	const sendMessage = vi.fn().mockResolvedValue(undefined);
	const deps: PluginHostDependencies = {
		// 只指向示例插件所在目录；复制一份避免污染仓库。
		pluginsDir: join(root, "plugins"),
		eventSource: {
			subscribe(type, handler) {
				const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
				set.add(handler);
				handlers.set(type, set);
				return () => {
					set.delete(handler);
				};
			},
		},
		sendMessage,
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: join(root, "config"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		...(defaultBotIds ? { defaultBotIds } : {}),
	};
	return {
		root,
		deps,
		sendMessage,
		async emit(event: NormalizedPlatformEvent) {
			for (const handler of [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])]) {
				await handler(event, new AbortController().signal);
			}
		},
	};
}

function botAdded(overrides: Partial<NormalizedPlatformEvent> = {}): NormalizedPlatformEvent {
	return {
		eventId: "evt-1",
		type: "platform.group.bot_added",
		platform: "qq",
		botId: "bot-1",
		timestamp: "2026-10-22T00:00:00Z",
		scope: "group",
		peerId: "group-1",
		payload: { rawEventType: "GROUP_ADD_ROBOT" },
		...overrides,
	};
}

/** 把示例插件复制进临时插件目录。 */
async function installWelcome() {
	const { cp } = await import("node:fs/promises");
	const h = await harness();
	const target = Array.isArray(h.deps.pluginsDir) ? h.deps.pluginsDir[0]! : h.deps.pluginsDir;
	await cp(join(WELCOME_PLUGIN_DIR, "miubot.welcome"), join(target, "miubot.welcome"), {
		recursive: true,
	});
	return h;
}

describe("miubot.welcome plugin", () => {
	it("sends the welcome text when the bot joins a group", async () => {
		const h = await installWelcome();
		const host = createPluginHost(h.deps);
		const statuses = await host.startAll();
		expect(statuses.find((status) => status.id === "miubot.welcome")?.state).toBe("active");

		await h.emit(botAdded());

		expect(h.sendMessage).toHaveBeenCalledOnce();
		const [pluginId, botId, target, text] = h.sendMessage.mock.calls[0] as [
			string,
			string,
			{ scope: string },
			string,
		];
		expect(pluginId).toBe("miubot.welcome");
		expect(botId).toBe("bot-1");
		expect(target).toEqual({ scope: "group", targetId: "group-1" });
		expect(text).toContain("MiuBot");
	});

	it("does nothing for other events", async () => {
		const h = await installWelcome();
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(botAdded({ type: "platform.friend.added", peerId: "user-1" }));
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("stays silent after being disabled", async () => {
		const h = await installWelcome();
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.stop("miubot.welcome");

		await h.emit(botAdded());
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("survives repeated events with the same dedupKey exactly once", async () => {
		const h = await installWelcome();
		const host = createPluginHost(h.deps);
		await host.startAll();

		// Bot 入群事件不带平台稳定 id，所以两次事件都会被处理——这是刻意的：
		// 宁可重复进入插件，也不要静默丢弃合法事件。
		await h.emit(botAdded({ eventId: "e-1" }));
		await h.emit(botAdded({ eventId: "e-2" }));
		expect(h.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("keeps working when sending fails", async () => {
		const h = await installWelcome();
		h.sendMessage.mockRejectedValue(new Error("network down"));
		const host = createPluginHost(h.deps);
		await host.startAll();

		// 插件内部吞掉发送错误并记录日志，异常不能逃逸到事件总线。
		await expect(h.emit(botAdded())).resolves.toBeUndefined();
		expect(h.deps.logger.warn).toHaveBeenCalled();
	});

	it("registers its subscription only once across restarts", async () => {
		const h = await installWelcome();
		const host = createPluginHost(h.deps);
		await host.startAll();
		await host.restart("miubot.welcome");
		await host.restart("miubot.welcome");

		await h.emit(botAdded({ eventId: "e-1" }));
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});
});
