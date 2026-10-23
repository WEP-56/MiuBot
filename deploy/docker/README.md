# Docker 部署

一条命令起一个容器：管理 API、工作台、QQ Gateway 都在同一个进程里，只需要**一个端口**。
数据全在具名卷 `miubot-data` 里，删容器不丢配置。

```
浏览器 ──HTTPS──> caddy（可选，自动证书） ──HTTP──> miubot:8787
                                                    ├─ /            工作台
                                                    ├─ /api/*       管理 API（口令登录）
                                                    └─ QQ Gateway   出站连接，不需要入口
```

## 1. 三种起法，按你的情况挑一个

前置：Docker Engine + Compose v2（`docker compose version` 有输出即可）。

```bash
git clone https://github.com/WEP-56/MiuBot.git && cd MiuBot
cp .env.example .env
```

> **不想在机器上构建？** 用官方发布镜像：`.env` 里设
> `MIUBOT_IMAGE=ghcr.io/wep-56/miubot:latest`，然后 `docker compose pull && docker compose up -d`
> （ARM 机器推荐这条路，CI 只出 amd64 镜像；ARM 也能本地 `--build`，只是慢）。
> 下面的 `--build` 步骤在没有镜像时才需要。

### A. 有域名，要自动 HTTPS（最常见）

```bash
# .env 里填 MIUBOT_DOMAIN=bot.example.com，并把域名 A/AAAA 记录指向这台机器
docker compose --profile tls up -d --build
```

Caddy 会自动申请证书、80 跳 443。开放端口：**80 / 443**。

### B. 已有反代（nginx / Traefik / Cloudflare Tunnel）

```bash
# .env 里同样填 MIUBOT_DOMAIN（应用靠它做 Host 校验）
docker compose up -d --build
```

容器只绑 `127.0.0.1:8787`，由你的反代转发过去。反代**必须保留原始 Host**：

```nginx
proxy_pass http://127.0.0.1:8787;
proxy_set_header Host $host;      # 不要写成 127.0.0.1:8787
```

### C. 只想在内网 / 本机试

```bash
# .env 里 MIUBOT_DOMAIN 留空
docker compose up -d --build
curl -s http://127.0.0.1:8787/api/health
```

此时只有回环地址被接受；从别的机器用 IP 访问会 403（这是 Host 校验在起作用，不是故障）。
真要从内网其它机器访问，把 `MIUBOT_BIND=0.0.0.0`、`MIUBOT_DOMAIN=<内网IP或域名>` 一起改。

## 2. 首次启动：拿管理员口令

没在 `.env` 里配 `MIUBOT_PASSWORD_HASH` / `MIUBOT_ADMIN_PASSWORD` 时，首次启动会生成一个随机口令，
**只打印一次**（散列存进数据卷）：

```bash
docker compose logs miubot | grep 管理员口令
```

登录后到工作台「设置 → 管理员口令」改成自己的。

## 3. 数据、备份、升级

```bash
# 数据卷里有什么：config.json（含 QQ AppSecret 与 Provider apiKey 明文）、
# 会话、插件数据、admin-password（散列）、admin-sessions.json、runtime.log
docker compose exec miubot ls -l /var/lib/miubot

# 备份（备份文件同样敏感，出机器前建议再加密）
docker compose exec -T miubot tar czf - -C /var/lib miubot > miubot-$(date +%F).tar.gz

# 恢复
docker compose stop miubot
docker compose run --rm --no-deps -T miubot sh -c 'rm -rf /var/lib/miubot/* && tar xzf - -C /var/lib' < miubot-2026-10-23.tar.gz
docker compose start miubot

# 升级（两种，看你是本地构建还是用发布镜像）
# 用发布镜像：
docker compose pull && docker compose up -d
# 本地构建：
git pull --ff-only && docker compose build && docker compose up -d

# 升级前先备份（配置结构变更时要和备份一起回滚）
docker compose exec -T miubot tar czf - -C /var/lib miubot > miubot-before-upgrade.tar.gz
```

升级完成后到工作台「设置 → 版本与更新」确认版本号变了。那里也会提示有没有更新的版本
（每 6 小时问一次 GitHub 公开 API，不自动升级；`MIUBOT_UPDATE_CHECK=0` 可关）。

`docker compose down` 保留数据卷；`docker compose down -v` 会**连数据一起删**。

## 4. 运维小事

```bash
# 看日志（容器 stdout + 应用自己的运行日志页读的是同一份数据）
docker compose logs -f --tail=100 miubot

# 改口令（工作台里改也行）
docker compose exec miubot rm /var/lib/miubot/admin-password
docker compose restart miubot && docker compose logs --tail=30 miubot | grep 管理员口令

# 进容器排障（非 root 用户）
docker compose exec miubot sh
```

## 5. 常见问题

| 现象 | 原因 |
|---|---|
| 访问域名返回 403「Host 不被允许」 | `.env` 的 `MIUBOT_DOMAIN` 没填，或反代把 Host 改写成了 `127.0.0.1:8787` |
| 登录后立刻又回登录页 | 走的是纯 HTTP，但 Cookie 带了 `Secure`。设 `MIUBOT_COOKIE_SECURE=0`，或改用 HTTPS |
| 容器起来就退出，日志提示 `EACCES` | 用了 `./data:/var/lib/miubot` 绑定挂载但目录属主不对：`chown 10001:10001 ./data`（或直接用默认具名卷） |
| 工作台 503「尚未构建」 | 镜像里 `apps/web/dist` 缺失，通常是构建阶段失败；看 `docker compose build` 的输出 |
| 时间不对 / 静默时段错乱 | `.env` 里的 `TZ` 没设（容器默认 UTC） |
| 日志里 Host 校验把健康检查挡了 | 健康检查打的是 `127.0.0.1:8787`，回环始终放行；若改过 `MIUBOT_PORT` 也会自动跟随 |
| `docker compose build` 在 `npm prune` 一步失败 | 去掉 Dockerfile 里 `&& npm prune --omit=dev --ignore-scripts` 重新构建（镜像会大一些，功能不受影响） |
| 22.x 日志里出现 Type Stripping 的实验性提示 | Node 22 的固有警告，不影响运行；介意就用 `node:24-slim` 替换 Dockerfile 里两处基础镜像 |

## 6. 安全提醒

- 容器里跑的是**非 root**（uid 10001），但插件仍是**进程内任意 Node 代码**：能装插件 ≈ 能在容器里跑命令。
  容器边界只能挡住宿主，挡不住「同容器内的插件读 `config.json`」。
- `tools.enabled` 只留 `web_search`。开了 `bash` / `write`，任何群成员的一条消息都可能变成命令。
- 不要把 8787 直接绑到 `0.0.0.0` 又不加 TLS。
