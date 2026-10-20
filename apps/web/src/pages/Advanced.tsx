import { Icon } from "../components/Icon";
import { useTheme } from "../theme";

/* 主动行为页面 */
export function Proactive() {
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div>
          <h1 className="text-[20px] font-bold text-white tracking-tight">主动行为</h1>
          <p className="text-[13px] text-[#777777] mt-0.5">主动发起、主动插话策略与冷却概率</p>
        </div>

        <div className="sketch-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[15px] font-bold text-white">群聊智能插话</div>
              <div className="text-[12.5px] text-[#777777]">当检测到感兴趣或求助话题时，Bot 自主插话</div>
            </div>
            <span className="pill-green">已开启</span>
          </div>

          <div className="space-y-3 pt-3 border-t border-[rgba(255,255,255,0.06)] text-[13.5px]">
            <div className="flex justify-between py-1">
              <span className="text-[#cccccc]">插话概率阈值</span>
              <span className="text-white font-mono">25%</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#cccccc]">最小发言间隔</span>
              <span className="text-white font-mono">10 分钟</span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[#cccccc]">夜间静默时间</span>
              <span className="text-white font-mono">01:00 - 07:00</span>
            </div>
          </div>
        </div>

        <div className="sketch-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[15px] font-bold text-white">私聊主动问候</div>
              <div className="text-[12.5px] text-[#777777]">定时或按纪念日向授权好友发起早晚安</div>
            </div>
            <span className="pill-gray">未开启</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* MCP 页面 */
export function MCP() {
  const mcpServers = [
    { name: "fs-tools", desc: "本地工作区文件系统读写权限", tools: "6 个可用工具", status: "online" },
    { name: "web-search-brave", desc: "实时联网网页搜索", tools: "2 个可用工具", status: "online" },
    { name: "memory-graph", desc: "本地长期实体关系图谱检索", tools: "4 个可用工具", status: "online" },
    { name: "github-mcp", desc: "仓库代码、Issue 与 PR 操作", tools: "8 个可用工具", status: "offline" },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">MCP</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">外部 Model Context Protocol 工具服务器连接</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>添加服务器</span>
          </button>
        </div>

        <div className="space-y-3">
          {mcpServers.map((s) => (
            <div key={s.name} className="sketch-card p-5 cursor-pointer">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[15px] font-bold text-white">{s.name}</div>
                  <div className="text-[12.5px] text-[#777777] mt-0.5">{s.desc}</div>
                </div>
                {s.status === "online" ? (
                  <span className="pill-green">已挂载</span>
                ) : (
                  <span className="pill-gray">已断开</span>
                )}
              </div>
              <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] flex justify-between text-[12.5px] text-[#888888]">
                <span>{s.tools}</span>
                <span className="text-[#cccccc] hover:text-white">配置权限</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Skills 页面 */
export function Skills() {
  const skills = [
    { name: "daily-summary", desc: "每日群聊关键话题自动聚合简报", ver: "v1.2.0" },
    { name: "sd-image-craft", desc: "Stable Diffusion 局部重绘与风格生图", ver: "v2.0.4" },
    { name: "bilibili-summary", desc: "B 站视频字幕提取与快速问答", ver: "v0.9.1" },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">Skills</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">管理已安装的 Agent 专属技能</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>安装技能</span>
          </button>
        </div>

        <div className="space-y-3">
          {skills.map((sk) => (
            <div key={sk.name} className="sketch-card p-5 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white">{sk.name}</span>
                  <span className="text-[11px] text-[#888888] font-mono bg-[#141414] px-1.5 py-0.5 rounded border border-[#2a2a2a]">
                    {sk.ver}
                  </span>
                </div>
                <div className="text-[12.5px] text-[#777777] mt-1">{sk.desc}</div>
              </div>
              <span className="pill-green">已启用</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 记忆与知识库 */
export function Memory() {
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">记忆与知识库</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">长期记忆条目、群友画像与挂载文档库</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>新增条目</span>
          </button>
        </div>

        <div className="sketch-card p-5 space-y-3">
          <div className="text-[14px] font-bold text-white">长期实体记忆 (Top 3)</div>
          <div className="space-y-2.5 text-[13px]">
            <div className="p-3 bg-[#141414] rounded-xl border border-[#242424]">
              <div className="text-white font-medium">摸鱼研究所 · 讨论偏好</div>
              <div className="text-[#888888] mt-1">成员以全栈工程师为主，偏好简短代码、不喜欢寒暄客套。</div>
            </div>
            <div className="p-3 bg-[#141414] rounded-xl border border-[#242424]">
              <div className="text-white font-medium">Alice · 私聊备注</div>
              <div className="text-[#888888] mt-1">提醒习惯：早晨 08:30 播报天气，偏好温柔二次元语调。</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* 定时任务 */
export function Scheduler() {
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">定时任务</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">Cron 定时触发 Agent 执行任务或推送</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>新建任务</span>
          </button>
        </div>

        <div className="sketch-card p-5 space-y-3">
          {[
            { name: "每日 08:00 早报推送", cron: "0 8 * * *", target: "QQ群 · 摸鱼研究所", status: "运行中" },
            { name: "每周五 18:00 下班提醒", cron: "0 18 * * 5", target: "全员广播", status: "运行中" },
            { name: "每日凌晨清理过期日志", cron: "0 3 * * *", target: "系统后台", status: "运行中" },
          ].map((t) => (
            <div key={t.name} className="flex items-center justify-between py-2 border-b border-[rgba(255,255,255,0.04)]">
              <div>
                <div className="text-[14px] font-medium text-white">{t.name}</div>
                <div className="text-[12px] text-[#777777] font-mono mt-0.5">{t.cron} · {t.target}</div>
              </div>
              <span className="pill-green">{t.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 扩展插件 */
export function Extensions() {
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <h1 className="text-[20px] font-bold text-white tracking-tight">扩展插件</h1>
        <div className="sketch-card p-5 text-[13px] text-[#888888]">
          已加载 3 个非 Agent 原生事件处理插件（Webhook 桥接、娱乐骰子、群事件监听）。
        </div>
      </div>
    </div>
  );
}

/* 运行日志 */
export function Logs() {
  const logs = [
    { time: "12:42:13", level: "INFO", trace: "tr-9b21", text: "OneBot v11 收到来自群「摸鱼研究所」的消息" },
    { time: "12:42:13", level: "INFO", trace: "tr-9b21", text: "规则引擎命中：@提及，触发主模型 gpt-4o" },
    { time: "12:42:14", level: "INFO", trace: "tr-9b21", text: "调用完成，生成 148 tokens，耗时 382ms" },
    { time: "12:38:02", level: "WARN", trace: "tr-7c10", text: "Bot Miu Dev 心跳包偶发超时，已自动触发保活" },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">运行日志</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">消息记录、事件日志、Agent 执行跟踪与系统日志</p>
          </div>
          <button className="btn-pill-dark">
            <span>导出日志</span>
          </button>
        </div>

        <div className="sketch-card p-4 font-mono text-[12px] space-y-2">
          {logs.map((l, i) => (
            <div key={i} className="flex items-center gap-3 py-1 border-b border-[rgba(255,255,255,0.03)]">
              <span className="text-[#666666]">{l.time}</span>
              <span className={l.level === "WARN" ? "text-[#f59e0b]" : "text-[#22c55e]"}>{l.level}</span>
              <span className="text-[#888888]">{l.trace}</span>
              <span className="text-white flex-1 truncate">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 设置 */
export function Settings() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div>
          <h1 className="text-[20px] font-bold text-white tracking-tight">设置</h1>
          <p className="text-[13px] text-[#777777] mt-0.5">外观主题、本地存储管理与版本信息</p>
        </div>

        <div className="sketch-card p-5 space-y-3">
          <div className="text-[14px] font-bold text-white">客户端外观</div>
          <div className="flex items-center justify-between py-1 text-[13px]">
            <span className="text-[#cccccc]">主题风格</span>
            <div className="flex gap-1.5 bg-[#141414] p-1 rounded-full border border-[#2a2a2a]">
              <button
                onClick={() => setTheme("dark")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] transition-colors ${
                  theme === "dark"
                    ? "bg-[#282828] text-white font-medium shadow-sm"
                    : "text-[#888888] hover:text-white"
                }`}
              >
                <Icon.Moon size={12} />
                深夜黑
              </button>
              <button
                onClick={() => setTheme("light")}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] transition-colors ${
                  theme === "light"
                    ? "bg-[#282828] text-white font-medium shadow-sm"
                    : "text-[#888888] hover:text-white"
                }`}
              >
                <Icon.Sun size={12} />
                柔光纸
              </button>
            </div>
          </div>
          <p className="text-[11.5px] text-[#777777] leading-relaxed">
            浅色为暖灰纸面 + 米白卡片的柔光纸质感,非纯白,不晃眼;偏好会自动记住。
          </p>
        </div>

        <div className="sketch-card p-5 space-y-3">
          <div className="text-[14px] font-bold text-white">存储管理</div>
          <div className="space-y-2 text-[13px] text-[#888888]">
            <div className="flex justify-between">
              <span>本地 SQLite 数据库</span>
              <span className="text-white font-mono">14.2 MB</span>
            </div>
            <div className="flex justify-between">
              <span>表情包与媒体缓存</span>
              <span className="text-white font-mono">82.6 MB</span>
            </div>
          </div>
        </div>

        <div className="sketch-card p-5 text-[13px] text-[#888888] space-y-1">
          <div className="text-white font-bold">MiuBot Workspace</div>
          <div>v0.9.4 Preview · 专用 QQ 机器人桌面工作台</div>
        </div>
      </div>
    </div>
  );
}
