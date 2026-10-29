# MiuBot

基于 Pi 内核构建的 QQ 机器人管理平台。

- 运行时：`apps/server`（QQ 官方 Bot、模型调用、会话与工具运行）
- 工作台：`apps/web`（平台、提供商、人格、会话、调试台与设置）
- 桌面端：`apps/desktop`（Windows 启动器与版本管理器，见 [apps/desktop/README.md](apps/desktop/README.md)）
- 复用内核：`packages/{provider,agent,context,plugin,session}`
- 移植来源与模块映射：`docs/10-技术架构/04-Pi移植记录.md`
- 开发约定：`AGENTS.md`

## 开始

### 本机使用（Windows，推荐）

下载 [最新 Release](https://github.com/WEP-56/MiuBot/releases/latest) 里的
`MiuBot-Desktop-Setup-<版本>-x64.exe`，安装后打开 **MiuBot Desktop**。

首次打开还没有服务端：在「服务端版本」里点**下载**，下完点**启用**，再点**启动服务**。
控制台会自动打开；以后也可以从首页的「控制台」按钮进入。

首次启动会生成一个管理员口令，桌面端会弹窗显示**一次**（不写日志），请立刻记下或改掉。

数据存放在 `%APPDATA%\MiuBot Desktop\`：`data\` 是配置与会话（跨版本共享，升级不受影响），
`versions\` 是各个已下载的服务端版本。卸载不会删这个目录。

只想自己跑、不装桌面端的话，也可以直接用源码：

```bash
npm install --ignore-scripts
npm run dev --workspace=@miubot/server   # http://127.0.0.1:8787（同时托管工作台产物）
npm run dev --workspace=@miubot/web      # http://127.0.0.1:5173（热更新，/api 代理到服务端）
```

此时数据目录默认 `apps/server/.miubot/`，管理员口令打印在服务端控制台里。
桌面端的详细说明见 [apps/desktop/README.md](apps/desktop/README.md)。

### 部署到服务器

**Docker（推荐，一条命令）**：

```bash
cp .env.example .env          # 填 MIUBOT_DOMAIN
docker compose --profile tls up -d --build
docker compose logs miubot | grep 管理员口令
```

详见 [deploy/docker/README.md](deploy/docker/README.md)。

**裸机（systemd + nginx）**：见 [deploy/README.md](deploy/README.md)，包含 HTTPS、独立数据目录、
备份与升级。设计背景与已落地/未落地项见 [deploy.md](deploy.md)。

## 常见问题与解决方案


## 开发

```bash
npm install --ignore-scripts
npm run check                 # 类型检查
npm test                      # 单元测试
```

模型目录（`packages/provider/src/providers/data/`）是提交进仓库的固定快照，装完依赖即可跑，不需要生成。
要刷新到上游最新目录时运行 `npm run generate:model-data`（会联网拉 models.dev 等），
生成后记得同步更新引用具体模型 id 的 provider 测试。


## License

Miubot 采用 MIT。Pi 的 MIT 许可与版权声明保留在 [LICENSE-Pi](docs/LICENSE-Pi)
