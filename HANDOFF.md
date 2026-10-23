# 交接文档：Plugin 模块（阶段 A / B / C 主体已完成）

> 用途：因会话上下文过长，在新会话继续开发时先读这份。
> 最后更新：2026-10-23 18:00

**第一次读这份时按这个顺序：**

1. **§零 下一轮计划** —— 2026-10-23 提出的五条线，都还没开工；从这里挑一件
2. §一 当前状态 —— 已推到哪、门禁是否绿
3. §三 关键设计决策 —— 动手前必须知道哪些是刻意如此的
4. 相关工作区 §二 代码位置 + §六 已知遗留

---

## 零、下一轮计划（2026-10-23 提出，全部未开工）

五条线互不依赖。建议顺序 **4 → 2 → 5 → 1 → 3**：4 和 2 改的是服务端数据模型与入站流程，
5 与 2 同属"工具级配置"、可以顺手一起做，1 是纯前端收口，3 依赖 2 落地后才有"每会话"的统计口径。

### 1. 前端布局与控件一致性

**1a 主内容区水平居中（只有表情包页是对的）**

| 页面 | 容器 | 现状 |
|---|---|---|
| `Stickers.tsx:96` | `mx-auto max-w-[1100px]` | ✅ 参考实现：居中 + 有上限 |
| `Dashboard.tsx:13` | `max-w-[760px]` | ❌ 偏左 |
| `Plugins.tsx:492` | `max-w-[760px]` | ❌ 偏左 |
| `Advanced.tsx`（8 处 section） | `max-w-[760px]` | ❌ 偏左 |
| `Personas.tsx:20` | `max-w-[900px]` | ❌ 偏左 |
| `Platforms.tsx:23` | `max-w-[900px]` | ❌ 偏左 |
| `Providers.tsx:69` | `max-w-[980px]` | ❌ 偏左 |
| `Debug.tsx` / `Sessions.tsx` | 全宽 flex / 双栏 | 保持原样（用户明确排除） |

缺的就是一个 `mx-auto`。但别只补 8 个 `mx-auto` 了事——各页的宽度（760/900/980/1100）和
外层样式（有的 `bg-black text-white`，有的 `var(--bg-app)` + `var(--text-main)`）本来就
不一致，这正是"整体偏左 + 视觉不齐"的根因。

落点：`apps/web/src/components/PageShell.tsx`，props `{ width?: 760|900|980|1100, children }`，
内部 `mx-auto max-w-[…]`；逐页替换手写容器，顺手统一外层背景/文字色变量。
验收：1280 宽窗口下各页左右留白相等；缩到 900 宽内容跟着缩且仍居中；表情包页视觉不变。

**1b 控件风格：原生 → 微拟物**

现状盘点（都是浏览器原生外观）：

- `<input type="checkbox">`：`Platforms.tsx`、`Plugins.tsx`、`Advanced.tsx`（Tools 页每个开关）、`Personas.tsx` 等
- `<select className="sketch-input">`：Stickers 打标模型、Tools 搜索提供商、Providers 类型选择
- `Providers.tsx:70` 还有个 hack：把原生 `<select>` 设成 `opacity-0` 盖在按钮上做下拉
- `type="range"`：`Stickers.tsx` 自动采集概率（只有 `accent-color`）

落点：`components/Toggle.tsx`（`role="switch"` + 凹槽 + 圆形滑块，开=绿）、`components/Select.tsx`
（自绘下拉，键盘 ↑↓/Enter/Esc 可用，`aria-expanded`）、`components/Slider.tsx`；样式变量放 `index.css`。

坑：
- 别为了好看把 `<select>` 换成 `div` 却丢掉键盘操作与 `label` 关联——自绘组件必须自己补齐
  `role`/`aria-*`/焦点环/Tab 顺序，否则是可用性倒退。
- `opacity-0` 覆盖式下拉统一后应删除（它是为了"看起来像按钮、实际是 select"）。
- 一次性换完再截图对比，别一半原生一半自绘。

### 2. 群 / 私聊细粒度配置

现状：`PeerConfig`（`agent-host.ts:37-47`）只有 `personaId` / `providerId` / `modelId` /
`useTools`（布尔）/ `features.activeReply`。工具是全局 `config.tools.enabled`，对象级只有
"全开或全关"。

**2a 备用模型**

- `PeerConfig` 增 `fallbackProviderId` / `fallbackModelId`（空 = 不启用）。
- 回退点选在**请求级**（`agent-host.getAgentSession()` 里取模型处）：主模型缺 key、模型被删、
  或 provider 报错时用备用模型重试一次。
- **不要静默切换**：回退要在运行日志里记 `WARN`，并在回复里留痕（至少 `session.lastModelUsed`），
  否则用户会以为主模型坏了却查不到原因。
- 待定：回退是否也覆盖"主模型可用但 429/超时"。建议第一版只覆盖"不可用"，限流重试另算。

**2b 分作用域工具**

- `PeerConfig` 增 `toolsOverride?: string[] | null`（`null` = 继承全局）。
- 唯一的执行点已经存在：`agent-host.enabledToolNames()` 里已经读了 `peer.useTools`，
  在那里做 `toolsOverride ?? config.tools.enabled` 即可，**不要**在入站流程里另写一套过滤。
