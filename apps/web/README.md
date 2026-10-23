# apps/web

React + Vite 管理工作台。平台、提供商和调试台页面连接 `apps/server` 的本机 API。

```powershell
npm run dev --workspace=@miubot/web
```

默认地址为 `http://127.0.0.1:5173`，开发代理将 `/api` 请求转发到 `http://127.0.0.1:8787`。

代理开启了 `changeOrigin`：服务端按 `Host` 判定「只接受回环或 `MIUBOT_ALLOWED_HOSTS`」，不改写会全部 403。**这一行只服务本地开发**，生产反代必须传真实域名（见 `deploy/nginx.conf`）。

登录由 `src/AuthGate.tsx` 统一处理：挂载前先问 `GET /api/auth/me`，未登录时显示口令页（`POST /api/auth/login` 换 `HttpOnly` 会话 Cookie），登录后才渲染 `App`；每 60 秒复查一次，会话失效就退回登录页。各页面的 `fetch` 无需改动，同源自动携带 Cookie。

生产形态下工作台由服务端托管（`apps/web/dist/index.html` + SPA 回退），不需要单独跑 vite：

```powershell
npm run build --workspace=@miubot/web
```
