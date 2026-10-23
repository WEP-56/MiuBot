# Miubot 公网部署与安全适配

> 2026-10-23。这份文档是「把 Miubot 放到公网」的现状评估与实施计划，不是使用手册。
> 手册（装什么、怎么起、怎么备份）在 §6；为什么现在还不能放、要先改什么在 §3 / §5。

## 0. 结论先行

**今天不能直接把管理面暴露到公网。** 不是配置问题，是三个代码级的硬阻断：

1. 监听地址与 `Host` 校验都硬编码成回环（`index.ts:266`、`api-security.ts:76`）。改环境变量没用，得改代码。
2. `/api/auth/session` 是**无认证的令牌下发口**——过了 `Host` / `Origin` 就白送一个 7 天有效的管理会话。今天唯一挡住它的就是第 1 条的回环校验。所以「让 nginx 把 Host 改写成 `127.0.0.1:8787`」能让整站"跑起来"，同时把唯一的门锁卸了。这条路必须堵死，不能当部署方案用。
3. 服务端不托管工作台构建产物，生产拓扑里没有一个"一个端口、一个 origin"的合法形态，只能退化成「vite dev + 反代」这种不该上线的组合。

**今天就能上服务器跑的形态**（零改动）：见 §6.4，SSH 隧道进工作台。适合先把它真正跑在 VPS 上观察几天，把数据、日志、重启这些运维问题先暴露出来，再动认证。

**QQ 侧不需要公网入口。** `transport: "websocket"`（`qq/connection.ts:75`），出站连接。没有 webhook、没有回调 URL、没有签名校验、不需要域名备案。需要暴露的只有**管理面**——而这恰恰是整个系统里权限最大的东西：能装任意插件、能开 shell 工具、能改模型 Key。这决定了安全投入的重心在哪。

## 1. 需要保护的到底是什么

按敏感度从高到低：

| 面 | 内容 | 泄露/被控后果 |
|---|---|---|
| 管理 API 写操作 | `/api/plugins/import`、`/api/skills/import`、`PUT /api/tools`、`PUT /api/config` | **服务器任意代码执行**（插件与技能都是本进程内跑的 Node 代码），可读 `.miubot/` 下的全部密钥 |
| 管理 API 读操作 | `/api/sessions`、`/api/logs`、`PUT /api/chat` | 全部群聊/私聊内容、模型 Key（`publicConfig` 已遮蔽，但插件/skill 文件不一定） |
| 数据目录 | `apps/server/.miubot/`：`config.json`（QQ AppSecret + 各 Provider apiKey 明文）、`api-token`、会话、插件数据 | 直接接管 Bot 与模型额度 |
| QQ 入站 | 任何群成员的消息都能触发 Agent 与工具 | token 消耗；若开了 `bash` / `write` 工具，**提示注入 = RCE** |

这四条里最容易忽略的是最后一条：它不需要攻击管理面，只需要在群里发一条精心构造的消息。

## 2. 现状盘点

### 2.1 网络与边界

| 项 | 现状 | 公网可用 | 处理 |
|---|---|---|---|
| 监听地址 | `listen(port, "127.0.0.1")` 硬编码 | ❌ | P0-1：`MIUBOT_HOST`，默认仍回环 |
| `Host` 校验 | 只接受 `127.0.0.1` / `localhost` / `[::1]`，且端口必须等于服务端口 | ❌ | P0-1：改成显式允许名单 `MIUBOT_ALLOWED_HOSTS`，默认等价于现在的值 |
| `X-Forwarded-*` | 完全不读 | ✅ 反而好 | 保持不读。信任这些头等于让任何客户端伪造 Host/协议；反代应改 `Host`（`proxy_set_header Host $host`） |
| CORS | 白名单回写，不发 `*`，`Origin: null` 拒绝 | ✅ | 保留；域名要进 `MIUBOT_ALLOWED_ORIGINS` |
| 静态托管 | 无。`/` 返回 404 | ❌ | P0-3：二选一（见下） |
| 请求体上限 | JSON 走 `body()`，**无上限**；只有 ZIP 上传用 `binaryBody(20MB)` | ❌ | P1-1：JSON 设 1 MB |
| 速率限制 | 无（插件发送有，HTTP 没有） | ❌ | P1-2 |
| 安全响应头 | 无 CSP / HSTS / `X-Content-Type-Options` / `frame-ancestors` | ❌ | P1-3（nginx 层即可） |

