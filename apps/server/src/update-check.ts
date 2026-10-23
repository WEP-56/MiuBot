import { isNewerVersion, normalize } from "./version.ts";

/**
 * 内置更新检查。
 *
 * 只做「有没有新版本」的提示，**不做自动更新**：这套系统的权限本质是「能装任意代码」，
 * 自动拉取并执行远端产物等于把升级通道变成第二条攻击面。要不要升、什么时候升由管理员决定。
 *
 * 请求的是 GitHub 公开 API，不带任何标识（除 User-Agent），结果缓存 6 小时——
 * 未认证接口每小时 60 次，工作台轮询不会打满。
 */

export type UpdateStatus = {
	/** 检查功能是否开启（`MIUBOT_UPDATE_CHECK=0` 可关）。 */
	enabled: boolean;
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	/** 最新 release 的页面地址。 */
	url: string | null;
	publishedAt: string | null;
	/** 上次成功检查的时间（ISO）。 */
	checkedAt: string | null;
	error: string | null;
};

export type UpdateChecker = {
	/** 取状态；缓存未过期时直接返回。`force` 绕过缓存（工作台的「立即检查」）。 */
	status(force?: boolean): Promise<UpdateStatus>;
	/** 启动时预热一次，失败静默。 */
	warm(): void;
};

export type UpdateCheckerOptions = {
	currentVersion: string;
	/** `owner/repo`；默认本仓库。 */
	repo?: string;
	enabled?: boolean;
	cacheTtlMs?: number;
	timeoutMs?: number;
	/** 测试注入。 */
	fetchImpl?: typeof fetch;
	now?: () => number;
};

const DEFAULT_REPO = "WEP-56/MiuBot";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** 失败也缓存一会儿：GitHub 挂了不该被工作台轮询打成重试风暴。 */
const ERROR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
	const repo = options.repo?.trim() || DEFAULT_REPO;
	const enabled = options.enabled ?? true;
	const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;

	let cached: { status: UpdateStatus; expiresAt: number } | undefined;
	let inflight: Promise<UpdateStatus> | undefined;

	function base(error: string | null = null): UpdateStatus {
		return {
			enabled,
			current: options.currentVersion,
			latest: null,
			updateAvailable: false,
			url: null,
			publishedAt: null,
			checkedAt: null,
			error,
		};
	}

	async function fetchLatest(): Promise<UpdateStatus> {
		const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": `miubot/${options.currentVersion}`,
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 404) throw new Error("仓库还没有发布过版本");
		if (response.status === 403 || response.status === 429)
			throw new Error(`GitHub 限流（HTTP ${response.status}），稍后再试`);
		if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
		const payload = (await response.json()) as {
			tag_name?: unknown;
			html_url?: unknown;
			published_at?: unknown;
		};
		if (typeof payload.tag_name !== "string" || !payload.tag_name.trim()) throw new Error("响应里没有版本号");
		const latest = normalize(payload.tag_name);
		return {
			enabled,
			current: options.currentVersion,
			latest,
			updateAvailable: isNewerVersion(latest, options.currentVersion),
			url: typeof payload.html_url === "string" ? payload.html_url : null,
			publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
			checkedAt: new Date(now()).toISOString(),
			error: null,
		};
	}

	async function run(): Promise<UpdateStatus> {
		try {
			const status = await fetchLatest();
			cached = { status, expiresAt: now() + ttl };
			return status;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const status = base(detail.slice(0, 200));
			cached = { status, expiresAt: now() + ERROR_TTL_MS };
			return status;
		}
	}

	const api: UpdateChecker = {
		async status(force = false) {
			if (!enabled) return base();
			if (!force && cached && cached.expiresAt > now()) return cached.status;
			// 并发调用共享同一次请求：工作台多个页面同时问也只打一次 GitHub。
			inflight ??= run().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
		warm() {
			if (!enabled) return;
			void api.status().catch(() => undefined);
		},
	};
	return api;
}
