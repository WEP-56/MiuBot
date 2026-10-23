import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformEventHandler } from "@miubot/shared/platform/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost, type PluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(): Promise<{ host: PluginHost; pluginsDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-ext-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	const storageDir = join(root, "storage");
	await mkdir(pluginsDir, { recursive: true });
	const handlers = new Map<string, Set<PlatformEventHandler>>();
	const deps: PluginHostDependencies = {
		pluginsDir,
		eventSource: {
			subscribe(type, handler) {
				const set = handlers.get(type) ?? new Set<PlatformEventHandler>();
				set.add(handler);
				handlers.set(type, set);
				return () => set.delete(handler);
			},
		},
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: storageDir, pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	return { host: createPluginHost(deps), pluginsDir };
}

/** 写一个注册对话钩子的插件。`setup` 直接用真实 ctx 调 `ctx.extensions.register`。 */
async function writeExtensionPlugin(
	pluginsDir: string,
	options: {
		id: string;
		permissions?: string[];
		name?: string;
		body?: string;
		bots?: string[];
	},
): Promise<void> {
	const directory = join(pluginsDir, options.id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: options.id,
			name: options.id,
			version: "0.1.0",
			entry: "./index.ts",
			permissions: options.permissions ?? ["extension:register"],
			...(options.bots ? { bots: options.bots } : {}),
		}),
		"utf8",
	);
	await writeFile(
		join(directory, "index.ts"),
		`export default {
			id: ${JSON.stringify(options.id)},
			setup(ctx) {
				ctx.extensions.register({
					name: ${JSON.stringify(options.name ?? "hooks")},
					factory(pi) { ${options.body ?? ""} },
				});
			},
		};`,
		"utf8",
	);
}

/** 只实现被测代码用到的方法，其余能力不参与断言。 */
function fakeApi(overrides: Record<string, unknown> = {}) {
	return {
		on: vi.fn(() => () => undefined),
		registerTool: vi.fn(),
		...overrides,
	} as never;
}

describe("插件注册对话钩子", () => {
	it("注册后能取到工厂，路径为 plugin:{id}/{name}", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.hooks", name: "prompt" });
		await h.host.discover();
		const status = await h.host.start("test.hooks");

		expect(status?.state).toBe("active");
		expect(status?.extensions).toEqual(["prompt"]);
		const entries = h.host.extensions.factoriesFor({ botId: "bot-1" });
		expect(entries.map((entry) => entry.name)).toEqual(["plugin:test.hooks/prompt"]);
		expect(typeof entries[0]?.factory).toBe("function");
	});

	it("没有 extension:register 权限时拒绝注册", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.hooks", permissions: ["tool:register"] });
		await h.host.discover();
		const status = await h.host.start("test.hooks");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("extension:register");
		expect(h.host.extensions.factoriesFor({ botId: "bot-1" })).toHaveLength(0);
	});

	it("扩展名不合法时拒绝注册", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.hooks", name: "Bad_Name" });
		const status = await (async () => {
			await h.host.discover();
			return h.host.start("test.hooks");
		})();

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("扩展名");
	});

	it("同一插件内扩展重名会失败", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, {
			id: "test.hooks",
			name: "dup",
			body: 'ctx.extensions?.register?.({ name: "dup", factory() {} });',
		});
		// 第二次注册用同一名字：第二次必须失败，插件整体失败。
		await writeFile(
			join(h.pluginsDir, "test.hooks", "index.ts"),
			`export default {
				id: "test.hooks",
				setup(ctx) {
					ctx.extensions.register({ name: "dup", factory() {} });
					ctx.extensions.register({ name: "dup", factory() {} });
				},
			};`,
			"utf8",
		);
		await h.host.discover();
		const status = await h.host.start("test.hooks");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("已被占用");
	});

	it("不同插件可以用同名扩展，路径各自独立", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.a", name: "hooks" });
		await writeExtensionPlugin(h.pluginsDir, { id: "test.b", name: "hooks" });
		await h.host.discover();
		await h.host.start("test.a");
		await h.host.start("test.b");

		expect(
			h.host.extensions
				.factoriesFor({ botId: "bot-1" })
				.map((entry) => entry.name)
				.sort(),
		).toEqual(["plugin:test.a/hooks", "plugin:test.b/hooks"]);
	});

	it("停用后工厂不再下发", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.hooks" });
		await h.host.discover();
		await h.host.start("test.hooks");
		await h.host.stop("test.hooks");

		expect(h.host.extensions.factoriesFor({ botId: "bot-1" })).toHaveLength(0);
		expect(h.host.get("test.hooks")?.extensions).toEqual([]);
	});

	it("按 manifest 的 bots 过滤", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, { id: "test.hooks", bots: ["bot-2"] });
		await h.host.discover();
		await h.host.start("test.hooks");

		expect(h.host.extensions.factoriesFor({ botId: "bot-2" })).toHaveLength(1);
		expect(h.host.extensions.factoriesFor({ botId: "bot-1" })).toHaveLength(0);
	});

	it("工厂拿到的是真实 pi：钩子能注册", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, {
			id: "test.hooks",
			body: 'pi.on("before_agent_start", () => undefined);',
		});
		await h.host.discover();
		await h.host.start("test.hooks");

		const [entry] = h.host.extensions.factoriesFor({ botId: "bot-1" });
		const api = fakeApi();
		await entry?.factory(api);
		expect((api as { on: ReturnType<typeof vi.fn> }).on).toHaveBeenCalledWith(
			"before_agent_start",
			expect.any(Function),
		);
	});

	it("桥接的 pi 不允许注册工具，必须走 ctx.tools.register()", async () => {
		const h = await harness();
		await writeExtensionPlugin(h.pluginsDir, {
			id: "test.hooks",
			body: 'pi.registerTool({ name: "sneaky", label: "x", description: "x", parameters: {}, execute() {} });',
		});
		await h.host.discover();
		await h.host.start("test.hooks");

		const [entry] = h.host.extensions.factoriesFor({ botId: "bot-1" });
		const api = fakeApi();
		// 工厂是同步的，守卫直接抛；异步工厂则由加载器捕获成 reject。
		expect(() => entry!.factory(api)).toThrow("不能注册工具");
		// 守卫拦在调用真实 API 之前，底层 API 不该被触达。
		expect((api as { registerTool: ReturnType<typeof vi.fn> }).registerTool).not.toHaveBeenCalled();
	});
});
