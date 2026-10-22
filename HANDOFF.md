# 交接文档：Plugin 模块（阶段 A / B / C 均已完成）

> 用途：因会话上下文过长，在新会话继续开发时先读这份。
> 最后更新：2026-10-22 22:20

---

## 一、当前状态

**阶段 A（事件型插件）、阶段 B（插件注册 Agent Tool）、阶段 C（管理 API + 工作台插件页）均已完成并推送。** 管理面安全与 `index.ts` 职责拆分也已就绪（2160 → 约 215 行）。

验证门禁全绿：`npm run check` / `npm run lint` / `npm test`（**187 files / 1763 tests**）。

最近七次提交：

| commit | 内容 |
|---|---|
| 本次 | feat: 插件注册 Agent Tool 与会话注入（阶段 B） |
| `d41ce5d` | feat: 插件管理 API 与工作台插件页（阶段 C） |
| `86dc6af` | refactor(server): 拆分运行时状态、QQ 流水线与前置逻辑 |
| `705c9d8` | refactor(server): 管理 API 路由从 index.ts 拆出 |
| `8ae1731` | feat(server): 管理 API 本机认证与 Origin 收敛 |
| `d08d0f7` | fix(plugin): 收紧生命周期与能力撤销 |
| `c7c956d` | feat(plugin): 服务级 Plugin Host 与受控平台能力 |

### index.ts 拆分（本次完成）

`index.ts` 现在只剩路径常量、子系统装配、启动流程，约 220 行。其余按职责落到：

| 文件 | 职责 |
|---|---|
| `src/http/server.ts` | CORS 回写 + `api-security` 三层校验 + OPTIONS + 会话下发 + 404/500 边界 |
| `src/http/router.ts` | 路由表（顺序即匹配优先级） |
| `src/http/routes/*.ts` | 12 个按域拆分的路由模块（config/tools/proactive/stickers/skills/personas/sessions/providers/qqbot/plugins/chat/system） |
| `src/http/context.ts` | 路由依赖的运行时状态访问器（`config`/`sessions` 需整体替换，统一 get/replace） |
| `src/app-state.ts` | 配置/会话/对象配置/主动发言额度：内存状态 + 持久化 + 会话与对象工厂 |
| `src/qq/connection.ts` | Gateway 连接、扫码、连接状态、凭据校验 |
| `src/qq/inbound.ts` | 入站消息主流程（去重 → 事件 → 采集 → 插话/回复） |
| `src/proactive.ts` | 群聊插话：聚合窗口、全局闸门、冷却、判断模型、发送前复核 |
| `src/sticker-tagging.ts` | 表情包自动打标（单飞、对话优先、最多重试 3 次） |
| `src/logging.ts` / `src/util/time.ts` | 运行日志；日期键 |
| `src/session-context.ts` / `src/target-queue.ts` | 会话提示/发图上下文；按目标串行队列 |

顺带修掉一个缺陷：`PUT /api/personas/active` 原先排在 `/api/personas/:id` 之后，`active` 被当成人格 id 匹配，工作台切换人格一直 404。

验证方式：用 28 个请求的 curl 矩阵对重构前后逐条比对（状态码 + 响应体；日志/决策/健康这类随时间变化的只比结构），除 QQ 头像 CDN 参数由平台轮换外完全一致；新增 `apps/server/test/qq-inbound.test.ts`（4 项，覆盖 @ 回复、重复投递、非 @ 走插话、`/new`），并做过「断掉 prompt 让测试失败」的反向验证。

### 管理面安全（前一轮完成）

`apps/server/src/api-security.ts`，三层校验：`Host` 回环 + 端口匹配（挡 DNS rebinding）、`Origin` 白名单（挡跨域读取，`ACAO: *` 已删除）、令牌（`Authorization` / `X-Miubot-Token` / `miubot_token` HttpOnly Cookie）。

- 令牌文件 `apps/server/.miubot/api-token`（首次启动生成）；`MIUBOT_AUTH_TOKEN` 可覆盖。
- 工作台在 `main.tsx` 挂载前调 `POST /api/auth/session` 换 Cookie，**60 余处 `fetch` 无需改动**。
- `apps/web/vite.config.ts` 代理改为 `changeOrigin: true`（不改写 Host 会全部 403）。
- 免认证端点：`GET /api/health`、`POST /api/auth/session`；`OPTIONS` 预检放行但同样过 Host / Origin。
- 威胁模型与验收情景：`docs/10-技术架构/02-消息处理与安全.md`。
- 单测：`apps/server/test/api-security.test.ts`（17 项）。已按 §九 习惯做过「移除修复确认测试失败」验证。

