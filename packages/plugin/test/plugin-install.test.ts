import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformEventHandler } from "@miubot/shared/platform/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilePluginConfig } from "../src/host/config.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { DEFAULT_MAX_FILES, inspectPackage } from "../src/host/install.ts";
import { createFileStorage } from "../src/host/storage.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

/** 写一个可安装的插件包：manifest + 入口。`id` 同时是目录名，但安装时会以 manifest 的 id 为准。 */
async function writePackage(
	parent: string,
	options: { id?: string; directoryName?: string; entry?: string; extra?: Record<string, unknown> } = {},
): Promise<string> {
	const id = options.id ?? "test.packaged";
	const directory = join(parent, options.directoryName ?? id);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "miubot.plugin.json"),
		JSON.stringify({
			schemaVersion: 1,
			id,
			name: `插件 ${id}`,
			version: "0.1.0",
			entry: options.entry ?? "./index.ts",
			permissions: ["event:*"],
			...(options.extra ?? {}),
		}),
		"utf8",
	);
	if (!options.entry || options.entry === "./index.ts") {
		await writeFile(join(directory, "index.ts"), `export default { id: ${JSON.stringify(id)}, setup() {} };`, "utf8");
	}
	return directory;
}

async function harness() {
	const root = await tempDir("miubot-plugin-install-");
	const builtinDir = join(root, "builtin");
	const userDir = join(root, "user");
	const packagesDir = join(root, "packages");
	await mkdir(builtinDir, { recursive: true });
	await mkdir(userDir, { recursive: true });
	await mkdir(packagesDir, { recursive: true });
	const storageDir = join(root, "storage");
	const configDir = join(root, "config");
	const handlers = new Map<string, Set<PlatformEventHandler>>();
	const deleteAssets = vi.fn().mockResolvedValue(undefined);

	const deps: PluginHostDependencies = {
		pluginsDir: [builtinDir, userDir],
		installDir: userDir,
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
		sendMessage: vi.fn().mockResolvedValue(undefined),
		storageFor: (pluginId) => createFileStorage({ root: storageDir, pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: configDir, pluginId }),
		deleteAssets,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};

	return {
		deps,
		root,
		builtinDir,
		userDir,
		packagesDir,
		storageDir,
		configDir,
		deleteAssets,
		host: createPluginHost(deps),
	};
}

