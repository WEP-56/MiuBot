# Miubot 生产部署手册

> **想最快跑起来？** 用 Docker，一条命令：[`deploy/docker/README.md`](docker/README.md)
> （`cp .env.example .env` → `docker compose --profile tls up -d --build`）。
> 下面是裸机（systemd + nginx）路径，适合不想引入容器、或要跟现有服务共用 nginx 的场景。

面向一台 Linux VPS（systemd + nginx + HTTPS）。目标是**一个 origin、一个端口**：
服务端同时提供管理 API 与工作台静态产物，nginx 只负责 TLS、限流与请求体上限。

```
浏览器 ──HTTPS──> nginx ──HTTP(127.0.0.1:8787)──> Miubot (Node)
                                                    ├─ /            工作台（apps/web/dist/index.html）
                                                    ├─ /api/*       管理 API（口令登录 + 会话 Cookie）
                                                    └─ QQ Gateway   出站 WebSocket，不需要公网入口
```

QQ 侧没有 webhook、没有回调 URL、不需要域名备案；需要保护的只有管理面。

## 0. 前置

- Linux + systemd + nginx（或 Caddy，把 §4 换成 Caddy 的等价配置）
- Node **≥ 22.19**（`engines` 要求；服务端直接跑 `.ts`，靠原生类型擦除，没有构建步骤）
- 一个已备案域名（HTTPS 证书用）与一个系统用户

```bash
sudo useradd --system --create-home --home-dir /var/lib/miubot --shell /usr/sbin/nologin miubot
sudo install -d -m 700 -o miubot -g miubot /var/lib/miubot
sudo install -d -m 700 /etc/miubot
```

## 1. 代码与依赖

两种拿代码的方式：

```bash
# A. 从 git 拉（要自己构建工作台）
sudo git clone <repo> /opt/miubot
cd /opt/miubot
sudo npm ci --ignore-scripts
# 工作台产物：服务端直接托管 apps/web/dist/index.html（模型目录已随仓库提交）
sudo npm run build --workspace=@miubot/web
sudo chown -R miubot:miubot /opt/miubot
```

```bash
# B. 用发布包（推荐：含预构建工作台与已生成的模型目录，服务器上不用 build）
curl -fsSLO https://github.com/WEP-56/MiuBot/releases/latest/download/miubot-<版本>.tar.gz
sudo tar xzf miubot-<版本>.tar.gz -C /opt && sudo mv /opt/miubot-<版本> /opt/miubot
cd /opt/miubot && sudo npm ci --ignore-scripts
sudo chown -R miubot:miubot /opt/miubot
```

> `npm ci --ignore-scripts` 是刻意的：包的 lifecycle 脚本不该在服务器上跑。
> 发布包里的 `VERSION` 文件决定工作台显示的版本号；从 git 拉时用 `MIUBOT_VERSION` 覆盖。

## 2. 环境变量

```bash
sudo install -m 600 deploy/miubot.env.example /etc/miubot/miubot.env
sudo editor /etc/miubot/miubot.env     # 至少改 MIUBOT_ALLOWED_HOSTS
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIUBOT_HOST` | `127.0.0.1` | 监听地址。**保持回环**，公网入口交给 nginx |
| `MIUBOT_PORT` | `8787` | 监听端口 |
| `MIUBOT_DATA_DIR` | `apps/server/.miubot` | 数据目录。生产必须指到 `/var/lib/miubot` |
| `MIUBOT_ALLOWED_HOSTS` | 空 | 允许的 `Host`（真实域名，可带端口）。空 = 只接受回环；不支持 `*` |
| `MIUBOT_ALLOWED_ORIGINS` | 空 | 额外允许的浏览器 Origin；同源部署时由域名自动推导，通常不用配 |
| `MIUBOT_COOKIE_SECURE` | 配了域名即 `1` | 会话 Cookie 加 `Secure` 并下发 HSTS。纯 HTTP 内网部署要显式设 `0` |
| `MIUBOT_PASSWORD_HASH` | 空 | 管理员口令散列（`npm run hash-password --workspace=@miubot/server -- '<口令>'`） |
| `MIUBOT_ADMIN_PASSWORD` | 空 | 管理员口令明文（启动时就地散列，不落盘；适合容器 secrets） |
| `MIUBOT_WEB_DIST` | `apps/web/dist` | 工作台产物目录 |
| `MIUBOT_AUTH_TOKEN` | 读/生成 `api-token` | 自动化脚本令牌（只能走请求头，不能换浏览器 Cookie） |
| `MIUBOT_VERSION` | 空 | 版本号覆盖；发布包自带 `VERSION` 文件，通常不用配 |
| `MIUBOT_UPDATE_CHECK` | 开 | 内置更新检查（每 6 小时问一次 GitHub 公开 API，只提示不升级）；设 `0` 完全不出站 |
| `MIUBOT_UPDATE_REPO` | `WEP-56/MiuBot` | fork 后改这里，检查自己的仓库 |

## 3. systemd

```bash
sudo install -m 644 deploy/miubot.service /etc/systemd/system/miubot.service
sudo systemctl daemon-reload
sudo systemctl enable --now miubot
```

**首次启动要拿口令。** 没配 `MIUBOT_PASSWORD_HASH` / `MIUBOT_ADMIN_PASSWORD` 时，
服务会生成一个随机口令并打印一次（散列存到 `$MIUBOT_DATA_DIR/admin-password`）：

```bash
sudo journalctl -u miubot -n 50 | grep 管理员口令
```

