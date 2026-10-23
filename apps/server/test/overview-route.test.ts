import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HttpContext } from "../src/http/context.ts";
import { handleOverviewRoutes } from "../src/http/routes/overview.ts";

type Body = {
	version: string;
	uptimeSeconds: number;
	today: { messages: number; sessions: number; activePeers: number; proactiveSent: number; proactiveBlocked: number };
	bots: { online: number; total: number };
	errorsLast24h: number;
	tokens: unknown;
};

const HOUR = 3_600_000;

/** 今天 0 点之后、与 24 小时前的两个时间点，避免测试在跨天瞬间抖动。 */
function times() {
	const now = Date.now();
	const startOfToday = new Date().getFullYear();
	void startOfToday;
	const todayIso = new Date(Math.max(Date.parse(new Date().toDateString()), now - HOUR)).toISOString();
	const oldIso = new Date(now - 48 * HOUR).toISOString();
	return { todayIso, oldIso };
}

function harness() {
	const { todayIso, oldIso } = times();
	const sessions = [
		{
			id: "s1",
			botId: "bot-1",
			scope: "group",
			peerId: "g1",
			createdAt: todayIso,
			messages: [
				{ role: "user", content: "a", timestamp: todayIso },
				{ role: "assistant", content: "b", timestamp: todayIso },
			],
		},
		{
			id: "s2",
			botId: "bot-1",
			scope: "c2c",
			peerId: "u1",
			createdAt: oldIso,
			messages: [{ role: "user", content: "c", timestamp: oldIso }],
		},
	];
	const ctx = {
		sessions: { get: () => sessions },
		qq: {
			states: new Map([
				["bot-1", { phase: "connected" }],
				["bot-2", { phase: "disconnected" }],
			]),
		},
		proactive: { sentToday: () => 4, metrics: { blocked: 2 } },
		logs: {
			list: () => [
				{ time: new Date().toISOString(), level: "ERROR", text: "boom" },
				{ time: oldIso, level: "ERROR", text: "old" },
				{ time: new Date().toISOString(), level: "INFO", text: "ok" },
			],
		},
		version: "0.9.4",
	} as unknown as HttpContext;

	async function call(): Promise<Body> {
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
		const handled = await handleOverviewRoutes(
			ctx,
			{ method: "GET", url: "/api/overview", headers: {} } as unknown as IncomingMessage,
			res,
			new URL("/api/overview", "http://127.0.0.1"),
		);
		expect(handled).toBe(true);
		expect(status).toBe(200);
		return JSON.parse(text) as Body;
	}

	return { call };
}

describe("/api/overview", () => {
	it("只统计今天的数据", async () => {
		const body = await harness().call();
		// s1 的两条是今天的；s2 是 48 小时前的。
		expect(body.today.messages).toBe(2);
		expect(body.today.sessions).toBe(1);
		expect(body.today.activePeers).toBe(1);
	});

	it("在线 Bot 只数 connected，总数取自连接状态表", async () => {
		const body = await harness().call();
		expect(body.bots).toEqual({ online: 1, total: 2 });
	});

	it("近 24 小时错误只数 ERROR", async () => {
		const body = await harness().call();
		expect(body.errorsLast24h).toBe(1);
	});

	it("主动消息带被拦截数", async () => {
		const body = await harness().call();
		expect(body.today.proactiveSent).toBe(4);
		expect(body.today.proactiveBlocked).toBe(2);
	});

	it("Token 用量未接入时给 null 而不是 0", async () => {
		const body = await harness().call();
		// 0 会被前端读成「今天没花钱」，null 才能显示「未统计」。
		expect(body.tokens).toBeNull();
	});

	it("非 GET / 其它路径不接管", async () => {
		const handled = await handleOverviewRoutes(
			{ sessions: { get: () => [] } } as unknown as HttpContext,
			{ method: "POST", url: "/api/overview", headers: {} } as unknown as IncomingMessage,
			{ writeHead: () => ({ end: () => {} }), setHeader: () => {}, end: () => {} } as unknown as ServerResponse,
			new URL("/api/overview", "http://127.0.0.1"),
		);
		expect(handled).toBe(false);
		void vi;
	});
});
