/**
 * 按目标（Bot + 对象）串行化任务队列。
 *
 * 同一对象的回复必须串行：并发跑 Agent 会让上下文互相覆盖。不同对象之间不阻塞。
 * 队列里保留的是「永远 resolve」的 Promise，避免一次失败把后续任务卡死。
 */
const queues = new Map<string, Promise<void>>();

export function enqueueForTarget(key: string, task: () => Promise<void>): Promise<void> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(() => task());
	queues.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}
