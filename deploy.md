# Miubot 公网部署与安全适配

> 2026-10-23。这份文档是「把 Miubot 放到公网」的**评估与改造记录**，不是使用手册。
> 装什么、怎么起、怎么备份 → [`deploy/README.md`](deploy/README.md)。
> 为什么当初不能放、改了什么、还差什么 → 本文。

## 0. 结论先行

**P0 已全部落地，管理面可以暴露到公网。** 三个代码级硬阻断都解掉了：

1. **监听地址与 `Host` 校验可配置**：`MIUBOT_HOST` 控制 `listen`，`MIUBOT_ALLOWED_HOSTS` 是显式域名允许名单（无通配符），默认仍只接受回环。
2. **无认证令牌下发口已删除**：`POST /api/auth/session` 不再存在。改为口令登录（scrypt）+ 服务端可撤销会话 + `Secure` Cookie + 失败锁定；共享令牌降级为「自动化脚本用请求头」。
3. **服务端托管工作台产物**：非 `/api` 的 GET/HEAD 一律回 `apps/web/dist/index.html`（SPA 回退），部署拓扑收敛成**一个端口、一个 origin**。

验收矩阵见 §7，实际跑过（`MIUBOT_PORT=8899` + 临时数据目录）。

**部署形态二选一**：`docker compose --profile tls up -d --build`（[Docker 手册](deploy/docker/README.md)），
或裸机 systemd + nginx（[部署手册](deploy/README.md)）。

**但「能部署」不等于「随便用」。** 剩下的风险不在认证，在**执行面**（§2.4）：插件是进程内任意代码、
`tools.enabled` 里打开 `bash`/`write` 就等于把服务器交出去、入站没有对象白名单。
这些是产品策略问题，不是配置能兜住的，见 §8 / §9。

**QQ 侧不需要公网入口。** `transport: "websocket"`（`qq/connection.ts`），出站连接。没有 webhook、没有回调 URL、没有签名校验、不需要域名备案。需要暴露的只有**管理面**——而这恰恰是整个系统里权限最大的东西：能装任意插件、能开 shell 工具、能改模型 Key。

## 1. 需要保护的到底是什么

按敏感度从高到低：

| 面 | 内容 | 泄露/被控后果 |
|---|---|---|
| 管理 API 写操作 | `/api/plugins/import`、`/api/skills/import`、`PUT /api/tools`、`PUT /api/config` | **服务器任意代码执行**（插件与技能都是本进程内跑的 Node 代码），可读数据目录下的全部密钥 |
| 管理 API 读操作 | `/api/sessions`、`/api/logs`、`PUT /api/chat` | 全部群聊/私聊内容、模型 Key（`publicConfig` 已遮蔽，但插件/skill 文件不一定） |
| 数据目录 | `config.json`（QQ AppSecret + 各 Provider apiKey 明文）、`api-token`、`admin-password`、会话、插件数据 | 直接接管 Bot 与模型额度 |
| QQ 入站 | 任何群成员的消息都能触发 Agent 与工具 | token 消耗；若开了 `bash` / `write` 工具，**提示注入 = RCE** |

最容易忽略的是最后一条：它不需要攻击管理面，只需要在群里发一条精心构造的消息。

## 2. 现状盘点（改造后）

### 2.1 网络与边界

| 项 | 现状 | 处理 |
|---|---|---|
| 监听地址 | `MIUBOT_HOST`，默认 `127.0.0.1` | ✅ P0-1 |
| `Host` 校验 | 回环（端口须匹配）或 `MIUBOT_ALLOWED_HOSTS` 显式域名；不支持 `*`，不读 `X-Forwarded-Host` | ✅ P0-1 |
| `X-Forwarded-*` | 完全不读 | 保持。信任这些头等于让任何客户端伪造 Host/协议；反代应改 `Host`（`proxy_set_header Host $host`） |
| CORS | 白名单回写，不发 `*`，`Origin: null` 拒绝；同源部署时由域名自动推导 | ✅ |
| 静态托管 | 服务端托管 `apps/web/dist/index.html` + SPA 回退；缺产物返回 503 并提示构建 | ✅ P0-3 |
| 请求体上限 | JSON 1 MB（`HttpError(413)`，含 `content-length` 预检）；ZIP 上传仍 20 MB | ✅ P1-1 |
| 速率限制 | 按来源令牌桶（120 突发 / 600 每分钟）；登录另有失败锁定 | ✅ P1-2 |
| 安全响应头 | `nosniff`、`Referrer-Policy`、`X-Frame-Options`、CSP（`default-src 'self'` + 内联脚本/样式白名单 + `frame-ancestors 'none'`）、HTTPS 下 HSTS | ✅ P1-3 |

