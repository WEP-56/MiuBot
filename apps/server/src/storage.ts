import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 运行数据的落盘原语。
 *
 * 公网部署后 `.miubot/`（或 `MIUBOT_DATA_DIR`）里是 QQ AppSecret、各 Provider apiKey
 * 与会话内容，因此写盘有两条硬要求：文件只有服务账号可读（0600、目录 0700），
 * 且写入必须原子（先写临时文件再 `rename`）——直接 `writeFile` 在写一半崩溃时会留下
 * 半个 JSON，配置和会话就一起丢了。
 */

/** 目录权限：仅属主可进入与列目录。 */
export const PRIVATE_DIR_MODE = 0o700;
/** 文件权限：仅属主可读写。 */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * 建目录并收紧权限。
 *
 * `mkdir({ mode })` 只对**新建**目录生效，且会受 umask 影响；已存在的目录必须显式
 * `chmod`，否则从旧版本升级上来的数据目录仍是 0755。
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	await chmod(dir, PRIVATE_DIR_MODE).catch(() => undefined);
}

/** 把已存在的文件收紧到 0600（Windows 上等价于清除「其他用户可写」，失败忽略）。 */
export async function restrictFileMode(path: string): Promise<void> {
	await chmod(path, PRIVATE_FILE_MODE).catch(() => undefined);
}

/** 原子写入文本文件：同目录临时文件 → `rename`。 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
	await ensurePrivateDir(dirname(path));
	// 临时名带随机后缀：两个并发写（例如登录建会话与退出落盘）不会踩同一个临时文件，
	// 结果退化成「后写者赢」，而不是半个 JSON。
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		await writeFile(temporary, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
		await chmod(temporary, PRIVATE_FILE_MODE).catch(() => undefined);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** 原子写入 JSON（两空格缩进，便于人工排障）。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeFileAtomic(path, JSON.stringify(value, null, 2));
}

/**
 * 读 JSON；文件不存在或内容损坏时返回 `undefined`。
 *
 * 调用方自己决定「损坏 = 重建」还是「损坏 = 报错」，这里不吞掉语义。
 */
export async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}
