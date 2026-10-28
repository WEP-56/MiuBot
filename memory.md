## Claude Code 记忆系统调研
本文档是对 https://github.com/Haleclipse/CometixCode 跨会话记忆系统的调研，对应代码中的 src/memdir/ 模块（auto-memory）以及 src/tools/agent_tool/agent_memory.rs（持久化 Agent 记忆）。它是 Claude Code memdir 子系统的 Rust 移植，核心是基于文件的记忆目录 + MEMORY.md 索引 + 行为指令注入到 system prompt，而非向量数据库或运行时存储。

- 一句话：跨会话记忆 = 一个磁盘目录（默认 ~/.claude/projects/<sanitized-cwd>/memory/），其中 MEMORY.md 是索引文件，每个记忆是独立的 .md 文件（带 frontmatter：name / description / type）。会话启动时，目录路径和行为规则通过 build_memory_lines() 注入 system prompt 的 # auto memory 段，MEMORY.md 内容经由 claudemd 内存文件管道（作为 ClaudeMdKind::AutoMem）进入上下文；写入完全由 LLM 自己用 Write/Edit 工具完成。另有三种作用域的 agent-memory（User/Project/Local）和特性开关控制的 team-memory 变体。

## 核心设计思想：
- 文件即记忆：不用数据库、不用 embedding。记忆是普通 Markdown 文件，模型通过常规文件工具读写，跨会话持久化天然成立。 memdir.rs:152-156
- 索引分离：MEMORY.md 只是索引（每行一条 - [Title](file.md) — hook），内容永远不写进索引本身；索引常驻上下文，因此有硬上限 MAX_ENTRYPOINT_LINES = 200 / MAX_ENTRYPOINT_BYTES = 25_000，超出截断。 memdir.rs:10-12 memdir.rs:492-494
- 行为靠 prompt 而非代码：何时存、存什么、不存什么、如何验证过期记忆，全部写在 system prompt 的指导段落里；代码只做路径解析、开关判断和 prompt 组装。 memdir.rs:142-198
- 类型化记忆：四种类型 — user（用户画像）、feedback（纠正/验证过的工作方式，强制带 Why: 和 How to apply:）、project（项目动态，相对日期转绝对日期）、reference（外部系统指针）。 memdir.rs:40-104

## 完整机制拆解
开启判定与路径解析
- is_auto_memory_enabled() 检查环境变量 CLAUDE_CODE_DISABLE_AUTO_MEMORY / CLAUDE_CODE_SIMPLE / CLAUDE_CODE_REMOTE 以及 settings 中的 autoMemoryEnabled。 types.rs:1220-1230
- get_auto_mem_path() 按优先级解析根目录：CLAUDE_COWORK_MEMORY_PATH_OVERRIDE → 可信 settings 的 autoMemoryDirectory → 默认 ~/.claude/projects/<sanitized-cwd>/memory/。projectSettings 中的目录会被忽略（安全考虑）。 types.rs:1226-1230

### 注入到 system prompt 的两条路径
![alt text](image.png)
- 行为指令：build_memory_lines() 生成的 # auto memory 段被插在 # Environment 段之前；测试 default_system_prompt_includes_auto_memory_section_when_enabled 验证了这个顺序。 prompts.rs:1031-1041
- 索引内容：自动记忆的 MEMORY.md 入口文件在 claudemd 文件发现阶段以 ClaudeMdKind::AutoMem 处理，走与 CLAUDE.md 相同的内存文件管道进入上下文（AutoMem 不触发 InstructionsLoaded hook）。 claudemd.rs:302-315 claudemd.rs:345-353
- 自定义 prompt 情形：用户给 system_prompt 时，顺序为 custom → auto-memory 段 → append，由 resolve_system_prompt 组装。 query_engine.rs:1770-1776
- 写入路径：模型直接用 Write 工具写目录（prompt 明确告知 "This directory already exists — write to it directly"）。 memdir.rs:26
- 回忆/搜索：## Searching past context 段（受 FeatureFlag::MemorySearchPastContext 控制）指示模型先 Grep memory/*.md，最后手段才是 Grep 历史 session 的 *.jsonl 转录文件。 memdir.rs:202-252 session_storage.rs:7

### 三种记忆子系统
子系统	入口	路径	开关
Auto-memory	主会话 system prompt # auto memory	~/.claude/projects/<cwd>/memory/	autoMemoryEnabled + 环境变量
Agent-memory	load_agent_memory_prompt() 追加到子代理 system prompt	User: ~/.../agent-memory/；Project: .claude/agent-memory/；Local: 本地私有	随 auto-memory
Team-memory	get_team_mem_entrypoint()	<auto-mem>/team/MEMORY.md	auto-memory + FeatureFlag::TeamMemory

