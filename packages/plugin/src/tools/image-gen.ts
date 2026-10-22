import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/index.ts";

export type ImageGenerationRequest = {
	prompt: string;
	size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
	quality?: "auto" | "low" | "medium" | "high";
	signal?: AbortSignal;
};
const imageGenSchema = Type.Object({
	prompt: Type.String({ minLength: 1, maxLength: 4000, description: "Required. What to draw, described concretely." }),
	size: Type.Optional(
		Type.Union(
			[Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")],
			{ description: "Optional, defaults to auto. Width x height of the output." },
		),
	),
	quality: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
			description: "Optional, defaults to auto. Higher quality is slower and costlier.",
		}),
	),
});

export function createImageGenTool(
	generate: (request: ImageGenerationRequest) => Promise<void>,
): ToolDefinition<typeof imageGenSchema> {
	return {
		name: "image_gen",
		label: "Image Generation",
		description: [
			"Generate one image from a text prompt with the configured image provider, then send it to the current QQ conversation.",
			'Parameters: prompt is required; size and quality are optional and only sent when you provide a non-"auto" value.',
			"Call with prompt only unless the user asks for a specific shape or quality; omit size and quality rather than guessing.",
			"If the call returns an invalid request error, drop one optional parameter (quality first, then size) and retry once; do not repeat an identical failing call.",
		].join(" "),
		promptSnippet:
			"Use image_gen when the user asks to create or draw an image; pass prompt alone unless a size or quality is explicitly wanted.",
		parameters: imageGenSchema,
		async execute(_id, params, signal) {
			try {
				await generate({ ...params, ...(signal ? { signal } : {}) });
				return { content: [{ type: "text", text: "图片已生成并发送到当前对话。" }], details: {} };
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