### 2.2 认证与传输

| 项 | 现状 | 处理 |
|---|---|---|
| 口令 | scrypt（N=16384,r=8,p=1）散列存 `admin-password`（0600）；`MIUBOT_PASSWORD_HASH` / `MIUBOT_ADMIN_PASSWORD` 可覆盖 | ✅ P0-2 |
| 浏览器会话 | 登录签发随机 session id；服务端存 SHA-256 + 过期时间（`admin-sessions.json`），24h 滑动续期 | ✅ P0-2 |
| Cookie | `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`，HTTPS 部署加 `Secure` | ✅ P0-2 |
| 撤销 | 登出、改口令立刻失效；不依赖浏览器端过期 | ✅ P0-2 |
| 令牌 | `api-token` 保留，仅 `Authorization: Bearer` / `X-Miubot-Token`，**不能换浏览器 Cookie** | ✅ P0-2 |
| TLS | 应用不碰证书，交给 nginx / Caddy | `deploy/nginx.conf` |
| 登录失败保护 | 连续 5 次锁 5 分钟（429 + `Retry-After`），锁定期内正确口令也拒绝 | ✅ P1-2 |
| 权限模型 | 全有或全无（登录 = 管理员） | 单管理员可接受，见 §4 |

### 2.3 数据与运维

| 项 | 现状 | 处理 |
|---|---|---|
| 数据目录 | `MIUBOT_DATA_DIR`，默认 `apps/server/.miubot` | ✅ P0-4 |
| 文件权限 | 目录 0700、文件 0600；旧文件在启动时收紧 | ✅ P1-4 |
| 写盘原子性 | 临时文件 + `rename`（`storage.ts`），配置/会话/口令/认证会话全部走这条 | ✅ P1-4 |
| 密钥存储 | 明文 JSON | 不做自研加密（密钥还得放同一个文件）。靠文件权限 + 磁盘加密 + 备份加密 |
| 日志 | `runtime.log` 按 10 MB 轮转、保留 5 份（≈50 MB 上限）；写入前统一脱敏（密钥 / Bearer / 32 位以上十六进制 / 超长 base64），单条截断 2000 字符；启动时跨文件恢复最近 1000 条 | ✅ P1-5 |
| 错误响应 | `HttpError` 按状态码回；其余 500 只回 `traceId`，详情进运行日志 | ✅ P1-6 |
| 守护 | `deploy/miubot.service` + SIGTERM 优雅退出（断 Gateway → 关端口 → 落盘） | ✅ P1-7 |
| 备份 | `deploy/backup.sh`（tar + 权限收紧 + 14 天轮转） | ✅ P1-8 |
| 审计日志 | `audit.log`（JSON Lines，10 MB × 3）：登录/失败/锁定/登出/改密 + 所有变更类管理请求（统一在 `http/server.ts` 埋点）；插件与技能的安装/卸载额外记具体名字 | ✅ P2-4 |
| 入站白名单 | `config.access.allowedPeers`（`group:<ID>` / `c2c:<ID>`）；未命中的消息在副作用之前丢弃、不回复；`MIUBOT_ALLOWED_PEERS` 可覆盖 | ✅ P2-1 |
| 工具策略 | 文件与命令类工具启用时启动 WARN + Tools 页红字；`MIUBOT_DISABLE_NATIVE_TOOLS=1` 在会话层整体禁用 | ✅ P2-2 |

### 2.4 执行面（部署文档必须讲清楚的部分）

