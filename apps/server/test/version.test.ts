import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isNewerVersion, normalize, resolveVersion } from "../src/version.ts";

afterEach(() => {
	delete process.env.MIUBOT_VERSION;
});

describe("normalize", () => {
	it("strips the tag prefix and marks the placeholder version as a dev build", () => {
		expect(normalize("v1.2.3")).toBe("1.2.3");
		expect(normalize(" 1.2.3 ")).toBe("1.2.3");
		expect(normalize("0.0.0")).toBe("0.0.0-dev");
	});
});

describe("resolveVersion", () => {
	it("prefers MIUBOT_VERSION", () => {
		process.env.MIUBOT_VERSION = "v9.9.9";
		expect(resolveVersion()).toBe("9.9.9");
	});

	it("falls back to the repository version when nothing is injected", () => {
		// 仓库的 package.json 带真实版本号（v0.3.0 起）；这里断言的是「以它为兜底」，
		// 而不是某个写死的值——否则每次发版都要改测试。
		const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		expect(resolveVersion()).toBe(normalize(manifest.version ?? "0.0.0"));
	});
});

describe("isNewerVersion", () => {
	it("compares major, minor and patch", () => {
		expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
		expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
		expect(isNewerVersion("1.0.1", "1.0.1")).toBe(false);
		expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
	});

	it("treats a release as newer than its prerelease", () => {
		expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
		expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
		expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
	});

	it("ignores build metadata and tolerates a v prefix", () => {
		expect(isNewerVersion("v1.2.4", "1.2.3+build.5")).toBe(true);
		expect(isNewerVersion("1.2.3+build.9", "1.2.3")).toBe(false);
	});

	it("never claims an update for unparsable versions", () => {
		expect(isNewerVersion("not-a-version", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.0.0", "not-a-version")).toBe(false);
	});
});
