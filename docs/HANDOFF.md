# 交接文档：Miubot 当前状态与下一步（长期记忆）

> 用途：因会话上下文过长，在新会话继续开发时先读这份。
> 最后更新：2026-10-28

**第一次读这份时按这个顺序：**

1. **§零 v0.5.0 发布内容** —— 长期记忆、定时任务与全局静默
2. §一 当前状态 —— 已推到哪、门禁是否绿
3. §三 关键设计决策 —— 动手前必须知道哪些是刻意如此的
4. 相关工作区 §二 代码位置 + §六 已知遗留

---

## 零、v0.5.0 发布内容（2026-10-28）

v0.5.0 汇总长期记忆、定时任务、time Tool、群聊提示词改进、全局静默和此前完成的 Assistant 多消息与 Tool 活动展示。

### 已实现

- `apps/server/src/memory.ts`：按 Bot、对象类型、对象 OpenID 派生目录；群共享与成员摘要、私聊记忆、原子写入、对象级串行、索引截断警告、旧 Markdown 读取与对象级后台整理。
- `packages/plugin/src/tools/memory.ts`：Plugin Core 注册 `save_memory` / `read_memory`；服务端按会话与当前群发言者注入存储能力，并服从 `useTools` 与对象自定义白名单。
- `apps/server/src/agent-host.ts`：对象启用后注入可见记忆索引；详情读取有来源和不可信资料边界，群聊只向当前成员展示其个人摘要。
- `apps/server/src/http/routes/memory.ts` 和长期记忆页面：记忆条目增改删、Prompt 编辑、对象开关、后台整理配置/状态、立即整理和清空。
- `docs/07-高级配置/05-长期记忆.md` 与路线图已同步；删除对象会取消整理并清空该对象记忆。
- Agent 可以创建绑定当前会话的单次或循环任务；支持单次、固定间隔、随机间隔和每日规则，并提供当前时区查询。
- 默认长期记忆提示、表情包发送、智能插话判断和定时任务创建提示均改为具体可执行的中文规则，面向能力较弱的实际 Bot 模型。
- “设置 → 全局静默时段”暂停 QQ/插件业务事件、所有出站消息和定时任务；按服务器本地时间判断，支持跨午夜，结束后继续到期任务。

### 验证

- `npm run check`、`apps/web` 的 `npm run check` 均通过。
- `npm test`：216 files passed / 27 skipped；2,067 tests passed / 864 skipped。
- Biome 检查了本轮修改的服务端与 Plugin 实现文件；`git diff --check` 通过。
- 人工验收：用户已确认实机测试通过，覆盖本次发布功能。

### 落地决策

- 群成员摘要最多 60 个字符；群记忆按一个 Markdown 文件保存，成员归属由宿主从入站上下文解析，不接受模型传入的 ID。
- 整理器每分钟检查到期对象，只有 Agent 空闲时运行；失败后按对象配置间隔再试，不读取会话、不向 QQ 发送。
- 删除对象时清空记忆文件；关闭记忆只停止注入与读写，不删除既有文件。

后续从当前工作区状态继续，先看 `git status --short`。不要重置或覆盖用户已有改动。

---
## 历史计划：工作台与配置收尾（2026-10-23）

> 第 4 条（斜杠命令 + 管理员）、第 2 条（群 / 私聊细粒度配置）、第 5 条（图像提供商下移）已于
> 2026-10-23 完成，落地明细见 §五.8 / §五.9 / §五.10。

剩余两条互不依赖，**决策已全部拍板**（见本节末尾「已定」），可以直接开工。
建议顺序 **1 → 3**：1 是纯前端收口（布局居中 + 控件统一），3 是首页接真实数据。
**1a（布局居中）已完成**（2026-10-23，见 §五.11），1b（控件统一）待做。

### 1. 前端布局与控件一致性

**1a 主内容区水平居中 —— ✅ 已完成，见 §五.11**

8 个页面原来各写一套外层容器（宽度 760/900/980/1100 混用，背景一半 `bg-black` 一半主题变量，
居中只有表情包页做了）。现在统一由 `components/PageShell.tsx` 提供，页面只写内容。

**1b 控件风格：原生 → 微拟物（进行中：Toggle / Slider 已完成，Select 未做）**

已落地 `apps/web/src/components/Controls.tsx`（三个控件放一个文件，比拆三个文件少三份 import）：

- `Toggle`：`<button role="switch" aria-checked>`，轨道走 `var(--border-strong)` / 绿，**13 处**原生
  `<input type="checkbox">` 全部替换（Advanced 7、Sessions 3、Commands / Platforms / Plugins / Providers 各 1）。
- `Slider`：仍是原生 `<input type="range">`（键盘步进、触摸、无障碍读数浏览器全给好了），
  只换外观（`index.css` 的 `.sketch-slider` + 内联渐变画进度），**2 处**替换（表情包采集概率、插话概率）。
