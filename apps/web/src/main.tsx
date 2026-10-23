import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AuthGate } from "./AuthGate";

// 先过登录闸门再挂载工作台：各页面一挂载就发请求，未登录时会拿一串 401。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>
);
