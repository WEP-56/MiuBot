import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const scheduleTaskSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 80, description: "任务的简短名称，概括提醒内容或周期工作" }),
	prompt: Type.String({
		minLength: 1,
		maxLength: 4000,
		description: "触发时交给 Agent 执行的具体指令，例如检查、查询、总结或提醒用户",
	}),
	schedule: Type.Union([
		Type.Object({
			type: Type.Literal("once"),
			runAt: Type.String({ description: "ISO 8601 格式的未来时间；用于某次、稍后或指定日期/时间的提醒和任务" }),
		}),
		Type.Object({
			type: Type.Literal("interval"),
			intervalMinutes: Type.Number({
				minimum: 1,
				maximum: 525600,
				description: "每隔多少分钟重复一次；用于固定间隔的检查、汇报、同步或提醒",
			}),
		}),
		Type.Object({
			type: Type.Literal("range"),
			minMinutes: Type.Number({
				minimum: 1,
				maximum: 525600,
				description: "随机重复间隔的最小分钟数；仅在用户明确要求随机频率时使用",
			}),
			maxMinutes: Type.Number({
				minimum: 1,
				maximum: 525600,
				description: "随机重复间隔的最大分钟数；必须不小于最小间隔",
			}),
		}),
		Type.Object({
			type: Type.Literal("daily"),
			time: Type.String({ description: "每天触发时间，HH:mm 格式；用于每天/每日在固定时刻执行" }),
			timezone: Type.String({ description: "IANA 时区，例如 Asia/Shanghai；使用当前会话或用户明确指定的时区" }),
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
			"为当前 QQ 会话创建单次或循环任务。用户明确要求“提醒我/到时告诉我/通知我”、指定“几分钟后/某天某时”，或要求“每天/每隔一段时间/定期检查、查询、汇报、同步”时使用。支持单次、固定间隔、随机间隔范围和每日指定时间；任务只能使用当前会话已授权的 Tools。",
		promptSnippet:
			"识别定时任务请求：例如“提醒我交报告”“半小时后告诉我”“明早 9 点提醒”“每天检查一次”“每隔 30 分钟查状态”“定期汇报变化”。即使用户说的是定时检查、查询、总结、同步或跟进，而不是‘提醒’，也属于定时任务请求。只有用户明确要求安排未来/重复动作时才创建；只是讨论计划或说‘以后有空’不创建。先确认要执行的动作和时间/周期；关键信息不清楚时先追问，不要猜。按已表达的周期选择单次、固定间隔、随机间隔或每日指定时间；若用户要求每周某天/工作日等当前规则无法准确表达的周期，先说明限制并询问可接受的替代周期。",
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