- 注意这条链上不止内置工具名：`enabledToolNames()` 还拼了 `load_skill` / `search_stickers` /
  `send_sticker` / MCP 工具 / 插件工具。过滤只应作用于"内置 + 可配置"那一段，别把插件工具一起过滤掉。
- UI：会话/对象配置弹窗加"工具"多选（继承 / 自定义），跟现有"聊天模型、人格、主动行为"并列。

验收：给某个群设自定义只留 `web_search` → 该群 `bash` 不可用、其它群不受影响；把该群主模型
指向一个已删除的模型 → 回退到备用并在日志里看到 `WARN`。

### 3. 首页概览接真实数据

现状：`Dashboard.tsx` 全是硬编码（`1,284` / `2.6M` / `2 / 2` / `99.2%`），页脚自己写着
"布局概念示意 · 数据为虚构样例"。

| 卡片 | 能不能算 | 数据源 |
|---|---|---|
| 今日消息 | ✅ | 会话 `messages[].timestamp` 按当天过滤（`state.getSessions()`） |
| 在线 Bot | ✅ | `ctx.qq.states`（`phase === "connected"`） |
| 平台连接列表 | ✅ | 同上 + `qqBots` 昵称 |
| Token 消耗 / 费用 | ⚠️ 需补采集 | `AgentSession.getSessionStats()` 有 `usage` 合计（含 cost），但只在内存里、且会话不常驻 |
| API 成功率 | ❌ 无数据源 | 现在只有运行日志里的 ERROR 行，不是成功率 |
| 平均耗时 / Agent 触发 | ❌ 无数据源 | 未埋点 |

建议：
- 新增 `GET /api/overview` 在服务端聚合，别让前端拉五个接口自己算。
- token 采集：`inbound.ts` 每轮 `prompt()` 结束后读一次 `agentSession.getSessionStats()`，
  把**增量**写进 `usage.json`（结构可参考现有的 `proactive-usage`），按天分桶。
- "成功率"和"平均耗时"这两张卡**要么删、要么换成真有数据的指标**（如"今日主动消息 / 被拦截"，
  `proactive.metrics` 里有）。不要为了凑满 2×2 去造数据——这一页现在的问题就是造数据。

### 4. 斜杠命令 + 管理员

**现状 bug**：`inbound.ts:118` 的 `if (isGroup && !mentioned) { proactive.queueGroupMessage(...); return; }`
排在命令判定（`:142` `/new`、`:155` `/compact`）之前——群里不 @ 的 `/new` 根本到不了命令分支，
私聊能用、@ 了也能用。这就是"群聊下无法使用 /new"的原因。

**现状**：命令是两条 `if (text === "/new")` 硬编码，没有注册表、没有权限、没有帮助。

目标：

- `apps/server/src/commands/`：注册表 `{ name, description, permission: "admin" | "all", run(ctx) }`，
  内置 `new` / `compact` / `help`；解析放在**去重与白名单之后、群聊闸门之前**，命中即接管
  （不走插话、不进 Agent）。
- 管理员：`config.admins: string[]`（QQ 用户 openid）。**默认空 = 没有人能执行管理员命令**
  （安全默认），启动日志与 UI 都要提示"尚未配置管理员"。
- 新增「高级配置 → 斜杠命令」页：命令总览（名称/说明/权限/开关）+ 管理员名单 + 每个命令的启停。
- 为插件留口：插件经 `ctx.commands.register()` 注册命令，与 `ctx.tools` / `ctx.extensions` 同一套
  代次 + 权限守卫（`plugin:command:register`），命名冲突规则照抄工具注册表。

坑：
- 命令解析必须在 `normalizeMessageEvent` 剥离 @ 之后（现状已满足），否则群里 `@bot /new` 匹配不上。
- 群聊里非 @ 的命令**只接管已注册的命令**；其余以 `/` 开头的普通聊天仍走插话，否则会误吞群友的消息。
- 命令回复走被动回复锚点（`inboundReferences`），不要新开一条主动推送。

验收：群里不 @ 发 `/new` → 新建会话；`/help` 列出可用命令；非管理员发 `/admin` 被拒且记审计；
关掉某命令后它不再响应；插件注册的命令出现在同一张表里。

### 5. 图像生成提供商配置下移到 高级配置 → Tools → image_gen

**现状**：`image_gen` 的提供商配置挂在 `Providers.tsx` 里，和 LLM 提供商并列（同一页两个区块 +
"添加提供商 → 图像生成"的分支），数据存在 `config.imageProviders[]`（`runtime.ts:98`），
经 `PUT /api/config` 保存。而 `web_search` 的提供商配置在 Tools 页，数据是
`config.tools.webSearch = { provider, apiKeys }`（`runtime.ts:54`）。

同一个层级上放着两种语义：**LLM 提供商**是 Agent 的推理后端，**图像提供商**是
`image_gen` 这个工具的依赖。放在一起会让人以为"换个提供商就能换掉模型的图像能力"。

