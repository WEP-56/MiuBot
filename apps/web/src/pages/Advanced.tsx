import { Slider, Toggle } from "../components/Controls";
import { Icon } from "../components/Icon";
import { PageShell } from "../components/PageShell";
import { useTheme } from "../theme";
import { useEffect, useRef, useState } from "react";
import { changePassword } from "../utils/api";

/* 主动行为页面 */
export function Proactive() {
  type Rule = { enabled: boolean; mode: "smart" | "probability"; probabilityPercent: number; dailyMessageLimit: number; quietStart: string; quietEnd: string; notifyOnLimit: boolean; aggregationSeconds: number; cooldownSeconds: number; judgeProviderId: string; judgeModelId: string };
  type Provider = { id: string; name: string; models: Array<{ id: string; name: string }> };
  type DecisionData = { metrics: { groupMessagesReceived: number; candidates: number; judgments: number; planned: number; sent: number; blocked: number }; sentToday: number; decisions: Array<{ time: string; groupId: string; result: string; reason: string }> };
  const [rule, setRule] = useState<Rule>({ enabled: false, mode: "smart", probabilityPercent: 10, dailyMessageLimit: 0, quietStart: "00:00", quietEnd: "00:00", notifyOnLimit: false, aggregationSeconds: 8, cooldownSeconds: 600, judgeProviderId: "", judgeModelId: "" });
  const [providers, setProviders] = useState<Provider[]>([]); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [decisionData, setDecisionData] = useState<DecisionData | null>(null);
  const refreshDecisions = () => { void fetch("/api/proactive-decisions").then((response) => response.json()).then((data: DecisionData) => setDecisionData(data)).catch(() => {}); };
  useEffect(() => { void fetch("/api/proactive-gate").then((response) => response.json()).then((data: { proactiveGate: Rule; providers: Provider[] }) => { setRule(data.proactiveGate); setProviders(data.providers); }).catch(() => setNotice("无法连接 Miubot Server")); refreshDecisions(); const timer = window.setInterval(refreshDecisions, 5000); return () => window.clearInterval(timer); }, []);
  const provider = providers.find((item) => item.id === rule.judgeProviderId); const models = provider?.models ?? [];
  const save = async (next: Rule) => { setBusy(true); setNotice(""); try { const response = await fetch("/api/proactive-gate", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }); const data = await response.json() as { proactiveGate?: Rule; message?: string }; if (!response.ok || !data.proactiveGate) throw new Error(data.message ?? "保存失败"); setRule(data.proactiveGate); setNotice("智能插话配置已保存"); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <PageShell>
    <div><h1 className="text-[20px] font-bold">主动行为</h1><p className="mt-0.5 text-[13px] text-[#777777]">智能插话策略与全局保护</p></div>
    <section className="sketch-card space-y-4 p-5"><div className="flex items-center justify-between gap-4"><div><h2 className="font-semibold">群聊智能插话</h2><p className="mt-1 text-xs text-[#888888]">仅对启用了“智能插话”的群生效；群级开关默认关闭。</p></div><div className="flex shrink-0 items-center gap-2 text-sm"><Toggle checked={rule.enabled} disabled={busy} onChange={(next) => setRule({ ...rule, enabled: next })} label="全局启用"/><span>全局启用</span></div></div>
      <label className="block text-sm">插话模式<select className="sketch-input mt-1 w-full" value={rule.mode} disabled={busy} onChange={(event) => setRule({ ...rule, mode: event.target.value as Rule["mode"] })}><option value="smart">智能判断（调用判断模型）</option><option value="probability">纯概率（不调用判断模型）</option></select></label>
      {rule.mode === "smart" ? <><label className="block text-sm">判断模型提供商<select className="sketch-input mt-1 w-full" value={rule.judgeProviderId} disabled={busy} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); setRule({ ...rule, judgeProviderId: event.target.value, judgeModelId: next?.models[0]?.id ?? "" }); }}><option value="">选择提供商</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-sm">判断模型<select className="sketch-input mt-1 w-full" value={rule.judgeModelId} disabled={busy || models.length === 0} onChange={(event) => setRule({ ...rule, judgeModelId: event.target.value })}><option value="">选择模型</option>{models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label></> : <label className="block text-sm">每个聚合窗口的插话概率：{rule.probabilityPercent}%<div className="mt-2"><Slider value={rule.probabilityPercent} min={1} max={100} disabled={busy} onChange={(percent) => setRule({ ...rule, probabilityPercent: percent })} label="插话概率"/></div><span className="mt-1 block text-xs text-[#888888]">仅对通过全局限制和群级冷却的窗口抽样。命中后仍会调用聊天模型生成回复，但省去单独的判断模型调用。</span></label>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">聚合窗口（秒）<input className="sketch-input mt-1 w-full" type="number" min="0" max="60" step="1" value={rule.aggregationSeconds} onChange={(event) => setRule({ ...rule, aggregationSeconds: Number(event.target.value) })}/><span className="mt-1 block text-[11px] text-[#777777]">0 = 每条消息立即判断，不做聚合。</span></label>
        <label className="text-sm">群级冷却（秒）<input className="sketch-input mt-1 w-full" type="number" min="0" max="86400" step="1" value={rule.cooldownSeconds} onChange={(event) => setRule({ ...rule, cooldownSeconds: Number(event.target.value) })}/><span className="mt-1 block text-[11px] text-[#777777]">{rule.cooldownSeconds === 0 ? "0 = 不冷却" : rule.cooldownSeconds >= 60 ? `约 ${Math.round(rule.cooldownSeconds / 60)} 分钟` : `${rule.cooldownSeconds} 秒`}</span></label>
      </div>
      <div className="flex items-center gap-3"><button className="btn-pill-dark" disabled={busy} onClick={() => void save(rule)}>{busy ? "保存中…" : "保存智能插话配置"}</button>{notice && <span className="text-xs text-[#aaaaaa]" role="status">{notice}</span>}</div>
    </section>
    <section className="sketch-card space-y-3 p-5"><h2 className="font-semibold">决策记录</h2><div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">{[["收到普通群消息", decisionData?.metrics.groupMessagesReceived ?? 0], ["候选窗口", decisionData?.metrics.candidates ?? 0], ["判断调用", decisionData?.metrics.judgments ?? 0], ["计划回复", decisionData?.metrics.planned ?? 0], ["实际发送", decisionData?.metrics.sent ?? 0], ["被拦截", decisionData?.metrics.blocked ?? 0], ["今日已发送", decisionData?.sentToday ?? 0]].map(([label, value]) => <div className="border-t py-2" style={{ borderColor: "var(--hairline)" }} key={label}><span className="text-[#888888]">{label}</span><b className="ml-2 text-white">{value}</b></div>)}</div><div className="max-h-56 space-y-2 overflow-y-auto">{decisionData?.decisions.slice(0, 20).map((item, index) => <div className="flex flex-wrap justify-between gap-2 border-t py-2 text-xs" style={{ borderColor: "var(--hairline)" }} key={`${item.time}-${index}`}><span className="text-[#888888]">{new Date(item.time).toLocaleString()} · {item.groupId}</span><span>{item.result}: {item.reason}</span></div>)}{!decisionData?.decisions.length && <p className="text-xs text-[#888888]">暂无决策记录</p>}</div></section>
  </PageShell>;
}

/* MCP 页面 */
export function MCP() {
  type Server = { id: string; name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; enabled: boolean; state: "disconnected" | "connecting" | "connected" | "error"; error?: string; toolCount: number; toolNames: string[] };
  type Draft = { id: string; name: string; transport: "stdio" | "http"; command: string; args: string; url: string };
  const emptyDraft = (): Draft => ({ id: "", name: "", transport: "stdio", command: "", args: "[]", url: "" });
  const [servers, setServers] = useState<Server[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch("/api/mcp");
    const data = await response.json() as { servers: Server[] };
    if (!response.ok) throw new Error("读取 MCP 服务器失败");
    setServers(data.servers);
  };
  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, []);
  const save = async (next: Server[]) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ servers: next }) });
      const data = await response.json() as { servers?: Server[]; message?: string };
      if (!response.ok || !data.servers) throw new Error(data.message ?? "保存 MCP 配置失败");
      setServers(data.servers); setNotice("MCP 配置已保存");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const add = async () => {
    let args: string[] = [];
    try { const parsed: unknown = JSON.parse(draft.args); if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(); args = parsed; }
    catch { setNotice("启动参数必须是 JSON 字符串数组"); return; }
    const server: Server = { id: draft.id.trim(), name: draft.name.trim(), transport: draft.transport, enabled: true, state: "disconnected", toolCount: 0, toolNames: [], ...(draft.transport === "stdio" ? { command: draft.command.trim(), args } : { url: draft.url.trim() }) };
    await save([...servers, server]);
    setDraft(emptyDraft()); setAdding(false);
  };
  const statusLabel: Record<Server["state"], string> = { connected: "已连接", connecting: "连接中", disconnected: "已断开", error: "连接失败" };
  return <PageShell>
    <div className="flex items-start justify-between gap-4"><div><h1 className="text-[20px] font-bold">MCP</h1><p className="mt-0.5 text-[13px] text-[#777777]">连接外部工具服务器；工具是否可调用由高级配置中的全局开关控制。</p></div><button className="btn-primary-white shrink-0" disabled={busy} onClick={() => setAdding(!adding)}><Icon.Plus size={14}/><span>添加服务器</span></button></div>
    {adding && <section className="sketch-card space-y-3 p-5"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">服务器 ID<input className="sketch-input mt-1 w-full" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="filesystem"/></label><label className="text-sm">名称<input className="sketch-input mt-1 w-full" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Filesystem"/></label><label className="text-sm">传输方式<select className="sketch-input mt-1 w-full" value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as Draft["transport"] })}><option value="stdio">本地进程 (stdio)</option><option value="http">Streamable HTTP</option></select></label>
      {draft.transport === "stdio" ? <><label className="text-sm">启动命令<input className="sketch-input mt-1 w-full" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx.cmd"/></label><label className="text-sm sm:col-span-2">参数（JSON 字符串数组）<textarea className="sketch-input mt-1 min-h-20 w-full" value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })}/></label></> : <label className="text-sm sm:col-span-2">服务器 URL<input className="sketch-input mt-1 w-full" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example.com/mcp"/></label>}</div><div className="flex gap-2"><button className="btn-pill-dark" disabled={busy} onClick={() => void add()}>保存并连接</button><button className="btn-pill-dark" disabled={busy} onClick={() => { setAdding(false); setDraft(emptyDraft()); }}>取消</button></div></section>}
    {servers.length === 0 && <p className="sketch-card p-6 text-center text-sm text-[#888888]">尚未配置 MCP 服务器</p>}
    {servers.map((server) => <article key={server.id} className="sketch-card space-y-3 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="font-semibold">{server.name}<code className="ml-2 text-xs text-[#888888]">{server.id}</code></h2><p className="mt-1 break-all text-xs text-[#888888]">{server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}</p></div><div className="flex items-center gap-3"><span className={server.state === "connected" ? "pill-green" : server.state === "error" ? "pill-red" : "pill-gray"}>{statusLabel[server.state]}</span><div className="flex items-center gap-2 text-sm"><Toggle checked={server.enabled} disabled={busy} onChange={(next) => void save(servers.map((item) => item.id === server.id ? { ...item, enabled: next } : item))} label={"启用 " + server.name}/><span>启用</span></div></div></div>
      {server.error && <p className="text-xs text-red-400" role="alert">{server.error}</p>}{server.toolNames.length > 0 && <div className="border-t pt-3 text-xs text-[#888888]" style={{ borderColor: "var(--hairline)" }}>发现 {server.toolCount} 个工具：{server.toolNames.join("、")}</div>}
      <div className="flex justify-end"><button className="text-xs text-red-400 hover:text-red-300" disabled={busy} onClick={() => void save(servers.filter((item) => item.id !== server.id))}>删除服务器</button></div>
    </article>)}
    {notice && <p className="text-sm text-[#aaaaaa]" role="status">{notice}</p>}
  </PageShell>;
}