- `Select`：组件已写好（combobox + listbox、↑↓/Home/End/Enter/Esc、`aria-activedescendant`、
  点外部关闭），**但 12 个调用点还没换**——它们用的是 `<option>` 子元素，要改成 `options` 数组传参。

**下一步（16 处，逐个把 `<option>` 子元素改成 `options` 数组）**：

| 位置 | 选项来源 | 备注 |
|---|---|---|
| `Advanced.tsx:23` | 字面量 2 项 | 插话模式 |
| `Advanced.tsx:24` / `:25` | `providers` / `models` | 判断提供商 / 判断模型 |
| `Advanced.tsx:71` | 字面量 2 项 | MCP 传输方式 |
| `Advanced.tsx:603` / `:594` | `imageProviders` / 固定 4 家 | 图像提供商 / 搜索提供商 |
| `Sessions.tsx:68` | `bots` | 新建对象时选 Bot |
| `Sessions.tsx:71` ×5 | `configOptions.personas` / `providers` / `selectedProvider.models` / `fallbackProvider.models` | 人格 / 提供商 / 模型 / 备用提供商 / 备用模型 |
| `Providers.tsx:59` / `:61` | 字面量 3 项 / `catalog` | API 协议 / 模型列表（`value=""` 的「选完即加」用法要保留） |
| `Stickers.tsx:101` ×2 | `taggingProviders` / 其 models | 打标提供商 / 模型 |
| `Debug.tsx:33` ×2 | `providers` / `selected.models` | 调试台 |

标签取值有两种：`item.name` 与 `item.name || item.id`（模型类要用后者）。空值选项（「不启用」「选择提供商」）
用 `placeholder` 属性表达，不要再塞一个 `value=""` 的 option——`Select` 已经会在无匹配时显示 placeholder。

坑：
- 别为了好看把 `<select>` 换成 `div` 却丢掉键盘操作与 `label` 关联——自绘组件必须自己补齐
  `role`/`aria-*`/焦点环/Tab 顺序，否则是可用性倒退。
- 列表项用 `onMouseDown` 而不是 `onClick`：click 会先触发外层的「点外面关闭」。
- 一次性换完再截图对比，别一半原生一半自绘。

### 2. 群 / 私聊细粒度配置（✅ 已完成，见 §五.9）

`PeerConfig` 现在有 `fallbackProviderId` / `fallbackModelId` 与 `toolsOverride`；备用模型的
重试循环在 `apps/server/src/agent-prompt.ts`，工具覆盖的唯一执行点仍是 `agent-host.enabledToolNames()`。
落地明细、坑与实测方式见 §五.9。

**实现时发现的两件事（原计划没写到，后续别再踩）**：

- **provider 报错不会让 `prompt()` 抛错**：Agent Loop 把错误写进 assistant 消息的
  `stopReason: "error"` 里然后正常结束。原来的 `inbound.ts` 只在 `prompt()` 抛错时回通用文案，
  所以「429 / 超时 / 网络错」这类失败以前是**静默的**（空回复、日志里什么都没有）。现在两者都算失败。
- **Pi 自带重试**（`settings.retry`，`auto_retry_start/end`）。我们的 3 次是它耗尽之后的**外层**重试，
  所以实际请求数可能比「3 次」更多；日志按「第 n/m 次」逐条记录，别把它当成 Pi 的那套。

### 3. 首页概览接真实数据（✅ 主体完成，Token 累计未做）

`GET /api/overview`（`apps/server/src/http/routes/overview.ts`）一次给齐：今日消息 / 今日会话 /
活跃对象 / 在线 Bot（`connected` / 连接状态表总数）/ 今日主动消息 + 被拦截数 / 近 24h ERROR 数 /
版本 + 运行时长。`Dashboard.tsx` 已接上，每 15 秒刷新，首帧显示 `—` 而不是 0。

**仍未做**：Token 消耗卡显示「未统计」——`AgentSession.getSessionStats()` 是实时值，要按天累计必须
在 `inbound.ts` 每轮 `prompt()` 后取一次增量写进 `usage.json`（参考 `proactive-usage.json` 的写法）。
接口里 `tokens` 字段显式给 `null`（不是 0），前端据此显示「未统计」。

**决定（2026-10-23）**：只上有真实数据源的指标；没有数据源的两张卡直接删，不为凑 2×2 造数。

四张主卡：

| 卡片 | 数据源 | 备注 |
|---|---|---|
| 今日消息 | 会话 `messages[].timestamp` 按当天过滤 | 纯内存数据，直接算 |
| Token 消耗（附估算费用） | `AgentSession.getSessionStats()` 的 usage 合计 | 需按天累计，见下 |
| 在线 Bot | `ctx.qq.states` 里 `phase === "connected"` | 同时给出 `n / 总数` |
| 今日主动消息 | `proactive.metrics` + `sentToday()` | 副标题带"被拦截 n 条"，比"成功率"有意义 |

详情抽屉（点右上角省略号）改为：今日会话数、活跃群/私聊数、近 24 小时 ERROR 条数
（从 `logger.list()` 数）、当前版本 + 运行时长。

