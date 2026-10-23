import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedPlatformEvent, PlatformEventHandler } from "@miubot/shared/platform/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactAgainstDefaults,
	configuredSecretKeys,
	createFilePluginConfig,
	createPluginConfigAccess,
	type PluginConfigSchema,
	resolveConfigValues,
	validateConfigSchema,
	validateConfigValues,
} from "../src/host/config.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { validateManifest } from "../src/host/manifest.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SCHEMA: PluginConfigSchema = {
	type: "object",
	properties: {
		greeting: { type: "string", default: "默认问候", minLength: 1, maxLength: 10 },
		retries: { type: "integer", default: 3, minimum: 0, maximum: 9 },
		loud: { type: "boolean", default: false },
		mode: { type: "string", enum: ["fast", "safe"] },
		apiKey: { type: "string", secret: true },
	},
	required: ["greeting"],
};

describe("config schema validation", () => {
	it("accepts a flat scalar schema", () => {
		const result = validateConfigSchema(SCHEMA);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.keys(result.schema.properties)).toEqual(["greeting", "retries", "loud", "mode", "apiKey"]);
		expect(result.schema.required).toEqual(["greeting"]);
	});

	it("rejects nested objects and arrays by refusing a non-scalar type", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { nested: { type: "object", properties: { a: { type: "string" } } } },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.nested.type" }));
	});

	it("rejects a required key that is not declared", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { a: { type: "string" } },
			required: ["b"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.required[0]" }));
	});

	it("rejects secret on a non-string field", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { count: { type: "integer", secret: true } },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.count.secret" }));
	});

	it("rejects a default that contradicts the declared type", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { retries: { type: "integer", default: "many" } },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.retries.default" }));
	});

	it("rejects an enum whose members do not match the field type", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { mode: { type: "string", enum: ["a", 2] } },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.mode.enum[1]" }));
	});

	it("rejects length bounds on non-string fields", () => {
		const result = validateConfigSchema({
			type: "object",
			properties: { retries: { type: "integer", maxLength: 3 } },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.retries.maxLength" }));
	});
});

describe("config value resolution", () => {
	it("fills defaults and keeps stored values", () => {
		const { values } = resolveConfigValues(SCHEMA, { greeting: "自定义", mode: "fast" });
		expect(values).toEqual({ greeting: "自定义", mode: "fast", retries: 3, loud: false });
	});

	it("falls back to defaults for values that no longer match the schema", () => {
		// 插件改了字段类型、或文件被手工改坏，都不能让插件拿到非法值。
		const { values, invalidKeys } = resolveConfigValues(SCHEMA, { retries: "3", greeting: "ok" });
		expect(values.retries).toBe(3);
		expect(invalidKeys).toEqual(["retries"]);
	});

	it("reports keys the schema no longer declares instead of silently dropping them", () => {
		const { values, ignoredKeys } = resolveConfigValues(SCHEMA, { legacy: "x", greeting: "ok" });
		expect(values).not.toHaveProperty("legacy");
		expect(ignoredKeys).toEqual(["legacy"]);
	});

	it("treats everything as undeclared when the plugin has no config schema", () => {
		const { values, ignoredKeys } = resolveConfigValues(undefined, { a: 1 });
		expect(values).toEqual({});
		expect(ignoredKeys).toEqual(["a"]);
	});
});

describe("config value validation", () => {
	it("accepts a complete submission", () => {
		const result = validateConfigValues(SCHEMA, { greeting: "hi", retries: 1, loud: true, mode: "safe" });
		expect(result).toEqual({ ok: true, values: { greeting: "hi", retries: 1, loud: true, mode: "safe" } });
	});

	it("applies defaults for omitted optional fields", () => {
		const result = validateConfigValues(SCHEMA, { greeting: "hi" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.values).toEqual({ greeting: "hi", retries: 3, loud: false });
	});

	it("reports the exact field for every kind of violation", () => {
		const result = validateConfigValues(SCHEMA, {
			greeting: "0123456789abc",
			retries: 2.5,
			loud: "yes",
			mode: "slow",
			typo: 1,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const fields = result.issues.map((issue) => issue.field).sort();
		expect(fields).toEqual(["greeting", "loud", "mode", "retries", "typo"]);
	});

	it("rejects an empty required field without a default", () => {
		const schema: PluginConfigSchema = {
			type: "object",
			properties: { token: { type: "string" } },
			required: ["token"],
		};
		const result = validateConfigValues(schema, {});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "token" }));
	});

	it("does not treat a missing required field with a default as an error", () => {
		const schema: PluginConfigSchema = {
			type: "object",
			properties: { token: { type: "string", default: "preset" } },
			required: ["token"],
		};
		const result = validateConfigValues(schema, {});
		expect(result).toEqual({ ok: true, values: { token: "preset" } });
	});
});

describe("config compaction", () => {
	it("drops keys equal to their default so schema default changes reach users", () => {
		const compacted = compactAgainstDefaults(SCHEMA, {
			greeting: "默认问候",
			retries: 5,
			loud: false,
			mode: "fast",
		});
		expect(compacted).toEqual({ retries: 5, mode: "fast" });
	});

	it("lists configured secrets without exposing their values", () => {
		expect(configuredSecretKeys(SCHEMA, { apiKey: "sk-1" })).toEqual(["apiKey"]);
		expect(configuredSecretKeys(SCHEMA, { apiKey: "" })).toEqual([]);
		expect(configuredSecretKeys(undefined, { apiKey: "sk-1" })).toEqual([]);
	});
});