---

## 二、代码位置

### 平台契约（SDK 无关，`packages/shared/src/platform/`）

| 文件 | 内容 |
|---|---|
| `events.ts` | `PlatformEventType`（19 种）、`NormalizedPlatformEvent`、`PlatformEventBus`、`createPlatformEventBus` |
| `messages.ts` | `MessageSegment`、`QuotedMessage`、`NormalizedInboundMessage` |
| `outbound.ts` | `MessageTarget`、`PluginTextOptions`、`PluginMessageSender` |
| `dedup.ts` | `createDeduplicator`（TTL + 容量上限） |

### QQ 实现（`apps/server/src/platform/`）

- `events.ts` — QQ 原始事件 → 统一事件（`RAW_EVENT_MAP`、`normalizeRawEvent` 等）
- `inbound.ts` — 入站消息归一化、@ 剥离、引用上下文
- `outbound.ts` — `createOutboundChannel`，统一出站（分片、被动配额、降级主动推送）
- `qq-adapter.ts` — QQ SDK 事件绑定、`InteractionAckDecision`
- `runtime.ts` — `createQqPlatform()`，装配总线 + 去重 + 出站通道
- `plugin-bridge.ts` — `botId → OutboundChannel` 桥接、入站 `msgId` 有界反查

### Plugin Host（`packages/plugin/src/host/`）

| 文件 | 职责 |
|---|---|
| `manifest.ts` | `miubot.plugin.json` 校验（`schemaVersion`、id、版本、entry 逃逸、权限、bots） |
| `lifecycle.ts` | `AbortController` + disposers 栈（LIFO）+ 运行代次 |
| `context.ts` | 插件能力包装：代次 / 权限 / Bot 范围三重校验 |
| `loader.ts` | `.ts` 走 jiti；`.js`/`.mjs`/`.cjs` 走原生 `import()` |
| `storage.ts` | 每插件一个 JSON 文件，串行化写入 |
| `rate-limit.ts` | 出站滑动窗口限流 |
| `host.ts` | 发现 / 启停 / 重启 / 状态 / 去重 / 事件扇出 |
| `index.ts` | barrel |

### 示例插件

`plugins/miubot.welcome/` — 监听 `platform.group.bot_added` 发欢迎语。

---

## 三、关键设计决策（不要推翻）

1. **`eventId` ≠ 幂等键。** `eventId` 只是事件标识；`dedupKey` 仅在平台提供稳定 id 时设置（`GROUP_ADD_ROBOT` 有 `id`，`message.received` 有 `messageId`，连接类事件从不设）。`fingerprint` 仅供诊断。
2. **Context 在构造时捕获代次与信号。** 若改为读 `lifecycle` 当前值，旧实例跨越「停用 → 重新启用」后会复活。
3. **停用顺序：先撤销能力，再执行清理。** 插件 `dispose` 通过 `ctx.onDispose` 登记，LIFO 时最后跑，此时已无发送权限。
4. **限流在出站能力层，不在事件分发层。** 分发层丢 `message.sent` 只是中断循环，消息已经发出去了；出站层拒绝则连 `OutboundChannel` 都不调用。默认每会话 10s / 5 次。
5. **来源标注逐次传入，不用全局状态。** 多插件并发时全局状态会互相覆盖。`OutboundChannel.sendText/sendMarkdown/sendMedia` 的第 4/3 个参数是 `OutboundOriginMeta`。
6. **宿主默认不回送插件自身引发的事件。** 需要时用 `ctx.events.subscribeIncludingSelfOrigin()`。
7. **`causationId` 保留字段但不写入。** 出站限流已能挡住自激，不需要严格因果链追踪。
8. **启停按插件 id 串行化**（`serialize()`），不加全局锁，不同插件互不阻塞。
9. **插件入口不需要 `language` 字段**，`entry` 后缀已表达。
10. **`enabled: []` 表示全部启用**，`disabled` 优先。装好插件却毫无反应比误启用更难排查。

---

## 四、插件目录与配置

- 内置插件：`<repo>/plugins/`（仓库内，随代码分发）
- 用户插件：`apps/server/.miubot/plugins/`
- **内置优先**：`pluginsDir: [builtinPluginsDir, pluginsDir]`，同名 id 只认第一个，冲突登记为 `duplicate:*` 诊断条目
- 插件数据：`apps/server/.miubot/plugin-data/<id>.json`

配置（`apps/server/.miubot/config.json`）：

```json
"plugins": { "enabled": [], "disabled": [] }
```

