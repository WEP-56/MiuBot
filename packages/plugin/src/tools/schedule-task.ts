import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const scheduleTaskSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 80, description: "任务的简短名称" }),
	prompt: Type.String({ minLength: 1, maxLength: 4000, description: "触发时交给 Agent 执行的指令" }),
	schedule: Type.Union([
		Type.Object({ type: Type.Literal("once"), runAt: Type.String({ description: "ISO 8601 格式的未来时间" }) }),
		Type.Object({
			type: Type.Literal("interval"),
			intervalMinutes: Type.Number({ minimum: 1, maximum: 525600, description: "循环间隔分钟数" }),
		}),
		Type.Object({
			type: Type.Literal("range"),
			minMinutes: Type.Number({ minimum: 1, maximum: 525600, description: "最小间隔分钟数" }),
			maxMinutes: Type.Number({ minimum: 1, maximum: 525600, description: "最大间隔分钟数" }),
		}),
		Type.Object({
			type: Type.Literal("daily"),
			time: Type.String({ description: "每天触发时间，HH:mm 格式" }),
			timezone: Type.String({ description: "IANA 时区，例如 Asia/Shanghai" }),
		}),
	]),
});

export type ScheduledTaskSchedule =
	| { type: "once"; runAt: string }
	| { type: "interval"; intervalMinutes: number }
	| { type: "range"; minMinutes: number; maxMinutes: number }
	| { type: "daily"; time: string; timezone: string };

export type CreateScheduledTaskInput = {
	name: string;
	prompt: string;
	schedule: ScheduledTaskSchedule;
	allowedTools: string[];
};

export function createScheduleTaskTool(
	createTask: (input: CreateScheduledTaskInput) => Promise<{ id: string; nextRunAt: string }>,
	allowedTools: () => string[],
): ToolDefinition<typeof scheduleTaskSchema> {
	return {
		name: "schedule_task",
		label: "创建定时任务",
		description:
			"为当前 QQ 会话创建单次或循环任务。仅在用户明确要求提醒或定时执行时使用。任务只能使用当前会话已授权的 Tools。支持单次、固定间隔、随机间隔范围和每日指定时间。",
		promptSnippet: "按用户要求为当前会话创建单次或循环定时任务",
		parameters: scheduleTaskSchema,
		async execute(_id, params) {
			try {
				const task = await createTask({ ...params, allowedTools: allowedTools() });
				return {
					content: [{ type: "text", text: `定时任务已创建（${task.id}），下次执行时间：${task.nextRunAt}` }],
					details: { taskId: task.id, nextRunAt: task.nextRunAt },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	};
}
