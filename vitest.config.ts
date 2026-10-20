import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = ["shared", "context", "plugin", "session", "provider", "agent", "telemetry", "mcp"];

const srcPath = (name: string, subpath: string): string =>
	fileURLToPath(new URL(`./packages/${name}/src/${subpath}`, import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: packages.flatMap((name) => [
			{ find: new RegExp(`^@miubot/${name}$`), replacement: srcPath(name, "index.ts") },
			{ find: new RegExp(`^@miubot/${name}/(.*)$`), replacement: srcPath(name, "$1.ts") },
		]),
	},
	ssr: { resolve: { conditions: ["source"] } },
});