**还有一处语义缺口**（不只是 UI 位置）：`agent-host.ts:215` 选图像提供商的方式是
`config().imageProviders.find((item) => item.enabled && item.apiKey)`——**第一个启用且有 key 的**，
没有显式选择；`web_search` 则有 `tools.webSearch.provider` 明确指向。所以"下移"必须连同
"显式选择"一起做，否则只是换了个页面摆。

**方案（推荐）**：

- 数据：`config.imageProviders[]` **保留**（用户可自定义 baseUrl/model，不像 web_search 是固定枚举），
  新增 `config.tools.imageGen = { providerId: string }`（空 = 未选择，`image_gen` 直接不可用）。
- 读取：`agent-host.ts:215` 改成按 `providerId` 找，找不到就报"图像提供商未配置"，
  不再"随便挑第一个"。
- 写入：`PUT /api/tools` 增加 `imageGen.providerId`（与 `webSearch` 同一处，别再开第二个写入口）；
  `PUT /api/config` 继续负责 `imageProviders[]` 的增删改。
- UI：`Tools.tsx` 的 `image_gen` 卡片里放提供商下拉 + key 输入 + "新建图像提供商"，
  与 `web_search` 卡片同构；`Providers.tsx` 只留 LLM 提供商，删掉图像分支。

**另一种更彻底的做法**：完全对齐 web_search，把 key 也挪进 `tools.imageGen.apiKeys`、删掉
`config.imageProviders[]`。**不建议**——web_search 的四个提供商是代码里写死的，而图像提供商
要允许自定义 baseUrl / model / 多个并存，硬套同一个结构会丢掉这些能力，还要写配置迁移。

坑：
- 现有用户配置里 `imageProviders[0].enabled && apiKey` 就是当前生效的那个；迁移时把它填进
  `tools.imageGen.providerId`，否则升级后 `image_gen` 会突然"未配置"。
- `publicConfig()`（`present.ts:8`）同时返回 providers 与 imageProviders，前端两个页面都读它；
  拆页面不拆接口，避免多一次请求与两个真相。

验收：Tools 页能选图像提供商并保存；选中的那个才被 `image_gen` 使用（把另一个也启用、且排在前面，
验证不再"挑第一个"）；未选择时 `image_gen` 报"未配置"而不是静默用错提供商。

### 决策待定（开工前先定）

1. 管理员名单为空时是"没人能用"还是"所有人能用"——建议前者，但要在 UI 上说清楚。
2. 备用模型是否覆盖限流/超时，还是只覆盖"不可用"。
3. 首页"API 成功率""平均耗时"两张卡：删掉还是换指标。
4. 图像提供商：按推荐方案（保留 `imageProviders[]` + 新增 `tools.imageGen.providerId`），
   还是彻底对齐 web_search 结构（要写迁移，且丢掉自定义 baseUrl/model）。

---

## 一、当前状态

**阶段 A（事件型插件）、阶段 B（插件注册 Agent Tool + Pi Extension 钩子）、阶段 C（管理 API + 工作台插件页）均已完成并推送。** 管理面安全与 `index.ts` 职责拆分也已就绪（2160 → 约 215 行）。

**阶段 C 的 Schema Config 已完成（2026-10-23，`88fee6d`）**：manifest 声明 `config` → 宿主校验并合成默认值 → 工作台渲染表单 → 插件从 `ctx.config` 读。`miubot.welcome` 已从「把欢迎语存在插件存储里」迁到 manifest 配置。

**插件包的安装 / 上传 / 卸载已完成（2026-10-23，未提交）**：`POST /api/plugins/install` 从本地目录复制插件包，`POST /api/plugins/import` 接收 ZIP 上传（工作台拖拽或选文件），`POST /api/plugins/:id/uninstall` 删除插件目录并按勾选处理数据与配置。ZIP 解压与技能导入共用 `packages/plugin/src/archive.ts`。

**插件闭环现在是完整的**：事件订阅 / 发消息 / 存储 / Agent Tool / 对话钩子五条能力都有权限、代次、`bots` 作用域三道校验，启停即生效（重建会话），失败都写进插件状态或运行日志；配置面（Schema Config）与分发面（目录安装 / ZIP 上传 / 卸载）也已接通。剩下的活是独立 WebUI 入口、后台任务/调度与几只遗留 P2。

验证门禁全绿：`npm run check` / `npm run lint` / `npm test`（**192 files / 1869 tests**）；`apps/web` 的 `tsc --noEmit` 也已干净（顺手删掉 `Sessions.tsx` 里一个未使用的类型别名）。

**公网部署改造（2026-10-23，未提交）**：P0 四项 + 相关 P1 已落地，管理面可以暴露公网。要点：

