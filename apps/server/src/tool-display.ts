const TOOL_LABELS: Record<string, string> = {
	web_search: "网页搜索",
	image_gen: "图像生成",
	schedule_task: "定时任务",
	time: "确认时间",
	read: "读取文件",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "编辑文件",
	write: "写入文件",
	grep: "内容搜索",
	find: "查找文件",
	ls: "列出目录",
	load_skill: "读取技能",
	search_stickers: "搜索表情包",
	send_sticker: "发送表情包",
};

export function toolDisplayName(name: string): string {
	const known = TOOL_LABELS[name];
	if (known) return known;
	if (name.startsWith("mcp__")) {
		const mcpName = name.split("__").at(-1);
		return mcpName ? `MCP 工具 ${mcpName}` : "MCP 工具";
	}
	return `插件工具 ${name}`;
}
