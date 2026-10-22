# apps/web

React + Vite 管理工作台。平台、提供商和调试台页面连接 `apps/server` 的本机 API。

```powershell
npm run dev --workspace=@miubot/web
```

默认地址为 `http://127.0.0.1:5173`，开发代理将 `/api` 请求转发到 `http://127.0.0.1:8787`。

代理开启了 `changeOrigin`：服务端按 `Host` 判定「只接受本机回环地址」，不改写会全部 403。页面挂载前由 `src/utils/api.ts` 向 `/api/auth/session` 换取管理会话 Cookie，各页面的 `fetch` 无需改动。
