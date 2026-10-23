import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { CommandCatalogEntry } from "../src/commands/index.ts";
import type { HttpContext } from "../src/http/context.ts";
import { handleCommandRoutes } from "../src/http/routes/commands.ts";
import { type AppConfig, createDefaultConfig } from "../src/runtime.ts";

type Call = { status: number; body: Record<string, unknown> };

/**
 * 只搭路由需要的依赖：`config` 与只读命令清单。
 *
 * 命令的注册由代码与插件决定，路由只改「谁关着、谁是管理员」——测试也只看这两项
 * 有没有真的写进配置并落盘。
 */
function harness() {
	let config: AppConfig = createDefaultConfig();
	let saves = 0;
	const log = vi.fn();
	const catalog: CommandCatalogEntry[] = [
		{ name: "new", description: "结束当前会话", permission: "all", source: "builtin", enabled: true },
		{ name: "admin", description: "查看运行状态", permission: "admin", source: "builtin", enabled: false },
	];
	const ctx = {
		config: {
			get: () => config,
			replace: (next: AppConfig) => {
				config = next;
			},
			save: async () => {
				saves += 1;
			},
		},
		commands: { list: () => catalog },
		log,
	} as unknown as HttpContext;

	async function call(method: string, payload?: unknown): Promise<Call> {
		const url = new URL("/api/commands", "http://127.0.0.1");
		const req = {
			method,
			url: "/api/commands",
			headers: {},
			async *[Symbol.asyncIterator]() {
				if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
			},
		} as unknown as IncomingMessage;
		let status = 0;
		let text = "";
		const res = {
			writeHead: (code: number) => {
				status = code;
				return res;
			},
			setHeader: () => res,
			end: (chunk?: string) => {
				text = chunk ?? "";
			},
		} as unknown as ServerResponse;
		const handled = await handleCommandRoutes(ctx, req, res, url);
		if (!handled) throw new Error(`路由未处理：${method} /api/commands`);
		return { status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
	}

	return { ctx, call, log, saves: () => saves, config: () => config };
}

describe("/api/commands", () => {
	it("返回命令清单、管理员与禁用状态", async () => {
		const h = harness();
		const { status, body } = await h.call("GET");

		expect(status).toBe(200);
		expect(body.admins).toEqual([]);
		expect(body.disabled).toEqual([]);
		// 空名单 = 没有人能执行管理员命令，前端据此显示提示。
		expect(body.adminsConfigured).toBe(false);
		expect((body.commands as CommandCatalogEntry[]).map((entry) => entry.name)).toEqual(["new", "admin"]);
	});

	it("保存管理员名单并落盘", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { admins: ["user-1", " user-1 ", "", "user-2"] });

		expect(status).toBe(200);
		// 去空行、去重：同一个 openid 写两遍不该变成两个管理员。
		expect(body.admins).toEqual(["user-1", "user-2"]);
		expect(body.adminsConfigured).toBe(true);
		expect(h.config().admins).toEqual(["user-1", "user-2"]);
		expect(h.saves()).toBe(1);
		// 名单里有 openid，日志只报数量。
		expect(h.log).toHaveBeenCalledWith("INFO", expect.stringContaining("管理员 2 人"));
	});

	it("保存禁用清单时容忍带斜杠的写法", async () => {
		const h = harness();
		const { status, body } = await h.call("PUT", { disabled: ["/new", "ADMIN", "new"] });

		expect(status).toBe(200);
		expect(body.disabled).toEqual(["new", "admin"]);
		expect(h.config().commands.disabled).toEqual(["new", "admin"]);
	});

	it("只提交一个字段时不覆盖另一个", async () => {
		const h = harness();
		await h.call("PUT", { admins: ["user-1"] });
		const { body } = await h.call("PUT", { disabled: ["new"] });

		expect(body.admins).toEqual(["user-1"]);
		expect(body.disabled).toEqual(["new"]);
	});

	it("拒绝非数组与非法命令名", async () => {
		const h = harness();
		expect((await h.call("PUT", { admins: "user-1" })).status).toBe(400);
		expect((await h.call("PUT", { disabled: "new" })).status).toBe(400);
		expect((await h.call("PUT", { disabled: ["bad name"] })).status).toBe(400);
		// 校验失败不落盘，配置保持原样。
		expect(h.saves()).toBe(0);
		expect(h.config().admins).toEqual([]);
	});
});