**删除**："API 成功率"（没有数据源，日志里的 ERROR 行不等于失败率）、
"平均耗时"与"Agent 触发"（未埋点；要做就单独一轮，加 `performance.now()` 埋点 + 持久化）。

Token 采集怎么做：

- `inbound.ts` 每轮 `prompt()` 结束后读一次 `agentSession.getSessionStats()`，取 usage 增量
  （记住上次的合计值做差），写进 `usage.json`，按 `YYYY-MM-DD` 分桶。
- 结构参考现有的 `proactive-usage`（`state.saveProactiveUsage()` / `getProactiveUsage()`）。
- 会话被压缩（`/compact`）后 `getSessionStats()` 仍含历史条目，增量口径不受影响。

接口：新增 `GET /api/overview` 在服务端聚合，前端只请求一次：

```json
{
  "version": "0.2.0",
  "uptimeSeconds": 3600,
  "today": { "messages": 128, "sessions": 12, "activePeers": 5, "proactiveSent": 9, "proactiveBlocked": 3 },
  "tokens": { "input": 120000, "output": 34000, "cost": 0.42 },
  "bots": [{ "id": "…", "nickname": "Miu", "connected": true }],
  "errorsLast24h": 2
}
```

坑：`Dashboard.tsx` 现在 `select-none` + 全静态，接数据后要有空态（"还没有消息"）和加载态，
否则首帧会显示 0 然后跳变；数字统一走 `Intl.NumberFormat`（现在是手写的 `1,284`）。

### 4. 斜杠命令 + 管理员（✅ 已完成，见 §五.8）

原来的 bug 已修：`inbound.ts` 的群聊闸门曾排在命令判定之前，群里不 @ 的 `/new` 根本到不了命令分支。
现在命令解析在**去重与白名单之后、群聊闸门之前**，命中即接管。实现细节与验收方式见 §五.8。

### 5. 图像生成提供商配置下移到 高级配置 → Tools → image_gen（✅ 已完成，见 §五.10）

`config.imageProviders[]` 保留（允许自定义 baseUrl / model），新增 `config.tools.imageGen.providerId`；
`agent-host` 改成按 `providerId` 找，不再「挑第一个启用且有 Key 的」；`PUT /api/tools` 管选择、
`PUT /api/config` 管提供商本身的增删改；`Providers.tsx` 只留 LLM 提供商，图像分支整体搬到 Tools 页。
落地明细、迁移与实测见 §五.10。

### 已定（2026-10-23，开工前不必再问）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 管理员名单为空时 | **没人能执行管理员命令**。启动日志 WARN + 「斜杠命令」页顶部提示"尚未配置管理员"。 |
| 2 | 备用模型覆盖哪些错误 | **不区分**：缺 key、模型被删、429、超时、网络错一律计入 3 次连续失败。备用是单次调用内的临时替换，下次调用仍从主模型开始（见 2a）。 |
| 3 | 首页两张无数据源的卡 | **删掉**（"API 成功率""平均耗时"）。四张主卡全部有真实数据源，详见第 3 条；不为凑 2×2 造数。 |
| 4 | 图像提供商数据形态 | **保留 `config.imageProviders[]` + 新增 `tools.imageGen.providerId`**。不对齐 web_search 的固定枚举结构——那会丢掉自定义 baseUrl/model。 |

---

## 一、当前状态

**阶段 A（事件型插件）、阶段 B（插件注册 Agent Tool + Pi Extension 钩子）、阶段 C（管理 API + 工作台插件页）均已完成并推送。** 管理面安全与 `index.ts` 职责拆分也已就绪（2160 → 约 215 行）。

**阶段 C 的 Schema Config 已完成（2026-10-23，`88fee6d`）**：manifest 声明 `config` → 宿主校验并合成默认值 → 工作台渲染表单 → 插件从 `ctx.config` 读。`miubot.welcome` 已从「把欢迎语存在插件存储里」迁到 manifest 配置。

**插件包的安装 / 上传 / 卸载已完成（2026-10-23，已随 v0.3.0 发布）**：`POST /api/plugins/install` 从本地目录复制插件包，`POST /api/plugins/import` 接收 ZIP 上传（工作台拖拽或选文件），`POST /api/plugins/:id/uninstall` 删除插件目录并按勾选处理数据与配置。ZIP 解压与技能导入共用 `packages/plugin/src/archive.ts`。

**插件闭环现在是完整的**：事件订阅 / 发消息 / 存储 / Agent Tool / 对话钩子五条能力都有权限、代次、`bots` 作用域三道校验，启停即生效（重建会话），失败都写进插件状态或运行日志；配置面（Schema Config）与分发面（目录安装 / ZIP 上传 / 卸载）也已接通。独立 WebUI 入口与少数遗留 P2 仍未做；QQ 定时任务与长期记忆已随 v0.5.0 发布（见 §零）。

