import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 当前版本号。
 *
 * 三个来源，优先级从高到低：
 *
 * 1. `MIUBOT_VERSION`：CI 打镜像时用 tag 注入（`--build-arg MIUBOT_VERSION=v0.2.0`）。
 * 2. 仓库根的 `VERSION` 文件：发布包（tarball）里由 CI 写入。
 * 3. 根 `package.json` 的 `version`：源码直接跑时的兜底。
 *
 * 都没有时返回 `0.0.0-dev`，工作台据此显示「开发版」，更新检查也就不会误报。
 */
export function resolveVersion(): string {
	const fromEnv = process.env.MIUBOT_VERSION?.trim();
	if (fromEnv) return normalize(fromEnv);
	const root = repoRoot();
	try {
		const fromFile = readFileSync(join(root, "VERSION"), "utf8").trim();
		if (fromFile) return normalize(fromFile);
	} catch {}
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
		if (typeof manifest.version === "string" && manifest.version.trim()) return normalize(manifest.version);
	} catch {}
	return "0.0.0-dev";
}

/** `v1.2.3` → `1.2.3`；`0.0.0`（仓库里的占位版本）标成开发版。 */
export function normalize(raw: string): string {
	const version = raw.trim().replace(/^v/i, "");
	return version === "0.0.0" ? "0.0.0-dev" : version;
}

/**
 * `candidate` 是否比 `current` 新。
 *
 * 只需要回答「要不要提示升级」，所以按 semver 的主/次/修订 + 预发布比较，
 * 不处理 build metadata（`+` 之后的部分不参与排序）。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const left = parseVersion(candidate);
	const right = parseVersion(current);
	if (!left || !right) return false;
	for (let index = 0; index < 3; index += 1) {
		if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index];
	}
	if (!left.prerelease && right.prerelease) return true;
	if (left.prerelease && !right.prerelease) return false;
	if (!left.prerelease || !right.prerelease) return false;
	return comparePrerelease(left.prerelease, right.prerelease) > 0;
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

/** 仓库根目录：本文件在 `apps/server/src/` 下。 */
function repoRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
