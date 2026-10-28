import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppState } from "../src/app-state.ts";
import { DEFAULT_MEMORY_PROMPT, LEGACY_DEFAULT_MEMORY_PROMPT } from "../src/memory-prompt.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function loadWith(config: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "miubot-imagegen-"));
	roots.push(dir);
	await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf8");
	const state = createAppState({ dataDir: dir });
	await state.load();
	return state.getConfig();
}

/**
 * `tools.imageGen.providerId` 是后加的字段。
 *
 * 旧逻辑是「第一个启用且有 Key 的图像提供商」；升级时不迁移的话，用户什么都没改，
 * `image_gen` 却突然变成「未配置」。
 */
describe("图像提供商选择迁移", () => {
	it("老配置：记下当时真正生效的那一个", async () => {
		const config = await loadWith({
			imageProviders: [
				{ id: "img-off", name: "停用", api: "openai-images", apiKey: "sk", model: "m", enabled: false },
				{ id: "img-live", name: "可用", api: "openai-images", apiKey: "sk", model: "m", enabled: true },
			],
		});

		expect(config.tools.imageGen.providerId).toBe("img-live");
	});

	it("没有可用的图像提供商时留空", async () => {
		const config = await loadWith({
			imageProviders: [
				{ id: "img", name: "无 Key", api: "openai-images", apiKey: "", model: "m", enabled: true },
			],
		});

		expect(config.tools.imageGen.providerId).toBe("");
	});

	it("已有显式选择时不被迁移覆盖（包括用户主动清空）", async () => {
		const config = await loadWith({
			tools: { imageGen: { providerId: "" } },
			imageProviders: [{ id: "img", name: "可用", api: "openai-images", apiKey: "sk", model: "m", enabled: true }],
		});

		expect(config.tools.imageGen.providerId).toBe("");
	});
});

describe("长期记忆提示迁移", () => {
	it("将旧内置默认提示升级到新版规则", async () => {
		const config = await loadWith({ memoryPrompt: LEGACY_DEFAULT_MEMORY_PROMPT });
		expect(config.memoryPrompt).toBe(DEFAULT_MEMORY_PROMPT);
	});

	it("保留管理员自定义提示", async () => {
		const config = await loadWith({ memoryPrompt: "自定义记忆规则" });
		expect(config.memoryPrompt).toBe("自定义记忆规则");
	});
});
