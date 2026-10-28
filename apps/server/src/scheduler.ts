import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreateScheduledTaskInput, ScheduledTaskSchedule } from "@miubot/plugin/tools/index";
import { writeJsonAtomic } from "./storage.ts";

export type ScheduledTask = {
	id: string;
	sessionId: string;
	name: string;
	prompt: string;
	schedule: ScheduledTaskSchedule;
	allowedTools: string[];
	enabled: boolean;
	nextRunAt: string;
	lastRunAt?: string;
	lastStatus?: "success" | "error";
	lastError?: string;
	createdAt: string;
};

export type Scheduler = ReturnType<typeof createScheduler>;

function assertSchedule(schedule: ScheduledTaskSchedule, now = new Date()): string {
	if (schedule.type === "once") {
		const at = Date.parse(schedule.runAt);
		if (!Number.isFinite(at) || at <= now.getTime()) throw new Error("单次任务时间必须是未来时间");
		return new Date(at).toISOString();
	}
	if (schedule.type === "interval") {
		if (
			!Number.isInteger(schedule.intervalMinutes) ||
			schedule.intervalMinutes < 1 ||
			schedule.intervalMinutes > 525600
		)
			throw new Error("循环间隔必须是 1 到 525600 分钟");
		return new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString();
	}
	if (schedule.type === "range") {
		if (
			!Number.isInteger(schedule.minMinutes) ||
			!Number.isInteger(schedule.maxMinutes) ||
			schedule.minMinutes < 1 ||
			schedule.maxMinutes < schedule.minMinutes ||
			schedule.maxMinutes > 525600
		)
			throw new Error("随机间隔范围无效，需满足 1 ≤ 最小值 ≤ 最大值 ≤ 525600 分钟");
		return new Date(now.getTime() + randomMinutes(schedule) * 60_000).toISOString();
	}
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("每日触发时间需使用 HH:mm 格式");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format(now);
	} catch {
		throw new Error("时区必须是有效的 IANA 时区，例如 Asia/Shanghai");
	}
	return nextDaily(schedule.time, schedule.timezone, now).toISOString();
}

function randomMinutes(schedule: Extract<ScheduledTaskSchedule, { type: "range" }>): number {
	return schedule.minMinutes + Math.floor(Math.random() * (schedule.maxMinutes - schedule.minMinutes + 1));
}

function nextDaily(time: string, timezone: string, after: Date): Date {
	const [hour, minute] = time.split(":").map(Number);
	const format = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
	for (let offset = 0; offset <= 26 * 60; offset += 1) {
		const candidate = new Date(start + offset * 60_000);
		const parts = format.formatToParts(candidate);
		const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
		if (Number(values.hour) === hour && Number(values.minute) === minute) return candidate;
	}
	throw new Error("无法计算下次每日触发时间");
}

