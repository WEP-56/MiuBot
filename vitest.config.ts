import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["{apps,packages}/*/test/**/*.test.ts"],
		// example/ 与 ui-ux-design/ 是本地参考素材，不纳入版本库，也不参与测试。
		exclude: ["**/node_modules/**", "**/dist/**", "example/**", "ui-ux-design/**"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
