import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { json } from "../response.ts";

/** 当天 0 点（服务器本地时区）。「今日」的口径只在这里定义一次。 */
function startOfToday(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * `/api/overview`：首页概览。
 *
 * 一次请求给齐所有指标，前端只渲染、不做聚合——否则「今日」的算法会在前后端各写一遍，
 * 迟早对不上。没有数据源的指标（成功率、平均耗时）不在这里编造。
 */
export async function handleOverviewRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	if (url.pathname !== "/api/overview" || req.method !== "GET") return false;

	const since = startOfToday();
	const now = Date.now();
	const sessions = ctx.sessions.get();

	let messages = 0;
	const activePeers = new Set<string>();
	for (const session of sessions) {
		const created = Date.parse(session.createdAt);
		for (const message of session.messages) {
			if (Date.parse(message.timestamp) < since) continue;
			messages += 1;
			activePeers.add(`${session.botId}:${session.scope}:${session.peerId}`);
		}
		if (created >= since) activePeers.add(`${session.botId}:${session.scope}:${session.peerId}`);
	}

	const states = [...ctx.qq.states.values()];
	const errorsLast24h = ctx.logs
		.list()
		.filter((entry) => entry.level === "ERROR" && now - Date.parse(entry.time) <= 86_400_000).length;

	json(res, 200, {
		version: ctx.version,
		uptimeSeconds: Math.floor(process.uptime()),
		today: {
			messages,
			sessions: sessions.filter((session) => Date.parse(session.createdAt) >= since).length,
			activePeers: activePeers.size,
			proactiveSent: ctx.proactive.sentToday(),
			proactiveBlocked: ctx.proactive.metrics.blocked,
		},
		bots: {
			online: states.filter((state) => state.phase === "connected").length,
			total: ctx.qq.states.size,
		},
		errorsLast24h,
		// Token 用量要按天累计（AgentSession 的 usage 是实时值），单独一轮做；这里显式给 null，
		// 前端据此显示「未统计」而不是 0——0 会被读成「今天没花钱」。
		tokens: null,
	});
	return true;
}
