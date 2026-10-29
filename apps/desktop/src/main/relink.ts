import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * 重建 `node_modules/@miubot/*` 的目录联接。
 *
 * 这一步不能省，原因有两条，都是实测出来的：
 *
 * 1. zip 存不下 junction。发布包里 `node_modules/@miubot/*` 是指向 `packages/*` 的目录联接，
 *    压缩后变成空目录，解压出来 `@miubot/plugin/src` 直接消失，服务起不来。
 *    所以打包时把它们删掉（见 `.github/workflows/release.yml`），由这里重建。
 * 2. Node 的类型擦除拒绝执行 `node_modules` 下的 `.ts`：
 *    `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。而 workspace 包的 `exports` 指向
 *    `./src/*.ts`（`source` 条件），必须让它们从 `node_modules` 里「链接出去」——
 *    解析后的真实路径不在 `node_modules` 下，才过得了这道检查。改成实体副本会直接失败。
 *
 * Windows 用 `mklink /J`：junction 不需要管理员权限，也不需要开发者模式。
 */
export async function relinkWorkspaces(versionDir: string): Promise<void> {
	const scopeDir = join(versionDir, "node_modules", "@miubot");
	await mkdir(scopeDir, { recursive: true });
	const link = async (name: string, target: string): Promise<void> => {
		const destination = join(scopeDir, name);
		await rm(destination, { recursive: true, force: true });
		if (process.platform === "win32") {
			// `cmd /c mklink` 没有 Node 原生替代：`fs.symlink` 在 Windows 上要么要管理员，
			// 要么要开发者模式，而 junction 两者都不要。失败不抛错——由调用方检查结果。
			await new Promise<void>((resolve) => {
				const proc = spawn("cmd", ["/c", "mklink", "/J", destination, target], { windowsHide: true });
				proc.on("exit", () => resolve());
				proc.on("error", () => resolve());
			});
			return;
		}
		await symlink(target, destination, "dir").catch(() => undefined);
	};
	for (const group of ["packages", "apps"]) {
		const base = join(versionDir, group);
		let names: string[];
		try {
			names = await readdir(base);
		} catch {
			continue;
		}
		for (const name of names) {
			// 只有 workspace 包（有 package.json）才进 `@miubot/*`；纯素材目录不该被链进去。
			if (!(await isFile(join(base, name, "package.json")))) continue;
			await link(name, join(base, name));
		}
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
