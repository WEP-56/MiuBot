import type { RuntimeSession } from "../agent-host.ts";
import type { AppConfig, ImageProviderConfig, ProviderConfig, QqBotConfig } from "../runtime.ts";
import { toolDisplayName } from "../tool-display.ts";

/** 对外暴露的配置：凭据只回传「是否已配置」，不回传密钥本身。 */
export type PublicConfig = {
	qqBots: Array<Omit<QqBotConfig, "appSecret"> & { credentialsConfigured: boolean }>;
	providers: Array<Omit<ProviderConfig, "apiKey"> & { apiKeyConfigured: boolean }>;
	imageProviders: Array<Omit<ImageProviderConfig, "apiKey"> & { apiKeyConfigured: boolean }>;
};

export function publicConfig(config: AppConfig): PublicConfig {
	const qqBots = config.qqBots.map(({ appSecret, ...bot }) => ({ ...bot, credentialsConfigured: Boolean(appSecret) }));
	const providers = config.providers.map(({ apiKey, ...provider }) => ({
		...provider,
		apiKeyConfigured: Boolean(apiKey),
	}));
	const imageProviders = config.imageProviders.map(({ apiKey, ...provider }) => ({
		...provider,
		apiKeyConfigured: Boolean(apiKey),
	}));
	return { qqBots, providers, imageProviders };
}

/** 会话列表项：不带消息正文与摘要正文，只报数量。 */
export function publicSession(session: RuntimeSession): Omit<RuntimeSession, "messages" | "summary" | "activities"> & {
	messageCount: number;
	summaryConfigured: boolean;
} {
	const { messages, summary, activities: _activities, ...item } = session;
	void _activities;
	return { ...item, messageCount: messages.length, summaryConfigured: Boolean(summary) };
}

export type ToolCatalogEntry = {
	name: string;
	label: string;
	description: string;
	configurable?: boolean;
	/** 文件与命令类工具：能读写服务器文件或执行命令，公网部署下要单独提示。 */
	native?: boolean;
};

export const toolCatalog: ToolCatalogEntry[] = [
	{
		name: "web_search",
		label: toolDisplayName("web_search"),
		description: "使用 Tavily、Brave、Exa 或 Serper 搜索公开网页。",
		configurable: true,
	},
	{
		name: "image_gen",
		label: toolDisplayName("image_gen"),
		description: "按文字提示生成图片并发送到当前 QQ 对话。",
		configurable: true,
	},
	{
		name: "schedule_task",
		label: toolDisplayName("schedule_task"),
		description: "按用户要求为当前会话创建单次或循环定时任务。",
		configurable: true,
	},
	{
		name: "time",
		label: toolDisplayName("time"),
		description: "查询当前时间、日期与星期，使用 Tools 中配置的时区。",
		configurable: true,
	},
	{ name: "read", label: toolDisplayName("read"), description: "读取工作区文件内容。", native: true },
	{ name: "bash", label: toolDisplayName("bash"), description: "在服务器工作目录执行 Bash 命令。", native: true },
	{
		name: "powershell",
		label: toolDisplayName("powershell"),
		description: "在服务器工作目录执行 PowerShell 命令。",
		native: true,
	},
	{ name: "edit", label: toolDisplayName("edit"), description: "编辑工作区文件。", native: true },
	{ name: "write", label: toolDisplayName("write"), description: "创建或覆盖工作区文件。", native: true },
	{ name: "grep", label: toolDisplayName("grep"), description: "在工作区文件中搜索文本。", native: true },
	{ name: "find", label: toolDisplayName("find"), description: "按名称或模式查找文件。", native: true },
	{ name: "ls", label: toolDisplayName("ls"), description: "查看工作区目录内容。", native: true },
];
