# apps/server

管理 API 与官方 QQ Bot Gateway 进程。配置、会话与插件数据默认持久化在 `apps/server/.miubot/`，
生产部署用 `MIUBOT_DATA_DIR` 指到独立卷（见仓库根 `deploy/README.md`）。

```powershell
npm run dev --workspace=@miubot/server
```

默认监听 `http://127.0.0.1:8787`。QQ 凭据与提供商 API Key 只保存在本机配置中，配置读取接口只返回凭据是否已配置，不回传密钥。

## 管理面认证

`/api/*` 只服务管理员。四层校验（`src/api-security.ts`）：`Host`（回环或 `MIUBOT_ALLOWED_HOSTS`）→ `Origin` 白名单 → `Sec-Fetch-Site` → 凭据。

凭据有两种：

- **浏览器**：口令登录换 `HttpOnly` 会话 Cookie，之后同源 `fetch` 自动携带。会话由服务端保存（`admin-sessions.json`，只存 SHA-256），可撤销、24h 滑动续期。
- **脚本**：`api-token` 走请求头，不参与浏览器流程。

```powershell
# 脚本调用
$token = (Get-Content apps/server/.miubot/api-token).Trim()
curl.exe -H "Authorization: Bearer $token" http://127.0.0.1:8787/api/config
```

### 管理员口令

- 散列存 `<数据目录>/admin-password`（0600）；`MIUBOT_PASSWORD_HASH` / `MIUBOT_ADMIN_PASSWORD` 可覆盖。
- 首次启动若两者都没有，会生成一个随机口令并**打印一次**到启动日志（散列落盘，明文不落盘）。
  忘记口令：删掉 `admin-password` 重启，重新生成。
- 生成散列：`npm run hash-password --workspace=@miubot/server -- '<口令>'`。
- 登录后可在工作台「设置 → 管理员口令」修改；改完其他会话立即作废。
- 连续 5 次口令错误锁 5 分钟。

### 端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /api/health` | 免 | 存活探测 + 当前版本 |
| `GET /api/system/update` | 需 | 内置更新检查（`?refresh=1` 绕过 6 小时缓存）；只提示，不自动升级 |
| `POST /api/auth/login` | 免 | `{ password }` → 下发会话 Cookie；错误 401，锁定 429 + `Retry-After` |
| `POST /api/auth/logout` | 免 | 撤销当前会话并清 Cookie |
| `GET /api/auth/me` | 免 | `{ authenticated, sessions }`，工作台据此决定显示登录页还是工作台 |
| `POST /api/auth/password` | 需 | `{ current, next }`，改口令并作废其他会话 |
| 其余 `/api/*` | 需 | 会话 Cookie 或 `Authorization: Bearer` |

- 旧端点 `POST /api/auth/session`（无认证下发令牌 Cookie）**已删除**。
- 自定义前端端口时用 `MIUBOT_ALLOWED_ORIGINS` 追加（逗号分隔）；同源部署时 Origin 由 `MIUBOT_ALLOWED_HOSTS` 自动推导。
- 细节与威胁模型见 `docs/10-技术架构/02-消息处理与安全.md`，部署步骤见 `deploy/README.md`。

## 静态托管

服务端同时提供工作台：非 `/api` 的 GET/HEAD 一律回 `apps/web/dist/index.html`（SPA 回退），
产物不存在时返回 503 并提示构建。`MIUBOT_WEB_DIST` 可改路径。

## 运行日志

`runtime.log` 按 10 MB 轮转、保留 5 份（`runtime.log.1`…`.4`，合计约 50 MB），启动时跨文件恢复最近 1000 条给工作台。
写入前统一脱敏（`sk-` 类密钥、Bearer、`apiKey=` 这类键值对、32 位以上十六进制、超长 base64），单条超过 2000 字符截断——
调用点不需要各自记得处理。首次启动生成的管理员口令**只写进程输出**，不进 `runtime.log`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIUBOT_HOST` | `127.0.0.1` | 监听地址 |
| `MIUBOT_PORT` | `8787` | 监听端口 |
| `MIUBOT_DATA_DIR` | `apps/server/.miubot` | 数据目录 |
| `MIUBOT_ALLOWED_HOSTS` | 空 | 允许的 `Host`（域名，可带端口；不支持 `*`） |
| `MIUBOT_ALLOWED_ORIGINS` | 空 | 额外允许的浏览器 Origin |
| `MIUBOT_COOKIE_SECURE` | 配了域名即开 | 会话 Cookie 加 `Secure`，同时下发 HSTS |
| `MIUBOT_PASSWORD_HASH` / `MIUBOT_ADMIN_PASSWORD` | 空 | 管理员口令 |
| `MIUBOT_WEB_DIST` | `apps/web/dist` | 工作台产物目录 |
| `MIUBOT_AUTH_TOKEN` | 读/生成 `api-token` | 自动化令牌 |
| `MIUBOT_VERSION` | 空 | 版本号覆盖（发布包用根 `VERSION` 文件） |
| `MIUBOT_UPDATE_CHECK` | 开 | 更新检查；`0` = 完全不出站 |
| `MIUBOT_UPDATE_REPO` | `WEP-56/MiuBot` | 更新检查的仓库（fork 用） |

## 退出

`SIGTERM` / `SIGINT` 会断开 QQ Gateway、关闭 HTTP 端口、落盘会话后退出（systemd 停服务即走这条路径）。