**斜杠命令 + 管理员已完成（2026-10-23，已随 v0.3.0 发布）**：`apps/server/src/commands/` 注册表 + 内置 `new` / `compact` / `help` / `admin`，解析在群聊闸门之前（修掉「群里不 @ 就用不了 `/new`」），`config.admins` 决定谁能执行管理员命令（默认空 = 没人能），插件经 `ctx.commands.register()` 注册命令，工作台新增「高级配置 → 斜杠命令」页。明细见 §五.8。

**群 / 私聊细粒度配置已完成（2026-10-23，已随 v0.3.0 发布）**：对象配置多了备用模型（主模型连续失败 3 次后本轮临时换用，结束即恢复）与工具覆盖（`toolsOverride`，只作用于内置工具那一段）。同时修掉一个静默失败：provider 报错本来不会让 `prompt()` 抛错，以前只表现为「空回复」。明细见 §五.9。

**图像生成提供商已下移到 Tools（2026-10-23，已随 v0.3.0 发布）**：`config.tools.imageGen.providerId` 显式选择，`image_gen` 不再「挑第一个启用且有 Key 的」；「提供商」页只留 LLM 提供商，图像提供商的增删改与密钥搬进 Tools → 图像生成。老配置自动迁移。明细见 §五.10。

**页面外壳已统一（2026-10-23，已随 v0.3.0 发布）**：8 个管理页改用 `components/PageShell.tsx`，宽度与间距集中声明，外层背景/文字色改走主题变量（顺带修好浅色主题下的黑底）。明细见 §五.11。

**v0.4.0（2026-10-26）**：修掉「被引用的图片只报一句『含附件』」与「群聊插话丢掉图片」两个丢像素的路径，群级冷却单位从分钟改成秒。明细见 §五.12。

**v0.5.0**：长期记忆、Agent 定时任务与 time Tool、群聊/工具提示词改进、全局静默时段已完成实机验收；实现和门禁明细见 §零。此前 Assistant 多消息出站与 Tool 活动展示也随本版发布。

历史基线验证（2026-10-26）：`npm run check` / `npm run lint` / `npm test`（当时记录为 **239 files / 2911 tests**，2047 通过、其余 skip）；`apps/web` 的 `tsc --noEmit` 也已干净。v0.5.0 的最新门禁结果见 §零。

**公网部署改造（2026-10-23，已随 v0.3.0 发布）**：P0 四项 + 相关 P1 已落地，管理面可以暴露公网。要点：

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

单测新增 `apps/server/test/auth.test.ts`（18 项）、`response.test.ts`（9 项）、`storage.test.ts`（6 项）、`logging.test.ts`（11 项）、`audit.test.ts`（4 项）、`version.test.ts`（10 项）、`update-check.test.ts`（10 项）、`http-server.test.ts`（18 项，真实 HTTP server + 真实 auth），重写 `api-security.test.ts`；`qq-inbound.test.ts` 补了入站白名单两条用例。全量 200 files / 1962 tests 通过（当前 203 files / 1998 tests）；验收矩阵见 `deploy.md §7`（真实起进程跑过：Host 伪造 403、无凭据 401、旧后门 401、登录/登出、413/400、锁定 429、首启动口令只打印一次、会话文件只存 SHA-256；`/api/health` 带 `version`、`/api/system/update` 在 GitHub 403 时返回结构化错误而不是抛错；`/api/access` 的增删改与 env 只读、`/api/audit` 的记录顺序）。已按 §九 做反向验证：去掉会话校验 → `api-security` + `http-server` 的伪造 Cookie 用例转红；去掉 body 流式上限 → `response` 两条用例转红；去掉白名单判定 → `qq-inbound` 的越权用例转红；去掉日志脱敏 → `logging` 两条用例转红。

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
23. **斜杠命令的解析在群聊闸门之前，但只接管已注册的命令。** 放在闸门之后会让群里不 @ 的 `/new` 永远到不了命令分支（原来的 bug）；接管所有 `/` 开头的消息则会误吞群友的普通聊天。
24. **命令权限只有一个执行点**（`commands/dispatch.ts`），内置与插件命令共用。分散到各命令里判定，迟早出现「插件命令忘了查管理员」。管理员名单空 = 没有人能执行，这是刻意的安全默认。
25. **命令与普通回复共用同一条串行队列**（`enqueueForTarget`）。`/compact` 与正在跑的 Agent 抢同一个会话上下文，比「命令要等一会儿」糟得多。
26. **provider 报错不会让 `prompt()` 抛错**，而是留下一条 `stopReason: "error"` 的 assistant 消息。任何「调用失败后要做什么」的逻辑都必须同时看抛错与这条消息，否则 429 / 超时 / 网络错会静默失败（只表现为空回复）。
27. **备用模型是单次调用内的替换**：只在 `promptWithFallback()` 的 `finally` 里恢复，`session.modelId` 永不改写。没有配置备用模型时不重试——多试只会放大等待与计费。
28. **对象级工具覆盖只作用于内置工具**（`load_skill` / 表情包 / MCP / 插件工具各有自己的开关）。`useTools` 仍是总开关，优先级高于覆盖清单。
29. **图像提供商是 `image_gen` 的依赖，不是 Agent 的推理后端**：它的选择放在 `tools.imageGen`（与 `webSearch.provider` 同层），配置页在 Tools 而不是「提供商」。解析失败一律报错，不回退到「第一个可用」的——隐式回退会让「选了 A 却用了 B」变成悬案。

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

