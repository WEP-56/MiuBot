import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformEventHandler } from "@miubot/shared/platform/events";
import { strToU8, type Zippable, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entriesUnderRoot, findArchiveRoot, readZip } from "../src/archive.ts";
import { createFilePluginConfig } from "../src/host/config.ts";
import { createPluginHost, type PluginHostDependencies } from "../src/host/host.ts";
import { extractPackage } from "../src/host/install.ts";
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

/** 用 fflate 现造一个 ZIP，省掉往仓库里塞二进制夹具。 */
function makeZip(files: Record<string, string>): Uint8Array {
	const tree: Zippable = {};
	for (const [path, content] of Object.entries(files)) tree[path] = strToU8(content);
	return zipSync(tree);
}

function manifestJson(id: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		id,
		name: `插件 ${id}`,
		version: "0.1.0",
		entry: "./index.ts",
		permissions: ["event:*"],
		...overrides,
	});
}

const ENTRY_SOURCE = (id: string): string => `export default { id: ${JSON.stringify(id)}, setup() {} };`;

/** 一个从根目录就能装的包。 */
function flatPluginZip(id: string): Uint8Array {
	return makeZip({
		"miubot.plugin.json": manifestJson(id),
		"index.ts": ENTRY_SOURCE(id),
	});
}

/** 常见打包结果：外面套了一层目录。 */
function nestedPluginZip(id: string, folder = "my-plugin"): Uint8Array {
	return makeZip({
		[`${folder}/miubot.plugin.json`]: manifestJson(id),
		[`${folder}/index.ts`]: ENTRY_SOURCE(id),
		[`${folder}/assets/readme.txt`]: "hello",
	});
}

async function harness() {
	const root = await tempDir("miubot-plugin-zip-");
	const builtinDir = join(root, "builtin");
	const userDir = join(root, "user");
	await mkdir(builtinDir, { recursive: true });
	await mkdir(userDir, { recursive: true });
	const handlers = new Map<string, Set<PlatformEventHandler>>();
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
		storageFor: (pluginId) => createFileStorage({ root: join(root, "storage"), pluginId }),
		configFor: (pluginId) => createFilePluginConfig({ root: join(root, "config"), pluginId }),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
	return { deps, root, builtinDir, userDir, host: createPluginHost(deps) };
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("readZip", () => {
	it("reads files and skips directory entries", () => {
		const archive = makeZip({ "dir/": "", "dir/a.txt": "a", "b.txt": "b" });
		const entries = readZip(archive);
		expect(entries.map((entry) => entry.path).sort()).toEqual(["b.txt", "dir/a.txt"]);
		expect(new TextDecoder().decode(entries.find((entry) => entry.path === "b.txt")!.bytes)).toBe("b");
	});

	it("rejects entries that escape the target directory", () => {
		// zip slip：`..` 让解压写到目标目录之外，是最常见的一种归档攻击。
		const archive = zipSync({ "../evil.txt": strToU8("x") }, { level: 0 });
		expect(() => readZip(archive)).toThrow(/无效路径/);
	});

	it("rejects absolute paths and drive letters", () => {
		expect(() => readZip(zipSync({ "/etc/passwd": strToU8("x") }, { level: 0 }))).toThrow(/绝对路径/);
		expect(() => readZip(zipSync({ "C:/windows/x": strToU8("x") }, { level: 0 }))).toThrow(/绝对路径/);
	});

	it("normalizes backslash separators from Windows packers", () => {
		const entries = readZip(zipSync({ "dir\\a.txt": strToU8("a") }, { level: 0 }));
		expect(entries[0]?.path).toBe("dir/a.txt");
	});

	it("enforces the file-count limit", () => {
		const archive = makeZip({ "a.txt": "a", "b.txt": "b" });
		expect(() => readZip(archive, { maxFiles: 1 })).toThrow(/条目数超过上限/);
	});

	it("enforces the decompressed size limit while inflating", () => {
		// 压缩后很小、解压后很大：只校验归档大小是挡不住 zip bomb 的。
		const archive = makeZip({ "big.txt": "x".repeat(100_000) });
		expect(archive.byteLength).toBeLessThan(10_000);
		expect(() => readZip(archive, { maxTotalBytes: 1_000 })).toThrow(/解压后体积超过上限/);
	});

	it("rejects an empty archive and an oversized archive", () => {
		expect(() => readZip(new Uint8Array())).toThrow(/为空/);
		expect(() => readZip(makeZip({ "a.txt": "a" }), { maxArchiveBytes: 3 })).toThrow(/超过/);
	});

	it("rejects bytes that are not a zip at all", () => {
		// 传错文件（图片、文本）比传空包常见得多，报错要说准。
		expect(() => readZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/不是有效的 ZIP/);
	});

	it("reports a zip header with garbage content as unreadable", () => {
		// 有 PK 头但中央目录损坏：fflate 不抛错、只是读不出条目，报错文案要同时覆盖
		// 「空包」与「坏包」，别让用户以为自己传了个合法空包。
		expect(() => readZip(strToU8("PK\u0003\u0004garbage-not-a-real-archive"))).toThrow(/没有可读取的文件/);
	});
});

describe("archive root helpers", () => {
	it("detects a flat package and a nested one", () => {
		expect(findArchiveRoot(readZip(flatPluginZip("a.b")), "miubot.plugin.json")).toEqual({ root: "", matches: 1 });
		expect(findArchiveRoot(readZip(nestedPluginZip("a.b")), "miubot.plugin.json")).toEqual({
			root: "my-plugin",
			matches: 1,
		});
	});

	it("reports multiple markers instead of silently picking one", () => {
		const archive = makeZip({
			"one/miubot.plugin.json": manifestJson("a.one"),
			"two/miubot.plugin.json": manifestJson("a.two"),
		});
		expect(findArchiveRoot(readZip(archive), "miubot.plugin.json")?.matches).toBe(2);
	});

	it("strips the root prefix when selecting files", () => {
		const entries = readZip(nestedPluginZip("a.b"));
		const under = entriesUnderRoot(entries, "my-plugin");
		expect(under.map((entry) => entry.path).sort()).toEqual(["assets/readme.txt", "index.ts", "miubot.plugin.json"]);
	});
});

describe("extractPackage", () => {
	it("writes a nested package into a hidden temp directory", async () => {
		const parent = await tempDir("miubot-extract-");
		const result = await extractPackage(nestedPluginZip("a.b"), parent);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.directory.startsWith(join(parent, ".incoming-"))).toBe(true);
		expect(await exists(join(result.directory, "miubot.plugin.json"))).toBe(true);
		expect(await exists(join(result.directory, "assets", "readme.txt"))).toBe(true);
	});

	it("rejects an archive without a manifest", async () => {
		const parent = await tempDir("miubot-extract-");
		const result = await extractPackage(makeZip({ "index.ts": "x" }), parent);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("miubot.plugin.json");
	});

	it("rejects an archive containing two plugins", async () => {
		const parent = await tempDir("miubot-extract-");
		const archive = makeZip({
			"a/miubot.plugin.json": manifestJson("a.one"),
			"b/miubot.plugin.json": manifestJson("a.two"),
		});
		const result = await extractPackage(archive, parent);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("多个");
	});

	it("leaves nothing behind when the archive is rejected", async () => {
		const parent = await tempDir("miubot-extract-");
		await extractPackage(makeZip({ "index.ts": "x" }), parent);
		expect(await readdir(parent)).toEqual([]);
	});
});

