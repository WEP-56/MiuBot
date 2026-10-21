import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/index.ts";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type Tool } from "@miubot/mcp";

export interface McpServerConfig {
	id: string;
	name: string;
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	url?: string;
	enabled: boolean;
}

interface McpServerRuntime {
	config: McpServerConfig;
	state: "disconnected" | "connecting" | "connected" | "error";
	error?: string;
	client?: McpClient;
	tools: Tool[];
}

export interface McpServerStatus extends McpServerConfig {
	state: McpServerRuntime["state"];
	error?: string;
	toolCount: number;
	toolNames: string[];
}

function toolName(serverId: string, name: string): string {
	const safeServerId = serverId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeToolName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `mcp__${safeServerId}__${safeToolName}`;
}

export class McpRuntime {
	private servers = new Map<string, McpServerRuntime>();
	private globalToolsEnabled = false;

	constructor(configs: McpServerConfig[] = [], globalToolsEnabled = false) {
		this.globalToolsEnabled = globalToolsEnabled;
		for (const config of configs) this.servers.set(config.id, { config, state: "disconnected", tools: [] });
	}

	async startEnabled(): Promise<void> {
		await Promise.all([...this.servers.values()].filter((server) => server.config.enabled).map((server) => this.connect(server)));
	}

	setGlobalToolsEnabled(enabled: boolean): void {
		this.globalToolsEnabled = enabled;
	}

	getGlobalToolsEnabled(): boolean {
		return this.globalToolsEnabled;
	}

	getStatuses(): McpServerStatus[] {
		return [...this.servers.values()].map(({ config, state, error, tools }) => ({
			...config,
			state,
			...(error ? { error } : {}),
			toolCount: tools.length,
			toolNames: tools.map((tool) => tool.name),
		}));
	}

	getEnabledToolDefinitions(): ToolDefinition[] {
		if (!this.globalToolsEnabled) return [];
		return [...this.servers.values()]
			.filter((server) => server.config.enabled && server.state === "connected" && server.client)
			.flatMap((server) => server.tools.map((tool) => this.toToolDefinition(server, tool)));
	}

	async replace(configs: McpServerConfig[]): Promise<void> {
		const previous = this.servers;
		this.servers = new Map(configs.map((config) => [config.id, { config, state: "disconnected", tools: [] }]));
		await Promise.all([...previous.values()].map((server) => server.client?.close().catch(() => undefined)));
		await this.startEnabled();
	}

	async close(): Promise<void> {
		await Promise.all([...this.servers.values()].map((server) => server.client?.close().catch(() => undefined)));
	}

	private async connect(server: McpServerRuntime): Promise<void> {
		server.state = "connecting";
		server.error = undefined;
		let client: McpClient | undefined;
		try {
			client = new McpClient({ name: "miubot", version: "0.1.0" });
			const transport = server.config.transport === "stdio"
				? new StdioTransport({ command: server.config.command ?? "", args: server.config.args ?? [] })
				: new StreamableHttpTransport({ url: server.config.url ?? "" });
			await client.connect(transport);
			server.tools = await client.listTools();
			server.client = client;
			server.state = "connected";
			client.onClose(() => {
				if (server.client === client) {
					server.client = undefined;
					server.state = "disconnected";
					server.tools = [];
				}
			});
		} catch (error) {
			await client?.close().catch(() => undefined);
			server.state = "error";
			server.error = error instanceof Error ? error.message : String(error);
			server.tools = [];
		}
	}

	private toToolDefinition(server: McpServerRuntime, tool: Tool): ToolDefinition {
		const client = server.client;
		const name = toolName(server.config.id, tool.name);
		return {
			name,
			label: tool.title ?? tool.name,
			description: tool.description ?? `MCP tool ${tool.name} from ${server.config.name}`,
			promptSnippet: `MCP ${server.config.name}: ${tool.title ?? tool.name}`,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
			namespace: { name: `mcp__${server.config.id}`, aliases: [server.config.name], description: `Tools from MCP server ${server.config.name}` },
			annotations: tool.annotations ? {
				...(tool.annotations.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
				...(tool.annotations.destructiveHint === undefined ? {} : { destructiveHint: tool.annotations.destructiveHint }),
				...(tool.annotations.idempotentHint === undefined ? {} : { idempotentHint: tool.annotations.idempotentHint }),
				...(tool.annotations.openWorldHint === undefined ? {} : { openWorldHint: tool.annotations.openWorldHint }),
			} : undefined,
			async execute(_id, params, signal) {
				if (!client || server.client !== client || server.state !== "connected") {
					return { content: [{ type: "text", text: `MCP server ${server.config.name} is disconnected.` }], details: {}, isError: true };
				}
				try {
					const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
					return { content: toLlmContent(result), details: result.structuredContent ?? {}, isError: result.isError };
				} catch (error) {
					return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
				}
			},
		};
	}
}