### 0. 历史下一步候选（记录已过时；当前目标以 §零 为准）

下面的表格保留 2026-10-23 的 Plugin 遗留候选，不要据此覆盖新的任务优先级；长期记忆已完成，落地与验证见 §零。下面的 1–7 小节仍可查落点和约束，不要重做已完成内容。

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

### 6. 阶段 C 第 2 项：Schema Config（✅ 2026-10-23，已随 v0.3.0 发布）

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

### 7. 插件包安装 / ZIP 上传 / 卸载（✅ 2026-10-23，已随 v0.3.0 发布）

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

### 8. 斜杠命令 + 管理员（✅ 2026-10-23，已随 v0.3.0 发布）

修掉了「群聊下无法使用 `/new`」的根因：群聊闸门（`isGroup && !mentioned → 插话`）曾排在命令判定之前。

| 文件 | 职责 |
|---|---|
| `apps/server/src/commands/types.ts` | `CommandPermission` / `CommandInvocation` / `CommandDefinition` / 清单类型 |
| `apps/server/src/commands/parse.ts` | `parseCommand()`：只认「整条消息以 `/` 开头 + 合法命令名」，名字大小写不敏感 |
| `apps/server/src/commands/registry.ts` | 内置 + 插件命令合并、配置禁用、按调用者权限过滤出 `/help` 清单 |
| `apps/server/src/commands/builtin.ts` | 内置 `new` / `compact` / `help` / `admin`（`admin` 是唯一管理员命令，只读） |
| `apps/server/src/commands/dispatch.ts` | **唯一的权限执行点**：越权写审计 + 回通用拒绝语；失败回通用文案、细节进日志 |
| `apps/server/src/qq/inbound.ts` | 解析位置：去重与白名单之后、素材采集与群聊闸门之前；命中即接管（`return`） |
| `apps/server/src/http/routes/commands.ts` | `GET` / `PUT /api/commands`（清单 + 管理员名单 + 禁用清单） |
| `apps/server/src/runtime.ts` / `app-state.ts` | `config.admins: string[]`、`config.commands.disabled: string[]` + 归一化 |
| `packages/plugin/src/host/commands.ts` | 插件命令注册表（命名冲突、代次存活、`bots` 作用域、执行前复核） |
| `packages/plugin/src/host/context.ts` | `ctx.commands.register()`，权限 `command:register`，与工具/扩展同一套守卫 |
| `apps/web/src/pages/Commands.tsx` | 「高级配置 → 斜杠命令」：管理员名单 + 命令清单 + 逐个启停 |
| `apps/web/src/pages/Plugins.tsx` | 插件卡片多一排 `/命令` chip |

要点：

- **解析位置就是这次修 bug 的全部**：命令必须在群聊闸门之前判定，否则群里不 @ 的 `/new` 永远到不了。
- **只接管已注册的命令**。其余以 `/` 开头的普通聊天照旧走插话——否则群友的 `/` 开头消息会被吞掉。私聊/被 @ 时未注册的 `/xxx` 仍按普通文本进 Agent。
- **带附件的消息不当命令**：命令没法消费附件，接管等于把附件静默丢掉。
- **权限只有一个执行点**（`dispatch.ts`），内置与插件命令共用；越权写 `audit.record({ action: "command.denied" })` 并回「这个命令只有管理员能用。」。
- **管理员默认空 = 没有人能执行**（安全默认），启动日志 WARN + 页面顶部红字提示。不用 `access.allowedPeers` 兼任：那是「谁能用 Bot」，这里是「谁能让 Bot 做管理动作」。
- **禁用 = 当作不存在**，消息按普通聊天继续处理（不是「静默吞掉」）。默认全启用，与插件白名单同一取向。
- **插件命令不能占用内置命令名**（`reservedCommandNames` 由组合根传入），插件之间也不能重名；`permission` 字段必填，不设默认值——写错就 setup 失败，而不是静默提权。
- **命令与普通回复共用同一条串行队列**（`enqueueForTarget`）：`/compact` 不能和正在跑的 Agent 抢上下文。
- **命令回复走被动回复锚点**（`channel.sendText(message.replyTarget, …)`），不新开主动推送。
- 注意权限名是 `command:register`（与既有的 `tool:register` / `extension:register` 同构），不是原计划里写的 `plugin:command:register`。
- 测试：`apps/server/test/commands.test.ts`（16 项：解析 / 注册表 / 分发）、`commands-route.test.ts`（5 项）、`qq-inbound.test.ts` 新增 6 项（群聊非 @ `/new`、`/help`、越权拒绝 + 审计、管理员放行、禁用回落、未注册 `/foo` 仍走插话）、`packages/plugin/test/plugin-commands.test.ts`（9 项）。
- 反向验证：把命令判定挪回群聊闸门之后 → 「群聊非 @ `/new`」转红；去掉 `dispatch` 里的权限判断 → 两条越权用例转红；去掉 `command:register` 守卫 → 「没有权限时拒绝注册」转红。
- 真进程冒烟（`MIUBOT_DATA_DIR` 指到临时目录、`MIUBOT_PORT=18878`）：`/api/health` 200；未登录 `/api/commands` 401；登录后 `GET /api/commands` 返回 4 条内置命令、`PUT` 写 `admins: ["user-1"]` + `disabled: ["compact"]` 后 `config.json` 落盘、`audit.log` 记 `api.mutation`、响应里 `compact.enabled=false`；启动日志出现「未配置管理员」WARN。