- Agent 记忆把 MEMORY.md 内容直接内联进 prompt（build_memory_prompt 读文件、截断、追加 ## MEMORY.md 段），并按作用域追加不同的 scope_note 指南。 memdir.rs:320-348 agent_memory.rs:112-139
- 测试确认：agent 定义了 memory: Some(Project) 后，get_agent_system_prompt 输出同时包含自定义 prompt、"Persistent Agent Memory" 头和 MEMORY.md 内容。 run_agent.rs:2337-2341
- Team memory 用 normalize_lexically + is_team_mem_path 做词法包含检查，防止路径逃逸出 team 根目录。 team_mem_paths.rs:96-130
- is_auto_managed_memory_file() 统一识别 auto/team/agent/session 记忆文件，供 UI 折叠展示等使用。 memory_file_detection.rs:87-100


## 详细system prompt
build_memory_lines() 产出的完整段落（顺序固定）： memdir.rs:142-198

1. #auto memory — 声明存在 <dir>/ 的持久文件记忆系统，目录已存在可直接写。
2. 目标说明 — 随时间积累，让未来会话了解用户、协作偏好、应避免/重复的行为、工作背景；用户明确要求记住/忘记时立即处理。
3. ##Types of memory — user / feedback / project / reference 四类，各带 <when_to_save>、<how_to_use>、<body_structure>、<examples>。 memdir.rs:40-104
4. ##What NOT to save — 代码模式、git 历史、调试修复方案、已在 CLAUDE.md 的内容、临时任务状态；即使用户要求也不存，只存"surprising / non-obvious"部分。 memdir.rs:107-117
5. ##How to save memories — 两步法：写独立文件（frontmatter: name/description/type）→ 在 MEMORY.md 加一行索引（<150 字符）；索引超 200 行会被截断；禁止重复记忆、按语义组织。 memdir.rs:459-501
6. ##When to access / ## Before recommending from memory — 用户明确要求时必须访问；用户说忽略记忆则视为空；记忆会过期，引用具体文件/函数前必须验证现状，冲突时信当前观察并更新记忆。 memdir.rs:119-139
7. ##Memory and other forms of persistence — 区分 memory vs Plan vs Tasks（当前会话内用 plan/task，跨会话才用 memory）。 memdir.rs:187-191
8. ##Searching past context（条件编译进）— Grep 记忆目录 → Grep session jsonl。 memdir.rs:237-251

对 agent-memory，build_memory_prompt() 在以上之后追加 ## MEMORY.md 并内联索引全文（空则提示 "currently empty"）。 memdir.rs:325-345

## 存储与记忆结构
~/.claude/projects/<sanitized-cwd>/memory/   # auto-memory 根  
├── MEMORY.md                               # 索引（≤200行/25KB，无 frontmatter）  
├── user_role.md                            # 单条记忆文件  
├── feedback_testing.md  
└── team/                                   # team-memory 子目录  
    └── MEMORY.md  
  
.claude/agent-memory/<agent-type>/MEMORY.md # project-scope agent 记忆  
~/.claude/agent-memory/<agent-type>/        # user-scope agent 记忆  



## 在 Miubot 内的实现（设计方向）

### 定位
低复杂度但高效的跨会话记忆：Markdown 文件存储，不使用向量数据库，不做知识库问答。记忆按 QQ 对象长期保存，与单个会话生命周期无关。

### 身份与目录结构
目录键使用 QQ 官方 Bot 提供的稳定 OpenID，不使用可变化的群昵称或用户名。会话本身还按 Bot 隔离，因此落盘路径也应包含 Bot 作用域，且路径段由宿主根据可信会话信息生成，不能由模型传入任意路径。

- 私聊：对象本身就是一个人，以该 C2C OpenID 为记忆身份，不再按每条消息的发送者额外分层。
- 群聊：每个群只维护一个 Markdown 文件；其中同时包含低成本的共享记忆（群属性、整体话题风向、近期共同事件）和按发言者 OpenID 标记的极短个人摘要，以便区分“谁说过什么”。不为每个成员创建独立文件。显示名只用于阅读，不作为键。
- 群内个人摘要只记录有助于后续交流的少量信息，控制在几十个中文字以内；不建立私聊级别的细粒度画像。群共享记忆不能混入可归属到单个成员的个人信息。

