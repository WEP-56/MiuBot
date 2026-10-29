import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relinkWorkspaces } from "../src/main/relink.ts";

/**
 * 解压后重建 `node_modules/@miubot/*` 联接。
 *
 * 这一段是打包链上最容易静默坏掉的一环：zip 存不下 junction，打包时只能把它们删掉，
 * 解压后必须原样建回来。而「建错了」的表现不是报错，是服务起不来
 * （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 或模块找不到），所以要用真实目录结构验证。
 */

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 造一个和发布包同形的目录：`packages/*`、`apps/*`、空的 `node_modules`。 */
async function makeVersionDir(packages: string[], apps: string[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "miubot-relink-test-"));
	dirs.push(root);
	await mkdir(join(root, "node_modules"), { recursive: true });
	for (const [group, names] of [
		["packages", packages],
		["apps", apps],
	] as const) {
		for (const name of names) {
			const dir = join(root, group, name);
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "package.json"), JSON.stringify({ name: `@miubot/${name}`, type: "module" }));
			await writeFile(join(dir, "src", "index.ts"), `export const name = "${name}";\n`);
		}
	}
	return root;
}

describe("relinkWorkspaces", () => {
	it("为每个 workspace 包建出可解析的链接", async () => {
		const root = await makeVersionDir(["shared", "plugin"], ["server"]);
		await relinkWorkspaces(root);
		// 链接必须「解析得到」：这是 Node 能 load 到 src/*.ts 的前提。
		const plugin = join(root, "node_modules", "@miubot", "plugin");
		expect((await stat(join(plugin, "src", "index.ts"))).isFile()).toBe(true);
		expect(JSON.parse(await readFile(join(plugin, "package.json"), "utf8")).name).toBe("@miubot/plugin");
		expect((await stat(join(root, "node_modules", "@miubot", "server", "src", "index.ts"))).isFile()).toBe(true);
	});

	it("跳过没有 package.json 的目录", async () => {
		const root = await makeVersionDir(["shared"], []);
		// 比如 `packages/reference/` 这种纯素材目录，不该进 `@miubot/*`。
		await mkdir(join(root, "packages", "reference"), { recursive: true });
		await relinkWorkspaces(root);
		await expect(stat(join(root, "node_modules", "@miubot", "reference"))).rejects.toThrow();
		expect((await stat(join(root, "node_modules", "@miubot", "shared"))).isDirectory()).toBe(true);
	});

	it("可以重复执行（覆盖已有链接）", async () => {
		const root = await makeVersionDir(["shared"], ["server"]);
		await relinkWorkspaces(root);
		await relinkWorkspaces(root);
		expect((await stat(join(root, "node_modules", "@miubot", "shared", "src", "index.ts"))).isFile()).toBe(true);
	});

	it("缺少 apps/ 或 packages/ 时不抛错", async () => {
		const root = await mkdtemp(join(tmpdir(), "miubot-relink-empty-"));
		dirs.push(root);
		await mkdir(join(root, "node_modules"), { recursive: true });
		await expect(relinkWorkspaces(root)).resolves.toBeUndefined();
	});
});