/* Skills 页面 */
export function Skills() {
  type Skill = { name: string; description: string; filePath: string; baseDir: string; disableModelInvocation: boolean };
  const [skills, setSkills] = useState<Skill[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const zipInput = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = async () => {
    const response = await fetch("/api/skills");
    const data = await response.json() as { skills?: Skill[]; enabled?: boolean; message?: string };
    if (!response.ok || !data.skills) throw new Error(data.message ?? "读取 Skills 失败");
    setSkills(data.skills); setEnabled(data.enabled === true);
  };
  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, []);
  const install = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl: sourceUrl.trim() }) });
      const data = await response.json() as { skills?: Skill[]; message?: string };
      if (!response.ok || !data.skills) throw new Error(data.message ?? "安装 Skill 失败");
      setSkills(data.skills); setSourceUrl(""); setAdding(false); setNotice("Skill 已安装");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const importZip = async (file: File) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/skills/import", { method: "POST", headers: { "content-type": "application/zip" }, body: await file.arrayBuffer() });
      const data = await response.json() as { skills?: Skill[]; message?: string };
      if (!response.ok || !data.skills) throw new Error(data.message ?? "导入 ZIP 失败");
      setSkills(data.skills); setNotice(`已导入 ${file.name}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); if (zipInput.current) zipInput.current.value = ""; }
  };
  const remove = async (skill: Skill) => {
    if (!window.confirm(`删除 Skill ${skill.name}？`)) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      const data = await response.json() as { skills?: Skill[]; message?: string };
      if (!response.ok || !data.skills) throw new Error(data.message ?? "删除 Skill 失败");
      setSkills(data.skills); setNotice("Skill 已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <PageShell>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-[20px] font-bold">Skills</h1><p className="mt-0.5 text-[13px] text-[#777777]">管理已安装的 Agent 专属技能</p></div><div className="flex flex-wrap items-center gap-2"><span className={enabled ? "pill-green" : "pill-gray"}>{enabled ? "全局已启用" : "全局未启用"}</span><button className="btn-pill-dark" title="刷新" aria-label="刷新 Skills" disabled={busy} onClick={() => void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}><Icon.Refresh size={14}/></button><input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importZip(file); }}/><button className="btn-pill-dark" disabled={busy} onClick={() => zipInput.current?.click()}>导入 ZIP</button><button className="btn-primary-white" disabled={busy} onClick={() => setAdding(!adding)}><Icon.Plus size={14}/><span>从 GitHub 安装</span></button></div></div>
    {adding && <section className="sketch-card space-y-3 p-5"><label className="block text-sm">GitHub 技能目录 URL<input className="sketch-input mt-1 w-full" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills/my-skill" /></label><p className="text-xs text-[#888888]">目录必须包含一个 SKILL.md；安装后保存到 Agent Skills 目录。</p><div className="flex gap-2"><button className="btn-pill-dark" disabled={busy || !sourceUrl.trim()} onClick={() => void install()}>安装</button><button className="btn-pill-dark" disabled={busy} onClick={() => { setAdding(false); setSourceUrl(""); }}>取消</button></div></section>}
    {skills.length === 0 ? <p className="sketch-card p-6 text-center text-sm text-[#888888]">暂无已安装 Skill</p> : <div className="space-y-3">{skills.map((skill) => <article key={`${skill.name}-${skill.filePath}`} className="sketch-card flex flex-wrap items-start justify-between gap-4 p-5"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-bold">{skill.name}</span>{skill.disableModelInvocation ? <span className="pill-gray">仅手动调用</span> : <span className="pill-green">可自动发现</span>}</div><p className="mt-1 text-sm text-[#888888]">{skill.description}</p><p className="mt-2 break-all text-xs text-[#666666]">{skill.filePath}</p></div><button className="btn-pill-dark text-red-400" disabled={busy} onClick={() => void remove(skill)}>删除</button></article>)}</div>}
    {notice && <p className="text-sm text-[#aaaaaa]" role="status">{notice}</p>}
  </PageShell>;
}

/* 记忆与知识库 */
export function Memory() {
  type Memory = { enabled: boolean; dreamEnabled: boolean; dreamIntervalHours: number; dreamProviderId: string; dreamModelId: string; dreamNextRunAt?: string; dreamLastRunAt?: string; dreamLastStatus?: "running" | "success" | "error"; dreamLastError?: string };
  type Peer = { botId: string; botName: string; scope: "group" | "c2c"; peerId: string; name: string; memory: Memory };
  type Entry = { id: string; area: "shared" | "personal"; category: "user" | "feedback" | "project" | "reference"; title: string; content: string; createdAt: string; updatedAt: string; ownerOpenId?: string; memberName?: string };
  type Draft = { id: string; area: Entry["area"]; category: Entry["category"]; title: string; content: string; ownerOpenId: string; memberName: string };
  const emptyDraft = (scope: Peer["scope"] = "group"): Draft => ({ id: "", area: scope === "group" ? "shared" : "personal", category: "user", title: "", content: "", ownerOpenId: "", memberName: "" });
  const [peers, setPeers] = useState<Peer[]>([]); const [selectedKey, setSelectedKey] = useState(""); const [entries, setEntries] = useState<Entry[]>([]);
  const [prompt, setPrompt] = useState(""); const [draft, setDraft] = useState<Draft | null>(null); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const selected = peers.find((peer) => `${peer.botId}:${peer.scope}:${peer.peerId}` === selectedKey);
  const [providerOptions, setProviderOptions] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([]);
  const selectedProvider = providerOptions.find((provider) => provider.id === selected?.memory.dreamProviderId);
  const identity = selected ? { botId: selected.botId, scope: selected.scope, peerId: selected.peerId } : undefined;
  const keyOf = (peer: Peer) => `${peer.botId}:${peer.scope}:${peer.peerId}`;
  const load = async () => {
    const response = await fetch("/api/memory"); const data = await response.json() as { prompt: string; peers: Peer[] };
    if (!response.ok) throw new Error("无法读取长期记忆配置"); setPrompt(data.prompt); setPeers(data.peers); setSelectedKey((current) => current || (data.peers[0] ? keyOf(data.peers[0]) : ""));
  };
  const loadEntries = async (peer: Peer) => {
    const query = new URLSearchParams({ botId: peer.botId, scope: peer.scope, peerId: peer.peerId });
    const response = await fetch(`/api/memory/document?${query}`); const data = await response.json() as { entries?: Entry[]; message?: string };
    if (!response.ok) throw new Error(data.message ?? "读取记忆失败"); setEntries(data.entries ?? []);
  };
  useEffect(() => { void load().catch((error) => setNotice(String(error))); }, []);
  useEffect(() => { if (!selected) { setEntries([]); return; } void loadEntries(selected).catch((error) => setNotice(String(error))); }, [selectedKey]);
  const savePrompt = async () => {
    setBusy(true); setNotice("");
    try { const response = await fetch("/api/memory/prompt", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) }); const data = await response.json() as { message?: string }; if (!response.ok) throw new Error(data.message ?? "保存 Prompt 失败"); setNotice("长期记忆 Prompt 已保存"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const saveEntry = async () => {
    if (!selected || !identity || !draft) return; setBusy(true); setNotice("");
    try { const response = await fetch("/api/memory/entry", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, ...draft }) }); const data = await response.json() as { message?: string }; if (!response.ok) throw new Error(data.message ?? "保存记忆失败"); setDraft(null); await loadEntries(selected); setNotice("记忆条目已保存"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const deleteEntry = async (entry: Entry) => {
    if (!selected || !identity || !window.confirm(`删除记忆「${entry.title}」？`)) return; setBusy(true);
    try { const response = await fetch("/api/memory/entry", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...identity, id: entry.id }) }); if (!response.ok) throw new Error("删除记忆失败"); await loadEntries(selected); setNotice("记忆条目已删除"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const savePeerMemory = async () => {
    if (!selected || !identity) return; setBusy(true); setNotice("");
    try {
      const query = new URLSearchParams(identity); const current = await fetch(`/api/peer-config?${query}`); const details = await current.json() as { config?: Record<string, unknown>; providers?: typeof providerOptions; message?: string };
      if (!current.ok || !details.config) throw new Error(details.message ?? "读取对象配置失败");
      setProviderOptions(details.providers ?? []);
      const response = await fetch("/api/peer-config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...details.config, memory: selected.memory }) });
      const result = await response.json() as { message?: string }; if (!response.ok) throw new Error(result.message ?? "保存对象记忆配置失败"); await load(); setNotice("对象记忆配置已保存");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const runDream = async () => {
    if (!identity || !selected) return; setBusy(true); setNotice("");
    try { const response = await fetch("/api/memory/dream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(identity) }); const data = await response.json() as { message?: string }; if (!response.ok) throw new Error(data.message ?? "记忆整理失败"); await load(); await loadEntries(selected); setNotice("后台记忆整理完成"); }
    catch (error) { await load().catch(() => {}); setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const clearDocument = async () => {
    if (!identity || !selected || !window.confirm(`删除「${selected.name}」的全部长期记忆？`)) return; setBusy(true);
    try { const response = await fetch("/api/memory/document", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(identity) }); if (!response.ok) throw new Error("清空长期记忆失败"); setEntries([]); setDraft(null); setNotice("该对象的长期记忆已清空"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  return <PageShell>
    <div><h1 className="text-[20px] font-bold">长期记忆</h1><p className="mt-0.5 text-[13px] text-[#777777]">按 Bot 与 QQ 对象隔离的 Markdown 记忆、成员摘要和后台整理</p></div>
    <section className="sketch-card space-y-3 p-5"><div><h2 className="font-semibold">长期记忆行为 Prompt</h2><p className="mt-1 text-xs text-[#888888]">只指导记忆保存策略；记忆正文会作为不可信历史资料单独注入。</p></div><textarea className="sketch-input min-h-40 w-full" value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)}/><button className="btn-pill-dark" disabled={busy} onClick={() => void savePrompt()}>保存 Prompt</button></section>
    <section className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]"><aside className="sketch-card max-h-[650px] overflow-y-auto p-2"><h2 className="px-3 py-2 text-sm font-semibold">对象 · {peers.length}</h2>{peers.length ? peers.map((peer) => <button key={keyOf(peer)} className={`mb-1 w-full rounded-lg border p-3 text-left ${selectedKey === keyOf(peer) ? "bg-[var(--bg-active)]" : "bg-transparent"}`} style={{ borderColor: selectedKey === keyOf(peer) ? "var(--border-strong)" : "transparent" }} onClick={() => { setSelectedKey(keyOf(peer)); setDraft(null); }}><span className="block truncate text-sm font-medium">{peer.name}</span><span className="mt-1 block text-xs text-[#888888]">{peer.botName} · {peer.scope === "group" ? "群聊" : "私聊"}</span><span className="mt-1 block truncate font-mono text-[10px] text-[#777777]">{peer.peerId}</span><span className={peer.memory.enabled ? "pill-green mt-2" : "pill-gray mt-2"}>{peer.memory.enabled ? "已启用" : "已停用"}</span></button>) : <p className="p-3 text-sm text-[#888888]">还没有 QQ 对象；收到消息或在会话页添加对象后会显示在这里。</p>}</aside>
      {selected ? <div className="space-y-4">
        <section className="sketch-card space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{selected.name}</h2><p className="mt-1 break-all font-mono text-[11px] text-[#888888]">{selected.botName} · {selected.scope} · {selected.peerId}</p></div><button className="btn-pill-dark text-red-400" disabled={busy} onClick={() => void clearDocument()}>清空记忆</button></div>
          <label className="flex items-center gap-2 text-sm"><Toggle checked={selected.memory.enabled} disabled={busy} onChange={(enabled) => setPeers((current) => current.map((peer) => keyOf(peer) === selectedKey ? { ...peer, memory: { ...peer.memory, enabled } } : peer))} label="启用长期记忆"/><span>启用记忆注入与读写</span></label>
          <div className="border-t pt-3" style={{ borderColor: "var(--hairline)" }}><label className="flex items-center gap-2 text-sm"><Toggle checked={selected.memory.dreamEnabled} disabled={busy || !selected.memory.enabled} onChange={(dreamEnabled) => setPeers((current) => current.map((peer) => keyOf(peer) === selectedKey ? { ...peer, memory: { ...peer.memory, dreamEnabled } } : peer))} label="后台整理"/><span>后台记忆整理</span></label>
            <p className="mt-1 text-xs text-[#888888]">闲时运行，只整理现有记忆文件，不读取会话记录，也不会向 QQ 发送内容。</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs">整理间隔（小时）<input className="sketch-input mt-1 w-full" type="number" min="1" max="8760" value={selected.memory.dreamIntervalHours} disabled={busy || !selected.memory.enabled} onChange={(event) => setPeers((current) => current.map((peer) => keyOf(peer) === selectedKey ? { ...peer, memory: { ...peer.memory, dreamIntervalHours: Number(event.target.value) } } : peer))}/></label><label className="text-xs">整理模型提供商<select className="sketch-input mt-1 w-full" value={selected.memory.dreamProviderId} disabled={busy || !selected.memory.enabled} onFocus={() => { if (providerOptions.length) return; const query = new URLSearchParams(identity!); void fetch(`/api/peer-config?${query}`).then((response) => response.json()).then((data: { providers?: typeof providerOptions }) => setProviderOptions(data.providers ?? [])); }} onChange={(event) => { const provider = providerOptions.find((item) => item.id === event.target.value); setPeers((current) => current.map((peer) => keyOf(peer) === selectedKey ? { ...peer, memory: { ...peer.memory, dreamProviderId: event.target.value, dreamModelId: provider?.models[0]?.id ?? "" } } : peer)); }}><option value="">选择提供商</option>{providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>{selected.memory.dreamProviderId && <label className="text-xs">整理模型<select className="sketch-input mt-1 w-full" value={selected.memory.dreamModelId} disabled={busy || !selected.memory.enabled} onChange={(event) => setPeers((current) => current.map((peer) => keyOf(peer) === selectedKey ? { ...peer, memory: { ...peer.memory, dreamModelId: event.target.value } } : peer))}><option value="">选择模型</option>{selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label>}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2"><button className="btn-pill-dark" disabled={busy} onClick={() => void savePeerMemory()}>保存对象设置</button><button className="btn-pill-dark" disabled={busy || !selected.memory.enabled} onClick={() => void runDream()}>立即整理</button><span className="text-xs text-[#888888]">{selected.memory.dreamLastStatus === "running" ? "正在整理…" : selected.memory.dreamLastStatus === "success" ? `最近完成：${selected.memory.dreamLastRunAt ? new Date(selected.memory.dreamLastRunAt).toLocaleString() : ""}` : selected.memory.dreamLastStatus === "error" ? `上次失败：${selected.memory.dreamLastError || "未知错误"}` : "尚无整理记录"}</span></div>
          </div>
        </section>
        <section className="sketch-card space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">记忆条目 · {entries.length}</h2><p className="mt-1 text-xs text-[#888888]">群共享记忆和成员摘要保存在同一个文件中，注入时按当前发言者过滤。</p></div><button className="btn-pill-dark" onClick={() => setDraft(emptyDraft(selected.scope))}>新增条目</button></div>
          {draft && <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: "var(--hairline)" }}><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">记忆区域<select className="sketch-input mt-1 w-full" value={selected.scope === "c2c" ? "personal" : draft.area} disabled={selected.scope === "c2c"} onChange={(event) => setDraft({ ...draft, area: event.target.value as Draft["area"] })}>{selected.scope === "group" && <option value="shared">群共享</option>}<option value="personal">成员 / 私聊对象</option></select></label><label className="text-xs">类型<select className="sketch-input mt-1 w-full" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as Draft["category"] })}><option value="user">用户 / 偏好</option><option value="feedback">反馈 / 已验证做法</option><option value="project">持续背景 / 事件</option><option value="reference">资料指针</option></select></label></div>{selected.scope === "group" && draft.area === "personal" && <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">成员 OpenID<input className="sketch-input mt-1 w-full" value={draft.ownerOpenId} onChange={(event) => setDraft({ ...draft, ownerOpenId: event.target.value })}/></label><label className="text-xs">当前显示名<input className="sketch-input mt-1 w-full" value={draft.memberName} onChange={(event) => setDraft({ ...draft, memberName: event.target.value })}/></label></div>}<label className="block text-xs">标题<input className="sketch-input mt-1 w-full" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label><label className="block text-xs">内容<textarea className="sketch-input mt-1 min-h-24 w-full" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })}/>{selected.scope === "group" && draft.area === "personal" && <span className="mt-1 block text-[11px] text-[#888888]">群成员摘要最多 60 个字符。</span>}</label><div className="flex gap-2"><button className="btn-pill-dark" disabled={busy} onClick={() => void saveEntry()}>保存条目</button><button className="btn-pill-dark" disabled={busy} onClick={() => setDraft(null)}>取消</button></div></div>}
          {entries.length ? <div className="space-y-2">{entries.map((entry) => <article key={entry.id} className="rounded-lg border p-3" style={{ borderColor: "var(--hairline)" }}><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-medium">{entry.title}</h3><div className="mt-1 text-[11px] text-[#888888]">{entry.area === "shared" ? "群共享" : selected.scope === "group" ? "成员摘要" : "私聊对象"} · {entry.category}{entry.ownerOpenId ? ` · ${entry.memberName ?? "未知成员"} (${entry.ownerOpenId})` : ""}</div></div><div className="flex gap-2"><button className="btn-pill-dark !px-2 !py-1 text-xs" onClick={() => setDraft({ id: entry.id, area: entry.area, category: entry.category, title: entry.title, content: entry.content, ownerOpenId: entry.ownerOpenId ?? "", memberName: entry.memberName ?? "" })}>编辑</button><button className="btn-pill-dark !px-2 !py-1 text-xs text-red-400" disabled={busy} onClick={() => void deleteEntry(entry)}>删除</button></div></div><p className="mt-2 whitespace-pre-wrap text-sm text-[#aaaaaa]">{entry.content}</p><div className="mt-2 text-[10px] text-[#666666]">更新于 {new Date(entry.updatedAt).toLocaleString()}</div></article>)}</div> : <p className="py-6 text-center text-sm text-[#888888]">该对象还没有记忆条目</p>}
        </section>
      </div> : <div className="sketch-card p-6 text-sm text-[#888888]">请选择一个对象。对象记忆由会话消息自动建立，也可以在会话页添加。</div>}
    </section>
    {notice && <p className="text-sm text-[#aaaaaa]" role="status">{notice}</p>}
  </PageShell>;
}

/* 定时任务 */
export function Scheduler() {
  type Schedule = { type: "once"; runAt: string } | { type: "interval"; intervalMinutes: number } | { type: "range"; minMinutes: number; maxMinutes: number } | { type: "daily"; time: string; timezone: string };
  type Session = { id: string; title: string; scope: string; peerName: string; peerId: string; botId: string; tools: string[] };
  type Task = { id: string; name: string; prompt: string; sessionId: string; schedule: Schedule; allowedTools: string[]; enabled: boolean; nextRunAt: string; lastStatus?: string; lastError?: string };
  const [tasks, setTasks] = useState<Task[]>([]); const [sessions, setSessions] = useState<Session[]>([]); const [creating, setCreating] = useState(false); const [notice, setNotice] = useState("");
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [sessionId, setSessionId] = useState(""); const [kind, setKind] = useState<Schedule["type"]>("interval"); const [minutes, setMinutes] = useState(30); const [maxMinutes, setMaxMinutes] = useState(120); const [runAt, setRunAt] = useState(""); const [dailyTime, setDailyTime] = useState("09:00"); const [timezone, setTimezone] = useState("Asia/Shanghai"); const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const selected = sessions.find((item) => item.id === sessionId);
  const load = async () => { const response = await fetch("/api/scheduler"); const data = await response.json() as { tasks: Task[]; sessions: Session[] }; if (!response.ok) throw new Error("无法读取定时任务"); setTasks(data.tasks); setSessions(data.sessions); setSessionId((current) => current || data.sessions[0]?.id || ""); };
  useEffect(() => { void load().catch((error) => setNotice(String(error))); }, []);
  const create = async () => { setNotice(""); try { let schedule: Schedule; if (kind === "once") schedule = { type: kind, runAt: new Date(runAt).toISOString() }; else if (kind === "daily") schedule = { type: kind, time: dailyTime, timezone }; else if (kind === "range") schedule = { type: kind, minMinutes: minutes, maxMinutes }; else schedule = { type: kind, intervalMinutes: minutes }; const response = await fetch("/api/scheduler", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, prompt, sessionId, schedule, allowedTools }) }); const data = await response.json() as { message?: string }; if (!response.ok) throw new Error(data.message ?? "创建失败"); setCreating(false); setName(""); setPrompt(""); setAllowedTools([]); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } };
  const mutate = async (task: Task, action: "toggle" | "delete") => { const response = action === "delete" ? await fetch(`/api/scheduler/${task.id}`, { method: "DELETE" }) : await fetch(`/api/scheduler/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !task.enabled }) }); const data = await response.json() as { message?: string }; if (!response.ok) setNotice(data.message ?? "操作失败"); else await load(); };
  const formatRule = (schedule: Schedule) => schedule.type === "once" ? `单次 · ${new Date(schedule.runAt).toLocaleString()}` : schedule.type === "interval" ? `每 ${schedule.intervalMinutes} 分钟` : schedule.type === "range" ? `每 ${schedule.minMinutes}–${schedule.maxMinutes} 分钟随机` : `每天 ${schedule.time} · ${schedule.timezone}`;
  return <PageShell>
    <div className="flex items-start justify-between gap-4"><div><h1 className="text-[20px] font-bold">定时任务</h1><p className="mt-0.5 text-[13px] text-[#777777]">绑定会话运行 Agent，并向对应 QQ 对象发送回复</p></div><button className="btn-primary-white shrink-0" onClick={() => setCreating(!creating)}><Icon.Plus size={14}/><span>新建任务</span></button></div>
    {notice && <div role="status" className="text-sm text-amber-300">{notice}</div>}
    {creating && <section className="sketch-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2"><label className="text-sm">任务名称<input className="sketch-input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="text-sm">绑定会话<select className="sketch-input mt-1 w-full" value={sessionId} onChange={(e) => { setSessionId(e.target.value); setAllowedTools([]); }}><option value="">选择会话</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.title} · {s.peerName} ({s.scope === "group" ? "群" : "私聊"})</option>)}</select></label></div>
      <label className="block text-sm">执行 Prompt<textarea className="sketch-input mt-1 min-h-24 w-full" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
      <div className="grid gap-3 md:grid-cols-3"><label className="text-sm">规则<select className="sketch-input mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value as Schedule["type"])}><option value="once">单次</option><option value="interval">固定间隔</option><option value="range">随机间隔范围</option><option value="daily">每天指定时间</option></select></label>{kind === "once" ? <label className="text-sm">执行时间<input className="sketch-input mt-1 w-full" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} /></label> : kind === "daily" ? <><label className="text-sm">每天时间<input className="sketch-input mt-1 w-full" type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} /></label><label className="text-sm">时区<input className="sketch-input mt-1 w-full" value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label></> : <><label className="text-sm">{kind === "range" ? "最小分钟" : "间隔分钟"}<input className="sketch-input mt-1 w-full" type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>{kind === "range" && <label className="text-sm">最大分钟<input className="sketch-input mt-1 w-full" type="number" min={minutes} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} /></label>}</>}</div>
      <fieldset><legend className="text-sm">任务可用 Tools</legend>{selected?.tools.length ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{selected.tools.map((tool) => <label key={tool} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowedTools.includes(tool)} onChange={(e) => setAllowedTools(e.target.checked ? [...allowedTools, tool] : allowedTools.filter((item) => item !== tool))}/>{tool}</label>)}</div> : <p className="mt-1 text-xs text-[#888888]">该会话没有可授权的 Tools</p>}</fieldset>
      <div className="flex justify-end gap-2"><button className="btn-pill-dark" onClick={() => setCreating(false)}>取消</button><button className="btn-primary-white" disabled={!name.trim() || !prompt.trim() || !sessionId} onClick={() => void create()}>创建</button></div>
    </section>}
    <section className="space-y-2">{tasks.length === 0 ? <div className="py-8 text-center text-sm text-[#888888]">暂无定时任务</div> : tasks.map((task) => { const session = sessions.find((item) => item.id === task.sessionId); return <article key={task.id} className="sketch-card flex flex-wrap items-start justify-between gap-3 p-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{task.name}</h2><span className={task.enabled ? "pill-green" : "pill-gray"}>{task.enabled ? "启用" : "暂停"}</span></div><div className="mt-1 text-xs text-[#888888]">{formatRule(task.schedule)} · {session?.peerName ?? task.sessionId} · 下次 {new Date(task.nextRunAt).toLocaleString()}</div><p className="mt-2 whitespace-pre-wrap text-sm">{task.prompt}</p>{task.lastError && <p className="mt-1 text-xs text-red-400">上次失败：{task.lastError}</p>}</div><div className="flex gap-2"><button className="btn-pill-dark" onClick={() => void mutate(task, "toggle")}>{task.enabled ? "暂停" : "恢复"}</button><button className="btn-pill-dark text-red-400" onClick={() => { if (window.confirm(`删除任务“${task.name}”？`)) void mutate(task, "delete"); }}>删除</button></div></article>; })}</section>
  </PageShell>;
}

/* 运行日志 / 审计日志 */
export function Logs() {
  const [tab, setTab] = useState<"runtime" | "audit">("runtime");
  const [logs, setLogs] = useState<Array<{ time: string; level: "INFO" | "WARN" | "ERROR"; sessionId?: string; text: string }>>([]);
  const [entries, setEntries] = useState<Array<{ at: string; action: string; actor: string; detail: string }>>([]);
  useEffect(() => {
    if (tab !== "runtime") return;
    const load = () => { void fetch("/api/logs").then((response) => response.json()).then((data: { logs: typeof logs }) => setLogs(data.logs)).catch(() => {}); };
    load();
    const timer = window.setInterval(load, 2500);
    return () => window.clearInterval(timer);
  }, [tab]);
  useEffect(() => {
    if (tab !== "audit") return;
    const load = () => { void fetch("/api/audit?limit=200").then((response) => response.json()).then((data: { entries: typeof entries }) => setEntries(data.entries)).catch(() => {}); };
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [tab]);

  return (
    <PageShell>
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">{tab === "runtime" ? "运行日志" : "审计日志"}</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">{tab === "runtime" ? "消息记录、事件日志、Agent 执行跟踪与系统日志" : "登录、改密与所有变更类管理请求；与运行日志分开存放，不会被日常日志冲掉"}</p>
          </div>
          {tab === "runtime" && (
            <button className="btn-pill-dark" onClick={() => { const blob = new Blob([logs.map((item) => JSON.stringify(item)).join("\n")], { type: "application/x-ndjson" }); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "miubot-runtime.log"; anchor.click(); URL.revokeObjectURL(anchor.href); }}>
              <span>导出日志</span>
            </button>
          )}
        </div>

        <div className="flex gap-2">
          <button className={`btn-pill-dark${tab === "runtime" ? " active" : ""}`} onClick={() => setTab("runtime")}>运行日志</button>
          <button className={`btn-pill-dark${tab === "audit" ? " active" : ""}`} onClick={() => setTab("audit")}>审计日志</button>
        </div>

        {tab === "runtime" ? (
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
        ) : (
          <div className="sketch-card p-4 text-[12px] space-y-2">
            {entries.length === 0 && <p className="py-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>暂无审计记录</p>}
            {entries.map((entry, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 py-1 border-b border-[rgba(255,255,255,0.03)]">
                <span className="shrink-0 font-mono text-[#666666]">{new Date(entry.at).toLocaleString()}</span>
                <span className={entry.action.includes("failed") || entry.action.includes("locked") ? "text-[#f59e0b]" : "text-[#22c55e]"}>{entry.action}</span>
                <span className="min-w-0 flex-1 break-all text-white">{entry.detail}</span>
              </div>
            ))}
            <p className="pt-2 text-[11px] text-[#666666]">文件：数据目录下的 audit.log（JSON Lines，10 MB × 3 轮转）。</p>
          </div>
        )}
      </PageShell>
  );
}

/* 管理员口令：管理面唯一的凭据，改完立刻让其他会话失效 */
function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    if (next !== confirm) { setNotice("两次输入的新口令不一致"); return; }
    setBusy(true); setNotice("");
    const result = await changePassword(current, next);
    setBusy(false);
    if (!result.ok) { setNotice(result.message); return; }
    setCurrent(""); setNext(""); setConfirm("");
    setNotice("口令已更新，其他已登录会话已作废");
  };
  return (
    <div className="sketch-card p-5 space-y-3">
      <div className="text-[14px] font-bold text-white">管理员口令</div>
      <p className="text-[12px] text-[#888888]">口令散列保存在数据目录的 admin-password。修改后其他浏览器上的会话立即失效，当前会话保留。</p>
      <div className="grid max-w-lg gap-3 sm:grid-cols-3">
        <label className="text-[13px] text-[#cccccc]">当前口令<input className="sketch-input mt-1 w-full" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)}/></label>
        <label className="text-[13px] text-[#cccccc]">新口令<input className="sketch-input mt-1 w-full" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)}/></label>
        <label className="text-[13px] text-[#cccccc]">确认新口令<input className="sketch-input mt-1 w-full" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)}/></label>
      </div>
      <p className="text-[11px] text-[#777777]">至少 8 位，且不能与当前口令相同。</p>
      <div className="flex items-center gap-3"><button className="btn-pill-dark" disabled={busy || !current || !next} onClick={() => void save()}>{busy ? "保存中…" : "修改口令"}</button>{notice && <span className="text-xs text-[#aaaaaa]" role="status">{notice}</span>}</div>
    </div>
  );
}

