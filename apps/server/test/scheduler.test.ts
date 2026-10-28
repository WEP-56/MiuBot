import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "../src/scheduler.ts";

let dir: string;
const session = { id: "session-1" };
const execute = vi.fn(async () => {});
let paused = false;

function makeScheduler() {
	return createScheduler({
		dataDir: dir,
		isPaused: () => paused,
		getSession: (id) => id === session.id ? session : undefined,
		getAllowedTools: () => ["read", "web_search"],
		execute,
		log: () => {},
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "miubot-scheduler-"));
	execute.mockClear();
	paused = false;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("scheduled tasks", () => {
	it("creates and persists a repeating task bound to a session", async () => {
		const scheduler = makeScheduler();
		const task = await scheduler.createTask({
			sessionId: session.id,
			name: "Stretch",
			prompt: "提醒我站起来活动",
			schedule: { type: "interval", intervalMinutes: 30 },
			allowedTools: ["read"],
		});
		expect(task.sessionId).toBe(session.id);
		expect(Date.parse(task.nextRunAt)).toBeGreaterThan(Date.now());
		expect(JSON.parse(await readFile(join(dir, "scheduled-tasks.json"), "utf8"))).toHaveLength(1);
	});

	it("rejects missing sessions and tools outside the session grant", async () => {
		const scheduler = makeScheduler();
		const input = {
			name: "Task",
			prompt: "Prompt",
			schedule: { type: "interval" as const, intervalMinutes: 10 },
			allowedTools: ["bash"],
		};
		await expect(scheduler.createTask({ ...input, sessionId: "missing" })).rejects.toThrow("会话不存在");
		await expect(scheduler.createTask({ ...input, sessionId: session.id })).rejects.toThrow("只能选择");
	});

	it("holds due tasks during global silence and runs them after it ends", async () => {
		await writeFile(
			join(dir, "scheduled-tasks.json"),
			JSON.stringify([
				{
					id: "due-task",
					sessionId: session.id,
					name: "Once",
					prompt: "Run once",
					schedule: { type: "once", runAt: "2020-01-01T00:00:00.000Z" },
					allowedTools: [],
					enabled: true,
					nextRunAt: "2020-01-01T00:00:00.000Z",
					createdAt: "2019-12-31T00:00:00.000Z",
				},
			]),
		);
		const scheduler = makeScheduler();
		await scheduler.load();
		paused = true;
		scheduler.start();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(execute).not.toHaveBeenCalled();
		expect(scheduler.list()[0]?.enabled).toBe(true);

		paused = false;
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 6_000 });
		expect(scheduler.list()[0]?.enabled).toBe(false);
		await vi.waitFor(async () => {
			const stored = JSON.parse(await readFile(join(dir, "scheduled-tasks.json"), "utf8")) as Array<{
				lastStatus?: string;
			}>;
			expect(stored[0]?.lastStatus).toBe("success");
		});
		scheduler.stop();
	});

	it("loads, pauses, resumes, and deletes persisted tasks", async () => {
		const first = makeScheduler();
		const task = await first.createTask({
			sessionId: session.id,
			name: "Daily",
			prompt: "Say hello",
			schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
			allowedTools: [],
		});
		const second = makeScheduler();
		await second.load();
		expect(second.list()).toHaveLength(1);
		expect((await second.updateTask(task.id, { enabled: false }))?.enabled).toBe(false);
		expect((await second.updateTask(task.id, { enabled: true }))?.enabled).toBe(true);
		expect(await second.deleteTask(task.id)).toBe(true);
		expect(second.list()).toHaveLength(0);
	});
});