**需要人工验证（真机）**：群里不 @ 发 `/new` 能新建会话；`/help` 的清单与工作台一致；非管理员发 `/admin` 被拒且审计日志里出现 `command.denied`；在「斜杠命令」页关掉 `/help` 后它不再响应；装一个注册命令的插件后，该命令出现在同一张表里并能执行。

### 9. 群 / 私聊细粒度配置：备用模型 + 分作用域工具（✅ 2026-10-23，已随 v0.3.0 发布）

| 文件 | 职责 |
|---|---|
| `apps/server/src/agent-prompt.ts`（新） | `promptWithFallback()`：一轮内的失败计数、第 3 次失败换模型、`finally` 恢复主模型 |
| `apps/server/src/agent-host.ts` | `PeerConfig` 增 `fallbackProviderId`/`fallbackModelId`/`toolsOverride`；`getFallbackModel()`；`enabledToolNames()` 用 `toolsOverride` |
| `apps/server/src/app-state.ts` | 新字段默认值与老配置归一化（缺省 = 不启用备用、继承全局工具） |
| `apps/server/src/qq/inbound.ts` | 走 `promptWithFallback`；失败即取消流式并清空 `streamedText`；记录 `lastModelUsed`/`lastFallbackAt` |
| `apps/server/src/http/routes/sessions.ts` | `PUT /api/peer-config` 校验备用模型与工具覆盖；`GET` 多返回 `tools` 目录与 `globalTools` |
| `apps/web/src/pages/Sessions.tsx` | 对象配置面板：备用模型下拉 + 「自定义工具」多选；会话详情显示上次回答模型；中间列改成整列 `overflow-y-auto`（内容变高后小屏会被 `overflow-hidden` 裁掉） |

要点：

- **失败判定有两个来源**：`prompt()` 抛错（缺模型、缺 Key 这类前置校验）与 assistant 消息的
  `stopReason: "error"`（provider 报错走这条，**不会抛错**）。只看前者会让 429 / 超时 / 网络错静默失败。
- **没有备用模型时只跑一次**：多试几次只会放大等待与计费，换不来任何东西。所以「3 次」只在配了备用模型时存在。
- **备用模型的解析是懒的**：`getFallbackModel()` 每次都读配置；配置了但不可用（提供商停用 / 缺 Key / 模型被删）时
  只告警一次（`warnedFallbacks` 去重），然后按「没配」处理——静默不重试最难排查。
- **恢复主模型在 `finally`**：成功、失败、切换本身抛错都要恢复；恢复失败写 WARN 并明说「会话可能停在备用模型上」。
- **`session.modelId` 不变**：备用只是单次调用内的替换，绝不写进会话配置。
- **流式（C2C）失败一次就退化**：先 `stream.cancel()` 再清空 `streamedText`，`streamUsable = false`；
  重试成功后用普通文本整段发送。QQ 的 stream 绑在 `msgId` 上，重开没有保证，不去赌。
- **工具覆盖只作用于「内置 + 可配置」那一段**：`load_skill` / 表情包 / MCP / 插件工具仍由各自开关决定。
  `useTools` 仍是总开关（关掉 = 一个工具都不启用）。
- 测试：`apps/server/test/agent-prompt.test.ts`（7 项）、`peer-config-route.test.ts`（7 项）、
  `plugin-tool-session.test.ts` 新增「对象自定义工具清单」1 项。
- 反向验证：去掉 `enabledToolNames` 里的 `toolsOverride` → 自定义工具用例转红；去掉 `finally` 里的恢复 → 两条备用模型用例转红。
- 真进程冒烟（`MIUBOT_PORT=18880` + 预置一个假 Key 的提供商）：`PUT /api/peer-config` 保存备用模型与
  `toolsOverride: ["web_search"]` → 200 且 `peer-configs.json` 落盘；只填一半备用模型 → 400。

**已知限制（先记着，别当成 bug）**：

- 重试会重复 `prompt()`：provider 在运行中途失败时，用户消息已经进了 Pi 的会话树，所以成功的那次上下文里
  可能有 2–3 条相同的用户消息。要根治得先有「回滚上一轮」的公开 API（`navigateTree` 能做但副作用大），不在本轮范围。
