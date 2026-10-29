# 桌面端（MiuBot Desktop）

Windows 专用的**启动器 + 版本管理器**。它本身不含机器人逻辑，只负责三件事：

1. 从 GitHub Release 取服务端版本、下载、校验、安装；
2. 启动 / 停止服务进程（`apps/server`），并打开工作台；
3. 管理多个版本并存（切换、回滚、删除）。

服务端代码与桌面端分开下载：桌面端装好就能用，但第一次要点「下载」拿一个服务端版本。
这样服务端升级不必重装桌面端，桌面端升级也不影响服务端数据。

## 版本号

**桌面端不维护自己的版本号**，跟随仓库根 `package.json` 的 `version`（也就是主线版本，如 `0.5.0`）。
每次推 `v*` tag 发版都会重出安装包，两边版本号天然对齐：

- `scripts/build.mjs` 从根 `package.json` 读出 `version`，用 esbuild `define` 注入主进程
  （`src/main/version.ts` 的 `DESKTOP_VERSION`），并同步写回 `apps/desktop/package.json`，
  让 electron-builder 的产物名和 `app.getVersion()` 一致；
- 发版提交（`chore(release): v0.5.0`）本来就会递增根 `version`，所以 CI 不需要额外
  `npm version`——多一处版本来源就多一处能对不上。

这样做的直接好处：更新检查把「桌面端版本」和「release 最新 tag」比较，
两者同源时才不会出现「桌面端提示自己有新版」这种自我误报。

## 两个窗口

| 窗口 | 内容 | 为什么这么分 |
| --- | --- | --- |
| 首页 | 本地 HTML（React），启动/停止、版本列表、桌面端更新提示 | 只走 IPC，不访问 HTTP，因此不涉及服务端的 Origin / Cookie 规则 |
| 控制台 | `http://127.0.0.1:<port>`，完整工作台 | 服务端下发 `frame-ancestors 'none'` + `X-Frame-Options: DENY`，**不能嵌 iframe**，只能是独立窗口 |

服务启动成功后控制台会自动打开；首页的「控制台」按钮可以再打开一次。

## 目录布局

都在 `%APPDATA%\MiuBot Desktop\`（卸载不删，重装保留）：

```text
versions\<版本>\      解压后的服务端代码 + 该版本的 node_modules
data\                 MIUBOT_DATA_DIR：配置、会话、插件数据（跨版本共享）
downloads\            下载中的临时文件
settings.json         当前启用的版本、端口
desktop.log           启动器与服务进程输出
```

**`data\` 必须在版本目录之外**，否则切换或删除版本会连带删掉配置与会话。这是整个布局唯一不能变的约束。

Node 运行时**不在**版本目录里：`node.exe` 单独约 83 MB，按版本各带一份会让「留个旧版本以便回滚」
从几十兆变成一百多兆。它随桌面端安装包分发一份（`resources\node\node.exe`），所有版本共用。

## 停止服务的实现约束（Windows）

Windows 没有能把 `SIGTERM` 投递给子进程的机制：`child.kill()` 就是 `TerminateProcess`，
服务端的优雅退出（断 Gateway → 关端口 → 落盘会话）不会执行。因此：

1. 桌面端启动服务时设 `MIUBOT_CONTROL_STDIO=1`，并往子进程 stdin 写 `shutdown\n`；
2. 服务端（`apps/server/src/index.ts`）看到这个环境变量才挂 stdin 监听，读到就走同一条 `shutdown()`；
3. 10 秒内没退，才 `taskkill /PID <pid> /T /F` 强杀整棵进程树（插件派生的子进程不跟着父进程走）。

默认关闭该监听：systemd / docker 下 stdin 是 `/dev/null` 或立刻 EOF，不该被误读成指令。

## 版本包的结构要求

服务包文件名必须是 `miubot-win-x64-<tag>.zip`（见 `src/main/releases.ts` 的 `SERVICE_ASSET_PATTERN`），
解压后顶层是 `apps/`、`packages/`、`plugins/`、`node_modules/`、`VERSION`。

**`node_modules/@miubot/*` 不进 zip。** 两个原因，都是实测的：

- zip 存不下 junction，`npm ci` 装出来的 workspace 链接会被压成空目录，解压后 `@miubot/plugin/src` 直接消失；
- Node 的类型擦除拒绝执行 `node_modules` 下的 `.ts`（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），
  而 workspace 包的 `exports` 指向 `./src/*.ts`。把 package 换成实体副本会触发这个错误；
  只有「从 `node_modules` 链出去」、让解析后的真实路径落在 `node_modules` 之外才行。

所以打包时删掉那些链接，解压后用 `mklink /J` 重建（`src/main/relink.ts`）。

## 安全边界

- 服务包只校验 **sha256**：取 GitHub Release asset 的 `digest` 字段（`sha256:<hex>`），下载后重算比对，
  不匹配就删掉、不执行。挡的是传输损坏与中间人替换；挡不住上游仓库被投毒（那需要签名 manifest，当前不做）。
  没有 `digest` 的历史资产一律不认。
- 桌面端自身**不做自动更新**：只检查版本、提示、引导打开 release 页面。自动更新等于给程序开一条
  「拉取远端可执行文件并运行」的通道，与项目对服务端自动更新的态度保持一致。
- 控制台窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、禁止开新窗口（外链走系统浏览器）。
- 服务进程始终只听 `127.0.0.1`，`MIUBOT_HOST` 由桌面端注入，不受界面影响。

## 开发与打包

```bash
npm install --ignore-scripts
node apps/desktop/scripts/fetch-node.mjs     # 下共用的 node.exe 到 apps/desktop/.node/
npm run build --workspace=@miubot/desktop    # esbuild（主进程 + preload）+ vite（首页）
npm run check --workspace=@miubot/desktop    # 桌面端有独立 tsconfig，根 check 覆盖不到
```

开起来：

```bash
# 需要先让 electron 二进制到位（根 npm ci 用 --ignore-scripts 不会下）
node node_modules/electron/install.js
cd apps/desktop && npx electron .
```

打安装包（NSIS，未签名）：

```bash
cd apps/desktop && npm run dist      # → apps/desktop/release/MiuBot-Desktop-Setup-<版本>-x64.exe
```

CI 里由 `.github/workflows/release.yml` 的 `desktop` job 在 `windows-latest` 上产出两件东西：
`miubot-win-x64-<tag>.zip`（服务包）与 `MiuBot-Desktop-Setup-<tag>-x64.exe`（安装包）。

## 已知限制

- 只发 Windows x64。arm64 需要额外一份 arm64 的 `node.exe` 与 `windows-11-arm` runner，当前没做。
- 只保留用户手动装的版本，没有「自动清理旧版本」：版本目录占空间，但删不删由用户决定。
- 数据格式只向前兼容：新版本写的配置，旧版本不一定读得懂。回滚前建议先备份 `data\`。
- 未签名，SmartScreen 会拦一次；项目开源，需要用户自行确认来源。