- **插件 = 本进程内任意 Node 代码**，不是沙箱。`packages/plugin/src/host/` 只约束「能通过 `ctx` 拿到什么」，约束不了 `import("node:fs")`。所以「能装插件」这个权限等价于 root 级权限（同一用户下）。
- **技能同理**：`agentDir` 下的 `SKILL.md` 与脚本会被 Agent 读取执行。
- **`bash` / `write` / `edit` 工具可由模型调用**（`config.tools.enabled` 里加入即可，`toolNames` 允许）。默认值只有 `web_search`，但工作台上点一下就能开。开了之后，任何群成员的一条消息都可能变成服务器上的命令。
- **入站没有对象白名单**：Bot 所在的任何群、任何私聊都能触发 Agent。没有 `allowedPeers` 之类的策略层。

→ 硬规则：**公网部署时，`tools.enabled` 只留 `web_search`；`/api/plugins/import` 与 `/api/skills/import` 只在明确需要时用，且知道它们等于给管理员发了 shell。**

## 3. 三个硬阻断怎么解的

### 3.1 监听地址与 `Host` 校验

```ts
// index.ts
const listenHost = process.env.MIUBOT_HOST?.trim() || "127.0.0.1";
const allowedHosts = splitList(process.env.MIUBOT_ALLOWED_HOSTS);
// api-security.ts
if (!host || !isAllowedHost(host, options.port, allowedHosts)) return { ok: false, status: 403, ... }
```

- `Host` 校验的本意是防 DNS rebinding，这个目标在公网部署下依然成立，只是「允许的名字」从回环变成一个明确列出的域名。
- 名单条目可带端口（`example.com:8443`）；不带端口表示该域名的任意端口；**含 `*` 的条目直接忽略**并在启动日志里告警。
- 回环始终允许：本机 `curl` / 健康检查不受影响，且它本来就不是「外部可伪造」的入口。
- 反代配置 `proxy_set_header Host $host;` 传真实域名，应用照旧校验。
- 验收：`-H "Host: example.com"` → 200；`-H "Host: evil.com"` → 403（见 §7）。

### 3.2 认证：从「无认证发令牌」到「口令 + 可撤销会话」

旧实现：

```ts
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/api/auth/session"]);
if (url.pathname === "/api/auth/session" && req.method === "POST") {
    res.setHeader("set-cookie", security.sessionCookie());   // miubot_token=<64 hex>, 7 天
}
```

它安全的**唯一原因**是 `Host` 必须是回环。一旦放宽 `Host`，这个端点就变成「访问首页即获得管理员 Cookie」。

现在：

