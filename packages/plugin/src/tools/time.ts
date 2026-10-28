import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const timeSchema = Type.Object({});

export function createTimeTool(timezone: () => string): ToolDefinition<typeof timeSchema> {
	return {
		name: "time",
		label: "确认时间",
		description: "查询当前准确的日期、时间和星期；当用户问现在几点、今天日期或需要确认时间时使用。",
		promptSnippet: "需要准确当前时间或日期时，调用此工具，不要凭模型内部知识猜测",
		parameters: timeSchema,
		async execute() {
			try {
				const zone = timezone();
				const now = new Date();
				const formatted = new Intl.DateTimeFormat("zh-CN", {
					timeZone: zone,
					dateStyle: "full",
					timeStyle: "long",
				}).format(now);
				return {
					content: [{ type: "text", text: `当前时间：${formatted}（${zone}）` }],
					details: { timezone: zone, iso: now.toISOString() },
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
