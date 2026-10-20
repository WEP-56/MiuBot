# 技术架构 · Fork Pi 与模块边界

## 核心决定

Miubot **优先 Fork Pi**，而非仅把 Pi 作为黑盒 SDK 接入。明确希望继承其 Agent Core、Provider Core 和可复用 Extension/Plugin 基础，并围绕 QQ 社交聊天改造 Tools、Context Core 和 Plugin Core 的能力增量。

> 下面列的是**目标模块划分**，并非对某个具体 Pi 版本的源码结构及兼容性作承诺。启动实施前须记录上游仓库、commit、许可条款、依赖版本以及可复用接口清单。

## 模块结构

```text
miubot/
├── apps/
│   ├── server/             # 单机服务与 HTTP / WS API
│   └── web/                # Web 工作台
├── packages/
│   ├── agent/              # Pi Agent Core 派生：loop、工具执行、流式状态
│   ├── provider/           # Pi Provider Core 派生：协议和模型调用
│   ├── plugin/             # Pi 扩展设施 + Miubot 插件宿主
│   ├── context/            # 聊天上下文构建、压缩、检索、隔离
│   ├── platform/           # QQ 官方、OneBot 等标准化适配器
│   ├── session/            # 会话映射、并发、队列、配置继承
│   ├── routing/            # 任务到模型路由、回退、预算
│   ├── storage/            # 数据实体与持久化接口
│   └── shared/             # 通用契约、错误类型、事件类型
└── plugins/                # 内置官方插件
```

建议的主栈：**TypeScript + Node.js + React/Vite + 单机 SQLite（初期）**。HTTP 框架（Fastify/Hono 等）、持久化 ORM、后台任务调度工具暂作为待选实现细节。

## 四个核心

| 核心 | 保留什么 | 需要改变什么 |
|---|---|---|
| Agent Core | Agent Loop、模型与工具交互、流式事件 | 多会话运行上下文、取消/中断、工具执行元信息 |
| Provider Core | 多协议适配、模型调用、流式与 usage | 新任务类型适配、模型能力注册；路由建议在外部模块实现 |
| Plugin Core | 扩展注册与 Agent 相关 Hook | 平台事件、后台任务、UI 扩展、权限、生命周期与隔离 |
| Context Core | 尽可能复用上游上下文转换/压缩接口 | 群聊多人消息组织、引用链、长期记忆、独立历史与可见范围 |

## 运行职责

- **Platform** 接收、标准化、发送消息，不负责 Agent 推理。
- **Session** 决定消息属于哪段会话、如何排队/中断和选择生效配置。
- **Context** 为当前任务准备模型实际看到的信息，不承担永久历史唯一存储。
- **Routing** 选择模型和回退链，不把群信息硬编码进具体 Provider。
- **Agent** 在被授权的工具集合中决定如何完成任务。
- **Plugin** 提供扩展能力，但宿主掌握最终权限与执行审计。

## Fork 维护策略

1. 初始保留上游完整提交历史与明确的 `upstream` 远端；记录 Pi 来源/许可证。
2. 先建立行为测试（Agent Loop、三类协议、工具调用、流式处理、Session/Extension），再进行移动目录/重命名。
3. 核心改动尽可能以局部 Patch 与新增模块实现；尤其 `provider` 保持较小差异。
4. 对上游安全修复、协议适配更新建立定期同步检查，并记录 merge 冲突风险。
5. 维护自己的扩展 API 版本；兼容 Pi 扩展的范围需以测试矩阵公开声明。

## 默认工具与安全边界

Pi 面向编程的 Shell/文件写入工具**不作为 QQ 群聊默认 Tool**。Tool 对用户/会话的授权由 Miubot 执行层决定，不能由人格 Prompt 或插件配置文本绕过。若让外部插件执行宿主代码，必须认识到同进程扩展并不等于安全沙箱。

## 建议首先做的技术 Spike

- 运行一个最小 Agent Loop，仅使用测试 Tool，记录完整 Trace。
- 接入一个虚拟聊天平台适配器，验证多会话不串历史。
- 接入一个真实 QQ 适配器，测试接收→生成→发送和断线重连。
- 同时注册一个插件 Tool 与平台事件处理器，验证启停与授权。
- 验证 Pi Fork 的上游同步可行性、许可证与插件兼容边界。