### 2.2 认证与传输

| 项 | 现状 | 公网可用 | 处理 |
|---|---|---|---|
| 令牌模型 | 单一共享令牌，64 位 hex，存 `.miubot/api-token`（0600） | ⚠️ 能用，但无"用户"概念 | P0-2 |
| 浏览器会话 | `POST /api/auth/session` **无认证**下发 `miubot_token` Cookie，`Max-Age=604800` | ❌ **致命** | P0-2：删掉无条件下发，换成口令登录 |
| Cookie 属性 | `HttpOnly; SameSite=Strict; Path=/`（**无 `Secure`**） | ❌ | P0-2：HTTPS 下加 `Secure`，会话改服务端可撤销 |
| TLS | 无。Node 只监听 HTTP | — | 交给 nginx / Caddy 终结，应用不碰证书 |
| 登录失败保护 | 无 | ❌ | P1-2 |
| 权限模型 | 全有或全无（拿到令牌 = 管理员） | 单管理员可接受 | 见 §4 |

### 2.3 数据与运维

| 项 | 现状 | 公网可用 | 处理 |
|---|---|---|---|
| 数据目录 | 硬编码 `apps/server/.miubot` | ❌ 容器化/只读根文件系统时没法挂卷 | P0-4：`MIUBOT_DATA_DIR` |
| `config.json` 权限 | `writeFile` 默认 mode（典型 umask 022 → **0644，同机其他用户可读**） | ❌ | P1-4：0600 + 目录 0700 |
| 写盘原子性 | 全量覆盖 `writeFile`，无临时文件 + rename | ❌ 写一半崩掉 = 配置全丢 | P1-4 |
| 密钥存储 | 明文 JSON | ⚠️ | 不做自研加密（密钥还得放同一个文件）。靠文件权限 + 磁盘加密 + 备份加密 |
| 日志 | `runtime.log` 追加写，**无轮转** | ❌ 公网长期跑会撑爆磁盘 | P1-5 |
| 错误响应 | 500 直接回 `error.message`（含路径、堆栈文案） | ⚠️ 信息泄露 | P1-6 |
| 守护 | 无 systemd / Dockerfile | ❌ | P1-7 |
| 备份 | 无 | ❌ | §6.3 |

### 2.4 执行面（部署文档必须讲清楚的部分）

- **插件 = 本进程内任意 Node 代码**，不是沙箱。`packages/plugin/src/host/` 只约束"能通过 `ctx` 拿到什么"，约束不了 `import("node:fs")`。所以"能装插件"这个权限等价于 root 级权限（同一用户下）。
- **技能同理**：`agentDir` 下的 `SKILL.md` 与脚本会被 Agent 读取执行。
- **`bash` / `write` / `edit` 工具可由模型调用**（`config.tools.enabled` 里加入即可，`toolNames` 允许）。默认值只有 `web_search`，但工作台上点一下就能开。开了之后，任何群成员的一条消息都可能变成服务器上的命令。
- **入站没有对象白名单**：Bot 所在的任何群、任何私聊都能触发 Agent。没有 `allowedPeers` 之类的策略层。

→ 这三条合起来给出一条硬规则：**公网部署时，`tools.enabled` 只留 `web_search`；`/api/plugins/import` 与 `/api/skills/import` 只在明确需要时开，且知道它们等于给管理员发了 shell。**

## 3. 三个硬阻断，逐个说清楚

### 3.1 监听地址与 `Host` 校验

现在：

```ts
// index.ts
createServer(...).listen(port, "127.0.0.1", ...)
// api-security.ts
if (!isLoopbackHost(facts.host, options.port)) return { ok: false, status: 403, ... }
```