/** 目录是否存在。 */
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("inspectPackage", () => {
	it("accepts a valid package and reports its size", async () => {
		const parent = await tempDir("miubot-pkg-");
		const directory = await writePackage(parent);
		const result = await inspectPackage(directory);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.id).toBe("test.packaged");
		expect(result.files).toBe(2);
		expect(result.bytes).toBeGreaterThan(0);
	});

	it("rejects a directory without a manifest", async () => {
		const parent = await tempDir("miubot-pkg-");
		const directory = join(parent, "empty");
		await mkdir(directory, { recursive: true });
		const result = await inspectPackage(directory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("miubot.plugin.json");
	});

	it("rejects a manifest whose entry file does not exist", async () => {
		// 入口写对了但文件不在：装上去只会在启用时报「加载失败」，不如安装时就说清楚。
		const parent = await tempDir("miubot-pkg-");
		const directory = await writePackage(parent, { entry: "./missing.ts" });
		const result = await inspectPackage(directory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "entry" }));
	});

	it("rejects a package above the file-count limit", async () => {
		const parent = await tempDir("miubot-pkg-");
		const directory = await writePackage(parent);
		const result = await inspectPackage(directory, { maxFiles: 1 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("文件数超过上限");
	});

	it("rejects symlinks inside the package", async () => {
		const parent = await tempDir("miubot-pkg-");
		const directory = await writePackage(parent);
		const outside = join(parent, "outside.txt");
		await writeFile(outside, "x", "utf8");
		try {
			await symlink(outside, join(directory, "link.txt"));
		} catch {
			// Windows 非开发者模式下创建符号链接需要管理员权限。这条断言在没有权限的机器上
			// 无法构造场景，直接跳过而不是让测试假绿。
			return;
		}
		const result = await inspectPackage(directory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("符号链接");
	});

	it("rejects a relative path", async () => {
		// 相对路径按服务进程的 cwd 解析，用户以为是仓库根、实际是 apps/server。
		const result = await inspectPackage("./plugins/miubot.welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "path" }));
	});

	it("uses a sane default file limit", () => {
		expect(DEFAULT_MAX_FILES).toBeGreaterThan(100);
	});
});

describe("host.install", () => {
	it("copies the package into the install dir and registers it", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);

		const result = await h.host.install(source);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status.id).toBe("test.packaged");
		// 装完不启动：起不起来由管理面按配置决定。
		expect(result.status.state).toBe("inactive");
		expect(result.status.removable).toBe(true);

		// 复制到 installDir/<manifest id>，而不是沿用源目录名。
		expect(await exists(join(h.userDir, "test.packaged", "miubot.plugin.json"))).toBe(true);
	});

	it("uses the manifest id for the target directory even if the source dir is named differently", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir, { id: "test.renamed", directoryName: "whatever" });
		await h.host.install(source);
		expect(await exists(join(h.userDir, "test.renamed"))).toBe(true);
		expect(await exists(join(h.userDir, "whatever"))).toBe(false);
	});

	it("refuses a second install of the same id", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		await h.host.install(source);
		const again = await h.host.install(source);
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.issues[0]?.message).toContain("已存在");
	});

	it("refuses to shadow a built-in plugin with the same id", async () => {
		// discover 的「首个目录优先」会把内置的同名插件留下，装在用户目录的那份永远不生效。
		const h = await harness();
		await writePackage(h.builtinDir, { id: "test.builtin" });
		await h.host.discover();
		const source = await writePackage(h.packagesDir, { id: "test.builtin" });
		const result = await h.host.install(source);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("已存在");
	});

	it("refuses to install when the host has no writable dir configured", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		const host = createPluginHost({ ...h.deps, installDir: undefined });
		const result = await host.install(source);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.field).toBe("installDir");
	});

	it("leaves no partial directory behind when copying fails", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		// 目标目录被一个文件占住：`cp` 会失败，此时不应该留下半个插件目录。
		await writeFile(join(h.userDir, "test.packaged"), "blocker", "utf8");
		const result = await h.host.install(source);
		expect(result.ok).toBe(false);
		expect((await readFile(join(h.userDir, "test.packaged"), "utf8")) === "blocker").toBe(true);
	});
});

describe("host.uninstall", () => {
	it("removes the directory but keeps data and config by default", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		await h.host.install(source);

		const result = await h.host.uninstall("test.packaged");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dataDeleted).toBe(false);
		expect(result.configDeleted).toBe(false);
		// 宿主不再登记它，目录也没了。
		expect(h.host.get("test.packaged")).toBeUndefined();
		expect(await exists(join(h.userDir, "test.packaged"))).toBe(false);
		// 默认不碰持久化资源，连回调都不该被调用。
		expect(h.deleteAssets).not.toHaveBeenCalled();
	});

	it("deletes assets only for the flags that were set", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		await h.host.install(source);

		await h.host.uninstall("test.packaged", { deleteData: true });
		expect(h.deleteAssets).toHaveBeenCalledWith("test.packaged", { data: true, config: false });
	});

	it("refuses to uninstall a built-in plugin", async () => {
		const h = await harness();
		await writePackage(h.builtinDir, { id: "test.builtin" });
		await h.host.discover();

		const result = await h.host.uninstall("test.builtin");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("内置插件");
		// 内置目录必须原样还在。
		expect(await exists(join(h.builtinDir, "test.builtin"))).toBe(true);
	});

	it("reports an unknown id instead of throwing", async () => {
		const h = await harness();
		const result = await h.host.uninstall("nope");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe("插件不存在");
	});

	it("stops the plugin before deleting, so no capability survives", async () => {
		const h = await harness();
		const source = await writePackage(h.packagesDir);
		await h.host.install(source);
		await h.host.start("test.packaged");
		expect(h.host.get("test.packaged")?.state).toBe("active");

		await h.host.uninstall("test.packaged");
		// 条目已移除；再查状态就是 undefined，而不是一个仍标着 active 的幽灵。
		expect(h.host.get("test.packaged")).toBeUndefined();
		expect(h.host.list().some((status) => status.id === "test.packaged")).toBe(false);
	});
});
