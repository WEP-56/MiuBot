import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, readJsonFile, restrictFileMode, writeFileAtomic, writeJsonAtomic } from "../src/storage.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-storage-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("atomic writes", () => {
	it("creates missing directories and writes the payload", async () => {
		const target = join(dir, "nested", "deeper", "config.json");
		await writeJsonAtomic(target, { hello: "miu" });
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ hello: "miu" });
	});

	it("leaves no temporary file behind", async () => {
		const target = join(dir, "state.json");
		await writeFileAtomic(target, "{}");
		await writeFileAtomic(target, '{"second":true}');
		const entries = await readdir(dir);
		expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ second: true });
	});

	it("overwrites instead of appending", async () => {
		const target = join(dir, "state.json");
		await writeFile(target, "old content that is longer than the new one", "utf8");
		await writeFileAtomic(target, "new");
		expect(await readFile(target, "utf8")).toBe("new");
	});
});

describe("directory and file modes", () => {
	it("treats an existing directory and file as acceptable input", async () => {
		// 权限位在 Windows 上不可断言，这里只保证调用本身不抛错、内容不受影响。
		await ensurePrivateDir(dir);
		const target = join(dir, "api-token");
		await writeFile(target, "token", "utf8");
		await restrictFileMode(target);
		expect(await readFile(target, "utf8")).toBe("token");
	});
});

describe("reading JSON", () => {
	it("returns the parsed value", async () => {
		const target = join(dir, "state.json");
		await writeFile(target, '{"ok":true}', "utf8");
		expect(await readJsonFile(target)).toEqual({ ok: true });
	});

	it("returns undefined for missing or corrupted files instead of throwing", async () => {
		expect(await readJsonFile(join(dir, "missing.json"))).toBeUndefined();
		const corrupted = join(dir, "corrupted.json");
		await writeFile(corrupted, "{not json", "utf8");
		expect(await readJsonFile(corrupted)).toBeUndefined();
	});
});