当前实际值就是上面这个（全空 = 全部启用）。

---

## 五、下一步：阶段 C

### 1. 管理面安全（✅ 已完成，阻塞项已解除）

原先的四个问题都已修掉：`/api/*` 有令牌认证、`Access-Control-Allow-Origin: *` 已删除、`Host` 头校验挡住 DNS rebinding、`/api/sessions/:id` 与 `/api/logs`、`/api/peers` 不再能被任意网页读取。详见 §一「管理面安全」。

新增插件管理端点时**不需要再考虑认证**：`handler` 入口已经统一校验，新路由自动受保护。唯一注意点是 `json()` 不再写 CORS 头，CORS 由 `handler` 按请求 Origin 回写。

### 2. 插件管理 API（✅ 已完成）

`apps/server/src/http/routes/plugins.ts`，已在 `router.ts` 注册，`HttpContext` 增加 `plugins`（宿主 + 插件目录）。

| 端点 | 行为 |
|---|---|
| `GET /api/plugins` | 插件清单 + 配置放行状态（`enabled`）+ `settings` + 插件目录 |
| `POST /api/plugins/discover` | 重新扫描插件目录（幂等，`discover()` 可重复调用） |
| `POST /api/plugins/:id/enable` | 从 `disabled` 摘除、必要时补进白名单、启动；失败时自动重试一次干净加载 |
| `POST /api/plugins/:id/disable` | 写 `disabled`、从白名单摘除、停止 |
| `POST /api/plugins/:id/reload` | 停 → 重读 manifest → 启；配置里禁用的插件返回 409 |

要点：

- **配置与宿主必须一起改**。只调宿主不改 `config.plugins`，重启后插件会按旧配置复活或再次被压制。
- `PluginStatus` 新增 `source: "plugin" | "invalid" | "duplicate"`：后两者是诊断占位（坏目录 / 同 id 冲突），启停被拒并回 400。
- `PluginHost` 新增 `reload()`：改名/改版本/改权限/改入口不必重启进程。`id` 变了只报错要求重启，不悄悄搬迁条目。
- 修掉一个潜在缺陷：`discover()` 原先不幂等，第二次扫描会把每个已登记插件判成「重复」。现在同目录重扫直接跳过。
- 单测 `apps/server/test/plugins-route.test.ts`（13 项），已按 §九 做过反向验证（去掉幂等跳过、去掉 manifest 重读后测试转红）。

### 3. Web 工作台插件页（✅ 已完成）

`apps/web/src/pages/Plugins.tsx`，入口在侧边栏「高级配置 → 插件」（`extensions` 页签，原占位内容已删除）。

列表展示名称/版本/状态/权限/清理函数数/错误；按钮为启用 / 停用 / 重载（禁用条目上重载置灰），顶部「重新扫描」，底部显示插件目录与配置中的禁用清单。

### 4. 阶段 B：插件注册 Agent Tool（✅ 已完成）

| 文件 | 职责 |
|---|---|
| `packages/plugin/src/host/tools.ts` | 工具注册表：校验、查重、存活判定、`ToolDefinition` 生成（含超时与取消） |
| `packages/plugin/src/host/context.ts` | `ctx.tools.register()`（权限 `tool:register` + 代次校验 + 自动撤销） |
| `apps/server/src/agent-host.ts` | 合并进 `customTools`，并把工具名加进 `setActiveToolsByName` 的集合 |
| `apps/server/src/http/routes/plugins.ts` | 启停后 `rebuildAgentSessions()`，让已有会话同步工具集 |

要点：

- **不覆盖内置工具**：`reservedToolNames` 由组合根传入（内置 + 已启用的 MCP 工具），同名注册直接失败，错误写进插件状态并在工作台可见。
- **两个插件不能同名**：后来者失败并指出占用者，不静默覆盖。
- **执行前复核**：`execute` 里每次都查插件是否仍 active、代次是否一致；停用后旧会话即使拿着定义也会被拒（有测试锁住）。
- **作用域**：manifest `bots` 决定工具在哪些 Bot 的会话可见；对象 `useTools: false` 时整套工具都不激活。
- **超时**：默认 30s（可声明 1s–120s），超时与外部取消都会中断执行，不挂住整轮对话。
- **在途调用**：策略是「执行入口复核」而非等待/强杀——停用后新调用立即失败，旧调用靠 `signal` + 超时收敛。
- 端到端测试 `apps/server/test/plugin-tool-session.test.ts` 用**真实** `createAgentSession`（只构造不发请求）验证工具确实进了激活集、停用后消失、`useTools: false` 时为空。

