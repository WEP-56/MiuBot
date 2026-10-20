# apps/server

Miubot 的运行时进程。当前为空骨架：只确定职责边界，还没有实现。

## 职责

- 进程入口：加载配置、初始化存储、装配 `@miubot/session` 运行时。
- 对外提供 HTTP/WS API 给 `apps/web` 使用。
- 装配平台适配器（未来放在 `packages/platform`），把 QQ 消息标准化后交给会话层。
- 不承担 Agent 推理：那是 `@miubot/agent` 的职责。

## 待定

- HTTP 框架（Fastify / Hono）尚未选择，见 `docs/10-技术架构/03-待决策问题.md`。
- 存储层（SQLite + ORM）尚未选择。
