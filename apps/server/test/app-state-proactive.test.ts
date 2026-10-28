import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppState } from "../src/app-state.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function loadWith(config: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "miubot-proactive-config-"));
	roots.push(dir);
	await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf8");
	const state = createAppState({ dataDir: dir });
	await state.load();
	return state.getConfig();
}

/**
 * 群级冷却的单位从分钟改成了秒。
 *
 * 不迁移的话，老配置里那个 `cooldownMinutes: 10` 会被直接忽略，冷却静默变成 0 秒——
 * 用户什么都没改，机器人却开始在群里连续插话。
 */
describe("群级冷却单位迁移", () => {
	it("老配置的分钟换算成秒", async () => {
		const config = await loadWith({ proactiveGate: { cooldownMinutes: 5 } });

		expect(config.proactiveGate.cooldownSeconds).toBe(300);
	});

	it("已经有秒值时不被迁移覆盖（包括 0）", async () => {
		const config = await loadWith({ proactiveGate: { cooldownMinutes: 5, cooldownSeconds: 0 } });

		expect(config.proactiveGate.cooldownSeconds).toBe(0);
	});

	it("两个字段都没有时用默认值", async () => {
		const config = await loadWith({});

		expect(config.proactiveGate.cooldownSeconds).toBe(600);
	});
});

describe("全局静默配置迁移", () => {
	it("老配置默认关闭静默，新字段仅接受有效时间", async () => {
		expect((await loadWith({})).globalSilence).toEqual({ quietStart: "00:00", quietEnd: "00:00" });
		expect((await loadWith({ globalSilence: { quietStart: "22:30", quietEnd: "06:00" } })).globalSilence).toEqual({
			quietStart: "22:30",
			quietEnd: "06:00",
		});
		expect((await loadWith({ globalSilence: { quietStart: "25:00", quietEnd: "06:00" } })).globalSilence).toEqual({
			quietStart: "00:00",
			quietEnd: "06:00",
		});
	});
});
