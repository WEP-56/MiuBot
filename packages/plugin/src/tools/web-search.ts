import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/index.ts";

export type WebSearchProvider = "tavily" | "brave" | "exa" | "serper";
export type WebSearchConfig = { provider: WebSearchProvider; apiKeys: Record<WebSearchProvider, string> };

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of results" })),
});

export function createWebSearchTool(getConfig: () => WebSearchConfig): ToolDefinition<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "Web Search",
		description: "Search the public web and return titles, URLs, and short snippets.",
		promptSnippet: "Search the web for current information",
		defaultActive: true,
		parameters: webSearchSchema,
		async execute(_id, params, signal) {
			const { provider, apiKeys } = getConfig();
			const apiKey = apiKeys[provider];
			if (!apiKey)
				return {
					content: [{ type: "text", text: `Configure a ${provider} API key in Advanced > Tools first.` }],
					details: {},
					isError: true,
				};
			const count = Math.min(10, Math.max(1, params.count ?? 5));
			let endpoint: string;
			let headers: Record<string, string>;
			let payload: unknown;
			switch (provider) {
				case "tavily":
					endpoint = "https://api.tavily.com/search";
					headers = { "content-type": "application/json" };
					payload = { api_key: apiKey, query: params.query, max_results: count, include_answer: false };
					break;
				case "brave":
					endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;
					headers = { "x-subscription-token": apiKey, accept: "application/json" };
					payload = undefined;
					break;
				case "exa":
					endpoint = "https://api.exa.ai/search";
					headers = { "content-type": "application/json", "x-api-key": apiKey };
					payload = { query: params.query, numResults: count, contents: { text: { maxCharacters: 1200 } } };
					break;
				case "serper":
					endpoint = "https://google.serper.dev/search";
					headers = { "content-type": "application/json", "x-api-key": apiKey };
					payload = { q: params.query, num: count };
					break;
			}
			try {
				const response = await fetch(endpoint, {
					method: payload === undefined ? "GET" : "POST",
					headers,
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
					signal,
				});
				const data: unknown = await response.json();
				if (!response.ok)
					return {
						content: [{ type: "text", text: `Search provider returned HTTP ${response.status}` }],
						details: {},
						isError: true,
					};
				const object = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
				const rawResults =
					provider === "tavily"
						? object.results
						: provider === "brave"
							? (object.web as { results?: unknown[] } | undefined)?.results
							: provider === "exa"
								? object.results
								: object.organic;
				const results = Array.isArray(rawResults)
					? rawResults.slice(0, count).map((item) => {
							const result = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
							return {
								title: String(result.title ?? ""),
								url: String(result.url ?? result.link ?? ""),
								snippet: String(result.content ?? result.description ?? result.snippet ?? result.text ?? ""),
							};
						})
					: [];
				return {
					content: [
						{
							type: "text",
							text: results.length
								? results
										.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`)
										.join("\n\n")
								: "No results found.",
						},
					],
					details: {},
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
