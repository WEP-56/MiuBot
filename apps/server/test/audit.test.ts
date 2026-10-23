import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../src/audit.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-audit-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeLog(maxBytes?: number) {
	return createAuditLog({ filePath: join(dir, "audit.log"), dir, ...(maxBytes ? { maxBytes, maxFiles: 2 } : {}) });
}

describe("audit log", () => {
	it("appends entries with a timestamp and reads them newest first", async () => {
		const audit = makeLog();
		audit.record({ action: "auth.login", actor: "admin", detail: "登录成功" });
		audit.record({ action: "api.mutation", actor: "admin", detail: "PUT /api/config → 200" });
		await audit.flush();

		const entries = await audit.list();
		expect(entries.map((entry) => entry.action)).toEqual(["api.mutation", "auth.login"]);
		expect(entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("keeps the trail across restarts", async () => {
		const first = makeLog();
		first.record({ action: "auth.password", actor: "admin", detail: "口令已修改" });
		await first.flush();

		const reopened = makeLog();
		const entries = await reopened.list();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.detail).toBe("口令已修改");
	});

	it("redacts secrets before they reach the file", async () => {
		const audit = makeLog();
		audit.record({
			action: "api.mutation",
			actor: "admin",
			detail: 'PUT /api/tools {"apiKey":"sk-live-abcdefghijklmnop"}',
		});
		await audit.flush();

		const raw = await readFile(join(dir, "audit.log"), "utf8");
		expect(raw).not.toContain("sk-live-abcdefghijklmnop");
		expect(raw).toContain("apiKey");
	});

	it("rotates instead of growing without bound", async () => {
		const audit = makeLog(400);
		for (let index = 0; index < 12; index += 1) {
			audit.record({ action: "api.mutation", actor: "admin", detail: `PUT /api/config #${index}` });
		}
		await audit.flush();

		const rotated = await stat(join(dir, "audit.log.1"));
		expect(rotated.size).toBeGreaterThan(0);
		const current = await stat(join(dir, "audit.log"));
		expect(current.size).toBeLessThanOrEqual(400);
		// 轮转后仍然读得到较早的记录，只是最多保留 maxFiles 份。
		const entries = await audit.list(100);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.at(0)?.detail).toBe("PUT /api/config #11");
	});
});
