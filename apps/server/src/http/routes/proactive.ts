import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpContext } from "../context.ts";
import { body, json } from "../response.ts";

/** `/api/proactive-gate` 与 `/api/proactive-decisions`：智能插话的全局闸门与最近决策。 */
export async function handleProactiveRoutes(
	ctx: HttpContext,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<boolean> {
	const config = ctx.config.get();
	if (url.pathname === "/api/proactive-gate" && req.method === "GET") {
		json(res, 200, {
			proactiveGate: config.proactiveGate,
			providers: config.providers
				.filter((item) => item.enabled && item.apiKey)
				.map(({ id, name, models }) => ({
					id,
					name,
					models: models.map(({ id: modelId, name: modelName }) => ({ id: modelId, name: modelName })),
				})),
		});
		return true;
	}
	if (url.pathname === "/api/proactive-decisions" && req.method === "GET") {
		json(res, 200, {
			metrics: ctx.proactive.metrics,
			sentToday: ctx.proactive.sentToday(),
			decisions: ctx.proactive.decisions,
		});
		return true;
	}
	if (url.pathname === "/api/proactive-gate" && req.method === "PUT") {
		const input = await body(req);
		const dailyMessageLimit =
			input.dailyMessageLimit === undefined
				? config.proactiveGate.dailyMessageLimit
				: Number(input.dailyMessageLimit);
		const aggregationSeconds =
			input.aggregationSeconds === undefined
				? config.proactiveGate.aggregationSeconds
				: Number(input.aggregationSeconds);
		const cooldownSeconds =
			input.cooldownSeconds === undefined ? config.proactiveGate.cooldownSeconds : Number(input.cooldownSeconds);
		const probabilityPercent =
			input.probabilityPercent === undefined
				? config.proactiveGate.probabilityPercent
				: Number(input.probabilityPercent);
		const quietStart = String(input.quietStart ?? config.proactiveGate.quietStart);
		const quietEnd = String(input.quietEnd ?? config.proactiveGate.quietEnd);
		if (!Number.isInteger(dailyMessageLimit) || dailyMessageLimit < 0 || dailyMessageLimit > 100000) {
			json(res, 400, { ok: false, message: "每日消息上限需为 0 到 100000 的整数" });
			return true;
		}
		// 两个时间参数都不设下限：0 就是「不聚合 / 不冷却」，想 1 秒聚合、10 秒冷却都该允许。
		if (
			!Number.isInteger(aggregationSeconds) ||
			aggregationSeconds < 0 ||
			aggregationSeconds > 60 ||
			!Number.isInteger(cooldownSeconds) ||
			cooldownSeconds < 0 ||
			cooldownSeconds > 86_400
		) {
			json(res, 400, { ok: false, message: "聚合窗口需为 0 到 60 秒，冷却需为 0 到 86400 秒" });
			return true;
		}
		if (!Number.isInteger(probabilityPercent) || probabilityPercent < 1 || probabilityPercent > 100) {
			json(res, 400, { ok: false, message: "抽样概率需为 1 到 100%" });
			return true;
		}
		const mode = input.mode === undefined ? config.proactiveGate.mode : input.mode;
		if (mode !== "smart" && mode !== "probability") {
			json(res, 400, { ok: false, message: "插话模式无效" });
			return true;
		}
		if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)) {
			json(res, 400, { ok: false, message: "请填写有效的静默时段" });
			return true;
		}
		const judgeProviderId = String(input.judgeProviderId ?? config.proactiveGate.judgeProviderId);
		const judgeModelId = String(input.judgeModelId ?? config.proactiveGate.judgeModelId);
		const enabled = input.enabled === undefined ? config.proactiveGate.enabled : input.enabled === true;
		if (
			enabled &&
			mode === "smart" &&
			!config.providers.some(
				(item) =>
					item.id === judgeProviderId &&
					item.enabled &&
					item.apiKey &&
					item.models.some((model) => model.id === judgeModelId),
			)
		) {
			json(res, 400, { ok: false, message: "智能判断模式需选择已配置的判断模型" });
			return true;
		}
		config.proactiveGate = {
			enabled,
			mode,
			probabilityPercent,
			dailyMessageLimit,
			quietStart,
			quietEnd,
			notifyOnLimit:
				input.notifyOnLimit === undefined ? config.proactiveGate.notifyOnLimit : input.notifyOnLimit === true,
			aggregationSeconds,
			cooldownSeconds,
			judgeProviderId,
			judgeModelId,
		};
		await ctx.config.save();
		ctx.log("INFO", "主动行为全局限制已更新");
		json(res, 200, { ok: true, proactiveGate: config.proactiveGate });
		return true;
	}
	return false;
}