| 改动 | 落点 |
|---|---|
| `MIUBOT_HOST` / `MIUBOT_ALLOWED_HOSTS`（无通配符） | `index.ts`、`api-security.ts` |
| 口令登录 + 服务端可撤销会话 + 失败锁定 + `Secure` Cookie；删除 `POST /api/auth/session` | `auth.ts`（新）、`http/routes/auth.ts`（新）、`http/server.ts` |
| 服务端托管 `apps/web/dist/index.html` + SPA 回退 | `http/static.ts`（新）、`http/server.ts` |
| `MIUBOT_DATA_DIR` / `MIUBOT_WEB_DIST` | `index.ts` |
| JSON body 1 MB → 413、坏 JSON → 400 | `http/response.ts`（`HttpError`） |
| 安全响应头（CSP/HSTS/nosniff/frame-ancestors）、按来源限速 | `http/server.ts`、`http/rate-limit.ts`（新） |
| 数据目录 0700 / 文件 0600 / 原子写 | `storage.ts`（新）、`app-state.ts`、`auth.ts` |
| 500 只回 traceId，详情进运行日志 | `http/server.ts` |
| SIGTERM 优雅退出（断 Gateway → 关端口 → 落盘） | `index.ts` |
| systemd / nginx / env / 备份脚本 / 手册 | `deploy/`（新） |
| 登录页、登出、会话过期回登录页、改口令 | `apps/web/src/AuthGate.tsx`（新）、`utils/api.ts`、`Sidebar.tsx`、`pages/Advanced.tsx` |
| Docker 一键部署：两段构建、非 root（uid 10001）、具名数据卷、健康检查、可选 Caddy 自动 HTTPS | `Dockerfile`、`compose.yaml`、`.env.example`、`.dockerignore`、`deploy/docker/`（新） |
| 运行日志：10 MB × 5 轮转 + 写入前脱敏（密钥/令牌/长 base64）+ 单条截断 2000 字符 + 跨文件恢复 | `logging.ts`、`index.ts`（生成口令改为只写进程输出） |
| 版本号：`MIUBOT_VERSION` → 根 `VERSION` 文件 → `package.json`，`0.0.0-dev` 兜底 | `version.ts`（新） |
| 内置更新检查：GitHub Releases，6h 缓存、5s 超时、并发合并、`MIUBOT_UPDATE_CHECK=0` 可关；只提示不自动升级 | `update-check.ts`（新）、`routes/system.ts`、设置页 |
| CI / Release：tag → 门禁 → GHCR 镜像（amd64 + arm64）+ 源码包（含预构建工作台）+ GitHub Release | `.github/workflows/ci.yml`、`release.yml`（新） |
| 入站白名单：`group:<ID>` / `c2c:<ID>`，未命中的消息在副作用之前丢弃；`MIUBOT_ALLOWED_PEERS` 覆盖，工作台设置页可编辑 | `runtime.ts`、`qq/inbound.ts`、`http/routes/access.ts`、`peer-key.ts`（新）、`Advanced.tsx` |
| 工具策略：文件与命令类工具启用时启动 WARN + Tools 页红字；`MIUBOT_DISABLE_NATIVE_TOOLS=1` 在会话层整体禁用 | `index.ts`、`agent-host.ts`、`tool-names.ts`、`present.ts`、`Advanced.tsx` |
| 审计日志：`audit.log`（JSON Lines，10 MB × 3），登录/登出/改密 + 所有变更类管理请求，`GET /api/audit`，工作台日志页分页签 | `audit.ts`（新）、`rotating-writer.ts`（新，从 `logging.ts` 抽出）、`auth.ts`、`http/server.ts`、`Advanced.tsx` |

单测新增 `apps/server/test/auth.test.ts`（18 项）、`response.test.ts`（9 项）、`storage.test.ts`（6 项）、`logging.test.ts`（11 项）、`audit.test.ts`（4 项）、`version.test.ts`（10 项）、`update-check.test.ts`（10 项）、`http-server.test.ts`（18 项，真实 HTTP server + 真实 auth），重写 `api-security.test.ts`；`qq-inbound.test.ts` 补了入站白名单两条用例。全量 200 files / 1962 tests 通过；验收矩阵见 `deploy.md §7`（真实起进程跑过：Host 伪造 403、无凭据 401、旧后门 401、登录/登出、413/400、锁定 429、首启动口令只打印一次、会话文件只存 SHA-256；`/api/health` 带 `version`、`/api/system/update` 在 GitHub 403 时返回结构化错误而不是抛错；`/api/access` 的增删改与 env 只读、`/api/audit` 的记录顺序）。已按 §九 做反向验证：去掉会话校验 → `api-security` + `http-server` 的伪造 Cookie 用例转红；去掉 body 流式上限 → `response` 两条用例转红；去掉白名单判定 → `qq-inbound` 的越权用例转红；去掉日志脱敏 → `logging` 两条用例转红。

**仍未做**：插件/技能导入在公网模式下默认关闭、审计记录字段级 diff、会话级限流、多用户。见 `deploy.md §10`。

**Docker 相关文件未在开发机验证**（本机没有 Docker）：`Dockerfile` / `compose.yaml` / `.dockerignore` 只做过 YAML 解析与逻辑审查。首次在真机 `docker compose build` 时要重点看三处——`npm ci` 是否只靠 package.json 完成、`npm prune --omit=dev` 是否把运行期依赖剪掉、容器内 `--conditions=source` 能否解析 workspace 源码（本地 Windows 上已验证同样的解析路径）。

最近八次提交：

