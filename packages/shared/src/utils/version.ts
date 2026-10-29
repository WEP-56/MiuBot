/**
 * 版本号解析与比较。
 *
 * 两个消费方需要同一套语义：
 * - `apps/server` 的内置更新检查（`update-check.ts`）用它判断「要不要提示升级」；
 * - `apps/desktop` 用它判断桌面端与服务端包是否该提示新版本。
 *
 * 只回答「谁更新」，因此按 semver 的主/次/修订 + 预发布比较，不处理 build metadata
 * （`+` 之后的部分不参与排序）。
 */

/** `v1.2.3` → `1.2.3`；`0.0.0`（仓库里的占位版本）标成开发版。 */
export function normalize(raw: string): string {
	const version = raw.trim().replace(/^v/i, "");
	return version === "0.0.0" ? "0.0.0-dev" : version;
}

/** `candidate` 是否比 `current` 新。任一方解析失败时返回 false（宁可漏提示，不可误报）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
	return compareVersions(candidate, current) > 0;
}

/**
 * 升序比较：`left` 更新返回正数，更旧返回负数，相等（或都无法解析）返回 0。
 *
 * 用于列表排序。无法解析时返回 0 而不是抛错：界面上的排序不该因为一个畸形 tag 就崩掉。
 */
export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) return 0;
	for (let index = 0; index < 3; index += 1) {
		const leftNumber = a.numbers[index] ?? 0;
		const rightNumber = b.numbers[index] ?? 0;
		if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
	}
	if (!a.prerelease && b.prerelease) return 1;
	if (a.prerelease && !b.prerelease) return -1;
	if (!a.prerelease || !b.prerelease) return 0;
	return comparePrerelease(a.prerelease, b.prerelease);
}

type ParsedVersion = { numbers: [number, number, number]; prerelease: string | undefined };

function parseVersion(value: string): ParsedVersion | undefined {
	const cleaned = normalize(value).split("+")[0] ?? "";
	const [core, prerelease] = cleaned.split("-", 2);
	const parts = (core ?? "").split(".");
	if (parts.length === 0 || parts.length > 3) return undefined;
	const numbers: [number, number, number] = [0, 0, 0];
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index] ?? "";
		if (!/^\d+$/.test(part)) return undefined;
		numbers[index] = Number(part);
	}
	return { numbers, prerelease };
}

function comparePrerelease(left: string, right: string): number {
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const a = leftParts[index];
		const b = rightParts[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
		// 数字标识符的优先级低于字母标识符（semver 2.0.0 §11.4.3）。
		if (aNumeric) return -1;
		if (bNumeric) return 1;
		return a > b ? 1 : -1;
	}
	return 0;
}
