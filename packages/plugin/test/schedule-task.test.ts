import { describe, expect, it, vi } from "vitest";
import { createScheduleTaskTool } from "../src/tools/schedule-task.ts";

describe("schedule task prompt", () => {
	it("covers reminder and scheduled-work phrases without guessing unclear schedules", () => {
		const tool = createScheduleTaskTool(
			vi.fn(async () => ({ id: "task-1", nextRunAt: "2026-10-29T09:00:00.000Z" })),
			() => [],
		);
		expect(tool.description).toContain("提醒我/到时告诉我/通知我");
		expect(tool.description).toContain("定期检查、查询、汇报、同步");
		expect(tool.promptSnippet).toContain("半小时后告诉我");
		expect(tool.promptSnippet).toContain("定时检查、查询、总结、同步或跟进");
		expect(tool.promptSnippet).toContain("关键信息不清楚时先追问，不要猜");
		expect(tool.promptSnippet).toContain("每周某天/工作日");
	});
});
