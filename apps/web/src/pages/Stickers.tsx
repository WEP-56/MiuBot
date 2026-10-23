import { Slider } from "../components/Controls";
import { PageShell } from "../components/PageShell";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";

type Sticker = { id: string; fileName: string; mimeType: string; sha256: string; size: number; createdAt: string; description: string; tags: string[]; status: "pending" | "approved"; usageCount: number };
type Tab = "all" | "approved" | "pending";
type TaggingProvider = { id: string; name: string; models: Array<{ id: string; name: string }> };

export function Stickers() {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [autoCollectProbability, setAutoCollectProbability] = useState(0);
  const [savedAutoCollectProbability, setSavedAutoCollectProbability] = useState(0);
  const [taggingProviders, setTaggingProviders] = useState<TaggingProvider[]>([]);
  const [taggingProviderId, setTaggingProviderId] = useState("");
  const [taggingModelId, setTaggingModelId] = useState("");
  const [savedTaggingModel, setSavedTaggingModel] = useState({ providerId: "", modelId: "" });
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Sticker | null>(null);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const load = async () => {
    const response = await fetch("/api/stickers");
    const data = await response.json() as { stickers?: Sticker[]; enabled?: boolean; autoCollectProbability?: number; taggingModel?: { providerId: string; modelId: string }; taggingProviders?: TaggingProvider[]; message?: string };
    if (!response.ok || !data.stickers) throw new Error(data.message ?? "读取表情包失败");
    const model = data.taggingModel ?? { providerId: "", modelId: "" };
    setStickers(data.stickers); setEnabled(data.enabled === true); setAutoCollectProbability(data.autoCollectProbability ?? 0); setSavedAutoCollectProbability(data.autoCollectProbability ?? 0); setTaggingProviders(data.taggingProviders ?? []); setTaggingProviderId(model.providerId); setTaggingModelId(model.modelId); setSavedTaggingModel(model);
  };
  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, []);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setNotice("");
    let imported = 0; let duplicates = 0; const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const response = await fetch(`/api/stickers/import?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await file.arrayBuffer() });
        const data = await response.json() as { duplicate?: boolean; message?: string };
        if (!response.ok) throw new Error(data.message ?? "导入失败");
        if (data.duplicate) duplicates++; else imported++;
      } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { await load(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    setNotice(errors.length ? `导入 ${imported} 个，重复 ${duplicates} 个；${errors.join("；")}` : `导入 ${imported} 个，跳过重复 ${duplicates} 个`);
    setBusy(false); if (fileInput.current) fileInput.current.value = "";
  };

  const update = async (sticker: Sticker, changes: Partial<Pick<Sticker, "description" | "tags" | "status">>) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/stickers/${encodeURIComponent(sticker.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) });
      const data = await response.json() as { stickers?: Sticker[]; message?: string };
      if (!response.ok || !data.stickers) throw new Error(data.message ?? "更新失败");
      setStickers(data.stickers); setEditing(null); setNotice("表情包信息已更新");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const remove = async (sticker: Sticker) => {
    if (!window.confirm(`删除“${sticker.description || sticker.fileName}”？`)) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch(`/api/stickers/${encodeURIComponent(sticker.id)}`, { method: "DELETE" });
      const data = await response.json() as { stickers?: Sticker[]; message?: string };
      if (!response.ok || !data.stickers) throw new Error(data.message ?? "删除失败");
      setStickers(data.stickers); setNotice("表情包已删除");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const saveAutoCollectProbability = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/stickers/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autoCollectProbability }) });
      const data = await response.json() as { autoCollectProbability?: number; message?: string };
      if (!response.ok || data.autoCollectProbability === undefined) throw new Error(data.message ?? "保存采集概率失败");
      setSavedAutoCollectProbability(data.autoCollectProbability); setNotice("自动采集概率已保存");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveTaggingModel = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/stickers/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ taggingProviderId: taggingProviderId || "", taggingModelId: taggingModelId || "" }) });
      const data = await response.json() as { taggingModel?: { providerId: string; modelId: string }; message?: string };
      if (!response.ok || !data.taggingModel) throw new Error(data.message ?? "保存打标模型失败");
      setSavedTaggingModel(data.taggingModel); setNotice(data.taggingModel.modelId ? "打标模型已保存，待审核素材将在空闲时处理" : "自动打标已关闭");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const visible = stickers.filter((item) => (tab === "all" || item.status === tab) && (!query.trim() || `${item.fileName} ${item.description} ${item.tags.join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const tabs: Array<[Tab, string]> = [["all", `全部 ${stickers.length}`], ["approved", `已审核 ${stickers.filter((item) => item.status === "approved").length}`], ["pending", `待审核 ${stickers.filter((item) => item.status === "pending").length}`]];
  return <PageShell width={1100}>
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">表情包</h1><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>导入图片、审核标签，并管理 Agent 可用素材</p></div><div className="flex flex-wrap items-center gap-2"><span className={enabled ? "pill-green" : "pill-gray"}>{enabled ? "全局工具已启用" : "全局工具已停用"}</span><button className="btn-pill-dark" title="刷新" aria-label="刷新" disabled={busy} onClick={() => void load().catch((error) => setNotice(String(error)))}><Icon.Refresh size={14}/></button><input ref={fileInput} className="hidden" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/bmp" multiple disabled={busy} onChange={(event) => void importFiles(event.target.files)}/><button className="btn-primary-white" disabled={busy} onClick={() => fileInput.current?.click()}><Icon.Plus size={14}/><span>批量导入</span></button></div></header>
    <div className="sketch-card flex flex-wrap items-end gap-4 p-4"><label className="min-w-56 flex-1 text-sm">自动采集概率 <span className="ml-2 font-semibold">{autoCollectProbability}%</span><div className="mt-3"><Slider value={autoCollectProbability} min={0} max={100} step={1} disabled={busy} onChange={setAutoCollectProbability} label="自动采集概率"/></div><span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>需启用全局表情包 tools 和对象配置中的表情包授权；新素材进入待审核状态</span></label><input className="sketch-input w-24" type="number" min={0} max={100} step={1} aria-label="自动采集概率百分比" value={autoCollectProbability} disabled={busy} onChange={(event) => setAutoCollectProbability(Math.max(0, Math.min(100, Number(event.target.value) || 0)))}/><button className="btn-primary-white" disabled={busy || autoCollectProbability === savedAutoCollectProbability} onClick={() => void saveAutoCollectProbability()}>{busy ? "保存中…" : "保存概率"}</button></div>
    <div className="sketch-card flex flex-wrap items-end gap-3 p-4"><label className="min-w-48 flex-1 text-sm">打标模型<select className="sketch-input mt-1 w-full" value={taggingProviderId} disabled={busy} onChange={(event) => { const providerId = event.target.value; setTaggingProviderId(providerId); setTaggingModelId(taggingProviders.find((item) => item.id === providerId)?.models[0]?.id ?? ""); }}><option value="">关闭自动打标</option>{taggingProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="min-w-48 flex-1 text-sm">视觉模型<select className="sketch-input mt-1 w-full" value={taggingModelId} disabled={busy || !taggingProviderId} onChange={(event) => setTaggingModelId(event.target.value)}>{taggingProviders.find((item) => item.id === taggingProviderId)?.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label><button className="btn-primary-white" disabled={busy || (taggingProviderId === savedTaggingModel.providerId && taggingModelId === savedTaggingModel.modelId)} onClick={() => void saveTaggingModel()}>{busy ? "保存中…" : "保存模型"}</button><p className="w-full text-xs" style={{ color: "var(--text-muted)" }}>手动上传和自动采集的待审核素材都会排队处理；打标仅在 Agent 空闲时运行，新对话会立即中止当前请求。</p></div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2">{tabs.map(([id, label]) => <button key={id} className={`btn-pill-dark ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>)}</div><input className="sketch-input w-full sm:w-64" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索描述或标签" aria-label="搜索表情包"/></div>
    {notice && <p className="text-sm" style={{ color: "var(--text-muted)" }} role="status">{notice}</p>}
    {visible.length === 0 ? <div className="sketch-card p-10 text-center text-sm" style={{ color: "var(--text-muted)" }}>{stickers.length ? "没有符合条件的表情包" : "素材库为空，请导入图片"}</div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{visible.map((sticker) => <article key={sticker.id} className="sketch-card overflow-hidden"><button className="block aspect-square w-full bg-black" title={sticker.fileName} onClick={() => { setEditing(sticker); setDescription(sticker.description); setTags(sticker.tags.join(", ")); }}><img className="h-full w-full object-contain" src={`/api/stickers/${encodeURIComponent(sticker.id)}/image`} alt={sticker.description || sticker.fileName}/></button><div className="space-y-2 p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{sticker.description || sticker.fileName}</span><span className={sticker.status === "approved" ? "pill-green" : "pill-gray"}>{sticker.status === "approved" ? "已审核" : "待审核"}</span></div><div className="min-h-5 text-xs" style={{ color: "var(--text-muted)" }}>{sticker.tags.join(" · ") || "暂无标签"}</div><div className="flex items-center justify-between gap-2 text-xs" style={{ color: "var(--text-muted)" }}><span>使用 {sticker.usageCount} 次</span><div className="flex gap-1"><button className="btn-pill-dark !px-2 !py-1" disabled={busy} onClick={() => { setEditing(sticker); setDescription(sticker.description); setTags(sticker.tags.join(", ")); }}>编辑</button><button className="btn-pill-dark !px-2 !py-1 text-red-400" disabled={busy} onClick={() => void remove(sticker)}>删除</button></div></div></div></article>)}</div>}
    {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}><section className="sketch-card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5" role="dialog" aria-modal="true" aria-label="编辑表情包"><div className="flex items-start justify-between gap-4"><h2 className="font-semibold">编辑表情包</h2><button className="btn-pill-dark" aria-label="关闭" onClick={() => setEditing(null)}>关闭</button></div><div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><img className="max-h-80 min-h-40 w-full bg-black object-contain" src={`/api/stickers/${encodeURIComponent(editing.id)}/image`} alt={editing.description || editing.fileName}/><div className="space-y-3"><label className="block text-sm">描述<textarea className="sketch-input mt-1 min-h-24 w-full" maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)}/></label><label className="block text-sm">标签<input className="sketch-input mt-1 w-full" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="开心, 安慰, 猫猫"/><span className="mt-1 block text-xs" style={{ color: "var(--text-muted)" }}>用逗号分隔，最多 20 个</span></label><div className="flex flex-wrap gap-2"><button className="btn-pill-dark" disabled={busy} onClick={() => void update(editing, { description, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })}>保存标注</button>{editing.status === "pending" ? <button className="btn-primary-white" disabled={busy} onClick={() => void update(editing, { description, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), status: "approved" })}>审核通过</button> : <button className="btn-pill-dark" disabled={busy} onClick={() => void update(editing, { status: "pending" })}>撤销审核</button>}</div></div></div></section></div>}
  </PageShell>;
}