`Host` 校验的本意是防 DNS rebinding（外部域名解析到 127.0.0.1，浏览器带着 `Host: evil.com` 打到本机服务）。这个目标在公网部署下依然成立，只是"允许的名字"从回环变成一个明确列出的域名。

改法：

- `MIUBOT_HOST`（默认 `127.0.0.1`）控制 `listen` 地址。
- `MIUBOT_ALLOWED_HOSTS`（默认空 = 沿用现在的回环集合）显式列出允许的 `Host`（`example.com`、`example.com:443`）。**不提供 `*`**，不读 `X-Forwarded-Host`。
- 反代配置 `proxy_set_header Host $host;` 传真实域名，应用照旧校验。
- 验收：`curl -H "Host: example.com" http://127.0.0.1:8787/api/health` → 200；`-H "Host: evil.com"` → 403。

### 3.2 `/api/auth/session` 是无认证令牌下发口

这是当前设计里最容易被部署方案无意中解开的一环。

```ts
const UNAUTHENTICATED_PATHS = new Set(["/api/health", "/api/auth/session"]);
...
if (url.pathname === "/api/auth/session" && req.method === "POST") {
    res.setHeader("set-cookie", security.sessionCookie());   // miubot_token=<64 hex>, 7 天
    json(res, 200, { ok: true });
}
```

设计原意是"工作台不接触令牌，同源换 Cookie"，在这个前提下必须免认证。它安全的**唯一原因**是 `Host` 必须是回环——攻击者要让浏览器带着 `Host: 127.0.0.1:8787` 发请求，只能从本机发起。

一旦公网部署放宽 `Host`，这个端点就变成"访问首页即获得管理员 Cookie"。而 `vite.config.ts` 里那行 `changeOrigin: true` 的注释（"代理必须改写 Host，否则 403"）恰好给了一个"看起来能跑通"的错误示范：反代照抄这行，整站立刻可用，同时彻底失去认证。

改法（P0-2，方案见 §4）：

- 删除该端点，或让它只在"已认证"时可用（用于刷新会话）。
- 新增口令登录：`POST /api/auth/login`（body 口令）→ 校验 scrypt 散列表 → 签发服务端可撤销的 session id。
- Cookie 加 `Secure`（HTTPS 下），`Max-Age` 缩短到 24h，登出能真正失效。
- 令牌从"浏览器会话凭据"降级为"自动化脚本用"（`Authorization: Bearer` 保留，供 curl / CI）。

### 3.3 没有静态托管，生产拓扑没有合法形态

`viteSingleFile()` 把工作台打成**一个 HTML 文件**（`apps/web/dist/index.html`）。这意味着托管成本极低，但服务端现在完全不碰它，于是只剩两条路：

- **A. nginx 直接服务 `index.html` + 反代 `/api`**：服务端保持纯 API。多一个组件，但攻击面更小，缓存/压缩/证书都在同一层。
- **B. 服务端托管 dist**（约 15 行：固定读 `dist/index.html`，非 `/api` 请求回退到它）：一个端口、一个 origin，部署拓扑最简单，Docker 友好。

**推荐 B**，理由不是省一个 nginx，而是**同源**：工作台和 API 同一个 origin，Cookie 的 `SameSite` / `Secure` / CORS 语义都退化成默认安全状态，不会出现"前端在 `example.com`、API 在 `api.example.com`，跨站 Cookie 一路踩坑"。nginx 仍要（终结 TLS、限流、body 上限），但不再承担"应用的一部分"。

验收：`curl -s https://example.com/ | head -3` 返回 HTML；`curl -s https://example.com/api/health` 返回 JSON。

## 4. 认证方案：需要拍板

