# apps/server

本机管理 API 与官方 QQ Bot Gateway 进程。当前配置持久化在 `apps/server/.miubot/config.json`。

```powershell
npm run dev --workspace=@miubot/server
```

默认监听 `http://127.0.0.1:8787`。QQ 凭据与提供商 API Key 只保存在本机配置中，配置读取接口只返回凭据是否已配置，不回传密钥。

## 管理 API 认证

`/api/*` 只服务本机工作台：`Host` 必须是回环地址、`Origin` 必须在白名单内、且必须携带令牌。工作台通过 `POST /api/auth/session` 换取 `HttpOnly` Cookie，浏览器自动携带，页面代码不需要处理令牌。

用 `curl` 等脚本调用时手动带令牌（令牌文件由服务端首次启动生成）：

```powershell
$token = (Get-Content apps/server/.miubot/api-token).Trim()
curl.exe -H "Authorization: Bearer $token" http://127.0.0.1:8787/api/config
```

- 令牌路径：`apps/server/.miubot/api-token`；`MIUBOT_AUTH_TOKEN` 环境变量可覆盖。
- 免认证端点：`GET /api/health`、`POST /api/auth/session`（仍受 `Host` / `Origin` 约束）。
- 自定义前端端口时用 `MIUBOT_ALLOWED_ORIGINS` 追加（逗号分隔）。
- 细节与威胁模型见 `docs/10-技术架构/02-消息处理与安全.md`。