| commit | 内容 |
|---|---|
| `788b25d` | feat: 插件 Pi Extension factories 桥接会话资源加载器（阶段 B 收尾） |
| `972f8e9` | feat: 插件注册 Agent Tool 与会话注入（阶段 B） |
| `d41ce5d` | feat: 插件管理 API 与工作台插件页（阶段 C） |
| `86dc6af` | refactor(server): 拆分运行时状态、QQ 流水线与前置逻辑 |
| `705c9d8` | refactor(server): 管理 API 路由从 index.ts 拆出 |
| `8ae1731` | feat(server): 管理 API 本机认证与 Origin 收敛 |
| `d08d0f7` | fix(plugin): 收紧生命周期与能力撤销 |
| `c7c956d` | feat(plugin): 服务级 Plugin Host 与受控平台能力 |

### index.ts 拆分（已完成）

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

> ⚠️ 本节记录的是 2026-10-22 的**共享令牌**方案，已被 2026-10-23 的公网部署改造取代：
> `POST /api/auth/session` 与 `miubot_token` Cookie 均已删除，改为口令登录 + 服务端可撤销会话
> （`src/auth.ts`、`src/http/routes/auth.ts`）。现状看 §一 顶部的「公网部署改造」。

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
| `config.ts` | Schema Config：声明校验、默认值合成、输入校验、文件读写、`ctx.config` 访问器 |
| `install.ts` | 本地插件包：目录包校验（manifest / 入口存在 / 拒绝符号链接 / 文件数与体积上限）、复制、删除 |
| `loader.ts` | `.ts` 走 jiti；`.js`/`.mjs`/`.cjs` 走原生 `import()` |
| `storage.ts` | 每插件一个 JSON 文件，串行化写入 |
| `rate-limit.ts` | 出站滑动窗口限流 |
| `tools.ts` | 插件工具注册表：校验、查重、存活判定、`ToolDefinition` 生成（含超时与取消） |
| `extensions.ts` | 插件 Pi Extension 工厂注册表：命名、存活判定、`bots` 过滤、`pi` 守卫 |
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
11. **配置只存与默认值不同的键**（`compactAgainstDefaults()`）。全量落盘会把旧默认值永久钉在用户身上，插件以后改默认值就只对新人生效。
12. **配置 schema 只支持扁平一层标量**（string / number / integer / boolean + enum）。嵌套 object / array 会让表单渲染、错误定位、secret 遮蔽同时变复杂，等真有插件需要再扩，不先支持一半。
13. **secret 是三态语义**：缺省/空串 = 保持原值，`null` = 清除，有值 = 覆盖。遮蔽在宿主 `inspectConfig()` 完成，不在路由——多一个入口（CLI、别的前端）时不该靠每个调用方各自记得处理。
14. **保存配置后重启插件**（不是重启服务）。配置在 `setup()` 里读，重启才能生效；已停用的插件不会被顺带拉起。重启会让工具以新代次注册，**必须跟着 `rebuildAgentSessions()`**，否则旧会话里的插件工具一调用就被判失效。
15. **schema 写错 = 插件加载失败**，用户填错 = 保存失败。两者分开：放行一个坏 schema 会让工作台渲染出半截表单，而报错落在「保存失败」上。
16. **安装目标只能是用户目录**（`installDir`，与内置目录分开声明）。内置目录在仓库里，装进去会被 git 看见、升级时被覆盖。
17. **安装不覆盖、不自动启动。** 覆盖会让一次手滑把在用的插件换成半成品，升级必须是显式动作；启动与否取决于配置白名单，宿主不读配置——装完由路由按 `isAllowedByConfig` 决定，否则会造出「配置里禁用却跑着、下次重启就消失」的假活。
18. **卸载默认保留数据与配置**，删除要分别显式勾选。删代码是明确动作，删用户数据不是。
19. **插件包里的符号链接一律拒绝。** `cp` 按链接本身复制，装完链接仍指向源目录之外，等于绕过了 `entry` 的路径校验。安装路径还必须是绝对路径：相对路径会按服务进程的 cwd 解析，用户以为是仓库根、实际是 `apps/server`。
20. **上传不等于可信。** ZIP 解出来之后过的是与手工放目录**完全相同**的 `inspectPackage`，不因为「是我们自己解压的」放松。产品要部署到公网，工作台能上传就等于把「写文件到服务器」暴露成了 HTTP 接口。
21. **解压只有一份实现**（`src/archive.ts`，技能与插件共用）。它是外来字节落成本地文件的唯一入口；两套实现必然演化出两套校验，其中一套迟早漏掉某条路径检查。三道防线：zip slip（绝对路径 / 盘符 / `..` / `.` 一律拒绝）、zip bomb（条目数、单条目总量、解压后总量都要**边解边算**）、重名条目（先 `Map` 拦，落盘再叠 `flag: "wx"`）。
22. **解压先落隐藏临时目录再 `rename`。** 临时目录用 `.incoming-<uuid>` 放在安装目录**内部**：`discover()` 跳过 `.` 前缀目录，不会登记出「manifest 合法但文件没写完」的插件；同分区 `rename` 是原子的，不会留下半个插件。

---

## 四、插件目录与配置

