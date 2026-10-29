/**
 * 桌面端版本号。
 *
 * **单一来源是仓库根 `package.json` 的 `version`**，由发布流程随 tag 一起递增
 * （`chore(release): v0.5.0` 这类提交）。桌面端不维护自己的版本号：
 *
 * - 它没有独立发布节奏——每次推 tag 都会重新出一个安装包；
 * - 「桌面端版本」与「服务端版本」分开维护，只会让两边悄悄错开，
 *   而更新检查恰好依赖两者能否对齐。
 *
 * `__DESKTOP_VERSION__` 由 `scripts/build.mjs` 在构建时从根 `package.json` 注入
 * （esbuild 的 `define`），所以这里是构建期常量，运行时不读文件、不依赖打包工具元信息。
 * 未注入时（比如直接 `node` 跑源码）退回 `app.getVersion()`，那是 package.json 里的占位值。
 */

declare const __DESKTOP_VERSION__: string | undefined;

export const DESKTOP_VERSION: string =
	typeof __DESKTOP_VERSION__ === "string" && __DESKTOP_VERSION__ ? __DESKTOP_VERSION__ : "0.0.0-dev";
