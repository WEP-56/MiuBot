/**
 * 按来源的简单令牌桶限速（单实例、内存即可）。
 *
 * 管理 API 没有集群，也没有可信的客户端 IP（不读 `X-Forwarded-*`），所以：
 * 按 TCP 对端地址记账，反代后面所有请求都落在同一个桶里 —— 对单管理员工作台正合适。
 */

export type RateLimiter = {
	/** 取一个令牌；返回 false 表示超限。 */
	take(key: string): boolean;
};

export type RateLimitOptions = {
	/** 桶容量（突发上限）。 */
	capacity: number;
	/** 每秒补充的令牌数（持续速率）。 */
	refillPerSecond: number;
	now?: () => number;
};

/** 闲置桶的清理间隔：不清理的话，按 IP 记账的表会随扫描流量无限增长。 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
	const now = options.now ?? Date.now;
	const buckets = new Map<string, { tokens: number; updatedAt: number }>();
	let lastSweep = now();

	return {
		take(key) {
			const time = now();
			if (time - lastSweep > SWEEP_INTERVAL_MS) {
				lastSweep = time;
				for (const [entry, bucket] of buckets) if (time - bucket.updatedAt > IDLE_MS) buckets.delete(entry);
			}
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = { tokens: options.capacity, updatedAt: time };
				buckets.set(key, bucket);
			}
			const elapsedSeconds = Math.max(0, time - bucket.updatedAt) / 1000;
			bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
			bucket.updatedAt = time;
			if (bucket.tokens < 1) return false;
			bucket.tokens -= 1;
			return true;
		},
	};
}