- 内置插件：`<repo>/plugins/`（仓库内，随代码分发）
- 用户插件：`apps/server/.miubot/plugins/`
- **内置优先**：`pluginsDir: [builtinPluginsDir, pluginsDir]`，同名 id 只认第一个，冲突登记为 `duplicate:*` 诊断条目
- 插件业务数据：`apps/server/.miubot/plugin-data/<id>.json`
- 插件配置：`apps/server/.miubot/plugin-config/<id>.json`（与数据分开：卸载时「保留数据」不该顺手保住配置）
- 安装目标就是用户插件目录 `apps/server/.miubot/plugins/`（内置目录只读，工作台的「安装」不会写进去）

配置（`apps/server/.miubot/config.json`）：

```json
"plugins": { "enabled": [], "disabled": [] }
```

当前实际值就是上面这个（全空 = 全部启用）。

---

## 五、各阶段落地明细 + 下一步

### 0. 下一步候选（都**未开工**，按建议顺序）

挑一件开工；下面的 1–7 小节是已完成的记录，只用来查落点和约束，不要重做。**当前已无 P0，只剩一只 P1。**

| 优先级 | 事项 | 落点 / 前置 | 备注 |
|---|---|---|---|
| P1 | 运行日志轮转 + 脱敏 | `logging.ts` | 公网长期跑会撑爆磁盘：按 10 MB × 5 切割；同时确认 `apiKey` / `appSecret` / 消息正文不进日志 |
| P1 | `hasActiveHandler()` 支持按按钮归属判断 | `host.ts` + `platform/qq-adapter.ts` 的 `canHandleInteraction` | 现在只回答「有没有人在听」，回答不了「这个 `buttonId` 是不是你的」。**没有使用按钮交互的插件之前，没有真实需求驱动**，别为了它猜接口 |
| P2 | 启停不再无条件重建会话 | `routes/plugins.ts` + `agentHost.anyAgentLoopRunning()` | 流式回复会被打断。可改为「有 loop 在跑就延后到空闲」 |
| P2 | `inboundReferences.take()` 改引用计数 | `platform/plugin-bridge.ts` | 同一入站消息多插件回复时只有第一个拿到被动回复锚点。**会改变被动回复配额语义，先定语义再改** |
| P2 | `storage.readAll()` 不再吞解析错误 | `host/storage.ts` | 损坏文件下次写入会被覆盖。**抛错会影响容错策略，先定策略** |
| P2 | 补一次最小 `session.bindExtensions()` | `agent-host.ts` | 让 `session_start` / `resources_discover` 对插件可用；没插件需要之前不必做 |
| P2 | 诊断条目（`invalid:*`）无法从工作台删除 | `routes/plugins.ts` + `Plugins.tsx` | `uninstall()` 目前只接受 `source === "plugin"`。坏目录只能手动删；要支持就得给诊断行也做一个「删除目录」动作 |
| P3 | 插件升级（同 id 覆盖安装） | `host.ts` 的 `install()` | 现在必须先卸载。升级需要「先校验新包、再原子替换」，别做成直接覆盖 |
| P3 | 独立 WebUI 入口登记、插件后台任务/调度、精细审计 | — | 阶段 D，按真实需求再评估，不预先建设 |

下一步如果做「升级」，注意配置与数据现在分在两个目录（`plugin-config/` 与 `plugin-data/`），
升级要保留两者；而 `uninstall` 的默认行为是保留、删除要显式勾选，别把升级做成一次卸载。

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
- 单测 `apps/server/test/plugins-route.test.ts`（15 项，含插件注册的工具名与钩子名展示），已按 §九 做过反向验证（去掉幂等跳过、去掉 manifest 重读后测试转红）。

### 3. Web 工作台插件页（✅ 已完成）

`apps/web/src/pages/Plugins.tsx`，入口在侧边栏「高级配置 → 插件」（`extensions` 页签，原占位内容已删除）。

列表展示名称/版本/状态/权限/清理函数数/错误，以及该插件注册的 Agent 工具（绿色 chip）与对话钩子（sky 色 chip）；按钮为启用 / 停用 / 重载（禁用条目上重载置灰），顶部「重新扫描」，底部显示插件目录与配置中的禁用清单。

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

### 5. 阶段 B 收尾：Pi Extension factories 桥接（✅ 已完成）

| 文件 | 职责 |
|---|---|
| `packages/plugin/src/host/extensions.ts` | 工厂注册表：命名校验、跨插件重名、存活/代次判定、`bots` 过滤、`pi` 守卫 |
| `packages/plugin/src/host/context.ts` | `ctx.extensions.register()`（权限 `extension:register` + 代次校验 + 自动撤销） |
| `apps/server/src/agent-host.ts` | 铺进 `DefaultResourceLoader.extensionFactories`，并读出 `errors[]` 写运行日志 |
| `packages/plugin/src/host/host.ts` | `pluginHost.extensions`，`PluginStatus.extensions` 供工作台展示 |

要点：