登录后到工作台「设置 → 管理员口令」改成自己的。忘记口令时删除 `admin-password`
再重启，会重新生成并打印。

## 4. nginx + TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/miubot
sudo ln -s /etc/nginx/sites-available/miubot /etc/nginx/sites-enabled/miubot
sudo editor /etc/nginx/sites-available/miubot      # 改 server_name 与证书路径
sudo nginx -t && sudo systemctl reload nginx
```

- 反代必须 `proxy_set_header Host $host`：应用按 `MIUBOT_ALLOWED_HOSTS` 校验 Host，
  改写成 `127.0.0.1:8787` 等于关掉 DNS rebinding 防护。
- 应用**不读** `X-Forwarded-*`：不信任这些头比信任它们安全，反代负责把 Host 写对即可。
- 安全响应头（CSP / HSTS / nosniff / frame-ancestors）应用已经自己发，nginx 里再发一份也不冲突。

## 5. 验收

```bash
# 1. 工作台可加载（同源，单端口）
curl -sI https://example.com/ | head -1                       # 200
curl -s  https://example.com/ | head -3                       # HTML

# 2. 未登录时管理 API 全部 401
for p in /api/config /api/sessions /api/plugins /api/logs; do
  curl -s -o /dev/null -w "$p %{http_code}\n" https://example.com$p
done

# 3. 旧的后门端点已不存在（无认证时 401）
curl -s -X POST https://example.com/api/auth/session -o /dev/null -w "%{http_code}\n"

# 4. Host 伪造被拒（直连本机端口，绕过 nginx）
curl -s -H "Host: evil.com" http://127.0.0.1:8787/api/health -o /dev/null -w "%{http_code}\n"   # 403

# 5. 跨站 Origin 被拒
curl -s -H "Origin: https://evil.com" -H "Host: example.com" \
  http://127.0.0.1:8787/api/health -o /dev/null -w "%{http_code}\n"                              # 403

# 6. 登录下发 HttpOnly + SameSite=Strict + Secure
curl -sD- -X POST https://example.com/api/auth/login \
  -H 'content-type: application/json' -d '{"password":"..."}' | grep -i set-cookie

# 7. 请求体上限（1 MB）
head -c 2000000 /dev/zero | tr '\0' 'a' | \
  curl -s -X PUT https://example.com/api/config --data-binary @- -o /dev/null -w "%{http_code}\n"  # 413

# 8. 数据目录权限
ls -ld /var/lib/miubot && ls -l /var/lib/miubot/config.json    # drwx------ / -rw-------
```

手工确认：

- 口令连续输错 5 次后锁定 5 分钟（返回 429 + `Retry-After`）。
- 「退出登录」后原 Cookie 立即失效（服务端撤销，不靠过期）。
- `systemctl restart miubot` 后会话、插件状态、QQ 连接都恢复；已登录的浏览器无需重新登录。
- 插件装一个坏包 → 报错但不影响其它插件。

## 6. 运维

```bash
# 备份（config.json 含明文密钥，备份文件同样受保护）
MIUBOT_DATA_DIR=/var/lib/miubot ./deploy/backup.sh
crontab -e   # 17 4 * * * MIUBOT_DATA_DIR=/var/lib/miubot /opt/miubot/deploy/backup.sh

# 升级（A：从 git）
sudo systemctl stop miubot
MIUBOT_DATA_DIR=/var/lib/miubot ./deploy/backup.sh
cd /opt/miubot && sudo git pull --ff-only && sudo npm ci --ignore-scripts
sudo npm run build --workspace=@miubot/web
sudo systemctl start miubot

# 升级（B：换发布包，不用 build）
sudo systemctl stop miubot
MIUBOT_DATA_DIR=/var/lib/miubot ./deploy/backup.sh
curl -fsSLO https://github.com/WEP-56/MiuBot/releases/latest/download/miubot-<版本>.tar.gz
sudo tar xzf miubot-<版本>.tar.gz -C /opt && sudo rm -rf /opt/miubot.old
sudo mv /opt/miubot /opt/miubot.old && sudo mv /opt/miubot-<版本> /opt/miubot
cd /opt/miubot && sudo npm ci --ignore-scripts && sudo chown -R miubot:miubot /opt/miubot
sudo systemctl start miubot
```

回滚 = 换回上一个 commit / 上一个发布包 + 恢复备份（`config.json` 没有版本号，配置结构变更时要一起回滚）。

升级后到工作台「设置 → 版本与更新」确认版本号变了。那里也会提示有没有更新的版本
（每 6 小时问一次 GitHub 公开 API，不自动升级；`MIUBOT_UPDATE_CHECK=0` 可关）。

日志：`journalctl -u miubot -f`；工作台「运行日志」页读的是同一份（内存最近 1000 条 + `$MIUBOT_DATA_DIR/runtime.log`）。
`runtime.log` 按 10 MB 轮转、保留 5 份（≈50 MB 上限），写入前统一脱敏，单条超长会被截断。

## 7. 公网部署的安全边界

- **插件 = 本进程内任意 Node 代码**，不是沙箱。能装插件 ≈ 能在服务器上跑命令。
  `systemd` 的 `ProtectSystem=strict` 只是兜底，不是隔离。
- **`tools.enabled` 只留 `web_search`**。`bash` / `write` / `edit` 一旦打开，任何群成员
  的一条消息都可能变成服务器上的命令（提示注入 = RCE）。
- 入站没有对象白名单：Bot 所在的任何群、任何私聊都能触发 Agent。需要时按路线图补 `allowedPeers`。
- 数据目录走独立低权限用户（`miubot`），别用 root。