describe("config access", () => {
	it("merges defaults on every read so later writes are visible", async () => {
		let stored: Record<string, unknown> = {};
		const access = createPluginConfigAccess({ schema: SCHEMA, read: async () => stored });
		await expect(access.all()).resolves.toMatchObject({ greeting: "默认问候" });
		stored = { greeting: "改过了" };
		await expect(access.get<string>("greeting")).resolves.toBe("改过了");
	});
});

/** 一个把配置值发出去的插件：用来验证「配置真的传到了插件里」，而不只是写进了文件。 */
async function writeConfigPlugin(pluginsDir: string, configSchema: unknown): Promise<void> {
	const directory = join(pluginsDir, "test.config");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "test.config",
			name: "配置测试",
			version: "0.1.0",
			entry: "./index.ts",
			permissions: ["event:platform.friend.added", "message:send"],
			config: configSchema,
		}),
		"utf8",
	);
	await writeFile(
		join(directory, "index.ts"),
		`export default {
	id: "test.config",
	async setup(ctx) {
		ctx.events.subscribe("platform.friend.added", async (event) => {
			// 每次读盘而不是在 setup 里缓存：配置改动后插件会被重启，但这条路径要能独立验证。
			const text = await ctx.config.get("greeting");
			await ctx.messages.sendText(event.botId, { scope: "c2c", targetId: "u-1" }, String(text));
		});
	},
};
`,
		"utf8",
	);
}

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "miubot-plugin-config-"));
	roots.push(root);
	const pluginsDir = join(root, "plugins");
	await mkdir(pluginsDir, { recursive: true });
	const configDir = join(root, "config");
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
				};
			},
		},
		sendMessage,
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: configDir, pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	return {
		configDir,
		sendMessage,
		deps,
		async emit(event: NormalizedPlatformEvent) {
			for (const handler of [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])]) {
				await handler(event, new AbortController().signal);
			}
		},
	};
}

function friendAdded(): NormalizedPlatformEvent {
	return {
		eventId: "evt-1",
		type: "platform.friend.added",
		platform: "qq",
		botId: "bot-1",
		timestamp: "2026-10-23T00:00:00Z",
		scope: "c2c",
		peerId: "u-1",
		payload: {},
	};
}

describe("plugin config end to end", () => {
	it("exposes the manifest declaration on the plugin status", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, SCHEMA);
		const host = createPluginHost(h.deps);
		await host.startAll();
		expect(host.get("test.config")?.hasConfig).toBe(true);
	});

	it("delivers the configured value to the plugin after a save + reload", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, SCHEMA);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await h.emit(friendAdded());
		expect(h.sendMessage.mock.calls[0]?.[3]).toBe("默认问候");

		const saved = await host.config.save("test.config", { greeting: "来自表单" });
		expect(saved.ok).toBe(true);
		await host.reload("test.config");

		await h.emit({ ...friendAdded(), eventId: "evt-2" });
		expect(h.sendMessage.mock.calls[1]?.[3]).toBe("来自表单");
	});

	it("persists only non-default values", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, SCHEMA);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await host.config.save("test.config", { greeting: "改过", retries: 3 });
		const stored = await createFilePluginConfig({ root: h.configDir, pluginId: "test.config" }).read();
		// retries 与默认值相同，不落盘：将来插件把默认值调成 5，这个用户应该跟着变。
		expect(stored).toEqual({ greeting: "改过" });
	});

	it("hides secrets on read but keeps them for the plugin", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, SCHEMA);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await host.config.save("test.config", { greeting: "hi", apiKey: "sk-1" });
		const snapshot = await host.config.inspect("test.config");
		expect(snapshot?.values).not.toHaveProperty("apiKey");
		expect(snapshot?.secretKeys).toEqual(["apiKey"]);

		// 留空表示保持原值：表单不会回显密钥，用户只改欢迎语时不能把密钥冲掉。
		await host.config.save("test.config", { greeting: "hi2", apiKey: "" });
		expect((await host.config.inspect("test.config"))?.secretKeys).toEqual(["apiKey"]);

		// 显式 null 才是清除。
		await host.config.save("test.config", { greeting: "hi2", apiKey: null });
		expect((await host.config.inspect("test.config"))?.secretKeys).toEqual([]);
	});

	it("rejects an invalid submission and keeps the previous values", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, SCHEMA);
		const host = createPluginHost(h.deps);
		await host.startAll();

		await host.config.save("test.config", { greeting: "正常" });
		const failed = await host.config.save("test.config", { greeting: "这段问候语显然超过了十个字符" });
		expect(failed.ok).toBe(false);
		expect((await host.config.inspect("test.config"))?.values.greeting).toBe("正常");
	});

	it("refuses to configure a plugin without a schema", async () => {
		const h = await harness();
		await writeConfigPlugin(h.deps.pluginsDir as string, undefined);
		const host = createPluginHost(h.deps);
		await host.startAll();
		expect(host.get("test.config")?.hasConfig).toBe(false);
		const result = await host.config.save("test.config", { anything: 1 });
		expect(result.ok).toBe(false);
	});
});

describe("manifest with config", () => {
	const base = {
		schemaVersion: 1,
		id: "test.config",
		name: "配置测试",
		version: "0.1.0",
		entry: "./index.ts",
	};

	it("carries the parsed schema", () => {
		const result = validateManifest({ ...base, config: SCHEMA }, "plugins/test");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.config?.properties.greeting?.default).toBe("默认问候");
	});

	it("fails the manifest when the schema itself is broken", () => {
		// schema 写错是插件作者的问题，必须让插件加载失败并指出精确字段。
		const result = validateManifest(
			{ ...base, config: { type: "object", properties: { a: { type: "date" } } } },
			"plugins/test",
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "config.properties.a.type" }));
	});
});