| 方案 | 改动量 | 优点 | 缺点 |
|---|---|---|---|
| **A. 反代认证**（nginx basic auth / Caddy + Authelia / Cloudflare Access） | 最小，只删 3.2 那个端点 | 不写认证代码；复用成熟方案 | 应用不知道"谁在操作"，没有审计身份；反代配置被改一次就全裸；本地开发也要维护一份口令 |
| **B. 应用内单管理员口令**（scrypt + 服务端 session + 失败限速） | 约 250 行 + 测试 | 认证与应用同生命周期，配置跟 `.miubot/` 一起备份；是将来多用户/审计的基础 | 要自己写：CSRF 已有 Origin+SameSite，口令重置要手工 |
| **C. OIDC / SSO** | 大 | 多用户、企业场景 | 个人自托管用不上，且引入外部依赖 |

**推荐 B 的窄版本**：一个管理员口令（`MIUBOT_PASSWORD_HASH` 或首启动生成到 `.miubot/admin-password`）、服务端 session 表（内存 + 落盘可选）、失败 5 次锁 5 分钟。

理由是这套系统的权限本质是"能把任意代码装进服务器"。把这道门放在 nginx 配置里，等于把唯一的锁挂在最外层、且与应用状态不同步（改了口令要改两个地方，备份漏掉一个就恢复不回来）。而且 B 是唯一能长出审计（谁在什么时候装了哪个插件）的路径——那个能力对"公网部署"比对"本机玩具"重要得多。

选 A 也能上线，但要接受：工作台里所有操作在日志里都不可归因。

## 5. 分阶段清单

### P0：不完成不能暴露公网

| # | 事项 | 落点 | 验收 |
|---|---|---|---|
| P0-1 | `MIUBOT_HOST` + `MIUBOT_ALLOWED_HOSTS`（不可为 `*`） | `index.ts`、`api-security.ts` | 见 §3.1 的两条 curl |
| P0-2 | 认证模型改造：删无认证令牌下发、口令登录、可撤销 session、`Secure` Cookie | `api-security.ts`、`http/server.ts`、新增 `http/routes/auth.ts` | 未登录访问任意 `/api/*` → 401；错误口令 5 次后锁定；登出后原 Cookie 失效 |
| P0-3 | 服务端托管 `apps/web/dist`（单文件 + SPA 回退，非 `/api` 路径） | `http/server.ts` | `GET /` 返回 HTML；`GET /plugins` 也返回 HTML；`GET /api/nope` 返回 JSON 404 |
| P0-4 | `MIUBOT_DATA_DIR`（默认 `apps/server/.miubot`） | `index.ts` | 指到 `/var/lib/miubot` 后数据全在那边；仓库目录只读也能跑 |

### P1：上线前必须

| # | 事项 | 说明 |
|---|---|---|
| P1-1 | JSON 请求体上限 1 MB | `response.ts` 的 `body()` 加 `maxBytes`，超限 413 |
| P1-2 | 限速：登录端点 + 全局 | 登录 5 次/5 分钟；其它按 IP 简单令牌桶（内存即可，单实例） |
| P1-3 | 安全响应头 | `X-Content-Type-Options: nosniff`、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer`、HSTS（仅 HTTPS）、CSP（单文件产物需要 `'unsafe-inline'`，先只加 `default-src 'self'`） |
| P1-4 | `config.json` / 会话文件 0600 + 原子写 | 临时文件 + `rename`；`mkdir` 时 0700 |
| P1-5 | 日志轮转 + 脱敏 | 按大小切割（10 MB × 5）；`apiKey` / `appSecret` / 消息正文不进日志 |
| P1-6 | 500 不返回内部错误文本 | 只回 trace id，详情进日志 |
| P1-7 | systemd unit + 优雅退出（SIGTERM 时落盘、断开 WS） | §6.1 |
| P1-8 | 备份脚本 | §6.3 |

### P2：上线后按需

- 审计日志：谁（session）在何时改了配置 / 装了插件 / 开了工具。
- 入站对象白名单（`allowedPeers` / 群黑白名单），控制"谁能用这个 Bot"。
- 公网模式下的工具策略：默认禁 `bash` / `powershell` / `write` / `edit` / `read`，需要时显式开启并记审计。
- 插件/技能导入在公网模式下默认关闭（`MIUBOT_ALLOW_REMOTE_INSTALL=0`）。
- 数据目录走独立低权限用户 + `ProtectSystem=strict`（systemd 已给骨架）。
- 多用户与角色（届时才需要方案 C）。

## 6. 部署参考

以下配置随 P0 落地会放进 `deploy/` 目录；现在先作为设计目标，标注为**拟定**。

### 6.1 systemd（拟定）

```ini
# /etc/systemd/system/miubot.service
[Unit]
Description=Miubot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=miubot
Group=miubot
WorkingDirectory=/opt/miubot/apps/server
Environment=NODE_ENV=production
Environment=MIUBOT_PORT=8787
Environment=MIUBOT_HOST=127.0.0.1
Environment=MIUBOT_DATA_DIR=/var/lib/miubot
# 域名部署时再加：
# Environment=MIUBOT_ALLOWED_HOSTS=example.com
# Environment=MIUBOT_ALLOWED_ORIGINS=https://example.com
ExecStart=/usr/bin/node --conditions=source --enable-source-maps src/index.ts
Restart=always
RestartSec=3
# 崩溃前留最后 200 行
StandardOutput=journal
StandardError=journal
# 收紧：只有数据目录可写
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/miubot
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