实现前应明确群 OpenID 与成员 OpenID 在存储中的组合方式，确保同一成员在不同群的摘要不会意外串用，也确保不能通过模型提供的 ID 访问其它群或成员目录。

### Agent Tools 与权限

- 提供 `save_memory` 和 `read_memory`，分别用于写入/更新记忆与读取当前上下文所需记忆。Tools 面向 Agent；长期记忆页面负责浏览、编辑、删除 Agent 写入的记忆。
- 记忆 Tools 不进入“高级配置 → Tools”的普通全局开关清单；但必须遵守会话对象配置的“使用 Tools”总开关。对象开启自定义 Tools 时，记忆 Tools 也必须受该对象白名单约束，不能绕过授权。
- 是否为对象启用长期记忆，由“会话 → 对象配置”控制。禁用时不注入记忆，也不注册/调用记忆读写 Tools。
- Tool 只接收记忆内容、条目类型等业务字段；对象目录和文件名由宿主根据当前会话及发送者 OpenID 解析。读、写、编辑、删除都必须限制在当前对象允许的根目录内，并拒绝路径穿越和符号链接逃逸。
- 记忆正文是不可信的历史资料，不得作为系统指令执行。读取时应清楚标注记忆内容及其来源；用户要求忽略某条记忆时应尊重当前指令。

### 文件、索引与成本

索引层可以直接参考 Claude Code `claudemd` 路径的硬截断策略：先按行数截到 200 行，再按 25,000 个 UTF-16 code units 截断，并尽量回退到最后一个换行边界；截断后在尾部追加明确的 WARNING，告知模型只有部分索引已加载，并要求它缩短索引条目、把细节移出索引。对应上游函数为 `truncate_memory_entrypoint`，newline 回退由 `last_newline` 完成。这样既限制常驻上下文成本，也让模型知道索引超限并有机会自行修复。

注意实现来源的差异：文档调研的 CometixCode 当前 Rust `memdir::truncate_entrypoint_content` 使用 25,000 UTF-8 bytes 上限，并保证不切开 UTF-8 字符；上述 UTF-16 单元规则来自 Claude Code 的 `claudemd` 路径，二者不要混为同一段代码行为。

详细记忆文件层参考上游当前实现，不设置代码级文件大小硬上限；Miubot 仍应通过后台整理、对象级记忆 Prompt 和管理页面清理控制实际成本。群聊只有单个 Markdown 文件，故整理时还应限制成员摘要数量和每条摘要长度，避免文件持续膨胀。

元数据至少考虑 `created_at`、`updated_at`、类型和可选来源（例如群共享信息或某个成员 OpenID）。时间戳用于排序、过期检查和人工清理。写入采用原子持久化，并处理同一对象并发更新，避免会话并发导致文件覆盖。

### 写入与后台整理

参考上游的去重、价值判断和过期校验规则，但改写为 Miubot 的中文 QQ 场景，不直接照搬 Claude Code 专属路径或指令。在“高级配置 → 长期记忆”提供可编辑的记忆行为 Prompt，并用默认提示约束：只保存对未来交流有帮助且相对稳定的信息；群共享部分总结全群属性、话题和近期事件；成员部分只保留几十字以内的简短识别摘要；避免重复、临时细节、敏感信息和未经确认的推断。

上游设置名 `autoDreamEnabled` 对应“后台记忆整理”开关。调研到的 CometixCode 当前只有设置项、UI 开关和 Dream 任务状态投影；`query/stop_hooks.rs` 明确把 auto-dream orchestration 留作 TODO，实际整理服务没有移植。因此应借鉴其产品思路，不把 Rust 参考仓库误当成已有可复用实现。

Miubot 的整理任务按对象独立配置：每个群或私聊对象可设置开启/关闭、整理间隔和整理使用的模型。整理在后台闲时运行，只读取并重写该对象现有记忆，不结合或回放 session 历史；不向 QQ 发送整理结果。群对象整理全群共享部分和同一文件中的成员短摘要，私聊对象整理该用户记忆。执行需避免同一对象并发整理，并保留任务状态、最近运行时间和失败原因，供长期记忆页面查看与重试。暂停对象记忆或删除对象时，应相应停止/清理其整理任务。

长期记忆页面按群/私聊对象查看记忆，提供读取、增改删操作，并标明记忆所属对象及群内成员 OpenID/当前显示名，方便纠正归属或清理过期内容；对象配置区同时提供后台整理开关、间隔、模型选择及最近运行状态。
