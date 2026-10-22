import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadManifest,
	MANIFEST_SCHEMA_VERSION,
	type PluginManifest,
	resolveEntryPath,
	validateManifest,
} from "../src/host/manifest.ts";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "miubot-manifest-"));
	directories.push(directory);
	return directory;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		id: "miubot.welcome",
		name: "入群欢迎",
		version: "0.1.0",
		entry: "./index.ts",
		permissions: ["event:platform.group.bot_added", "message:send"],
		...overrides,
	};
}

function valid(raw: unknown, directory = "plugins/welcome"): PluginManifest {
	const result = validateManifest(raw, directory);
	if (!result.ok) throw new Error(`unexpected issues: ${JSON.stringify(result.issues)}`);
	return result.manifest;
}

describe("manifest validation", () => {
	it("accepts a well-formed manifest", () => {
		const parsed = valid(manifest({ description: "Bot 入群后打招呼", bots: ["bot-1"] }));
		expect(parsed).toMatchObject({
			id: "miubot.welcome",
			schemaVersion: MANIFEST_SCHEMA_VERSION,
			entry: "./index.ts",
			description: "Bot 入群后打招呼",
			bots: ["bot-1"],
			permissions: ["event:platform.group.bot_added", "message:send"],
		});
	});

	it("rejects a future schema version", () => {
		const result = validateManifest(manifest({ schemaVersion: MANIFEST_SCHEMA_VERSION + 1 }), "plugins/welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "schemaVersion" }));
	});

	it("rejects invalid ids, versions and unknown permissions", () => {
		for (const bad of ["Miubot.Welcome", "-bad", "", "a".repeat(65), "../escape"]) {
			const result = validateManifest(manifest({ id: bad }), "plugins/welcome");
			expect(result.ok).toBe(false);
		}
		for (const bad of ["1.0", "v1.0.0", "latest"]) {
			expect(validateManifest(manifest({ version: bad }), "plugins/welcome").ok).toBe(false);
		}
		const result = validateManifest(manifest({ permissions: ["message:send", "shell:exec"] }), "plugins/welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "permissions[1]" }));
	});

	it("rejects duplicate permissions", () => {
		const result = validateManifest(manifest({ permissions: ["message:send", "message:send"] }), "plugins/welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "permissions" }));
	});

	it("rejects entry paths that escape the plugin directory", () => {
		for (const entry of ["../evil.ts", "/etc/passwd", "C:\\evil.ts", "sub/../../escape.ts", "./index.txt"]) {
			expect(validateManifest(manifest({ entry }), "plugins/welcome").ok).toBe(false);
		}
		// 目录内的子路径是允许的。
		expect(valid(manifest({ entry: "src/main.ts" })).entry).toBe("src/main.ts");
	});

	it("rejects mixing the wildcard with concrete bot ids", () => {
		const result = validateManifest(manifest({ bots: ["*", "bot-1"] }), "plugins/welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues).toContainEqual(expect.objectContaining({ field: "bots" }));
	});

	it("deduplicates bot ids", () => {
		expect(valid(manifest({ bots: ["bot-1", "bot-1"] })).bots).toEqual(["bot-1"]);
	});

	it("rejects a non-object manifest and reports the root field", () => {
		const result = validateManifest([], "plugins/welcome");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]).toMatchObject({ field: "$" });
	});
});

describe("resolveEntryPath", () => {
	it("keeps paths inside the directory only", () => {
		expect(resolveEntryPath("plugins/welcome", "./index.ts")).toMatchObject({ ok: true });
		expect(resolveEntryPath("plugins/welcome", "..\\..\\win.ini").ok).toBe(false);
		expect(resolveEntryPath("plugins/welcome", "../../outside.ts").ok).toBe(false);
	});
});

describe("loadManifest", () => {
	it("reports a missing manifest file", async () => {
		const directory = await tempDir();
		const result = await loadManifest(directory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("miubot.plugin.json");
	});

	it("reports invalid JSON", async () => {
		const directory = await tempDir();
		await writeFile(join(directory, "miubot.plugin.json"), "{ not json", "utf8");
		const result = await loadManifest(directory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues[0]?.message).toContain("合法 JSON");
	});

	it("loads and resolves the entry path for a real directory", async () => {
		const directory = await tempDir();
		await mkdir(join(directory, "src"), { recursive: true });
		await writeFile(join(directory, "miubot.plugin.json"), JSON.stringify(manifest({ entry: "src/index.ts" })));
		const result = await loadManifest(directory);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entryPath.endsWith(join("src", "index.ts"))).toBe(true);
	});
});
