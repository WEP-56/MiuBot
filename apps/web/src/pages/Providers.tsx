import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";

type ModelConfig = { id: string; name: string; api: string; baseUrl?: string; maxOutput: number; maxContext: number; compressionThreshold: number; supportsThinking: boolean; supportsVision: boolean; supportsTools: boolean };
type ProviderConfig = { id: string; name: string; api: string; apiKey?: string; apiKeyConfigured?: boolean; baseUrl?: string; models: ModelConfig[]; enabled: boolean; ttsModel?: string; imageModel?: string };
type ImageProviderConfig = { id: string; name: string; api: "openai-images"; apiKey?: string; apiKeyConfigured?: boolean; baseUrl?: string; model: string; enabled: boolean };
const blankModel = (): ModelConfig => ({ id: "", name: "", api: "openai-completions", maxOutput: 4096, maxContext: 128000, compressionThreshold: 100000, supportsThinking: false, supportsVision: false, supportsTools: true });
const blankProvider = (): ProviderConfig => ({ id: "", name: "", api: "openai-completions", apiKey: "", baseUrl: "", models: [blankModel()], enabled: true, ttsModel: "", imageModel: "" });

export function Providers() {
	const [providers, setProviders] = useState<ProviderConfig[]>([]);
	const [imageProviders, setImageProviders] = useState<ImageProviderConfig[]>([]);
	const [editingImage, setEditingImage] = useState<ImageProviderConfig | null>(null);
	const [editing, setEditing] = useState<ProviderConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState("");
	const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [addType, setAddType] = useState("");
	const load = async () => { const response = await fetch("/api/config"); const data = await response.json() as { providers: ProviderConfig[]; imageProviders: ImageProviderConfig[] }; setProviders(data.providers); setImageProviders(data.imageProviders ?? []); };
	const saveImageProvider = async () => {
		if (!editingImage || !editingImage.id.trim() || !editingImage.name.trim() || !editingImage.model.trim()) { setNotice("请填写图像提供商 ID、名称和模型 ID"); return; }
		setSaving(true); setNotice("");
		try {
			const next = imageProviders.some((item) => item.id === editingImage.id) ? imageProviders.map((item) => item.id === editingImage.id ? editingImage : item) : [...imageProviders, editingImage];
			const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageProviders: next }) });
			if (!response.ok) throw new Error("保存图像提供商失败");
			const data = await response.json() as { imageProviders: ImageProviderConfig[] }; setImageProviders(data.imageProviders); setEditingImage(null); setNotice("图像提供商已保存");
		} catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
	};
	const removeImageProvider = async (provider: ImageProviderConfig) => {
		if (!window.confirm(`删除图像提供商“${provider.name}”？`)) return;
		setSaving(true);
		try { const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageProviders: imageProviders.filter((item) => item.id !== provider.id) }) }); if (!response.ok) throw new Error("删除图像提供商失败"); const data = await response.json() as { imageProviders: ImageProviderConfig[] }; setImageProviders(data.imageProviders); setNotice("图像提供商已删除"); }
		catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
	};
	useEffect(() => { void load(); }, []);
	const save = async () => {
		if (!editing || !editing.id.trim() || !editing.name.trim() || editing.models.some((model) => !model.id.trim())) { setNotice("请填写提供商名称、ID 和每个模型 ID"); return; }
		setSaving(true); setNotice("");
		try {
			const next = providers.some((item) => item.id === editing.id) ? providers.map((item) => item.id === editing.id ? editing : item) : [...providers, editing];
			const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: next }) });
			if (!response.ok) throw new Error("保存失败");
			const data = await response.json() as { providers: ProviderConfig[] }; setProviders(data.providers); setEditing(null); setNotice("配置已保存");
		} catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
	};
	const removeProvider = async (provider: ProviderConfig) => {
		if (!window.confirm(`删除提供商“${provider.name}”及其模型配置？`)) return;
		setSaving(true); setNotice("");
		try {
			const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: providers.filter((item) => item.id !== provider.id) }) });
			if (!response.ok) throw new Error("删除失败");
			const data = await response.json() as { providers: ProviderConfig[] }; setProviders(data.providers); setNotice("提供商已删除");
		} catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); }
	};
	const fetchModels = async () => {
		if (!editing) return;
		setLoadingModels(true); setNotice("");
		try {
			const response = await fetch("/api/providers/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: editing.id, api: editing.api, baseUrl: editing.baseUrl, apiKey: editing.apiKey }) });
			const data = await response.json() as { models?: Array<{ id: string; name: string }>; message?: string };
			if (!response.ok) throw new Error(data.message ?? "获取模型列表失败");
			setCatalog(data.models ?? []); setNotice(data.models?.length ? `已获取 ${data.models.length} 个模型` : "接口未返回模型");
		} catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } finally { setLoadingModels(false); }
	};
	const updateModel = (index: number, patch: Partial<ModelConfig>) => setEditing((current) => current ? { ...current, models: current.models.map((model, i) => i === index ? { ...model, ...patch } : model) } : current);
	return <section className="flex-1 h-full overflow-y-auto p-7" style={{ background: "var(--bg-app)", color: "var(--text-main)" }}>
		<div className="max-w-[980px] space-y-5">
			<header className="flex items-start justify-between"><div><h1 className="text-xl font-semibold">提供商</h1><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>管理聊天模型与图像生成凭据</p></div><label className="btn-primary-white relative"><Icon.Plus size={14}/><span>添加提供商</span><Icon.ChevronDown size={13}/><select className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="选择提供商类型" value={addType} onChange={(event) => { const value = event.target.value; setAddType(""); if (value === "chat") { setCatalog([]); setEditing(blankProvider()); } else if (value === "image") setEditingImage({ id: "", name: "", api: "openai-images", apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", enabled: true }); }}><option value="">选择类型</option><option value="chat">聊天模型提供商</option><option value="image">图像生成提供商</option></select></label></header>
			{notice && <div className="text-sm" role="status">{notice}</div>}
			<div className="space-y-3">{providers.map((provider) => <article className="sketch-card p-5" key={provider.id}>
				<div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Icon.Provider/><div><h2 className="font-semibold">{provider.name}</h2><p className="text-xs" style={{ color: "var(--text-muted)" }}>{provider.id} · {provider.api}</p></div></div><div className="flex items-center gap-3"><span className={provider.apiKeyConfigured ? "pill-green" : "pill-gray"}>{provider.apiKeyConfigured ? "凭据已配置" : "缺少 API Key"}</span><button className="btn-pill-dark" onClick={() => { setCatalog([]); setEditing({ ...provider, apiKey: "" }); }}>编辑</button><button className="btn-pill-dark text-red-400" disabled={saving} onClick={() => void removeProvider(provider)}>删除</button></div></div>
				<div className="mt-4 grid gap-2">{provider.models.map((model) => <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm" style={{ borderColor: "var(--hairline)" }} key={model.id}><div><b>{model.name || model.id}</b><span className="ml-2 font-mono text-xs" style={{ color: "var(--text-muted)" }}>{model.id}</span></div><div className="flex flex-wrap gap-2 text-xs" style={{ color: "var(--text-muted)" }}><span>上下文 {model.maxContext.toLocaleString()}</span><span>输出 {model.maxOutput.toLocaleString()}</span><span>{model.supportsThinking ? "思考" : "无思考"}</span><span>{model.supportsVision ? "视觉" : "纯文本"}</span><span>{model.supportsTools ? "Tools" : "无 Tools"}</span></div></div>)}</div>
			</article>)}</div>
			<div className="space-y-3"><h2 className="text-sm font-semibold">图像生成提供商</h2>{imageProviders.length === 0 && <p className="text-sm" style={{ color: "var(--text-muted)" }}>尚未配置图像生成提供商</p>}{imageProviders.map((provider) => <article className="sketch-card flex flex-wrap items-center justify-between gap-3 p-4" key={provider.id}><div><h3 className="font-semibold">{provider.name}</h3><p className="text-xs" style={{ color: "var(--text-muted)" }}>{provider.id} · OpenAI Images · {provider.model} · {provider.baseUrl}</p></div><div className="flex items-center gap-2"><span className={provider.apiKeyConfigured ? "pill-green" : "pill-gray"}>{provider.apiKeyConfigured ? "凭据已配置" : "缺少 API Key"}</span><button className="btn-pill-dark" onClick={() => setEditingImage({ ...provider, apiKey: "" })}>编辑</button><button className="btn-pill-dark text-red-400" disabled={saving} onClick={() => void removeImageProvider(provider)}>删除</button></div></article>)}</div>
		</div>
		{editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setEditing(null)}><div className="sketch-card max-h-[92vh] w-full max-w-2xl overflow-y-auto p-5" onClick={(event) => event.stopPropagation()}>
			<div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{providers.some((item) => item.id === editing.id) ? "编辑提供商" : "添加提供商"}</h2><button title="关闭" onClick={() => setEditing(null)}><Icon.X/></button></div>
			<div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">提供商 ID<input className="sketch-input mt-1 w-full" value={editing.id} onChange={(event) => setEditing({ ...editing, id: event.target.value })} disabled={providers.some((item) => item.id === editing.id)}/></label><label className="text-sm">显示名称<input className="sketch-input mt-1 w-full" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })}/></label><label className="text-sm">API 协议<select className="sketch-input mt-1 w-full" value={editing.api} onChange={(event) => setEditing({ ...editing, api: event.target.value, models: editing.models.map((model) => ({ ...model, api: event.target.value })) })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label className="text-sm">API Base URL<input className="sketch-input mt-1 w-full" value={editing.baseUrl ?? ""} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}/></label><label className="text-sm sm:col-span-2">API Key<input className="sketch-input mt-1 w-full" type="password" autoComplete="new-password" placeholder={providers.find((item) => item.id === editing.id)?.apiKeyConfigured ? "已保存；留空以保留当前密钥" : "输入 API Key"} value={editing.apiKey ?? ""} onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}/></label></div>
			<div className="mt-5 flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">聊天模型</h3><div className="flex gap-2"><button className="btn-pill-dark" disabled={loadingModels} onClick={() => void fetchModels()}>{loadingModels ? "获取中…" : "从 /models 获取"}</button><button className="btn-pill-dark" onClick={() => setEditing({ ...editing, models: [...editing.models, blankModel()] })}><Icon.Plus size={14}/> 添加模型</button></div></div>
			{catalog.length > 0 && <div className="mt-3"><label className="text-sm">模型列表<select className="sketch-input mt-1 w-full" value="" onChange={(event) => { const selected = catalog.find((item) => item.id === event.target.value); if (selected) { const emptyIndex = editing.models.findIndex((model) => !model.id); if (emptyIndex >= 0) updateModel(emptyIndex, selected); else setEditing({ ...editing, models: [...editing.models, { ...blankModel(), ...selected, api: editing.api }] }); } }}><option value="">选择模型并添加</option>{catalog.map((model) => <option value={model.id} key={model.id}>{model.name} ({model.id})</option>)}</select></label></div>}
			<div className="mt-3 space-y-4">{editing.models.map((model, index) => <div className="border-t pt-4" style={{ borderColor: "var(--hairline)" }} key={index}><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">模型 ID<input className="sketch-input mt-1 w-full" value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })}/></label><label className="text-sm">名称<input className="sketch-input mt-1 w-full" value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })}/></label>{([ ["最大输出", "maxOutput"], ["最大上下文", "maxContext"], ["压缩阈值", "compressionThreshold"] ] as const).map(([label, key]) => <label className="text-sm" key={key}>{label}<input className="sketch-input mt-1 w-full" type="number" min="1" value={model[key]} onChange={(event) => updateModel(index, { [key]: Number(event.target.value) })}/></label>)}</div><div className="mt-3 flex flex-wrap gap-4">{([ ["支持思考", "supportsThinking"], ["支持视觉", "supportsVision"], ["支持 Tools", "supportsTools"] ] as const).map(([label, key]) => <label className="flex items-center gap-2 text-sm" key={key}><input type="checkbox" checked={model[key]} onChange={(event) => updateModel(index, { [key]: event.target.checked })}/>{label}</label>)}{editing.models.length > 1 && <button className="text-sm text-red-400" onClick={() => setEditing({ ...editing, models: editing.models.filter((_, i) => i !== index) })}>移除模型</button>}</div></div>)}</div>
			<div className="mt-5 flex justify-end gap-2"><button className="btn-pill-dark" onClick={() => setEditing(null)}>取消</button><button className="btn-primary-white" disabled={saving} onClick={() => void save()}>{saving ? "保存中" : "保存配置"}</button></div>
		</div></div>}
		{editingImage && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setEditingImage(null)}><div className="sketch-card w-full max-w-xl p-5" role="dialog" aria-modal="true" aria-label="图像生成提供商配置" onClick={(event) => event.stopPropagation()}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{imageProviders.some((item) => item.id === editingImage.id) ? "编辑图像生成提供商" : "添加图像生成提供商"}</h2><button title="关闭" onClick={() => setEditingImage(null)}><Icon.X/></button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">提供商 ID<input className="sketch-input mt-1 w-full" value={editingImage.id} disabled={imageProviders.some((item) => item.id === editingImage.id)} onChange={(event) => setEditingImage({ ...editingImage, id: event.target.value })}/></label><label className="text-sm">显示名称<input className="sketch-input mt-1 w-full" value={editingImage.name} onChange={(event) => setEditingImage({ ...editingImage, name: event.target.value })}/></label><label className="text-sm sm:col-span-2">API Base URL<input className="sketch-input mt-1 w-full" value={editingImage.baseUrl ?? ""} onChange={(event) => setEditingImage({ ...editingImage, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1"/></label><label className="text-sm sm:col-span-2">API Key<input className="sketch-input mt-1 w-full" type="password" autoComplete="new-password" placeholder={imageProviders.find((item) => item.id === editingImage.id)?.apiKeyConfigured ? "已保存；留空以保留当前密钥" : "输入 API Key"} value={editingImage.apiKey ?? ""} onChange={(event) => setEditingImage({ ...editingImage, apiKey: event.target.value })}/></label><label className="text-sm">图像模型 ID<input className="sketch-input mt-1 w-full" value={editingImage.model} onChange={(event) => setEditingImage({ ...editingImage, model: event.target.value })}/></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editingImage.enabled} onChange={(event) => setEditingImage({ ...editingImage, enabled: event.target.checked })}/>启用</label></div><div className="mt-5 flex justify-end gap-2"><button className="btn-pill-dark" onClick={() => setEditingImage(null)}>取消</button><button className="btn-primary-white" disabled={saving} onClick={() => void saveImageProvider()}>{saving ? "保存中" : "保存配置"}</button></div></div></div>}
	</section>;
}