- 备用模型只覆盖**入站回复**这条路径。智能插话（`proactive.ts`）与表情包打标（`sticker-tagging.ts`）各自
  调用 `prompt()`，失败仍只写日志，不换模型——它们不是「用户等着的回复」。

**需要人工验证（真机）**：给某个群配一个不可用的主模型（删掉 Key 或指向不存在的模型）+ 一个可用的备用模型，
发一条消息 → 日志出现 3 次「调用失败」+ 1 次「本轮改用备用模型」，回复正常，会话详情显示「用过备用模型」，
**下一条消息仍从主模型开始**（日志第 1 次失败又是主模型）。另配一个只留 `web_search` 的群 → 该群 `bash` 不可用、其它群不受影响。

### 10. 图像生成提供商下移到 Tools（✅ 2026-10-23，已随 v0.3.0 发布）

| 文件 | 职责 |
|---|---|
| `apps/server/src/runtime.ts` | `ToolSettings` 增 `imageGen: { providerId }`（空 = 未选择） |
| `apps/server/src/app-state.ts` | 新字段默认值 + **迁移**：老配置里「第一个启用且有 Key 的图像提供商」填进 `providerId` |
| `apps/server/src/image-provider.ts`（新） | `resolveImageProvider()`：未选择 / 不存在 / 停用 / 缺 Key 四种失败都抛错 |
| `apps/server/src/agent-host.ts` | `image_gen` 改用 `resolveImageProvider()`，不再挑第一个 |
| `apps/server/src/http/routes/tools.ts` | GET 多返回 `imageGen`（选择 + 提供商清单，不含密钥）；PUT 校验并保存 `imageGen.providerId` |
| `apps/web/src/pages/Advanced.tsx` | Tools 页 `image_gen` 卡片：提供商下拉 + 密钥 + 新建/删除，与 `web_search` 同构 |
| `apps/web/src/pages/Providers.tsx` | 删掉图像提供商分支（列表、弹窗、"添加提供商"里的类型下拉），只留 LLM 提供商 |

要点：

- **`config.imageProviders[]` 保留**：图像提供商要允许自定义 baseUrl / model 且可多个并存，不像
  `webSearch` 是代码里写死的四家枚举。硬套同一结构会丢掉这些能力。
- **显式选择是这次的重点，不只是换页面**：旧逻辑「第一个启用且有 Key 的」挑错了只会表现成
  「画出来的东西不对」。现在四种失败都报错，**不回退到另一个提供商**——回退会让「我明明选了 A，
  为什么是 B」变成悬案。
- **两个写入口各管一件事**：`PUT /api/tools` 管「选哪个」（与 `webSearch.provider` 同层），
  `PUT /api/config` 管提供商本身的增删改（持有 `imageProviders[]` 与密钥合并逻辑）。
- **迁移**：`app-state.loadConfig()` 在老配置没有 `tools.imageGen` 时，把当时真正生效的那个 id 写进去；
  已有显式值（包括用户主动清空成 `""`）不被覆盖。
- **密钥不回传**：`GET /api/tools` 的 `imageGen.providers` 复用 `publicConfig()` 的投影，
  只有 `apiKeyConfigured`，没有 `apiKey`。
- 测试：`tools-route.test.ts`（7 项：GET 投影 / 选择 / 保留 / 清空 / 不存在 / 缺 Key / 停用）、
  `image-provider.test.ts`（5 项，含「两个都可用时用选中的那个」）、`app-state-image-gen.test.ts`（3 项迁移）。
- 反向验证：把 `resolveImageProvider` 改回「第一个启用且有 Key 的」→ 4 条用例转红。
- 真进程冒烟：预置只有 `imageProviders` 的老配置 → `GET /api/tools` 的 `imageGen.providerId` 已自动指向
  那个可用提供商；`PUT` 选 `nope` → 400；`config.json` 落盘 `{"providerId":"img-a"}`。

**需要人工验证（真机）**：Tools → 图像生成里选 A 家（另有一个也启用的 B 家排在前面）→ 让 Agent 画图，
确认用的是 A；把选择改成「未选择」→ Agent 画图时收到「尚未选择提供商」而不是用 B；在 Tools 页新建一个
图像提供商 → 立即出现在下拉里并能选中；「提供商」页不再出现图像区块。

### 11. PageShell：页面外壳统一（✅ 2026-10-23，已随 v0.3.0 发布）

`apps/web/src/components/PageShell.tsx`（新）接管所有管理页的外层容器：

| 页面 | 宽度 | 备注 |
|---|---|---|
| Dashboard / Plugins / Advanced（8 个 section）/ Commands | 760 | 默认值 |
| Personas / Platforms | 900 | `gap={5}`（原来就是 `space-y-5`） |
| Providers | 980 | `gap={5}` |
| Stickers | 1100 | 原来是唯一居中的那个 |
| Debug / Sessions | — | 不动：一个是全高聊天布局，一个是三栏 |

