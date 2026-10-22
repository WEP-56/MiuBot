import type { RuntimeSession } from "../agent-host.ts";
import type { AppConfig, ImageProviderConfig, ProviderConfig, QqBotConfig } from "../runtime.ts";

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
export function publicSession(
	session: RuntimeSession,
): Omit<RuntimeSession, "messages" | "summary"> & { messageCount: number; summaryConfigured: boolean } {
	const { messages, summary, ...item } = session;
	return { ...item, messageCount: messages.length, summaryConfigured: Boolean(summary) };
}

export const nativeToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

export const toolNames = [...nativeToolNames, "web_search", "image_gen"];

export type ToolCatalogEntry = {
	name: string;
	label: string;
	description: string;
	configurable?: boolean;
};

export const toolCatalog: ToolCatalogEntry[] = [
	{
		name: "web_search",
		label: "网页搜索",
		description: "使用 Tavily、Brave、Exa 或 Serper 搜索公开网页。",
		configurable: true,
	},
	{
		name: "image_gen",
		label: "图像生成",
		description: "按文字提示生成图片并发送到当前 QQ 对话。",
		configurable: true,
	},
	{ name: "read", label: "读取文件", description: "读取工作区文件内容。" },
	{ name: "bash", label: "Bash", description: "在服务器工作目录执行 Bash 命令。" },
	{ name: "powershell", label: "PowerShell", description: "在服务器工作目录执行 PowerShell 命令。" },
	{ name: "edit", label: "编辑文件", description: "对工作区文件进行局部修改。" },
	{ name: "write", label: "写入文件", description: "创建或覆盖工作区文件。" },
	{ name: "grep", label: "内容搜索", description: "在工作区文件中搜索文本。" },
	{ name: "find", label: "查找文件", description: "按名称或模式查找工作区文件。" },
	{ name: "ls", label: "列出目录", description: "查看工作区目录内容。" },
];