- `POST /api/auth/session` **已删除**（未认证访问 401，已认证访问 404）。
- `POST /api/auth/login`（口令 → 会话 Cookie）、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/password`。
- 会话记录只存 SHA-256：数据目录泄露也不能直接重放 Cookie。
- 连续 5 次口令错误锁 5 分钟；错误提示不区分「口令为空 / 口令错误」（都是「口令不正确」）。

### 3.3 静态托管

`viteSingleFile()` 把工作台打成**一个 HTML 文件**（`apps/web/dist/index.html`），所以托管只要一个文件 + SPA 回退：

- 非 `/api` 的 GET/HEAD → `index.html`（`/plugins` 这类前端路由由浏览器接管）。
- 其它方法 → 405；产物不存在 → 503 并提示 `npm run build --workspace=@miubot/web`。
- 没有目录映射，也就没有路径穿越面。

推荐服务端托管而不是「nginx 直接服务 dist」的理由不是省一个 nginx，而是**同源**：工作台和 API 同一个 origin，Cookie 的 `SameSite` / `Secure` / CORS 语义都退化成默认安全状态。nginx 仍要（终结 TLS、限流、body 上限），但不再承担「应用的一部分」。

## 4. 认证方案：已选 B 的窄版本

| 方案 | 结论 |
|---|---|
| A. 反代认证（basic auth / Authelia / Cloudflare Access） | 未采用：应用不知道「谁在操作」，改口令要改两处，备份漏一处就恢复不回来 |
| **B. 应用内单管理员口令** | **已采用**：scrypt + 服务端 session + 失败锁定，约 500 行（含测试） |
| C. OIDC / SSO | 个人自托管用不上 |

选 B 的理由：这套系统的权限本质是「能把任意代码装进服务器」，把这道门放在 nginx 配置里等于把唯一的锁挂在最外层、且与应用状态不同步。B 也是唯一能长出审计（谁在何时装了哪个插件）的路径——那个能力对「公网部署」比对「本机玩具」重要得多。

## 5. 分阶段清单（现状）

### P0：不完成不能暴露公网 —— ✅ 全部完成

| # | 事项 | 落点 |
|---|---|---|
| P0-1 | `MIUBOT_HOST` + `MIUBOT_ALLOWED_HOSTS` | `index.ts`、`api-security.ts` |
| P0-2 | 口令登录、可撤销会话、`Secure` Cookie、删除无认证下发 | `auth.ts`、`http/routes/auth.ts`、`http/server.ts` |
| P0-3 | 服务端托管 `apps/web/dist`（单文件 + SPA 回退） | `http/static.ts`、`http/server.ts` |
| P0-4 | `MIUBOT_DATA_DIR` | `index.ts` |

### P1：上线前必须 —— 7/8 完成

| # | 事项 | 状态 |
|---|---|---|
| P1-1 | JSON 请求体上限 1 MB | ✅ `http/response.ts` |
| P1-2 | 登录失败锁定 + 全局限速 | ✅ `auth.ts`、`http/rate-limit.ts` |
| P1-3 | 安全响应头 | ✅ `http/server.ts` |
| P1-4 | 0600/0700 + 原子写 | ✅ `storage.ts`、`app-state.ts`、`auth.ts` |
| P1-5 | 日志轮转 + 脱敏 | ✅ `logging.ts`（10 MB × 5、`redact`、单条截断） |
| P1-6 | 500 不返回内部错误文本 | ✅ `http/server.ts`（traceId） |
| P1-7 | systemd unit + 优雅退出 | ✅ `deploy/miubot.service`、`index.ts` |
| P1-8 | 备份脚本 | ✅ `deploy/backup.sh` |

### P2：上线后按需 —— 3/5 完成

- ✅ **审计日志**：`audit.ts` + `http/server.ts` 统一埋点，`GET /api/audit`，工作台「运行日志 → 审计日志」。
- ✅ **入站对象白名单**：`config.access.allowedPeers`（`group:<ID>` / `c2c:<ID>`），空 = 不限制；工作台设置页可编辑，也可从「已出现过的会话」一键加入。
- ✅ **工具策略**：文件与命令类工具启用时启动 WARN + Tools 页红字提示；`MIUBOT_DISABLE_NATIVE_TOOLS=1` 在 `agent-host.enabledToolNames()` 里整体过滤，配置里勾了也不生效。
- 插件/技能导入在公网模式下默认关闭（`MIUBOT_ALLOW_REMOTE_INSTALL=0`）——未做。注意插件导入本身就是「服务器任意代码执行」，和工具策略同级。
- 多用户与角色（届时才需要方案 C）。

## 6. 部署参考

已落地成文件，不再是「拟定」：

| 文件 | 内容 |
|---|---|
| [`Dockerfile`](Dockerfile)、[`compose.yaml`](compose.yaml)、[`.env.example`](.env.example) | 一键容器部署：两段构建、非 root（uid 10001）、具名数据卷、健康检查 |
| [`deploy/docker/README.md`](deploy/docker/README.md)、[`deploy/docker/Caddyfile`](deploy/docker/Caddyfile) | Docker 手册；`--profile tls` 时由 Caddy 自动申请证书 |
| [`deploy/README.md`](deploy/README.md) | 裸机安装、首启动口令、验收、升级、备份、安全边界 |
| [`deploy/miubot.service`](deploy/miubot.service) | systemd（`User=miubot`、`ProtectSystem=strict`、只放开数据目录） |
| [`deploy/miubot.env.example`](deploy/miubot.env.example) | 环境变量清单与说明 |
| [`deploy/nginx.conf`](deploy/nginx.conf) | TLS 终结 + `proxy_set_header Host $host` + body 上限 |
| [`deploy/backup.sh`](deploy/backup.sh) | 备份 + 权限收紧 + 轮转 |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml)、[`.github/workflows/release.yml`](.github/workflows/release.yml) | 门禁；tag 触发镜像推送与 Release（见 §9） |

两种拓扑都满足「一个 origin、一个端口」：容器里是 `miubot:8787`，裸机是 `127.0.0.1:8787`。

要点：

- **Node ≥ 22.19**（`engines` 要求）。服务端直接跑 `.ts`，靠 Node 原生类型擦除 + `--conditions=source` 解析 workspace 包源码，**没有构建步骤**；但工作台产物必须构建（`npm run build --workspace=@miubot/web`）。
- `User=miubot` 不要用 root。插件是任意代码，跑在哪个用户下就等于把那个用户交出去。
- `ProtectSystem=strict` + `ReadWritePaths` 只放开数据目录：插件想写 `/etc` 会直接失败。
- ⚠️ **不要** `proxy_set_header Host 127.0.0.1:8787;`——那是 `vite.config.ts` 为本地开发加 `changeOrigin` 的同款做法，在公网等于关掉 Host 校验。

## 7. 验收（2026-10-23 实测）

环境：`MIUBOT_PORT=8899`、`MIUBOT_ALLOWED_HOSTS=example.com`、临时数据目录、`MIUBOT_ADMIN_PASSWORD` 注入。

| 场景 | 结果 |
|---|---|
| `GET /api/health`，`Host: example.com` | 200 |
| `GET /api/health`，`Host: evil.com` | 403 |
| `GET /api/health`，回环 | 200 |
| `GET /api/config` 无凭据 | 401 |
| `GET /` / `GET /plugins` | 200 + HTML（单文件产物） |
| `POST /api/auth/session`（旧后门） | 401，无 `Set-Cookie` |
| `GET /api/auth/me` 未登录 | `{"authenticated":false}` |
| `POST /api/auth/login` 正确口令 | 200 + `miubot_session=…; HttpOnly; SameSite=Strict; Max-Age=86400; Secure` |
| 带 Cookie `GET /api/config` | 200 |
| `POST /api/auth/logout` 后同一 Cookie | 401（服务端撤销，不是过期） |
| `PUT /api/config` 1.2 MB body | 413 |
| `PUT /api/config` 坏 JSON | 400 |
| 口令错误 ×5 | 第 5 次起 429 + `Retry-After: 300`；锁定期内正确口令也 429 |
| 首启动（无口令环境变量） | 日志打印一次随机口令，`admin-password` 只存散列；二次启动不再打印 |
| `admin-sessions.json` 内容 | 只有 SHA-256 与时间戳，无会话原值 |
| `GET /api/access` 初始 | `{"allowedPeers":[],"source":"config"}` |
| `PUT /api/access` 合法键 | 200，回写去重后的列表；`PUT` 非法键（`123456`）→ 400 |
| 设 `MIUBOT_ALLOWED_PEERS=group:999, bogus-entry` 重启 | 启动日志 `入站白名单：1 个会话（来自 MIUBOT_ALLOWED_PEERS）` + WARN 忽略 `bogus-entry`；`GET /api/access` 回 `source: "env"`，`PUT` → 409 |
| 未配白名单启动 | 启动日志 WARN「任何群、任何私聊都能触发 Agent」 |
| `GET /api/audit` | 依次出现 `auth.login`、`api.mutation PUT /api/access → 200`、`→ 400` |
| 审计文件 | `audit.log` 为 JSON Lines，密钥被 `redact` 打码 |

单测：`apps/server/test/auth.test.ts`（18 项）、`response.test.ts`（9 项）、`http-server.test.ts`（18 项，真实 HTTP server + 真实 auth）、`storage.test.ts`（6 项）、`logging.test.ts`（11 项）、`audit.test.ts`（4 项）、`version.test.ts`（10 项）、`update-check.test.ts`（10 项），重写 `api-security.test.ts`；`qq-inbound.test.ts` 补了白名单两条用例。
全量 `npm test`：200 files / 1962 tests 通过。

**Linux 上还需人工确认一次**（Windows 验不了）：

- `ls -ld /var/lib/miubot` → `drwx------`，`ls -l config.json admin-password` → `-rw-------`。
- `systemctl restart miubot` 后会话、插件状态、QQ 连接都恢复，已登录浏览器无需重新登录。
- `systemctl stop miubot` 能在 `TimeoutStopSec` 内退出（SIGTERM → 断 Gateway → 关端口 → 落盘）。

## 8. 明确不做

- **不做多租户**。一个 Miubot 实例 = 一个管理员 + 他的一批 Bot。多用户等真有需求再谈。
- **不引数据库**。JSON 全量覆盖在单人管理场景够用；等出现并发写冲突或数据量级问题再换。
- **不做插件沙箱**（独立进程 / 容器）。真要做是另一个项目，见 `Plugin.md §11.1`。
- **不自研密钥加密**。把密钥和一个自研的加密密钥放同一个目录，等于没加密。靠文件权限 + 磁盘加密 + 备份加密。
- **不做 WebSocket 推送**。工作台是轮询的，公网部署下 polling 的额外成本远小于新引入的长连接状态管理。

## 9. 发布与更新

发版链路（`.github/workflows/`）：

| 文件 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push / PR / 被 release 复用 | `npm ci --ignore-scripts` → 校验模型目录快照 → `check` / `lint` / `test` → 构建工作台 + 工作台类型检查 |
| `release.yml` | 推 `v*` tag | 先跑同一套门禁，再 ①构建并推 `ghcr.io/<owner>/<repo>:<version|major.minor|latest>`（amd64 + arm64 manifest list，arm64 走 QEMU）②打 `miubot-v<version>.tar.gz`（源码 + 预构建工作台 + 已生成模型目录）③创建 GitHub Release |

**版本号**（`apps/server/src/version.ts`）优先级：`MIUBOT_VERSION`（CI 用 `--build-arg` 注入镜像）→ 仓库根 `VERSION` 文件（发布包自带）→ `package.json`。都拿不到时是 `0.0.0-dev`，工作台据此显示开发版。

**内置更新检查**（`apps/server/src/update-check.ts`）：

- `GET /api/system/update`（需登录）→ `{ enabled, current, latest, updateAvailable, url, publishedAt, checkedAt, error }`；`?refresh=1` 绕过缓存。
- 请求 `https://api.github.com/repos/<repo>/releases/latest`，5 秒超时，结果缓存 6 小时（失败缓存 5 分钟），并发调用共享同一次请求。
- 启动时预热一次；工作台「设置 → 版本与更新」显示当前版本、是否有新版、发布说明链接。
- `MIUBOT_UPDATE_CHECK=0` 完全不出站；`MIUBOT_UPDATE_REPO` 供 fork 改仓库。
- **不做自动更新**。这套系统的升级等于换掉正在跑的代码，而插件机制本来就允许装任意 Node 代码——自动拉取并执行远端产物会把升级通道变成第二条攻击面。检查只负责告诉你「有新版本」，升不升、什么时候升是管理员的决定。

## 10. 下一步

按风险从高到低：

1. ~~插件/技能导入在公网模式下默认关闭~~ **决定不做**（2026-10-23）：导入是管理员主动行为，只走已认证的管理面，
   而管理面本身已经守住了 Host / Origin / 跨站 / 凭据四层。加开关挡不住「管理员自己装了个坏插件」，
   也挡不住导入器本身的漏洞（那时被利用的就是导入路径）。真正能降低风险的是**事后可查**——
   所以 `plugin.install` / `plugin.uninstall` / `skill.install` / `skill.import` / `skill.remove`
   现在会连插件名、技能名、来源 URL 一起进审计日志，比请求级的 `POST /api/plugins/import → 200` 具体得多。
2. **审计日志补上「改了什么」**：现在记的是 `PUT /api/config → 200`，够定位是谁动的，但看不出改了哪几项。
   下一步可以在变更前后做一次字段级 diff（脱敏后入库）。
3. **会话级限流**：现在限速按来源 IP，公网多用户场景下应该按「群 / 用户」再限一层，防止单个群刷爆额度。
4. 多用户与角色（届时才需要方案 C）。
