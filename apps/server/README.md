# apps/server

本机管理 API 与官方 QQ Bot Gateway 进程。当前配置持久化在 `apps/server/.miubot/config.json`。

```powershell
npm run dev --workspace=@miubot/server
```

默认监听 `http://127.0.0.1:8787`。QQ 凭据与提供商 API Key 只保存在本机配置中，配置读取接口只返回凭据是否已配置，不回传密钥。