要点：

- **Node ≥ 22.19**（`engines` 要求）。服务端直接跑 `.ts`，靠 Node 原生类型擦除 + `--conditions=source` 解析 workspace 包源码，**没有构建步骤**——改完 `git pull` 重启即可，但也就意味着线上跑的是源码，别在服务器上改文件。
- `User=miubot` 不要用 root。插件是任意代码，跑在哪个用户下就等于把那个用户交出去。
- `ProtectSystem=strict` + `ReadWritePaths` 只放开数据目录：插件想写 `/etc` 会直接失败。

### 6.2 nginx（拟定，TLS + 一层兜底）

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # 插件 ZIP 上限 20 MB，留点余量
    client_max_body_size 25m;
    # /api/chat 是同步模型调用，可能几十秒
    proxy_read_timeout 300s;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        # 传真实域名：应用按 MIUBOT_ALLOWED_HOSTS 校验，不要改写成 127.0.0.1
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 应用不读 X-Forwarded-For，这里只留给 nginx 自己的日志
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

⚠️ **不要** `proxy_set_header Host 127.0.0.1:8787;`——那是 `vite.config.ts` 为本地开发加 `changeOrigin` 的同款做法，在公网等于关掉 Host 校验。

### 6.3 备份（拟定）

数据全在 `$MIUBOT_DATA_DIR`（默认 `apps/server/.miubot`）：

```bash
# config.json 含明文 AppSecret 与 Provider apiKey —— 备份必须同样受保护
tar czf /var/backups/miubot-$(date +%F).tar.gz -C /var/lib miubot
find /var/backups -name 'miubot-*.tar.gz' -mtime +14 -delete

# 可选：用 age / gpg 加密后再出机器
age -r <pubkey> -o /var/backups/miubot-$(date +%F).tar.gz.age /var/backups/miubot-$(date +%F).tar.gz
```

恢复：停服务 → 解包到数据目录 → 确认 `chmod 600 config.json api-token` → 起服务。
**`api-token` 与口令散列都在里面**，恢复后旧浏览器 Cookie 依然有效，必要时同时轮换。

### 6.4 现在就能用的过渡形态（零改动）

目标：先把 Miubot 真的跑在 VPS 上，不暴露任何端口。

```bash
# 服务器
cd /opt/miubot && npm ci --ignore-scripts && npm run generate:model-data
(cd apps/server && nohup npm start &)      # 监听 127.0.0.1:8787
(cd apps/web && nohup npm run dev &)       # 监听 127.0.0.1:5173

# 本地
ssh -N -L 5173:127.0.0.1:5173 user@server
# 浏览器打开 http://127.0.0.1:5173
```

为什么这样能过校验：浏览器发的是 `Host: 127.0.0.1:5173`，Vite 代理 `changeOrigin` 后转成 `Host: 127.0.0.1:8787` 落在回环集合里，`Origin: http://127.0.0.1:5173` 也在白名单（`api-security.ts:64` 里固定放行 5173）。