/* 版本与更新检查：只提示，不自动升级 */
type UpdateStatus = {
  enabled: boolean;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
};

function VersionCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (refresh: boolean) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/system/update${refresh ? "?refresh=1" : ""}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus(await response.json() as UpdateStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  useEffect(() => { void load(false); }, []);
  const headline = !status ? "读取中…" : status.enabled === false ? "更新检查已关闭" : status.updateAvailable ? `有新版本 v${status.latest}` : "已是最新版本";
  return (
    <div className="sketch-card p-5 space-y-3">
      <div className="text-[14px] font-bold text-white">版本与更新</div>
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-[#cccccc]">
        <span className="pill-gray">当前 v{status?.current ?? "…"}</span>
        <span className={status?.updateAvailable ? "pill-green" : "text-[#888888]"}>{headline}</span>
      </div>
      {status?.updateAvailable && (
        <div className="space-y-1 text-[12px] text-[#888888]">
          <p>升级不会自动进行：这套系统的升级等于换掉正在跑的代码，由你决定时机。</p>
          <p className="font-mono text-[11.5px] text-[#aaaaaa]">docker compose pull &amp;&amp; docker compose up -d　/　git pull &amp;&amp; systemctl restart miubot</p>
          {status.url && <a className="text-[#22c55e] underline" href={status.url} target="_blank" rel="noreferrer">查看发布说明</a>}
        </div>
      )}
      {status?.enabled === false && <p className="text-[12px] text-[#888888]">MIUBOT_UPDATE_CHECK=0：进程不会向 GitHub 发起任何请求。</p>}
      {status?.error && <p className="text-[12px] text-[#f59e0b]">检查失败：{status.error}</p>}
      {error && <p className="text-[12px] text-[#f59e0b]">无法读取版本信息：{error}</p>}
      <div className="flex items-center gap-3">
        <button className="btn-pill-dark" disabled={busy || status?.enabled === false} onClick={() => void load(true)}>{busy ? "检查中…" : "检查更新"}</button>
        {status?.checkedAt && <span className="text-[11px] text-[#777777]">上次检查：{new Date(status.checkedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}

/* 入站白名单：谁能触发 Agent。空 = 不限制 */
function AccessCard() {
  const [text, setText] = useState("");
  const [source, setSource] = useState<"env" | "config">("config");
  const [peers, setPeers] = useState<Array<{ scope: string; peerId: string; name: string }>>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [access, peerList] = await Promise.all([
      fetch("/api/access").then((response) => response.json() as Promise<{ allowedPeers: string[]; source: "env" | "config" }>),
      fetch("/api/peers").then((response) => response.json() as Promise<{ peers: Array<{ scope: string; peerId: string; name: string }> }>),
    ]);
    setText(access.allowedPeers.join("\n"));
    setSource(access.source);
    setPeers(peerList.peers);
  };
  useEffect(() => { void load().catch(() => {}); }, []);
  const keys = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const add = (key: string) => { if (!keys.includes(key)) setText([...keys, key].join("\n")); };
  const save = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/access", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowedPeers: keys }) });
      const payload = await response.json() as { message?: string; allowedPeers?: string[] };
      if (!response.ok) { setNotice(payload.message ?? `保存失败（HTTP ${response.status}）`); return; }
      setText((payload.allowedPeers ?? []).join("\n"));
      setNotice(keys.length ? `已保存 ${keys.length} 个会话` : "已清空：不限制谁能触发");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const candidates = peers
    .map((peer) => ({ key: `${peer.scope}:${peer.peerId}`, name: peer.name }))
    .filter((item) => !keys.includes(item.key));
  return (
    <div className="sketch-card p-5 space-y-3">
      <div className="text-[14px] font-bold text-white">入站白名单</div>
      <p className="text-[12px] text-[#888888]">
        只有列在这里的群 / 私聊能触发 Agent；留空表示不限制。公网部署下这是「谁能用这个 Bot」的唯一执行点——
        群成员的一条消息就是 Agent 的输入，白名单之外的消息会被直接忽略，也不回复（回复本身等于确认 Bot 在线）。
      </p>
      <textarea className="sketch-input w-full font-mono text-[12px]" rows={5} value={text} disabled={source === "env"} onChange={(event) => setText(event.target.value)} placeholder={"group:1234567890\nc2c:abcdefghij"} spellCheck={false} />
      {source === "env" && <p className="text-[12px] text-[#f59e0b]">当前由 MIUBOT_ALLOWED_PEERS 环境变量指定，这里只读。</p>}
      {candidates.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-[#777777]">已出现过的会话（点一下加入）：</p>
          <div className="flex flex-wrap gap-2">
            {candidates.slice(0, 12).map((item) => (
              <button key={item.key} className="btn-pill-dark text-[11px]" disabled={source === "env"} onClick={() => add(item.key)}>
                {item.name} · {item.key}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button className="btn-pill-dark" disabled={busy || source === "env"} onClick={() => void save()}>{busy ? "保存中…" : "保存白名单"}</button>
        {notice && <span className="text-[12px] text-[#aaaaaa]" role="status">{notice}</span>}
    </div>
    </div>
  );
}

/* 设置 */
export function Settings() {
  const { theme, setTheme } = useTheme();
  const [silence, setSilence] = useState({ quietStart: "00:00", quietEnd: "00:00" });
  const [silenceBusy, setSilenceBusy] = useState(false);
  const [silenceNotice, setSilenceNotice] = useState("");
  const [gate, setGate] = useState({ dailyMessageLimit: 0, quietStart: "00:00", quietEnd: "00:00", notifyOnLimit: false });
  const [gateBusy, setGateBusy] = useState(false);
  const [gateNotice, setGateNotice] = useState("");
  useEffect(() => {
    void fetch("/api/global-silence").then((response) => response.json()).then((data: { globalSilence: typeof silence }) => setSilence(data.globalSilence)).catch(() => setSilenceNotice("无法读取全局静默时段"));
    void fetch("/api/proactive-gate").then((response) => response.json()).then((data: { proactiveGate: typeof gate }) => setGate(data.proactiveGate)).catch(() => setGateNotice("无法读取主动行为限制"));
  }, []);
  const saveSilence = async () => {
    setSilenceBusy(true); setSilenceNotice("");
    try { const response = await fetch("/api/global-silence", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(silence) }); const data = await response.json() as { globalSilence?: typeof silence; message?: string }; if (!response.ok || !data.globalSilence) throw new Error(data.message ?? "保存失败"); setSilence(data.globalSilence); setSilenceNotice("全局静默时段已保存"); }
    catch (error) { setSilenceNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSilenceBusy(false); }
  };
  const saveGate = async () => {
    setGateBusy(true); setGateNotice("");
    try { const response = await fetch("/api/proactive-gate", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(gate) }); const data = await response.json() as { proactiveGate?: typeof gate; message?: string }; if (!response.ok || !data.proactiveGate) throw new Error(data.message ?? "保存失败"); setGate(data.proactiveGate); setGateNotice("主动行为限制已保存"); }
    catch (error) { setGateNotice(error instanceof Error ? error.message : String(error)); }
    finally { setGateBusy(false); }
  };
  return (
    <PageShell>
        <div>
          <h1 className="text-[20px] font-bold text-white tracking-tight">设置</h1>
          <p className="text-[13px] text-[#777777] mt-0.5">外观主题、本地存储管理与版本信息</p>
        </div>

        <div className="sketch-card p-5 space-y-3">
          <div className="text-[14px] font-bold text-white">全局静默时段</div>
          <p className="text-[12px] text-[#888888]">静默期间暂停接收和处理 QQ 与插件事件、所有消息发送及定时任务。按服务器本地时间判断。</p>
          <div className="grid max-w-lg grid-cols-2 gap-3">
            <label className="text-[13px] text-[#cccccc]">静默开始<input className="sketch-input mt-1 w-full" type="time" value={silence.quietStart} onChange={(event) => setSilence({ ...silence, quietStart: event.target.value })}/></label>
            <label className="text-[13px] text-[#cccccc]">静默结束<input className="sketch-input mt-1 w-full" type="time" value={silence.quietEnd} onChange={(event) => setSilence({ ...silence, quietEnd: event.target.value })}/></label>
          </div>
          <p className="text-[11px] text-[#777777]">起止时间相同表示关闭静默时段；跨午夜时段也支持。</p>
          <div className="flex items-center gap-3"><button className="btn-pill-dark" disabled={silenceBusy} onClick={() => void saveSilence()}>{silenceBusy ? "保存中…" : "保存静默时段"}</button>{silenceNotice && <span className="text-xs text-[#aaaaaa]" role="status">{silenceNotice}</span>}</div>
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
          <div className="flex items-center gap-2 text-[13px] text-[#cccccc]"><Toggle checked={gate.notifyOnLimit} onChange={(next) => setGate({ ...gate, notifyOnLimit: next })} label="触发限制时发送提示"/><span>触发限制时发送提示</span></div>
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

        <PasswordCard />

        <VersionCard />

        <AccessCard />

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
    </PageShell>
  );
}

type ToolEntry = { name: string; label: string; description: string; enabled: boolean; native?: boolean };
type SearchProvider = "tavily" | "brave" | "exa" | "serper";
type ImageProvider = { id: string; name: string; model: string; baseUrl?: string; enabled: boolean; apiKeyConfigured: boolean; /** 只写：提交新密钥时带上，读回来永远是 undefined。 */ apiKey?: string };
const searchProviders: Array<{ id: SearchProvider; label: string }> = [
  { id: "tavily", label: "Tavily" }, { id: "brave", label: "Brave Search" }, { id: "exa", label: "Exa" }, { id: "serper", label: "Serper" },
];
const blankImageProvider = (): ImageProvider => ({ id: "", name: "", model: "gpt-image-1", baseUrl: "https://api.openai.com/v1", enabled: true, apiKeyConfigured: false });

export function Tools() {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [skillsEnabled, setSkillsEnabled] = useState(false);
  const [stickersEnabled, setStickersEnabled] = useState(false);
  const [provider, setProvider] = useState<SearchProvider>("tavily");
  const [configured, setConfigured] = useState<Record<SearchProvider, boolean>>({ tavily: false, brave: false, exa: false, serper: false });
  const [apiKey, setApiKey] = useState("");
  /** 图像提供商：`image_gen` 的依赖，与搜索提供商同一层（不在「提供商」页）。 */
  const [imageProviders, setImageProviders] = useState<ImageProvider[]>([]);
  const [imageProviderId, setImageProviderId] = useState("");
  const [imageKey, setImageKey] = useState("");
  const [imageDraft, setImageDraft] = useState<ImageProvider | null>(null);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  /** 已启用的文件与命令类工具：公网部署下最该被看见的一行。 */
  const riskyTools = tools.filter((tool) => tool.native && tool.enabled).map((tool) => tool.name);

  const applyTools = (data: { tools: ToolEntry[]; mcpEnabled: boolean; skillsEnabled: boolean; stickersEnabled: boolean; webSearch: { provider: SearchProvider; configuredProviders: Record<SearchProvider, boolean> }; imageGen?: { providerId: string; providers: ImageProvider[] }; timezone?: string }) => {
    setTools(data.tools); setMcpEnabled(data.mcpEnabled); setSkillsEnabled(data.skillsEnabled); setStickersEnabled(data.stickersEnabled); setProvider(data.webSearch.provider); setConfigured(data.webSearch.configuredProviders);
    if (data.imageGen) { setImageProviderId(data.imageGen.providerId); setImageProviders(data.imageGen.providers); }
    if (data.timezone) setTimezone(data.timezone);
  };

  useEffect(() => {
    void fetch("/api/tools").then((response) => response.json()).then(applyTools).catch(() => setNotice("无法连接 Miubot Server"));
  }, []);

  const save = async (nextTools: ToolEntry[], nextProvider = provider, key = "", nextMcpEnabled = mcpEnabled, nextSkillsEnabled = skillsEnabled, nextStickersEnabled = stickersEnabled, nextImageProviderId = imageProviderId, nextTimezone = timezone) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/tools", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: nextTools.filter((item) => item.enabled).map((item) => item.name), mcpEnabled: nextMcpEnabled, skillsEnabled: nextSkillsEnabled, stickersEnabled: nextStickersEnabled, webSearch: { provider: nextProvider, apiKeys: key ? { [nextProvider]: key } : {} }, imageGen: { providerId: nextImageProviderId }, timezone: nextTimezone }) });
      const data = await response.json() as { tools?: ToolEntry[]; mcpEnabled?: boolean; skillsEnabled?: boolean; stickersEnabled?: boolean; webSearch?: { provider: SearchProvider; configuredProviders: Record<SearchProvider, boolean> }; imageGen?: { providerId: string; providers: ImageProvider[] }; timezone?: string; message?: string };
      if (!response.ok || !data.tools || !data.webSearch) throw new Error(data.message ?? "保存失败");
      applyTools({ tools: data.tools, mcpEnabled: data.mcpEnabled ?? false, skillsEnabled: data.skillsEnabled ?? false, stickersEnabled: data.stickersEnabled ?? false, webSearch: data.webSearch, imageGen: data.imageGen, timezone: data.timezone });
      setApiKey(""); setImageKey(""); setNotice("配置已保存");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  /**
   * 图像提供商的增删改走 `/api/config`（它持有 `imageProviders[]`），选哪个走 `/api/tools`。
   * 两个写入口各管一件事：提供商本身可以自定义 baseUrl/model，选中项则是工具级配置。
   */
  const saveImageProviders = async (next: ImageProvider[], selectedId: string, message: string) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageProviders: next }) });
      if (!response.ok) throw new Error("保存图像提供商失败");
      await save(tools, provider, "", mcpEnabled, skillsEnabled, stickersEnabled, selectedId);
      setNotice(message);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const selectedImageProvider = imageProviders.find((item) => item.id === imageProviderId);

  return <PageShell>
      <div><h1 className="text-[20px] font-bold">Tools</h1><p className="text-[13px] text-[#777777] mt-0.5">Pi Agent 工具、网页搜索与图像生成</p></div>
      {riskyTools.length > 0 && <article className="sketch-card p-4 space-y-1" style={{ borderColor: "#7f1d1d" }}>
        <div className="text-[13px] font-bold text-[#f87171]">已启用文件与命令类工具：{riskyTools.join("、")}</div>
        <p className="text-xs text-[#888888]">这些工具能读写服务器文件、执行命令，而入口是「任何能给 Bot 发消息的人」——一条精心构造的消息就是一次提示注入，注入成功即 RCE。公网部署请关掉它们；需要留一条保险丝时，设 <code className="text-[#cccccc]">MIUBOT_DISABLE_NATIVE_TOOLS=1</code> 会在会话里整体禁用这一组（配置不变，重启后生效）。</p>
      </article>}
      <article className="sketch-card flex items-center justify-between gap-4 p-4"><div><div className="font-semibold">MCP tools<code className="ml-2 text-xs text-[#888888]">mcp__*</code></div><p className="mt-1 text-xs text-[#888888]">全局控制已连接 MCP 服务器提供的工具；服务器连接状态在 MCP 页面单独管理。</p></div><div className="flex shrink-0 items-center gap-2 text-sm"><Toggle checked={mcpEnabled} disabled={busy} onChange={(next) => { setMcpEnabled(next); void save(tools, provider, "", next); }} label="启用 MCP tools"/><span>启用</span></div></article>
      <article className="sketch-card flex items-center justify-between gap-4 p-4"><div><div className="font-semibold">Skills</div><p className="mt-1 text-xs text-[#888888]">发现技能指令并允许 Agent 按名称加载匹配的 Skill。</p></div><div className="flex shrink-0 items-center gap-2 text-sm"><Toggle checked={skillsEnabled} disabled={busy} onChange={(next) => { setSkillsEnabled(next); void save(tools, provider, "", mcpEnabled, next); }} label="启用 Skills"/><span>启用</span></div></article>
      <article className="sketch-card flex items-center justify-between gap-4 p-4"><div><div className="font-semibold">表情包 tools</div><p className="mt-1 text-xs text-[#888888]">允许 Agent 搜索并发送已审核表情；还需在会话对象配置中授权。</p></div><div className="flex shrink-0 items-center gap-2 text-sm"><Toggle checked={stickersEnabled} disabled={busy} onChange={(next) => { setStickersEnabled(next); void save(tools, provider, "", mcpEnabled, skillsEnabled, next); }} label="启用表情包 tools"/><span>启用</span></div></article>
      {tools.map((tool) => <article key={tool.name} className="sketch-card flex items-center justify-between gap-4 p-4">
        <div className="min-w-0"><div className="font-semibold">{tool.label}<code className="ml-2 text-xs text-[#888888]">{tool.name}</code></div><p className="mt-1 text-xs text-[#888888]">{tool.description}</p>
          {tool.name === "time" && <div className="mt-3 flex flex-wrap items-center gap-2"><label className="text-xs text-[#888888]" htmlFor="time-tool-timezone">时区</label><input id="time-tool-timezone" className="sketch-input min-w-[220px]" aria-label="时间工具时区" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Shanghai"/><button className="btn-pill-dark" disabled={busy || !timezone.trim()} onClick={() => void save(tools, provider, "", mcpEnabled, skillsEnabled, stickersEnabled, imageProviderId, timezone.trim())}>保存时区</button></div>}
          {tool.name === "web_search" && <div className="mt-3 flex flex-wrap items-center gap-2">
            <select className="sketch-input" aria-label="网页搜索提供商" value={provider} disabled={busy} onChange={(event) => { const next = event.target.value as SearchProvider; setProvider(next); void save(tools, next); }}>
              {searchProviders.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <input className="sketch-input min-w-[200px]" type="password" autoComplete="new-password" placeholder={configured[provider] ? "密钥已保存；留空保留" : `${provider} API Key`} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <button className="btn-pill-dark" disabled={busy || !apiKey.trim()} onClick={() => void save(tools, provider, apiKey.trim())}>保存密钥</button>
            <span className={configured[provider] ? "pill-green" : "pill-gray"}>{configured[provider] ? "已配置" : "未配置"}</span>
          </div>}
          {tool.name === "image_gen" && <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <select className="sketch-input" aria-label="图像生成提供商" value={imageProviderId} disabled={busy} onChange={(event) => void save(tools, provider, "", mcpEnabled, skillsEnabled, stickersEnabled, event.target.value)}>
                <option value="">未选择（image_gen 不可用）</option>
                {imageProviders.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
              </select>
              <span className={selectedImageProvider?.apiKeyConfigured ? "pill-green" : "pill-gray"}>{!selectedImageProvider ? "未配置" : selectedImageProvider.apiKeyConfigured ? "已配置" : "缺少 API Key"}</span>
              <button className="btn-pill-dark" disabled={busy} onClick={() => setImageDraft(blankImageProvider())}>新建图像提供商</button>
              {selectedImageProvider && <button className="btn-pill-dark text-red-400" disabled={busy} onClick={() => { if (!window.confirm(`删除图像提供商“${selectedImageProvider.name}”？`)) return; void saveImageProviders(imageProviders.filter((item) => item.id !== selectedImageProvider.id), "", "图像提供商已删除"); }}>删除</button>}
            </div>
            {selectedImageProvider && <div className="flex flex-wrap items-center gap-2">
              <input className="sketch-input min-w-[200px]" type="password" autoComplete="new-password" placeholder={selectedImageProvider.apiKeyConfigured ? "密钥已保存；留空保留" : `${selectedImageProvider.name} API Key`} value={imageKey} onChange={(event) => setImageKey(event.target.value)} />
              <button className="btn-pill-dark" disabled={busy || !imageKey.trim()} onClick={() => void saveImageProviders(imageProviders.map((item) => item.id === selectedImageProvider.id ? { ...item, apiKey: imageKey.trim() } : item), selectedImageProvider.id, "图像提供商密钥已保存")}>保存密钥</button>
            </div>}
            <p className="text-xs text-[#888888]">只有这里选中的提供商会被 image_gen 使用；未选择时该工具直接报「未配置」，不会去猜。</p>
            {imageDraft && <div className="space-y-2 border-t pt-2" style={{ borderColor: "var(--hairline)" }}>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">提供商 ID<input className="sketch-input mt-1 w-full" value={imageDraft.id} onChange={(event) => setImageDraft({ ...imageDraft, id: event.target.value })} placeholder="openai-images"/></label>
                <label className="text-xs">显示名称<input className="sketch-input mt-1 w-full" value={imageDraft.name} onChange={(event) => setImageDraft({ ...imageDraft, name: event.target.value })}/></label>
                <label className="text-xs">图像模型 ID<input className="sketch-input mt-1 w-full" value={imageDraft.model} onChange={(event) => setImageDraft({ ...imageDraft, model: event.target.value })}/></label>
                <label className="text-xs">API Base URL<input className="sketch-input mt-1 w-full" value={imageDraft.baseUrl ?? ""} onChange={(event) => setImageDraft({ ...imageDraft, baseUrl: event.target.value })}/></label>
                <label className="text-xs sm:col-span-2">API Key<input className="sketch-input mt-1 w-full" type="password" autoComplete="new-password" value={imageDraft.apiKey ?? ""} onChange={(event) => setImageDraft({ ...imageDraft, apiKey: event.target.value })}/></label>
              </div>
              <div className="flex gap-2">
                <button className="btn-pill-dark" disabled={busy || !imageDraft.id.trim() || !imageDraft.name.trim() || !imageDraft.model.trim()} onClick={() => { const draft = { ...imageDraft, id: imageDraft.id.trim(), name: imageDraft.name.trim() }; setImageDraft(null); void saveImageProviders([...imageProviders, draft], draft.id, "图像提供商已创建并选用"); }}>保存并选用</button>
                <button className="btn-pill-dark" disabled={busy} onClick={() => setImageDraft(null)}>取消</button>
              </div>
            </div>}
          </div>}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm"><Toggle checked={tool.enabled} disabled={busy} onChange={(value) => { const next = tools.map((item) => item.name === tool.name ? { ...item, enabled: value } : item); setTools(next); void save(next); }} label={"启用 " + tool.label}/><span>启用</span></div>
      </article>)}
      {notice && <p className="text-sm text-[#aaaaaa]" role="status">{notice}</p>}
  </PageShell>;
}