export function createScheduler(deps: {
	dataDir: string;
	getSession(sessionId: string): { id: string } | undefined;
	getAllowedTools(sessionId: string): string[];
	execute(task: ScheduledTask): Promise<void>;
	log(level: "INFO" | "WARN" | "ERROR", text: string, sessionId?: string): void;
}) {
	const filePath = join(deps.dataDir, "scheduled-tasks.json");
	let tasks: ScheduledTask[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;
	const running = new Set<string>();
	let tickRunning = false;

	async function save(): Promise<void> {
		await writeJsonAtomic(filePath, tasks);
	}

	function allowedForSession(sessionId: string): string[] {
		const session = deps.getSession(sessionId);
		if (!session) throw new Error("绑定的会话不存在");
		return deps.getAllowedTools(sessionId);
	}

	function validateAllowedTools(sessionId: string, selected: string[] | undefined): string[] {
		const allowed = allowedForSession(sessionId);
		if (!selected) return allowed;
		if (!Array.isArray(selected) || selected.some((name) => typeof name !== "string" || !allowed.includes(name)))
			throw new Error("任务只能选择该会话当前已授权的工具");
		return [...new Set(selected)];
	}

	async function createTask(input: CreateScheduledTaskInput & { sessionId: string }): Promise<ScheduledTask> {
		const name = input.name.trim();
		const prompt = input.prompt.trim();
		if (!name || name.length > 80) throw new Error("任务名称需为 1 到 80 个字符");
		if (!prompt || prompt.length > 4000) throw new Error("任务 Prompt 需为 1 到 4000 个字符");
		const now = new Date();
		const task: ScheduledTask = {
			id: randomUUID(),
			sessionId: input.sessionId,
			name,
			prompt,
			schedule: input.schedule,
			allowedTools: validateAllowedTools(input.sessionId, input.allowedTools),
			enabled: true,
			nextRunAt: assertSchedule(input.schedule, now),
			createdAt: now.toISOString(),
		};
		tasks.unshift(task);
		await save();
		return task;
	}

	async function tick(): Promise<void> {
		if (tickRunning) return;
		tickRunning = true;
		try {
			const now = new Date();
			const due = tasks.filter(
				(task) => task.enabled && Date.parse(task.nextRunAt) <= now.getTime() && !running.has(task.id),
			);
			for (const task of due) {
				running.add(task.id);
				const scheduledAt = task.nextRunAt;
				task.lastRunAt = now.toISOString();
				if (task.schedule.type === "once") {
					task.enabled = false;
				} else {
					const nextBase = new Date(Math.max(now.getTime(), Date.parse(scheduledAt)));
					task.nextRunAt =
						task.schedule.type === "interval"
							? new Date(nextBase.getTime() + task.schedule.intervalMinutes * 60_000).toISOString()
							: task.schedule.type === "range"
								? new Date(nextBase.getTime() + randomMinutes(task.schedule) * 60_000).toISOString()
								: nextDaily(task.schedule.time, task.schedule.timezone, nextBase).toISOString();
				}
				await save();
				try {
					if (!deps.getSession(task.sessionId)) throw new Error("绑定的会话已删除");
					await deps.execute({ ...task, nextRunAt: scheduledAt });
					task.lastStatus = "success";
					delete task.lastError;
					deps.log("INFO", `定时任务执行完成：${task.name}`, task.sessionId);
				} catch (error) {
					task.lastStatus = "error";
					task.lastError = error instanceof Error ? error.message : String(error);
					deps.log("ERROR", `定时任务执行失败（${task.name}）：${task.lastError}`, task.sessionId);
				} finally {
					running.delete(task.id);
					await save();
				}
			}
		} finally {
			tickRunning = false;
		}
	}

	return {
		async load(): Promise<void> {
			try {
				const stored = JSON.parse(await readFile(filePath, "utf8")) as ScheduledTask[];
				tasks = Array.isArray(stored) ? stored : [];
			} catch {
				tasks = [];
			}
		},
		start(): void {
			if (timer) return;
			timer = setInterval(() => void tick(), 5_000);
			timer.unref?.();
			void tick();
		},
		stop(): void {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		list(): ScheduledTask[] {
			return tasks.map((task) => ({
				...task,
				schedule: { ...task.schedule },
				allowedTools: [...task.allowedTools],
			}));
		},
		allowedTools(sessionId: string): string[] {
			return allowedForSession(sessionId);
		},
		createTask,
		async updateTask(id: string, patch: { enabled?: boolean }): Promise<ScheduledTask | undefined> {
			const task = tasks.find((item) => item.id === id);
			if (!task) return undefined;
			if (typeof patch.enabled === "boolean") task.enabled = patch.enabled;
			await save();
			return { ...task };
		},
		async deleteTask(id: string): Promise<boolean> {
			const index = tasks.findIndex((task) => task.id === id);
			if (index < 0) return false;
			tasks.splice(index, 1);
			await save();
			return true;
		},
	};
}
