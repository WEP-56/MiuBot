/**
 * 插件实例的生命周期与资源栈。
 *
 * 事件总线的超时机制只让分发继续，**不会**停止已经在跑的异步 Handler。单纯 `abort()`
 * 也不够——插件可以完全不理会信号。因此这里额外维护「运行代次」：
 * 每次停用或重启用都会递增代次，能力接口在每次调用时校验代次，旧回合发出的调用一律拒绝。
 */

export type PluginLifecycleState = "inactive" | "loading" | "active" | "failed";

/** 已失效的插件能力调用。宿主接口抛出它，而不是静默丢弃。 */
export class PluginInactiveError extends Error {
	readonly pluginId: string;

	constructor(pluginId: string, detail: string) {
		super(`插件 ${pluginId} 不可用：${detail}`);
		this.name = "PluginInactiveError";
		this.pluginId = pluginId;
	}
}

export type Disposer = () => void | Promise<void>;

export type LifecycleHooks = {
	/** 状态变化通知，用于日志与工作台。 */
	onStateChange?: (state: PluginLifecycleState, detail?: { error?: string }) => void;
};

export function createPluginLifecycle(pluginId: string, hooks: LifecycleHooks = {}) {
	let state: PluginLifecycleState = "inactive";
	let generation = 0;
	let controller = new AbortController();
	const disposers: Disposer[] = [];

	function setState(next: PluginLifecycleState, detail?: { error?: string }): void {
		state = next;
		hooks.onStateChange?.(next, detail);
	}

	/** 登记一个清理函数。返回撤销函数，用于插件自行提前释放（例如取消某个订阅）。 */
	function track(disposer: Disposer): () => void {
		disposers.push(disposer);
		return () => {
			const index = disposers.indexOf(disposer);
			if (index >= 0) disposers.splice(index, 1);
		};
	}

	/** 校验插件仍处于可信状态。能力接口每次调用都应先过这一关。 */
	function assertActive(action: string): void {
		// `loading` 期间允许登记能力：插件的 setup() 正是在这个阶段订阅事件、注册清理函数。
		// 但 `inactive` / `failed` 一律拒绝，停用后旧任务无法再调用宿主能力。
		if (state !== "active" && state !== "loading") {
			throw new PluginInactiveError(pluginId, `${action}（当前状态：${state}）`);
		}
	}

	/** 校验代次：异步任务跨越停用边界后必须被拒绝，即使插件忽略了取消信号。 */
	function assertGeneration(seen: number, action: string): void {
		if (seen !== generation || (state !== "active" && state !== "loading")) {
			throw new PluginInactiveError(pluginId, `${action}（插件已停用或已重新加载）`);
		}
	}

	function begin(): { generation: number; signal: AbortSignal } {
		state = "loading";
		controller = new AbortController();
		return { generation, signal: controller.signal };
	}

	/** 标记启用完成，此前登记的清理函数保留。 */
	function activate(): void {
		setState("active");
	}

	/**
	 * 停用：先发取消信号，再递增代次，最后逐个执行清理。
	 *
	 * 顺序很重要——代次先递增，能让正在等待的 Handler 在清理期间就被拒绝；
	 * 清理函数本身失败不应阻止其它清理执行。
	 */
	async function stop(reason: string): Promise<{ failures: Array<{ error: string }> }> {
		const wasActive = state === "active" || state === "loading";
		controller.abort(new Error(`插件 ${pluginId} 已停用：${reason}`));
		generation += 1;
		setState("inactive");
		const failures: Array<{ error: string }> = [];
		if (!wasActive && disposers.length === 0) return { failures };
		// 后进先出：插件后登记的资源通常依赖先登记的。
		while (disposers.length > 0) {
			const disposer = disposers.pop();
			if (!disposer) break;
			try {
				await disposer();
			} catch (error) {
				failures.push({ error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { failures };
	}

	return {
		begin,
		activate,
		stop,
		track,
		assertActive,
		assertGeneration,
		get state(): PluginLifecycleState {
			return state;
		},
		get generation(): number {
			return generation;
		},
		get signal(): AbortSignal {
			return controller.signal;
		},
		get disposerCount(): number {
			return disposers.length;
		},
		/** 仅供失败路径：记录错误状态，不执行清理。 */
		fail(error: string): void {
			setState("failed", { error });
		},
	};
}

export type PluginLifecycle = ReturnType<typeof createPluginLifecycle>;