要点：

- **不只是补 `mx-auto`**：外层背景以前一半是 `bg-black text-white`、一半是主题变量。`--bg-app` 在
  浅色主题下是 `#e8e6e1`，所以那几页在浅色模式下一直是**黑底白字**。统一走变量后顺带修好了。
- 宽度与间距都做成字面量映射（`WIDTHS` / `GAPS`），Tailwind 才扫得到类名；`max-w-[${width}px]`
  这种拼接不会生成 CSS。
- 迁移时踩到的坑：这些页的闭合标签结构各不相同（`</div></div>;` / `</div></section>;` /
  `return (` 里没有分号），按行号替换时**删错一个 `</div>` 就会把子组件的闭合标签吃掉**——
  `Advanced.tsx` 的 `AccessCard` 就被误当成 `Logs` 的结尾替换掉了，tsc 报的却是几百行之后的语法错。
  结论：这类迁移用 `tsc` 当唯一判据，改完立刻跑，别攒着。

验收（人工）：1280 宽下各页左右留白相等；缩到 900 宽内容跟着缩且仍居中；**切到浅色主题**后
Dashboard / Plugins / 高级配置不再黑底。

顺带改了左侧栏（`components/Sidebar.tsx`）：上半区（Logo + 导航 + 高级配置）`min-h-0 flex-1 overflow-y-auto`，
下半区（主题 / 运行日志 / 设置 / 退出）`shrink-0` 常驻。导航项会随功能增加而变长，小屏下原来会把下半区顶出屏幕。

### 12. 引用图片交给视觉模型 / 插话带图 / 冷却改秒（✅ 2026-10-26，v0.4.0）

| 改动 | 落点 |
|---|---|
| 引用消息里的图片下载并作为附图送入模型；额度按整条消息算（正文优先、引用排后），无视觉能力时只留一句说明 | `media.ts` 的 `prepareInboundMedia` / `quoteMediaAttachments` |
| 被引用附件写清类型与文件名（`图片 a.png` / `语音 xxx（语音识别文本：…）`），不再是「含 1 个附件」 | `platform/inbound.ts` 的 `describeQuoteContext` |
| 只有引用、没正文没附件的消息不再被丢弃；会话历史落 `[引用消息]` 而不是空串 | `qq/inbound.ts` |
| 群聊插话的聚合窗口带附件（含引用附件），命中图片时真正 `prompt(..., { images })` | `proactive.ts` 的 `queueGroupMessage` + `prepareMediaAttachments` |
| 群级冷却 `cooldownMinutes` → `cooldownSeconds`，老配置 ×60 迁移；聚合窗口下限从 3 秒放开到 0 | `runtime.ts`、`app-state.ts` 的 `migrateProactiveGate`、`routes/proactive.ts`、`Advanced.tsx` |
| 侧栏去掉 `Agent Workspace` 副标题与「运行中」胶囊 | `components/Sidebar.tsx` |

要点与坑：

- **图片处理只留一份**：`prepareMediaAttachments` 收归一化后的 `MediaAttachment[]`，QQ 入站与插话聚合都走它，
  避免下载/尺寸/张数上限的逻辑出现第二份。`prepareInboundMedia` 只多做一步「把 QQ 平台字段翻成内部形态」。
- **迁移不能省**：老配置只有 `cooldownMinutes`，直接读 `cooldownSeconds` 会拿到 `undefined` → 冷却静默变 0 秒，
  用户没改任何设置却开始刷着说话。`app-state.ts:43` 的 `migrateProactiveGate` 有测试锁（`app-state-proactive.test.ts`）。
- **下限是有意的**：0 表示「不聚合 / 不冷却」，1 秒也允许——分钟制只能填整数，等于把冷却下限钉在 1 分钟。

验收（人工）：群里发图后 @Bot 问「这是什么」→ 模型能描述；引用一张图再问 → 同样能看见；
把群级冷却填 30 → 保存后 30 秒内不再插话；老配置（`config.json` 里还是 `cooldownMinutes`）升级后冷却仍是原来那个分钟数。

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
| P3 | `packages/plugin/src/host/commands.ts` | 插件命令只有原始 `args` 文本，没有参数 schema 与校验。需要结构化参数时再扩，别先支持一半 |
| P3 | `apps/server/src/commands/` | 命令只在 QQ 入站流程里分发，调试台（`/api/chat`）走不到；要一致就得把分发抽成「消息来源无关」的入口 |
| P2 | `apps/server/src/agent-prompt.ts` | 重试会重复 `prompt()`：provider 在运行中途失败时，用户消息已经进了 Pi 的会话树，成功那次的上下文里可能有 2–3 条相同用户消息。要根治需要「回滚上一轮」的公开 API |
| P2 | `proactive.ts` / `sticker-tagging.ts` | 这两条路径各自调用 `prompt()`，不走 `promptWithFallback`：失败只写日志、不换备用模型。它们不是「用户等着的回复」，但失败同样是静默的空结果 |

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
