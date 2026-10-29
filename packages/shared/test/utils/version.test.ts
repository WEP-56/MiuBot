import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion, normalize } from "../../src/utils/version.ts";

/**
 * 版本比较。
 *
 * 服务端的更新检查与桌面端的版本列表共用这一份实现：前者决定「要不要提示升级」，
 * 后者决定列表顺序。所以边界行为（预发布、畸形输入）要钉死，不能靠调用方兜底。
 */

describe("normalize", () => {
	it("去掉 v 前缀并标记占位版本", () => {
		expect(normalize("v1.2.3")).toBe("1.2.3");
		expect(normalize(" 1.2.3 ")).toBe("1.2.3");
		expect(normalize("0.0.0")).toBe("0.0.0-dev");
	});
});

describe("compareVersions", () => {
	it("按主/次/修订排序", () => {
		expect(compareVersions("0.5.0", "0.4.9")).toBeGreaterThan(0);
		expect(compareVersions("0.4.9", "0.5.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
	});

	it("正式版高于同号预发布", () => {
		expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
	});

	it("预发布内部按 semver 规则比较", () => {
		expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBeGreaterThan(0);
		// 数字标识符的优先级低于字母标识符。
		expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
	});

	it("无法解析时返回 0 而不是抛错", () => {
		// 列表排序不该因为一个畸形 tag 就崩掉。
		expect(compareVersions("not-a-version", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "not-a-version")).toBe(0);
	});
});

describe("isNewerVersion", () => {
	it("只在候选更新时返回 true", () => {
		expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
		expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
	});

	it("忽略 build metadata，容忍 v 前缀", () => {
		expect(isNewerVersion("v1.2.4", "1.2.3+build.5")).toBe(true);
		expect(isNewerVersion("1.2.3+build.9", "1.2.3")).toBe(false);
	});

	it("无法解析时不误报更新", () => {
		expect(isNewerVersion("not-a-version", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.0.0", "not-a-version")).toBe(false);
	});
});
