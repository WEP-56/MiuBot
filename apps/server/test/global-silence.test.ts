import { describe, expect, it } from "vitest";
import { createDefaultConfig, isGlobalSilenceActive } from "../src/runtime.ts";

describe("global silence window", () => {
	it("is disabled when start and end are equal", () => {
		expect(createDefaultConfig().globalSilence).toEqual({ quietStart: "00:00", quietEnd: "00:00" });
		expect(isGlobalSilenceActive({ quietStart: "22:00", quietEnd: "22:00" }, new Date(2026, 0, 1, 23, 0))).toBe(false);
	});

	it("supports daytime and overnight windows with an exclusive end", () => {
		const daytime = { quietStart: "09:00", quietEnd: "17:00" };
		expect(isGlobalSilenceActive(daytime, new Date(2026, 0, 1, 9, 0))).toBe(true);
		expect(isGlobalSilenceActive(daytime, new Date(2026, 0, 1, 17, 0))).toBe(false);

		const overnight = { quietStart: "22:00", quietEnd: "06:00" };
		expect(isGlobalSilenceActive(overnight, new Date(2026, 0, 1, 23, 0))).toBe(true);
		expect(isGlobalSilenceActive(overnight, new Date(2026, 0, 2, 5, 59))).toBe(true);
		expect(isGlobalSilenceActive(overnight, new Date(2026, 0, 2, 6, 0))).toBe(false);
	});
});
