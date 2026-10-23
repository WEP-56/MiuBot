import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeLogger, redact } from "../src/logging.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-log-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function loggerAt(name: string, options: { maxBytes?: number; maxFiles?: number; limit?: number } = {}) {
	return createRuntimeLogger({ filePath: join(dir, name), dir, ...options });
}

describe("log rotation", () => {
	it("keeps writing to the current file while it fits", async () => {
		const logger = loggerAt("runtime.log", { maxBytes: 10_000, maxFiles: 3 });
		logger.write("INFO", "hello");
		await logger.flush();
		const entries = await readdir(dir);
		expect(entries).toEqual(["runtime.log"]);
	});

	it("rotates when the file would exceed the cap and keeps the newest entries", async () => {
		// 每条约 100 字节，200 字节上限 → 每两条轮转一次。
		const logger = loggerAt("runtime.log", { maxBytes: 200, maxFiles: 3 });
		for (let index = 0; index < 6; index += 1) logger.write("INFO", `entry-${index}`);
		await logger.flush();

		const files = (await readdir(dir)).sort();
		expect(files).toEqual(["runtime.log", "runtime.log.1", "runtime.log.2"]);
		// 最新的在当前文件里。
		expect(await readFile(join(dir, "runtime.log"), "utf8")).toContain("entry-5");
	});

	it("never keeps more than maxFiles files", async () => {
		const logger = loggerAt("runtime.log", { maxBytes: 150, maxFiles: 2 });
		for (let index = 0; index < 10; index += 1) logger.write("INFO", `entry-${index}`);
		await logger.flush();
		const files = await readdir(dir);
		expect(files.sort()).toEqual(["runtime.log", "runtime.log.1"]);
	});

	it("reloads recent entries across rotated files, oldest first", async () => {
		const logger = loggerAt("runtime.log", { maxBytes: 150, maxFiles: 3 });
		for (let index = 0; index < 5; index += 1) logger.write("INFO", `entry-${index}`);
		await logger.flush();

		const restored = loggerAt("runtime.log", { maxBytes: 150, maxFiles: 3, limit: 100 });
		await restored.load();
		const texts = restored.list().map((entry) => entry.text);
		expect(texts.at(-1)).toBe("entry-4");
		expect(texts).toEqual([...texts].sort((left, right) => Number(left.split("-")[1]) - Number(right.split("-")[1])));
	});

	it("ignores half-written lines when reloading", async () => {
		const path = join(dir, "runtime.log");
		await writeFile(
			path,
			`${JSON.stringify({ time: "t", level: "INFO", text: "ok" })}\n{"time":"t","level":"IN`,
			"utf8",
		);
		const logger = loggerAt("runtime.log");
		await logger.load();
		expect(logger.list()).toHaveLength(1);
	});

	it("caps the in-memory list", async () => {
		const logger = loggerAt("runtime.log", { limit: 3 });
		for (let index = 0; index < 6; index += 1) logger.write("INFO", `entry-${index}`);
		await logger.flush();
		expect(logger.list().map((entry) => entry.text)).toEqual(["entry-3", "entry-4", "entry-5"]);
	});
});

describe("secret redaction", () => {
	it("masks api keys, bearer tokens and key/value pairs", () => {
		expect(redact("using sk-abcdefghijklmnopqrstuvwxyz")).toBe("using sk-***");
		expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer ***");
		expect(redact('{"apiKey":"secret-value"}')).toBe('{"apiKey":"***"}');
		expect(redact("appSecret=deadbeefcafe")).toBe("appSecret=***");
		expect(redact("token: abc123")).toBe("token: ***");
	});

	it("masks long hex and long base64 blobs", () => {
		expect(redact(`session ${"a".repeat(64)} end`)).toBe("session *** end");
		expect(redact(`jwt ${"A".repeat(60)}`)).toBe("jwt ***");
	});

	it("leaves ordinary operational text alone", () => {
		for (const text of [
			"插件加载完成：3/4 个启用",
			"管理面：http://127.0.0.1:8787；允许的 Host：example.com",
			"智能插话未执行：冷却中 (123456)",
			"Agent 回复完成：deepseek/deepseek-chat",
		]) {
			expect(redact(text), text).toBe(text);
		}
	});

	it("redacts before writing, in memory and on disk", async () => {
		const logger = loggerAt("runtime.log");
		logger.write("WARN", "调用失败：apiKey=super-secret-value");
		await logger.flush();
		const onDisk = await readFile(join(dir, "runtime.log"), "utf8");
		expect(onDisk).not.toContain("super-secret-value");
		expect(logger.list()[0]?.text).not.toContain("super-secret-value");
	});

	it("truncates very long lines instead of dumping a whole prompt", async () => {
		const logger = loggerAt("runtime.log");
		logger.write("ERROR", "prompt ".repeat(1000));
		await logger.flush();
		const text = logger.list()[0]?.text ?? "";
		expect(text.length).toBeLessThan(2100);
		expect(text.endsWith("…（已截断）")).toBe(true);
	});
});
