import { Icon } from "../components/Icon";
import { useTheme } from "../theme";
import { useEffect, useState } from "react";

/* 主动行为页面 */
export function Proactive() {
  type Rule = { enabled: boolean; mode: "smart" | "probability"; probabilityPercent: number; dailyMessageLimit: number; quietStart: string; quietEnd: string; notifyOnLimit: boolean; aggregationSeconds: number; cooldownMinutes: number; judgeProviderId: string; judgeModelId: string };
  type Provider = { id: string; name: string; models: Array<{ id: string; name: string }> };
  type DecisionData = { metrics: { groupMessagesReceived: number; candidates: number; judgments: number; planned: number; sent: number; blocked: number }; sentToday: number; decisions: Array<{ time: string; groupId: string; result: string; reason: string }> };
  const [rule, setRule] = useState<Rule>({ enabled: false, mode: "smart", probabilityPercent: 10, dailyMessageLimit: 0, quietStart: "00:00", quietEnd: "00:00", notifyOnLimit: false, aggregationSeconds: 8, cooldownMinutes: 10, judgeProviderId: "", judgeModelId: "" });
  const [providers, setProviders] = useState<Provider[]>([]); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [decisionData, setDecisionData] = useState<DecisionData | null>(null);
  const refreshDecisions = () => { void fetch("/api/proactive-decisions").then((response) => response.json()).then((data: DecisionData) => setDecisionData(data)).catch(() => {}); };
  useEffect(() => { void fetch("/api/proactive-gate").then((response) => response.json()).then((data: { proactiveGate: Rule; providers: Provider[] }) => { setRule(data.proactiveGate); setProviders(data.providers); }).catch(() => setNotice("无法连接 Miubot Server")); refreshDecisions(); const timer = window.setInterval(refreshDecisions, 5000); return () => window.clearInterval(timer); }, []);
  const provider = providers.find((item) => item.id === rule.judgeProviderId); const models = provider?.models ?? [];
  const save = async (next: Rule) => { setBusy(true); setNotice(""); try { const response = await fetch("/api/proactive-gate", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }); const data = await response.json() as { proactiveGate?: Rule; message?: string }; if (!response.ok || !data.proactiveGate) throw new Error(data.message ?? "保存失败"); setRule(data.proactiveGate); setNotice("智能插话配置已保存"); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7"><div className="max-w-[760px] space-y-4">
    <div><h1 className="text-[20px] font-bold">主动行为</h1><p className="mt-0.5 text-[13px] text-[#777777]">智能插话策略与全局保护</p></div>
    <section className="sketch-card space-y-4 p-5"><div className="flex items-center justify-between gap-4"><div><h2 className="font-semibold">群聊智能插话</h2><p className="mt-1 text-xs text-[#888888]">仅对启用了“智能插话”的群生效；群级开关默认关闭。</p></div><label className="flex shrink-0 items-center gap-2 text-sm"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(event) => setRule({ ...rule, enabled: event.target.checked })}/>全局启用</label></div>
      <label className="block text-sm">插话模式<select className="sketch-input mt-1 w-full" value={rule.mode} disabled={busy} onChange={(event) => setRule({ ...rule, mode: event.target.value as Rule["mode"] })}><option value="smart">智能判断（调用判断模型）</option><option value="probability">纯概率（不调用判断模型）</option></select></label>
      {rule.mode === "smart" ? <><label className="block text-sm">判断模型提供商<select className="sketch-input mt-1 w-full" value={rule.judgeProviderId} disabled={busy} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); setRule({ ...rule, judgeProviderId: event.target.value, judgeModelId: next?.models[0]?.id ?? "" }); }}><option value="">选择提供商</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-sm">判断模型<select className="sketch-input mt-1 w-full" value={rule.judgeModelId} disabled={busy || models.length === 0} onChange={(event) => setRule({ ...rule, judgeModelId: event.target.value })}><option value="">选择模型</option>{models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label></> : <label className="block text-sm">每个聚合窗口的插话概率：{rule.probabilityPercent}%<input className="mt-2 w-full accent-white" type="range" min="1" max="100" value={rule.probabilityPercent} disabled={busy} onChange={(event) => setRule({ ...rule, probabilityPercent: Number(event.target.value) })}/><span className="mt-1 block text-xs text-[#888888]">仅对通过全局限制和群级冷却的窗口抽样。命中后仍会调用聊天模型生成回复，但省去单独的判断模型调用。</span></label>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">聚合窗口（秒）<input className="sketch-input mt-1 w-full" type="number" min="3" max="60" value={rule.aggregationSeconds} onChange={(event) => setRule({ ...rule, aggregationSeconds: Number(event.target.value) })}/></label><label className="text-sm">群级冷却（分钟）<input className="sketch-input mt-1 w-full" type="number" min="0" max="1440" value={rule.cooldownMinutes} onChange={(event) => setRule({ ...rule, cooldownMinutes: Number(event.target.value) })}/></label></div>
      <div className="flex items-center gap-3"><button className="btn-pill-dark" disabled={busy} onClick={() => void save(rule)}>{busy ? "保存中…" : "保存智能插话配置"}</button>{notice && <span className="text-xs text-[#aaaaaa]" role="status">{notice}</span>}</div>
    </section>
    <section className="sketch-card space-y-3 p-5"><h2 className="font-semibold">决策记录</h2><div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">{[["收到普通群消息", decisionData?.metrics.groupMessagesReceived ?? 0], ["候选窗口", decisionData?.metrics.candidates ?? 0], ["判断调用", decisionData?.metrics.judgments ?? 0], ["计划回复", decisionData?.metrics.planned ?? 0], ["实际发送", decisionData?.metrics.sent ?? 0], ["被拦截", decisionData?.metrics.blocked ?? 0], ["今日已发送", decisionData?.sentToday ?? 0]].map(([label, value]) => <div className="border-t py-2" style={{ borderColor: "var(--hairline)" }} key={label}><span className="text-[#888888]">{label}</span><b className="ml-2 text-white">{value}</b></div>)}</div><div className="max-h-56 space-y-2 overflow-y-auto">{decisionData?.decisions.slice(0, 20).map((item, index) => <div className="flex flex-wrap justify-between gap-2 border-t py-2 text-xs" style={{ borderColor: "var(--hairline)" }} key={`${item.time}-${index}`}><span className="text-[#888888]">{new Date(item.time).toLocaleString()} · {item.groupId}</span><span>{item.result}: {item.reason}</span></div>)}{!decisionData?.decisions.length && <p className="text-xs text-[#888888]">暂无决策记录</p>}</div></section>
  </div></div>;
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
  const [logs, setLogs] = useState<Array<{ time: string; level: "INFO" | "WARN" | "ERROR"; sessionId?: string; text: string }>>([]);
  useEffect(() => { const load = () => { void fetch("/api/logs").then((response) => response.json()).then((data: { logs: typeof logs }) => setLogs(data.logs)).catch(() => {}); }; load(); const timer = window.setInterval(load, 2500); return () => window.clearInterval(timer); }, []);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">运行日志</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">消息记录、事件日志、Agent 执行跟踪与系统日志</p>
          </div>
          <button className="btn-pill-dark" onClick={() => { const blob = new Blob([logs.map((item) => JSON.stringify(item)).join("\n")], { type: "application/x-ndjson" }); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "miubot-runtime.log"; anchor.click(); URL.revokeObjectURL(anchor.href); }}>
            <span>导出日志</span>
          </button>
        </div>

        <div className="sketch-card p-4 font-mono text-[12px] space-y-2">
          {logs.length === 0 && <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>暂无运行日志</p>}
          {logs.map((l, i) => (
            <div key={i} className="flex items-center gap-3 py-1 border-b border-[rgba(255,255,255,0.03)]">
              <span className="shrink-0 text-[#666666]">{new Date(l.time).toLocaleString()}</span>
              <span className={l.level === "ERROR" ? "text-red-400" : l.level === "WARN" ? "text-[#f59e0b]" : "text-[#22c55e]"}>{l.level}</span>
              <span className="max-w-28 shrink-0 truncate text-[#888888]">{l.sessionId ?? "server"}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-white">{l.text}</span>
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
  const [gate, setGate] = useState({ dailyMessageLimit: 0, quietStart: "00:00", quietEnd: "00:00", notifyOnLimit: false });
  const [gateBusy, setGateBusy] = useState(false);
  const [gateNotice, setGateNotice] = useState("");
  useEffect(() => { void fetch("/api/proactive-gate").then((response) => response.json()).then((data: { proactiveGate: typeof gate }) => setGate(data.proactiveGate)).catch(() => setGateNotice("无法读取主动行为限制")); }, []);
  const saveGate = async () => {
    setGateBusy(true); setGateNotice("");
    try { const response = await fetch("/api/proactive-gate", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(gate) }); const data = await response.json() as { proactiveGate?: typeof gate; message?: string }; if (!response.ok || !data.proactiveGate) throw new Error(data.message ?? "保存失败"); setGate(data.proactiveGate); setGateNotice("主动行为限制已保存"); }
    catch (error) { setGateNotice(error instanceof Error ? error.message : String(error)); }
    finally { setGateBusy(false); }
  };
  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div>
          <h1 className="text-[20px] font-bold text-white tracking-tight">设置</h1>
          <p className="text-[13px] text-[#777777] mt-0.5">外观主题、本地存储管理与版本信息</p>
        </div>

        <div className="sketch-card p-5 space-y-3">
          <div className="text-[14px] font-bold text-white">主动行为全局限制</div>
          <p className="text-[12px] text-[#888888]">用于智能插话和主动发起，不影响被 @ 后的正常回复。任一限制命中都会阻止主动消息。</p>
          <label className="block max-w-xs text-[13px] text-[#cccccc]">每日主动消息上限
            <input className="sketch-input mt-1 w-full" type="number" min="0" max="100000" step="1" value={gate.dailyMessageLimit} onChange={(event) => setGate({ ...gate, dailyMessageLimit: Number(event.target.value) })}/>
            <span className="mt-1 block text-[11px] text-[#777777]">按发送的消息条数计；0 表示不限制。</span>
          </label>
          <div className="grid max-w-lg grid-cols-2 gap-3">
            <label className="text-[13px] text-[#cccccc]">静默开始<input className="sketch-input mt-1 w-full" type="time" value={gate.quietStart} onChange={(event) => setGate({ ...gate, quietStart: event.target.value })}/></label>
            <label className="text-[13px] text-[#cccccc]">静默结束<input className="sketch-input mt-1 w-full" type="time" value={gate.quietEnd} onChange={(event) => setGate({ ...gate, quietEnd: event.target.value })}/></label>
          </div>
          <p className="text-[11px] text-[#777777]">起止时间相同表示关闭静默时段；跨午夜时段也支持。按服务器本地时间判断。</p>
          <label className="flex items-center gap-2 text-[13px] text-[#cccccc]"><input type="checkbox" checked={gate.notifyOnLimit} onChange={(event) => setGate({ ...gate, notifyOnLimit: event.target.checked })}/>触发限制时发送提示</label>
          <div className="flex items-center gap-3"><button className="btn-pill-dark" disabled={gateBusy} onClick={() => void saveGate()}>{gateBusy ? "保存中…" : "保存限制"}</button>{gateNotice && <span className="text-xs text-[#aaaaaa]" role="status">{gateNotice}</span>}</div>
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

type ToolEntry = { name: string; label: string; description: string; enabled: boolean };
type SearchProvider = "tavily" | "brave" | "exa" | "serper";
const searchProviders: Array<{ id: SearchProvider; label: string }> = [
  { id: "tavily", label: "Tavily" }, { id: "brave", label: "Brave Search" }, { id: "exa", label: "Exa" }, { id: "serper", label: "Serper" },
];

export function Tools() {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [provider, setProvider] = useState<SearchProvider>("tavily");
  const [configured, setConfigured] = useState<Record<SearchProvider, boolean>>({ tavily: false, brave: false, exa: false, serper: false });
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/tools").then((response) => response.json()).then((data: { tools: ToolEntry[]; webSearch: { provider: SearchProvider; configuredProviders: Record<SearchProvider, boolean> } }) => {
      setTools(data.tools); setProvider(data.webSearch.provider); setConfigured(data.webSearch.configuredProviders);
    }).catch(() => setNotice("无法连接 Miubot Server"));
  }, []);

  const save = async (nextTools: ToolEntry[], nextProvider = provider, key = "") => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: nextTools.filter((item) => item.enabled).map((item) => item.name), webSearch: { provider: nextProvider, apiKeys: key ? { [nextProvider]: key } : {} } }) });
      const data = await response.json() as { tools?: ToolEntry[]; webSearch?: { provider: SearchProvider; configuredProviders: Record<SearchProvider, boolean> }; message?: string };
      if (!response.ok || !data.tools || !data.webSearch) throw new Error(data.message ?? "保存失败");
      setTools(data.tools); setProvider(data.webSearch.provider); setConfigured(data.webSearch.configuredProviders); setApiKey(""); setNotice("配置已保存");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7">
    <div className="max-w-[760px] space-y-4">
      <div><h1 className="text-[20px] font-bold">Tools</h1><p className="text-[13px] text-[#777777] mt-0.5">Pi Agent 工具与网页搜索</p></div>
      {tools.map((tool) => <article key={tool.name} className="sketch-card flex items-center justify-between gap-4 p-4">
        <div className="min-w-0"><div className="font-semibold">{tool.label}<code className="ml-2 text-xs text-[#888888]">{tool.name}</code></div><p className="mt-1 text-xs text-[#888888]">{tool.description}</p>
          {tool.name === "web_search" && <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="sketch-input" aria-label="网页搜索提供商" value={provider} disabled={busy} onChange={(event) => { const next = event.target.value as SearchProvider; setProvider(next); void save(tools, next); }}>
              {searchProviders.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <input className="sketch-input min-w-[200px]" type="password" autoComplete="new-password" placeholder={configured[provider] ? "密钥已保存；留空保留" : `${provider} API Key`} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <button className="btn-pill-dark" disabled={busy || !apiKey.trim()} onClick={() => void save(tools, provider, apiKey.trim())}>保存密钥</button>
            <span className={configured[provider] ? "pill-green" : "pill-gray"}>{configured[provider] ? "已配置" : "未配置"}</span>
          </div>}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm"><input type="checkbox" checked={tool.enabled} disabled={busy} onChange={(event) => { const next = tools.map((item) => item.name === tool.name ? { ...item, enabled: event.target.checked } : item); setTools(next); void save(next); }} />启用</label>
      </article>)}
      {notice && <p className="text-sm text-[#aaaaaa]" role="status">{notice}</p>}
    </div>
  </div>;
}