describe("host.importArchive", () => {
	it("installs from a flat zip and registers the plugin", async () => {
		const h = await harness();
		const result = await h.host.importArchive(flatPluginZip("test.zipped"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status.id).toBe("test.zipped");
		// 与目录安装一致：装完不启动。
		expect(result.status.state).toBe("inactive");
		expect(result.status.removable).toBe(true);
		expect(await exists(join(h.userDir, "test.zipped", "miubot.plugin.json"))).toBe(true);
	});

	it("installs from a nested zip", async () => {
		const h = await harness();
		const result = await h.host.importArchive(nestedPluginZip("test.nested"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await exists(join(h.userDir, "test.nested", "assets", "readme.txt"))).toBe(true);
	});

	it("leaves no temp directory after a successful import", async () => {
		const h = await harness();
		await h.host.importArchive(flatPluginZip("test.zipped"));
		const entries = await readdir(h.userDir);
		expect(entries.filter((name) => name.startsWith(".incoming-"))).toEqual([]);
	});

	it("refuses a second import of the same id", async () => {
		const h = await harness();
		await h.host.importArchive(flatPluginZip("test.zipped"));
		const again = await h.host.importArchive(flatPluginZip("test.zipped"));
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.issues[0]?.message).toContain("已存在");
		// 失败时不能留下临时目录：上一个包已经装好了，临时目录还占着磁盘。
		expect((await readdir(h.userDir)).filter((name) => name.startsWith(".incoming-"))).toEqual([]);
	});

	it("refuses to shadow a built-in plugin", async () => {
		const h = await harness();
		await mkdir(join(h.builtinDir, "test.builtin"), { recursive: true });
		await writeFile(join(h.builtinDir, "test.builtin", "miubot.plugin.json"), manifestJson("test.builtin"), "utf8");
		await writeFile(join(h.builtinDir, "test.builtin", "index.ts"), ENTRY_SOURCE("test.builtin"), "utf8");
		await h.host.discover();

		const result = await h.host.importArchive(flatPluginZip("test.builtin"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("已存在");
	});

	it("rejects a package whose entry file is missing", async () => {
		const h = await harness();
		// manifest 指向不存在的入口：解压能成功，但校验必须拦住。
		const archive = makeZip({ "miubot.plugin.json": manifestJson("test.broken", { entry: "./missing.ts" }) });
		const result = await h.host.importArchive(archive);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "entry" }));
		expect(await readdir(h.userDir)).toEqual([]);
	});

	it("keeps the plugin inactive when discovery skips it is not an option", async () => {
		// 回归：`discover()` 会跳过 `.` 开头的目录，临时目录不能因此变成「装好了但登记不上」。
		const h = await harness();
		await mkdir(join(h.userDir, ".incoming-fake"), { recursive: true });
		await writeFile(join(h.userDir, ".incoming-fake", "miubot.plugin.json"), manifestJson("test.fake"), "utf8");
		await h.host.discover();
		expect(h.host.list().some((status) => status.id === "test.fake")).toBe(false);
	});
});
