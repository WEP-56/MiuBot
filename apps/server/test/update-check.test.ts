import { describe, expect, it } from "vitest";
import { createUpdateChecker } from "../src/update-check.ts";

type Call = { url: string; headers: Record<string, string> | undefined };

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(input), headers: init?.headers as Record<string, string> | undefined };
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function release(tag: string, extra: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			tag_name: tag,
			html_url: `https://github.com/WEP-56/MiuBot/releases/tag/${tag}`,
			published_at: "2026-10-23T00:00:00Z",
			...extra,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("update checker", () => {
	it("reports an available update", async () => {
		const { fetchImpl, calls } = stubFetch(() => release("v0.2.0"));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		const status = await checker.status();
		expect(status).toMatchObject({
			enabled: true,
			current: "0.1.0",
			latest: "0.2.0",
			updateAvailable: true,
			error: null,
		});
		expect(status.url).toContain("releases/tag/v0.2.0");
		expect(status.checkedAt).toBeTruthy();
		expect(calls[0]?.url).toBe("https://api.github.com/repos/WEP-56/MiuBot/releases/latest");
		expect(calls[0]?.headers?.["user-agent"]).toBe("miubot/0.1.0");
	});

	it("reports no update when the installed version is current or newer", async () => {
		const same = createUpdateChecker({
			currentVersion: "0.2.0",
			fetchImpl: stubFetch(() => release("v0.2.0")).fetchImpl,
		});
		expect((await same.status()).updateAvailable).toBe(false);

		const ahead = createUpdateChecker({
			currentVersion: "0.3.0",
			fetchImpl: stubFetch(() => release("v0.2.0")).fetchImpl,
		});
		expect((await ahead.status()).updateAvailable).toBe(false);
	});

	it("caches the result and only bypasses the cache when forced", async () => {
		const { fetchImpl, calls } = stubFetch(() => release("v0.2.0"));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		await checker.status();
		await checker.status();
		expect(calls).toHaveLength(1);
		await checker.status(true);
		expect(calls).toHaveLength(2);
	});

	it("shares one request between concurrent callers", async () => {
		const { fetchImpl, calls } = stubFetch(() => release("v0.2.0"));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		const [first, second] = await Promise.all([checker.status(), checker.status()]);
		expect(calls).toHaveLength(1);
		expect(first.latest).toBe("0.2.0");
		expect(second.latest).toBe("0.2.0");
	});

	it("turns HTTP errors into a status instead of throwing", async () => {
		const { fetchImpl } = stubFetch(() => new Response("{}", { status: 500 }));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		const status = await checker.status();
		expect(status.error).toContain("500");
		expect(status.latest).toBeNull();
		expect(status.updateAvailable).toBe(false);
	});

	it("explains rate limiting and missing releases", async () => {
		const limited = createUpdateChecker({
			currentVersion: "0.1.0",
			fetchImpl: stubFetch(() => new Response("{}", { status: 403 })).fetchImpl,
		});
		expect((await limited.status()).error).toContain("限流");

		const missing = createUpdateChecker({
			currentVersion: "0.1.0",
			fetchImpl: stubFetch(() => new Response("{}", { status: 404 })).fetchImpl,
		});
		expect((await missing.status()).error).toContain("还没有发布");
	});

	it("turns network errors into a status", async () => {
		const fetchImpl = (async () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		}) as typeof fetch;
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		const status = await checker.status();
		expect(status.error).toContain("ENOTFOUND");
	});

	it("rejects a payload without a version", async () => {
		const { fetchImpl } = stubFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 200 }));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", fetchImpl });
		expect((await checker.status()).error).toContain("版本号");
	});

	it("does nothing at all when disabled", async () => {
		const { fetchImpl, calls } = stubFetch(() => release("v9.9.9"));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", enabled: false, fetchImpl });
		const status = await checker.status(true);
		expect(status).toMatchObject({ enabled: false, latest: null, updateAvailable: false, error: null });
		expect(calls).toHaveLength(0);
	});

	it("honours a custom repository", async () => {
		const { fetchImpl, calls } = stubFetch(() => release("v0.2.0"));
		const checker = createUpdateChecker({ currentVersion: "0.1.0", repo: "someone/fork", fetchImpl });
		await checker.status();
		expect(calls[0]?.url).toContain("/repos/someone/fork/releases/latest");
	});
});