代价：跑的是 `vite dev`（不适合长期），且只有能 SSH 的人能用。**适合过渡，不要当成终态。**

### 6.5 升级流程（拟定）

```bash
systemctl stop miubot
tar czf /var/backups/miubot-before-upgrade.tar.gz -C /var/lib miubot
cd /opt/miubot && git pull --ff-only
npm ci --ignore-scripts
npm run generate:model-data
systemctl start miubot
```

回滚 = 换回上一个 commit + 恢复备份（配置结构变更时尤其要一起回滚，`config.json` 没有版本号）。

## 7. 验收清单

P0 完成后按顺序跑（假设域名 `example.com`）：

```bash
# 1. 域名能通，工作台可加载
curl -sI https://example.com/ | head -1                 # 200

# 2. 未认证访问管理 API 全部 401
for p in /api/config /api/sessions /api/plugins /api/logs; do
  curl -s -o /dev/null -w "$p %{http_code}\n" https://example.com$p
done

# 3. 旧的后门端点已失效
curl -s -X POST https://example.com/api/auth/session -o /dev/null -w "%{http_code}\n"   # 401 / 404

# 4. Host 伪造被拒（直连本机端口，绕过 nginx）
curl -s -H "Host: evil.com" http://127.0.0.1:8787/api/health -o /dev/null -w "%{http_code}\n"   # 403

# 5. 跨站 Origin 被拒
curl -s -H "Origin: https://evil.com" -H "Host: example.com" http://127.0.0.1:8787/api/health -o /dev/null -w "%{http_code}\n"  # 403

# 6. Cookie 带 Secure 与 HttpOnly
curl -sD- -X POST https://example.com/api/auth/login -d '{"password":"..."}' | grep -i set-cookie

# 7. 请求体上限
head -c 2000000 /dev/zero | tr '\0' 'a' | curl -s -X POST https://example.com/api/config --data-binary @- -o /dev/null -w "%{http_code}\n"  # 413

# 8. 数据目录权限
ls -ld /var/lib/miubot && ls -l /var/lib/miubot/config.json    # drwx------ / -rw-------
```

另外手工确认：

- 登录失败 5 次后锁定，且锁定提示不区分"口令错误"与"不存在"。
- 登出后原 Cookie 立刻失效（服务端撤销，不是靠过期）。
- `systemctl restart miubot` 后会话、插件状态、QQ 连接都恢复。
- 插件装一个坏包 → 报错但不影响其它插件（已有测试覆盖，线上再确认一次）。

## 8. 明确不做

- **不做多租户**。一个 Miubot 实例 = 一个管理员 + 他的一批 Bot。多用户等真有需求再谈。
- **不引数据库**。JSON 全量覆盖在单人管理场景够用；等出现并发写冲突或数据量级问题再换，现在换只是把复杂度提前。
- **不做插件沙箱**（独立进程 / 容器）。真要做是另一个项目，见 `Plugin.md §11.1`。
- **不自研密钥加密**。把密钥和一个自研的加密密钥放同一个目录，等于没加密。靠文件权限 + 磁盘加密 + 备份加密。
- **不做 WebSocket 推送**。工作台是轮询的，公网部署下 polling 的额外成本远小于新引入的长连接状态管理。

## 9. 下一步

建议按这个顺序，每步都能单独验收、单独回滚：

1. **P0-4 数据目录可配置**（最小、无风险，先让部署拓扑能成立）。
2. **P0-1 Host / 监听可配置**（改完仍默认回环，不影响本地）。
3. **P0-3 静态托管**（工作台能直接从服务端口打开，拓扑收敛成一个 origin）。
4. **P0-2 认证改造**（最大一块，也最需要先定方案，见 §4）。
5. P1 整组，再上公网。

在动第 4 步之前需要定一件事：**走 §4 的方案 B（应用内口令），还是先用方案 A（反代认证）把公网上起来？** 两者代码量差一个数量级，但审计能力和长期维护成本也差一个数量级。
