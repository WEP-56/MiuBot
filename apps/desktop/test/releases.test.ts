import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseFetcher, downloadVerified, type ReleaseAsset } from "../src/main/releases.ts";

/**
 * 桌面端的版本获取与下载校验。
 *
 * 这里几乎全是「不该放过什么」的用例：版本列表来自公网，下载下来的东西要被直接执行，
 * 所以解析阶段的过滤和下载后的 sha256 比对是桌面端唯一的安全边界。
 */

const SHA = "a".repeat(64);

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function releaseAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "miubot-win-x64-v0.5.0.zip",
		browser_download_url: "https://github.com/WEP-56/MiuBot/releases/download/v0.5.0/miubot-win-x64-v0.5.0.zip",
		size: 1024,
		digest: `sha256:${SHA}`,
		...overrides,
	};
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: "v0.5.0",
		draft: false,
		prerelease: false,
		published_at: "2026-01-02T03:04:05Z",
		assets: [releaseAsset()],
		...overrides,
	};
}

describe("createReleaseFetcher", () => {
	it("解析出 Windows 服务包与 sha256 摘要", async () => {
		const fetcher = createReleaseFetcher({
			fetchImpl: async () => jsonResponse([release()]),
			now: () => 0,
		});
		const list = await fetcher.list();
		expect(list.error).toBeNull();
		expect(list.releases).toHaveLength(1);
		const first = list.releases[0];
		expect(first?.version).toBe("0.5.0");
		expect(first?.tag).toBe("v0.5.0");
		expect(first?.asset?.sha256).toBe(SHA);
	});

	it("跳过草稿与没有 Windows 服务包的 release", async () => {
		const fetcher = createReleaseFetcher({
			fetchImpl: async () =>
				jsonResponse([
					release({ tag_name: "v0.6.0", draft: true }),
					// 只有源码包：装了也起不来，不该出现在列表里
					release({ tag_name: "v0.4.0", assets: [{ name: "source.zip", browser_download_url: "https://x/y.zip" }] }),
					release({ tag_name: "v0.5.0" }),
				]),
			now: () => 0,
		});
		const list = await fetcher.list();
		expect(list.releases.map((item) => item.version)).toEqual(["0.5.0"]);
	});

	it("没有 sha256 摘要的资产拒绝使用", async () => {
		// GitHub 早期资产没有 digest 字段。没有摘要就没法校验，等于没法安全执行。
		const fetcher = createReleaseFetcher({
			fetchImpl: async () => jsonResponse([release({ assets: [releaseAsset({ digest: undefined })] })]),
			now: () => 0,
		});
		expect((await fetcher.list()).releases).toHaveLength(0);
	});

	it("摘要格式不对或不是 https 的资产拒绝使用", async () => {
		const fetcher = createReleaseFetcher({
			fetchImpl: async () =>
				jsonResponse([
					release({ tag_name: "v1.0.0", assets: [releaseAsset({ digest: "sha256:short" })] }),
					release({ tag_name: "v2.0.0", assets: [releaseAsset({ browser_download_url: "http://x/y.zip" })] }),
				]),
			now: () => 0,
		});
		expect((await fetcher.list()).releases).toHaveLength(0);
	});

	it("命中缓存时不重复请求", async () => {
		let calls = 0;
		const fetcher = createReleaseFetcher({
			fetchImpl: async () => {
				calls += 1;
				return jsonResponse([release()]);
			},
			now: () => 1000,
			ttlMs: 60_000,
		});
		await fetcher.list();
		await fetcher.list();
		expect(calls).toBe(1);
		await fetcher.list(true);
		expect(calls).toBe(2);
	});

	it("失败时保留上一次成功的列表并给出原因", async () => {
		let fail = false;
		let clock = 0;
		const fetcher = createReleaseFetcher({
			fetchImpl: async () => {
				if (fail) throw new Error("网络不可达");
				return jsonResponse([release()]);
			},
			now: () => clock,
			ttlMs: 1000,
		});
		await fetcher.list();
		fail = true;
		clock = 5000;
		const list = await fetcher.list();
		// 断网时本地已安装的版本仍然要能管理，所以这里不能把列表清空。
		expect(list.releases).toHaveLength(1);
		expect(list.error).toContain("网络不可达");
	});

	it("403 被识别为限流", async () => {
		const fetcher = createReleaseFetcher({
			fetchImpl: async () => jsonResponse({ message: "rate limited" }, 403),
			now: () => 0,
		});
		const list = await fetcher.list();
		expect(list.error).toContain("限流");
		expect(list.releases).toEqual([]);
	});
});

describe("downloadVerified", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	async function tempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "miubot-desktop-test-"));
		dirs.push(dir);
		return dir;
	}

	function assetFor(payload: Buffer): ReleaseAsset {
		return {
			name: "miubot-win-x64-v0.5.0.zip",
			url: "https://example.invalid/pkg.zip",
			size: payload.length,
			sha256: createHash("sha256").update(payload).digest("hex"),
		};
	}

	it("校验通过时落盘并改名", async () => {
		const dir = await tempDir();
		const payload = Buffer.from("hello service package");
		const target = join(dir, "pkg.zip");
		const result = await downloadVerified(assetFor(payload), target, {
			fetchImpl: async () => new Response(payload),
		});
		expect(result.ok).toBe(true);
		expect((await readFile(target)).equals(payload)).toBe(true);
	});

	it("摘要不符时报错并且不留文件", async () => {
		const dir = await tempDir();
		const payload = Buffer.from("tampered package");
		const target = join(dir, "pkg.zip");
		const asset = { ...assetFor(payload), sha256: "b".repeat(64) };
		const result = await downloadVerified(asset, target, { fetchImpl: async () => new Response(payload) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("校验失败");
		// 绝不能留下一个「看起来完整」的包：下次启动不能误把它当已下载。
		await expect(readFile(target)).rejects.toThrow();
		await expect(readFile(`${target}.part`)).rejects.toThrow();
	});

	it("HTTP 错误码转成可读信息", async () => {
		const dir = await tempDir();
		const result = await downloadVerified(assetFor(Buffer.from("x")), join(dir, "pkg.zip"), {
			fetchImpl: async () => new Response("nope", { status: 404 }),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("404");
	});

	it("进度回调报告累计字节", async () => {
		const dir = await tempDir();
		const payload = Buffer.alloc(64 * 1024, 7);
		const seen: number[] = [];
		await downloadVerified(assetFor(payload), join(dir, "pkg.zip"), {
			fetchImpl: async () => new Response(payload),
			onProgress: (received) => seen.push(received),
		});
		expect(seen.at(-1)).toBe(payload.length);
	});
});
