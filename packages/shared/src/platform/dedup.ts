/**
 * 有界去重器（LRU + TTL）。
 *
 * 平台重连后会重投事件，没有去重时同一条消息可能触发重复回复与重复副作用。
 * 平台层用它按消息 id 去重，插件宿主用它按事件的 `dedupKey` 去重。
 */
export type DeduplicatorOptions = { maxEntries?: number; ttlMs?: number; now?: () => number };

export function createDeduplicator(options: DeduplicatorOptions = {}) {
	const maxEntries = options.maxEntries ?? 2_000;
	const ttlMs = options.ttlMs ?? 10 * 60_000;
	const now = options.now ?? Date.now;
	const seen = new Map<string, number>();

	return {
		/** 首次出现返回 true；重复或已过期返回 false。 */
		shouldProcess(key: string): boolean {
			const timestamp = now();
			for (const [entryKey, seenAt] of seen) {
				if (timestamp - seenAt <= ttlMs) break;
				seen.delete(entryKey);
			}
			const existing = seen.get(key);
			if (existing !== undefined && timestamp - existing <= ttlMs) return false;
			seen.delete(key);
			seen.set(key, timestamp);
			while (seen.size > maxEntries) {
				const oldest = seen.keys().next().value;
				if (oldest === undefined) break;
				seen.delete(oldest);
			}
			return true;
		},
		/** 回滚一个已登记但未实际处理的 key，用于处理失败后允许重试。 */
		forget(key: string): void {
			seen.delete(key);
		},
		get size(): number {
			return seen.size;
		},
	};
}

export type Deduplicator = ReturnType<typeof createDeduplicator>;
