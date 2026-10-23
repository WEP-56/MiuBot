import { describe, expect, it } from "vitest";
import { resolveImageProvider } from "../src/image-provider.ts";
import { type AppConfig, createDefaultConfig } from "../src/runtime.ts";

function config(overrides: Partial<AppConfig["imageProviders"][number]>[] = [], selected = ""): AppConfig {
	const base = createDefaultConfig();
	base.tools.imageGen = { providerId: selected };
	base.imageProviders = [
		{ id: "img-a", name: "A 家", api: "openai-images", apiKey: "sk-a", model: "a-1", enabled: true },
		{ id: "img-b", name: "B 家", api: "openai-images", apiKey: "sk-b", model: "b-1", enabled: true },
	];
	base.imageProviders = base.imageProviders.map((provider, index) => ({ ...provider, ...overrides[index] }));
	return base;
}

describe("resolveImageProvider", () => {
	it("未选择时直接报错，不回退到「第一个」", () => {
		expect(() => resolveImageProvider(config())).toThrow(/尚未选择提供商/);
	});

	it("两个都可用时，用的是选中的那个而不是排在前面的", () => {
		expect(resolveImageProvider(config([], "img-b")).id).toBe("img-b");
	});

	it("选中的提供商被删掉时报错", () => {
		expect(() => resolveImageProvider(config([], "img-gone"))).toThrow(/已不存在/);
	});

	it("选中的提供商被停用时报错", () => {
		expect(() => resolveImageProvider(config([{ enabled: false }], "img-a"))).toThrow(/已停用/);
	});

	it("选中的提供商缺 Key 时报错", () => {
		expect(() => resolveImageProvider(config([{ apiKey: "" }], "img-a"))).toThrow(/API Key/);
	});
});
