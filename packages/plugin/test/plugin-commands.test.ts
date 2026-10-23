import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilePluginConfig } from "../src/host/config.ts";
import { createPluginHost, type PluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** 内置命令名：插件不能占用。 */
const BUILTIN_NAMES = ["new", "compact", "help", "admin"];

async function harness(): Promise<{ host: PluginHost; pluginsDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-cmd-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	await mkdir(pluginsDir, { recursive: true });
	const deps: PluginHostDependencies = {
		pluginsDir,
		eventSource: { subscribe: () => () => undefined },
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: join(root, "config"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		reservedCommandNames: () => BUILTIN_NAMES,
	};
	return { host: createPluginHost(deps), pluginsDir };
}

/** 写一个注册斜杠命令的插件；`body` 直接替换 `setup` 里的内容。 */
async function writeCommandPlugin(
	pluginsDir: string,
	options: { id: string; permissions?: string[]; bots?: string[]; body?: string },
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
			permissions: options.permissions ?? ["command:register"],
			...(options.bots ? { bots: options.bots } : {}),
		}),
		"utf8",
	);
	await writeFile(
		join(directory, "index.ts"),
		`export default {
			id: ${JSON.stringify(options.id)},
			setup(ctx) {
				${options.body ?? 'ctx.commands.register({ name: "ping", description: "回一句 pong", permission: "all", run: (c) => "pong " + c.args });'}
			},
		};`,
		"utf8",
	);
}

/** 执行一次命令需要的入站上下文；只有被测字段有值。 */
function invocation(overrides: { name?: string; args?: string; isAdmin?: boolean } = {}) {
	const reply = vi.fn<(text: string) => Promise<void>>(async () => {});
	return {
		invocation: {
			name: overrides.name ?? "ping",
			botId: "bot-1",
			scope: "group" as const,
			peerId: "group-1",
			peerName: "群 group-1",
			senderId: "user-1",
			isAdmin: overrides.isAdmin ?? false,
			args: overrides.args ?? "",
			reply,
		},
		reply,
	};
}

describe("插件注册斜杠命令", () => {
	it("注册后能从宿主取到，并在状态里列出", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.commands" });
		await h.host.discover();
		const status = await h.host.start("test.commands");

		expect(status?.state).toBe("active");
		expect(status?.commands).toEqual(["ping"]);
		expect(h.host.commands.list()).toEqual([
			{ pluginId: "test.commands", name: "ping", description: "回一句 pong", permission: "all" },
		]);
		expect(h.host.commands.find("ping", { botId: "bot-1" })).toMatchObject({
			pluginId: "test.commands",
			name: "ping",
		});
	});

	it("没有 command:register 权限时拒绝注册", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.commands", permissions: ["tool:register"] });
		await h.host.discover();
		const status = await h.host.start("test.commands");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("command:register");
		expect(h.host.commands.list()).toHaveLength(0);
	});

	it("命令名不合法时拒绝注册", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, {
			id: "test.commands",
			body: 'ctx.commands.register({ name: "Bad_Name", description: "x", permission: "all", run: () => "x" });',
		});
		await h.host.discover();
		const status = await h.host.start("test.commands");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("命令名");
	});

	it("没写 permission 时拒绝注册（不猜默认值）", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, {
			id: "test.commands",
			body: 'ctx.commands.register({ name: "ping", description: "x", run: () => "x" });',
		});
		await h.host.discover();
		const status = await h.host.start("test.commands");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("admin 或 all");
	});

	it("不能占用内置命令名", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, {
			id: "test.commands",
			body: 'ctx.commands.register({ name: "new", description: "x", permission: "all", run: () => "x" });',
		});
		await h.host.discover();
		const status = await h.host.start("test.commands");

		expect(status?.state).toBe("failed");
		expect(status?.error).toContain("内置命令");
	});

	it("两个插件不能用同一个命令名", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.a" });
		await writeCommandPlugin(h.pluginsDir, { id: "test.b" });
		await h.host.discover();
		await h.host.start("test.a");
		const second = await h.host.start("test.b");

		expect(second?.state).toBe("failed");
		expect(second?.error).toContain("已被插件 test.a 占用");
	});

	it("按 manifest 的 bots 过滤", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.commands", bots: ["bot-2"] });
		await h.host.discover();
		await h.host.start("test.commands");

		expect(h.host.commands.find("ping", { botId: "bot-2" })).toBeDefined();
		expect(h.host.commands.find("ping", { botId: "bot-1" })).toBeUndefined();
	});

	it("返回值等价于 reply，并把入站上下文交给插件", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.commands" });
		await h.host.discover();
		await h.host.start("test.commands");

		const { invocation: input, reply } = invocation({ args: "now" });
		await h.host.commands.run(input);

		expect(reply).toHaveBeenCalledWith("pong now");
	});

	it("停用后既查不到也执行不了", async () => {
		const h = await harness();
		await writeCommandPlugin(h.pluginsDir, { id: "test.commands" });
		await h.host.discover();
		await h.host.start("test.commands");
		await h.host.stop("test.commands");

		expect(h.host.commands.find("ping", { botId: "bot-1" })).toBeUndefined();
		expect(h.host.get("test.commands")?.commands).toEqual([]);
		const { invocation: input } = invocation();
		// 停用会摘掉登记（`removeOwner`），所以这里报「未注册」；即便登记还在，
		// 执行入口的代次复核也会拒绝。
		await expect(h.host.commands.run(input)).rejects.toThrow(/未注册|已停用/);
	});
});
