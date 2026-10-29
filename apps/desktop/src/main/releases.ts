import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 从 GitHub Release 取服务端版本，并下载校验。
 *
 * 信任模型（与用户确认的方案一致）：只校验 `sha256`。
 * GitHub 的 release assets API 会给每个 asset 一个 `digest: "sha256:<hex>"`，
 * 我们下载后重算摘要并比对；不匹配就删掉，绝不执行。这挡的是传输损坏与
 * 中间人替换，挡不住「上游仓库本身被投毒」——那需要签名 manifest，v1 不做。
 *
 * 请求 GitHub 不带凭据，因此受未认证限流（60 次/小时/IP），列表结果缓存 6 小时。
 */

const DEFAULT_REPO = "WEP-56/MiuBot";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const ERROR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** 服务端版本包的文件名约定，与 `.github/workflows/release.yml` 里的打包步骤一致。 */
export const SERVICE_ASSET_PATTERN = /^miubot-win-x64-(v[0-9][^/]*)\.zip$/;

export type ReleaseAsset = { name: string; url: string; size: number; sha256: string };

export type Release = {
	/** 去掉 `v` 的版本号。 */
	version: string;
	tag: string;
	publishedAt: string | null;
	prerelease: boolean;
	asset: ReleaseAsset | null;
};

export type ReleaseList = {
	releases: Release[];
	error: string | null;
	checkedAt: string | null;
};

export type ReleaseFetcherOptions = {
	repo?: string;
	ttlMs?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
};

export type ReleaseFetcher = {
	list(force?: boolean): Promise<ReleaseList>;
};

type RawAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown };
type RawRelease = {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	published_at?: unknown;
	assets?: unknown;
};

export function createReleaseFetcher(options: ReleaseFetcherOptions = {}): ReleaseFetcher {
	const repo = options.repo?.trim() || DEFAULT_REPO;
	const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now;

	let cached: { value: ReleaseList; expiresAt: number } | undefined;
	let inflight: Promise<ReleaseList> | undefined;

	async function fetchList(): Promise<ReleaseList> {
		const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
			headers: { accept: "application/vnd.github+json", "user-agent": `miubot-desktop` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (response.status === 403 || response.status === 429)
			throw new Error(`GitHub 限流（HTTP ${response.status}），稍后再试`);
		if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
		const payload = (await response.json()) as unknown;
		if (!Array.isArray(payload)) throw new Error("响应格式不是预期的列表");
		const releases: Release[] = [];
		for (const entry of payload as RawRelease[]) {
			const release = parseRelease(entry);
			if (release) releases.push(release);
		}
		return { releases, error: null, checkedAt: new Date(now()).toISOString() };
	}

	async function run(): Promise<ReleaseList> {
		try {
			const value = await fetchList();
			cached = { value, expiresAt: now() + ttl };
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const value: ReleaseList = {
				releases: cached?.value.releases ?? [],
				error: message.slice(0, 200),
				checkedAt: cached?.value.checkedAt ?? null,
			};
			// 失败只缓存 5 分钟：GitHub 短暂抽风不该让界面在 6 小时里都显示旧列表。
			cached = { value, expiresAt: now() + ERROR_TTL_MS };
			return value;
		}
	}

	return {
		async list(force = false) {
			if (!force && cached && cached.expiresAt > now()) return cached.value;
			inflight ??= run().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
	};
}

/** 过滤掉草稿、无版本号、以及**没有** Windows 服务包的 release：装了也起不来。 */
function parseRelease(entry: RawRelease): Release | undefined {
	if (entry.draft === true) return undefined;
	const tag = typeof entry.tag_name === "string" ? entry.tag_name.trim() : "";
	if (!tag) return undefined;
	const version = tag.replace(/^v/i, "");
	if (!/^\d/.test(version)) return undefined;
	const assets = Array.isArray(entry.assets) ? (entry.assets as RawAsset[]) : [];
	let asset: ReleaseAsset | undefined;
	for (const item of assets) {
		const name = typeof item.name === "string" ? item.name : "";
		if (!SERVICE_ASSET_PATTERN.test(name)) continue;
		const url = typeof item.browser_download_url === "string" ? item.browser_download_url : "";
		const digest = typeof item.digest === "string" ? item.digest.trim().toLowerCase() : "";
		// 没有 sha256 摘要的资产一律不认：无法校验就等于无法安全执行。
		if (!url.startsWith("https://") || !digest.startsWith("sha256:")) continue;
		const sha256 = digest.slice("sha256:".length);
		if (!/^[a-f0-9]{64}$/.test(sha256)) continue;
		asset = {
			name,
			url,
			size: typeof item.size === "number" ? item.size : 0,
			sha256,
		};
		break;
	}
	if (!asset) return undefined;
	return {
		version,
		tag,
		publishedAt: typeof entry.published_at === "string" ? entry.published_at : null,
		prerelease: entry.prerelease === true,
		asset,
	};
}

export type DownloadOptions = {
	onProgress?: (received: number, total: number) => void;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
};

export type DownloadResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * 下载并校验服务包。
 *
 * 先写 `.part` 再改名：中途失败或摘要不符时只留一个可删的临时文件，
 * 不会让调用方拿到「看起来完整」的包。
 */
export async function downloadVerified(
	asset: ReleaseAsset,
	targetPath: string,
	options: DownloadOptions = {},
): Promise<DownloadResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const partial = `${targetPath}.part`;
	await mkdir(dirname(targetPath), { recursive: true });
	try {
		const response = await fetchImpl(asset.url, {
			redirect: "follow",
			headers: { accept: "application/octet-stream", "user-agent": "miubot-desktop" },
			// 下载可能要几分钟，给一个宽松的上限；`AbortSignal.timeout` 是从发起时开始算的总时长。
			signal: AbortSignal.timeout(options.timeoutMs ?? 15 * 60 * 1000),
		});
		if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
		if (!response.body) throw new Error("下载响应没有正文");
		const total = Number(response.headers.get("content-length") ?? asset.size) || 0;
		let received = 0;
		const hash = createHash("sha256");
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				received += chunk.length;
				hash.update(chunk);
				options.onProgress?.(received, total);
				callback(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial));
		const actual = hash.digest("hex");
		if (actual !== asset.sha256) {
			await rm(partial, { force: true });
			return { ok: false, message: `校验失败：期望 ${asset.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…` };
		}
		await rename(partial, targetPath);
		return { ok: true, path: targetPath };
	} catch (error) {
		await rm(partial, { force: true }).catch(() => undefined);
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 版本是否完整装好：只看服务端入口在不在。
 *
 * Node 运行时是共用的（不随版本落盘），所以这里不检查 `node.exe`；
 * 「Node 缺失」属于安装包完整性/构建问题，不属于单个版本的状态。
 */
export async function isVersionInstalled(entry: string): Promise<boolean> {
	try {
		const info = await stat(entry);
		return info.isFile();
	} catch {
		return false;
	}
}
