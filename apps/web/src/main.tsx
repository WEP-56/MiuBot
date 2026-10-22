import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ensureApiSession } from "./utils/api";

// 先换取管理 API 会话 Cookie 再挂载页面：各页面一挂载就发请求，不能抢在前面。
void ensureApiSession().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});
