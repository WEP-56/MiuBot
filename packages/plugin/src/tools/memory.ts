import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const readMemorySchema = Type.Object({
	query: Type.Optional(Type.String({ maxLength: 200, description: "可选的关键词，用于筛选当前对象可见的记忆" })),
});

const saveMemorySchema = Type.Object({
	area: Type.Union([Type.Literal("shared"), Type.Literal("personal")], {
		description: "群共享信息，或只属于当前发言者的个人摘要",
	}),
	category: Type.Union(
		[Type.Literal("user"), Type.Literal("feedback"), Type.Literal("project"), Type.Literal("reference")],
		{
			description:
				"user=稳定个人偏好/背景；feedback=明确纠正；project=持续项目事实/决定；reference=以后会查用的资料及来源",
		},
	),
	title: Type.String({ minLength: 1, maxLength: 100, description: "稳定、简短的记忆标题" }),
	content: Type.String({ minLength: 1, description: "记忆正文；重复标题会更新现有条目" }),
});

export type SaveMemoryToolInput = {
	area: "shared" | "personal";
	category: "user" | "feedback" | "project" | "reference";
	title: string;
	content: string;
};

export function createMemoryTools(options: {
	read(query?: string): Promise<string>;
	save(input: SaveMemoryToolInput): Promise<{ title: string; area: string }>;
}): ToolDefinition[] {
	const readTool: ToolDefinition<typeof readMemorySchema> = {
		name: "read_memory",
		label: "读取长期记忆",
		description:
			"读取当前 QQ 对象中允许你查看的长期记忆；群聊只包含群共享记忆和当前发言者自己的摘要。用关键词可筛选标题或正文。",
		promptSnippet:
			"当用户问起过去说过什么、长期偏好、历史决定，或当前回答依赖已保存的个人/项目背景时，先调用 read_memory；主题明确时用短关键词。能由当前消息独立回答的问题、问候和普通闲聊不要读取。没有匹配结果就按当前消息回答，不要编造记忆。",
		parameters: readMemorySchema,
		async execute(_id, params) {
			try {
				const input = params as Static<typeof readMemorySchema>;
				const result = await options.read(input.query);
				return { content: [{ type: "text", text: result || "当前对象没有匹配的长期记忆。" }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	};
	const saveTool: ToolDefinition<typeof saveMemorySchema> = {
		name: "save_memory",
		label: "保存长期记忆",
		description:
			"保存对未来交流有帮助且相对稳定的记忆。先按类别选择 user（稳定个人偏好/背景）、feedback（明确纠正）、project（持续项目）或 reference（以后会查用的资料及来源）。群聊只能写群共享区或当前发言者自己的简短摘要；不能指定其他成员、对象或路径。相同区域和标题会更新原条目。",
		promptSnippet:
			"用户说‘记住/以后按这个来/别忘了’时，信息明确后立即调用 save_memory；否则只保存清楚、稳定、未来有用且归属明确的信息。调用前查重；群共享只存明确共同确认的内容，一个人的话不代表全群；个人区只能存当前发言者自己的信息。临时状态、玩笑、猜测和敏感凭据不要保存。",
		parameters: saveMemorySchema,
		async execute(_id, params) {
			try {
				const result = await options.save(params as Static<typeof saveMemorySchema>);
				return {
					content: [{ type: "text", text: `已保存长期记忆「${result.title}」（${result.area}）。` }],
					details: result,
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
	return [readTool, saveTool];
}