- **只桥接钩子，不桥接工具**：插件扩展拿到的 `pi.registerTool()` 被守卫直接抛错，必须走 `ctx.tools.register()`。两套注册路径会让重名检查、工作台展示、启停联动各算一套，最后必然出现「UI 里看不到但模型能调」的工具。
- **顺序稳定**：插件扩展排在服务端自己的 `miubot-qq-scene` **之前**，保证 `appendSystemPrompt` 的拼接顺序固定（场景 → 插件补充）。改顺序会直接改变提示词内容。
- **失败不静默**：`DefaultResourceLoader` 把工厂异常收进 `errors[]` 而不外抛，`agent-host` 主动读出来写 `WARN`（路径形如 `<inline:plugin:test.broken/hooks>`）。不读就等于插件悄悄失效。
- **扩展路径**：`plugin:{pluginId}/{name}`；`name` 为 2–32 位小写字母/数字/短横线，同插件内与跨插件都查重。
- **作用域**：manifest `bots` 决定哪些 Bot 的会话装载该扩展；停用后 `removeOwner()` 清空，重建会话才生效（与工具同一条策略）。
- 守卫每次装载重新包一层（`factory: (pi) => registration.factory(guard(pi))`），不缓存到登记对象上，避免改名后守卫文案串号。
- 测试：`packages/plugin/test/plugin-extensions.test.ts`（9 项，注册表语义）+ `apps/server/test/plugin-extension-session.test.ts`（4 项，真实 `DefaultResourceLoader` + 真实 `createAgentSession`）。会话侧断言落在 `session.extensionRunner.hasHandlers(...)` 与直接 `emit()` 上——`agent_start` / `agent_end` 载荷极简，不需要真实模型请求就能验证「handler 进了运行器且派发时插件代码真的执行」。

### 6. 阶段 C 第 2 项：Schema Config（✅ 2026-10-23，尚未提交）

| 文件 | 职责 |
|---|---|
| `packages/plugin/src/host/config.ts` | schema 类型、schema 自身校验、默认值合成、输入校验、`compactAgainstDefaults`、文件读写、`ctx.config` 访问器 |
| `packages/plugin/src/host/manifest.ts` | 解析并校验 `config` 声明；schema 非法 → manifest 非法（带精确字段） |
| `packages/plugin/src/host/context.ts` | `ctx.config`（`all()` / `get<T>()`），与其它能力同一条代次守卫 |
| `packages/plugin/src/host/host.ts` | `configFor` 注入、`PluginStatus.hasConfig`、`config.inspect/save/schemaOf` |
| `apps/server/src/http/routes/plugins.ts` | `GET` / `PUT /api/plugins/:id/config`；保存后重启运行中的插件并重建会话 |
| `apps/web/src/pages/Plugins.tsx` | 按 `x-ui.group` 分组的表单；布尔走开关、枚举走 select、`secret` 走密码框 + 清除 |
| `plugins/miubot.welcome/` | 迁移到 `config.welcomeText`，去掉 storage 里的欢迎语默认值（版本升到 0.2.0） |

manifest 声明形状（**扁平一层标量**，`x-ui` 只影响渲染）：

```json
"config": {
  "type": "object",
  "properties": {
    "welcomeText": {
      "type": "string", "title": "欢迎语", "default": "…",
      "minLength": 1, "maxLength": 500,
      "x-ui": { "widget": "textarea", "group": "消息设置" }
    },
    "apiKey": { "type": "string", "secret": true }
  },
  "required": ["welcomeText"]
}
```

要点：

- **支持子集**：`type`（string/number/integer/boolean）、`enum`、`default`、`required`、`min/maxLength`、`min/maximum`、`secret`、`x-ui{widget,placeholder,group}`。不支持嵌套、数组、pattern。
- **容错策略分两层**：schema 写错 → 插件加载失败；磁盘上的值不符合 schema（插件改了字段类型、文件被手改）→ 静默退回默认值，**不动磁盘上的原值**，插件照样能起来。
- **插件侧只读**。写入是管理面动作：允许插件在运行时改自己被管理员配置的值，会出现「界面显示 A、实际跑 B」。
- **未知键在保存时静默丢弃**：schema 删掉字段后旧前端仍可能带着它，为此让保存失败只会挡住与它无关的修改。
- **`ctx.config` 不设权限位**：插件只能读自己的配置，声明 `config` 本身就是授权。加一个 `config:read` 只会让「声明了 schema 却忘加权限、读到的永远是空对象」变成常见故障。
- 测试：`packages/plugin/test/plugin-config.test.ts`（27 项，含真实宿主 + 真实 `.ts` 入口的端到端：保存 → 重启 → 插件读到新值）+ `apps/server/test/plugins-route.test.ts` 新增 9 项（secret 不回显、校验失败不落盘、停用插件不自启）。
- 已按 §九 做过反向验证：去掉 `inspectConfig` 的 secret 剔除 → 密钥漏进响应，测试转红；把 `compactAgainstDefaults` 换成全量写入 → 默认值被钉死，测试转红。

### 7. 插件包安装 / ZIP 上传 / 卸载（✅ 2026-10-23，尚未提交）