**注意（原方案里的坑）**：如果改用扩展 `tool_call` handler 做授权，必须给每个 Session 无条件注册，否则「没有 handler = 默认放行」。本次没有走那条路——权限校验放在工具 `execute` 的统一入口，不依赖扩展是否存在。

---

## 六、已知遗留问题

| 优先级 | 位置 | 问题 |
|---|---|---|
| P1 | `host.ts` | `hasActiveHandler()` 只判断有无订阅者，不能判断具体按钮是否被某插件认领（`cultivation:*` 这类） |
| P2 | `plugin-bridge.ts` | `inboundReferences.take()` 只能消费一次；同一入站消息触发多个插件回复时，只有第一个拿到被动回复锚点 |
| P2 | `storage.ts` | `readAll()` 吞掉解析异常返回 `{}`，损坏文件下次写入会被覆盖（数据丢失） |
| ✅ | `src/tool-names.ts` | 阶段 B 已收敛：`nativeToolNames` / `toolNames` / `auxiliaryToolNames` 单一来源，`present.ts`、`agent-host.ts`、`routes/tools.ts`、组合根的保留集都从这里取 |
| P2 | `routes/plugins.ts` | 启停插件后无条件 `rebuildAgentSessions()`：若有会话正在流式回复会被中断。可改成 `anyAgentLoopRunning()` 为真时延后到空闲再重建 |

P2 里两项需要先确认语义再动：`take()` 改为引用计数会改变被动回复配额语义；`readAll()` 改为抛错会影响容错策略。会话重建那条属已知取舍——插件启停是低频管理动作，先保证工具集正确。

---

## 七、实测记录（2026-10-22）

真实 QQ 环境验证 `miubot.welcome`：

- 插件**正确加载**，`GROUP_ADD_ROBOT` 事件正常派发到插件
- 欢迎语**发送失败**，原因是官方机器人入群后需要先配置发言权限
- 这是平台时序限制，不是代码缺陷；插件链路本身是通的

若要支持「权限就绪后补发」，需要引入延迟重试策略——属于新行为，需先讨论。

### 管理面安全实测（2026-10-22，`MIUBOT_PORT=8899`）

| 场景 | 结果 |
|---|---|
| `curl /api/config` 无令牌 | 401 |
| `curl /api/health` 无令牌 | 200（免认证） |
| `POST /api/auth/session` → 带 Cookie 读 `/api/config`、`/api/sessions`、`/api/logs`、`/api/peers` | 200 |
| `Origin: https://evil.example` | 403 `Origin 不被允许` |
| `Origin: null`（本地 `file://`） | 403 |
| `Host: evil.example:8899` | 403 `Host 不被允许` |
| `Sec-Fetch-Site: cross-site` | 403 `跨站请求被拒绝` |
| `OPTIONS` 预检（合法 Origin） | 204 + `Access-Control-Allow-Origin` 回显 |
| 令牌是否出现在 `/api/logs` 响应中 | 否（0 处匹配） |

---

## 八、开发约定（务必遵守）

- 验证：`npm run check` + `npm run lint` + `npm test` 三者全绿才算完成
- **不要跑 `npm run build`**
- 只用可擦除 TS 语法（Node strip-only）：不用 `enum` / `namespace` / 参数属性
- 禁用 `any`；不写内联 import（除加载器等确有动态加载需求处）
- 只 stage 自己改过的文件，**禁止 `git add -A`**
- 禁用 `git reset --hard` / `git checkout .` / `git clean -fd` / `git stash`
- 提交信息：`{feat,fix,docs,chore}(<scope>): <简述>`
- 未经要求不提交
- 新增 `/api/*` 路由：在 `src/http/routes/` 建模块并注册到 `router.ts`，依赖从 `HttpContext` 取；**不要在 `json()` 里写 CORS 头**，`Access-Control-Allow-Origin` 由 `http/server.ts` 按 Origin 白名单回写。
- `index.ts` 只做装配与启动；新增业务逻辑落到对应模块（状态 → `app-state.ts`，QQ → `qq/`，插话 → `proactive.ts`）。

---

## 九、修复验证习惯（本项目已形成）

修 bug 时不要只写测试就完事，**临时移除修复确认测试真的会失败**，再恢复。本次会话中两次这样做：

- 把 `lifecycle.stop` 改回「先清理后撤销」→ 确认 `dispose` 期间真能发消息
- 把 `serialize()` 改成直接执行 → 确认并发 `setup` 真会重复

这样能避免写出「永远通过」的假测试。