| 文件 | 职责 |
|---|---|
| `packages/plugin/src/archive.ts` | `readZip`（ZIP 读取 + 三道防线）、`findArchiveRoot`、`entriesUnderRoot`；技能与插件共用 |
| `packages/plugin/src/host/install.ts` | `inspectPackage`（目录包校验）、`copyPackage`、`deletePackage`、`extractPackage`（解压到隐藏临时目录） |
| `packages/plugin/src/host/host.ts` | `install(sourceDir)` / `importArchive(bytes)` / `uninstall(id, {deleteData, deleteConfig})`；`reserveTarget` 与 `finishInstall` 两条入口共用；`PluginStatus.directory` / `.removable` |
| `apps/server/src/http/routes/plugins.ts` | `POST /api/plugins/install`、`POST /api/plugins/import`、`POST /api/plugins/:id/uninstall`；`respondInstalled()` 统一收尾 |
| `apps/server/src/index.ts` | `installDir: pluginsDir`；`deleteAssets` 按勾选删 `plugin-data` / `plugin-config` |
| `apps/web/src/pages/Plugins.tsx` | 顶部「安装」面板（拖拽区 + 选文件 + 路径兜底）、卡片「卸载」二次确认 + 两个勾选 |

要点：

- **两条安装入口，一套校验**。目录安装给本机开发用（不必先打包），ZIP 上传给工作台用（要部署到公网时只能走这条路）。两者最终都落到 `<installDir>/<manifest id>`，共用 `reserveTarget`（id 冲突 / 目标目录已存在）与 `finishInstall`（`discover()` + 回读）。
- **传输方式比 multipart 简单**：`content-type` 里含 `zip` 即可（Windows 浏览器可能报 `application/x-zip-compressed`），body 是原始字节，与 `/api/skills/import` 保持一致。请求体上限 20 MB，先挡在解压之前。
- **装完不启动**（见 §三.17）。启动由路由按 `isAllowedByConfig` 决定，装完再 `rebuildAgentSessions()`，让新工具进已有会话。宿主自己不读配置，所以这个判断只写一次。
- **校验项**：manifest 合法、入口文件真实存在、无符号链接、文件数 ≤ 2000 / 体积 ≤ 32 MB、路径是绝对路径（目录入口）、id 不与已有条目冲突（含内置同名插件）。
- **卸载做什么**：`stop()` → 删目录 → 按勾选删资源 → 从 `entries` 移除 → 路由清掉 `config.plugins` 里的 id 并 `save()`。删目录失败时条目保留，用户可以重试。
- **内置插件拒绝卸载**：`isInstalledDirectory()` 用 `relative()` 判断目录是否在 `installDir` 内，而不是字符串前缀（`plugins-evil` 会以 `plugins` 开头）。
- **技能导入顺手改成共用实现**：`tools/skills/runtime.ts` 里那套 fflate 处理被 `archive.ts` 取代（行为不变，只是不再各写一遍）。
- 测试：`packages/plugin/test/plugin-install.test.ts`（18 项）、`plugin-archive.test.ts`（23 项，含一次性跑通「解压 → 校验 → rename → 登记」）、`apps/server/test/plugins-route.test.ts` 新增安装 4 / 上传 8 / 卸载 3 项。
- 反向验证：去掉内置保护 → 内置目录真的被删、测试转红；去掉 id 冲突检查 → 同名内置插件被覆盖、测试转红；去掉 `normalizeEntryPath` 的 `..` 判断 → zip slip 测试转红。

---

## 六、已知遗留问题

| 优先级 | 位置 | 问题 |
|---|---|---|
| P1 | `host.ts` | `hasActiveHandler()` 只判断有无订阅者，不能判断具体按钮是否被某插件认领（`cultivation:*` 这类） |
| P2 | `plugin-bridge.ts` | `inboundReferences.take()` 只能消费一次；同一入站消息触发多个插件回复时，只有第一个拿到被动回复锚点 |
| P2 | `storage.ts` | `readAll()` 吞掉解析异常返回 `{}`，损坏文件下次写入会被覆盖（数据丢失） |
| P2 | `agent-host.ts` | 服务端从不调用 `session.bindExtensions()`，因此 `session_start` / `resources_discover` 这两个钩子对插件**永不触发**（`ExtensionRunner` 本身在会话构造时就建好了，`before_agent_start` / `tool_call` / `message_*` 等都正常）。Pi 那边这两个事件由 mode 层（interactive / print / rpc）绑定，Miubot 没有对应的 UI 层，是有意跳过的；若将来有插件需要它们，再补一次最小绑定 |
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

### 测试插件相关功能时的两个坑（2026-10-23 踩过）

1. **`before_agent_start` 只在 agent loop 里派发，建会话时不触发。** 想证明「插件钩子真的注册上了」，不要数钩子被调用的次数——断言 `session.extensionRunner.hasHandlers("agent_start")`，再直接 `await runner.emit({ type: "agent_start" })`。
   挑事件时注意：`before_agent_start` / `tool_call` / `message_end` / `context` 等走专用 `emitXxx()`，不在通用 `emit()` 的联合类型里；能通用派发又载荷极简的是 `agent_start`（无字段）和 `agent_end`（只要 `messages`）。
2. **「工厂抛错」必须写在工厂体里。** 写进 `pi.on(...)` 的回调体就变成运行期错误，扩展照样装载成功、测试会假绿。
3. 相关地：`PluginStatus.tools` / `.extensions` 给的是 `namesOf()` 的**短名**，`list()` 才返回完整路径（`plugin:{id}/{name}`）。
4. 想验「会话照常可用」这类空集断言，先 `config.tools.enabled = []`——`createDefaultConfig()` 默认带 `["web_search"]`。
