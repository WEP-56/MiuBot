import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";

type Model = { id: string; name: string };
type Provider = { id: string; name: string; enabled: boolean; models: Model[] };
type Message = { role: "user" | "assistant" | "trace"; text: string };
type Persona = { id: string; name: string; systemPrompt: string };
export function Debug() {
	const [providers, setProviders] = useState<Provider[]>([]); const [providerId, setProviderId] = useState(""); const [modelId, setModelId] = useState("");
	const [persona, setPersona] = useState<Persona | null>(null); const [summary, setSummary] = useState("");
	const [input, setInput] = useState(""); const [messages, setMessages] = useState<Message[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
	useEffect(() => { void Promise.all([fetch("/api/config").then((response) => response.json()) as Promise<{ providers: Provider[] }>, fetch("/api/personas").then((response) => response.json()) as Promise<{ personas: Persona[]; activePersonaId: string }>]).then(([data, personaData]) => { const available = data.providers.filter((provider) => provider.enabled); setProviders(available); setProviderId(available[0]?.id ?? ""); setModelId(available[0]?.models[0]?.id ?? ""); setPersona(personaData.personas.find((item) => item.id === personaData.activePersonaId) ?? null); }).catch(() => setError("无法连接 Miubot Server")); }, []);
	const selected = providers.find((provider) => provider.id === providerId);
	const send = async () => {
		const prompt = input.trim(); if (!prompt || busy) return; setInput(""); setError(""); setMessages((items) => [...items, { role: "user", text: prompt }]); setBusy(true);
		try {
			if (prompt === "/new") { setMessages([]); setSummary(""); setMessages([{ role: "trace", text: "已开始新对话" }]); return; }
			if (prompt === "/compact") {
				const transcript = messages.filter((item) => item.role !== "trace").map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.text}`).join("\n");
				if (!transcript) { setMessages([{ role: "trace", text: "当前对话为空，无需压缩" }]); return; }
				const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, modelId, message: `请总结以下对话，保留事实、偏好和未完成事项，不要回答对话：\n\n${transcript}`, messages: [] }) });
				const result = await response.json() as { ok: boolean; text?: string; error?: string }; if (!response.ok || !result.ok) throw new Error(result.error ?? "上下文压缩失败"); setSummary(result.text ?? ""); setMessages([{ role: "trace", text: "上下文摘要已更新" }]); return;
			}
			const history = messages.filter((item): item is Message & { role: "user" | "assistant" } => item.role !== "trace").map(({ role, text }) => ({ role, content: text }));
			const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, modelId, message: prompt, messages: [{ role: "system", content: persona?.systemPrompt ?? "你是一个友善的中文聊天助手。" }, ...(summary ? [{ role: "system", content: `此前对话摘要：\n${summary}` }] : []), ...history] }) });
			const result = await response.json() as { ok: boolean; text?: string; error?: string; providerId?: string; modelId?: string };
			if (!response.ok || !result.ok) throw new Error(result.error ?? "模型请求失败");
			setMessages((items) => [...items, { role: "trace", text: `${result.providerId} / ${result.modelId}` }, { role: "assistant", text: result.text ?? "" }]);
		} catch (cause) { const detail = cause instanceof Error ? cause.message : String(cause); setError(detail); setMessages((items) => [...items, { role: "trace", text: `请求失败：${detail}` }]); } finally { setBusy(false); }
	};
	return <section className="flex h-full min-h-0 flex-1 flex-col p-7" style={{ background: "var(--bg-app)", color: "var(--text-main)" }}><div className="mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col gap-4">
		<header className="flex items-start justify-between"><div><h1 className="text-xl font-semibold">调试台</h1><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>使用已配置的提供商和模型测试对话</p></div><button title="清空对话" className="btn-pill-dark" onClick={() => { setMessages([]); setError(""); }}><Icon.X size={14}/></button></header>
		<div className="sketch-card flex flex-wrap items-center gap-3 p-3"><label className="flex items-center gap-2 text-sm"><span style={{ color: "var(--text-muted)" }}>提供商</span><select className="sketch-input" value={providerId} onChange={(event) => { setProviderId(event.target.value); setModelId(providers.find((provider) => provider.id === event.target.value)?.models[0]?.id ?? ""); }}><option value="">选择提供商</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="flex items-center gap-2 text-sm"><span style={{ color: "var(--text-muted)" }}>模型</span><select className="sketch-input" value={modelId} onChange={(event) => setModelId(event.target.value)}>{(selected?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select></label><span className="text-sm" style={{ color: "var(--text-muted)" }}>人格：{persona?.name ?? "默认"}</span></div>
		{summary && <details className="sketch-card px-4 py-2 text-sm"><summary className="cursor-pointer">上下文摘要</summary><p className="mt-2 whitespace-pre-wrap" style={{ color: "var(--text-muted)" }}>{summary}</p></details>}
		<div className="sketch-card flex min-h-0 flex-1 flex-col p-4"><div className="flex-1 space-y-3 overflow-y-auto p-1">{messages.length === 0 && <div className="flex h-full min-h-48 items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>开始一段模型测试对话</div>}{messages.map((message, index) => message.role === "trace" ? <div key={index} className="rounded border px-3 py-2 font-mono text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>{message.text}</div> : <div key={index} className={`max-w-[85%] whitespace-pre-wrap rounded-md border p-3 text-sm ${message.role === "user" ? "ml-auto" : "mr-auto"}`} style={{ background: message.role === "user" ? "var(--bg-subtle)" : "var(--bg-active)", borderColor: "var(--border)" }}><div className="mb-1 text-xs" style={{ color: "var(--text-muted)" }}>{message.role === "user" ? "你" : "模型"}</div>{message.text}</div>)}</div>
			{error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}<form className="mt-3 flex gap-2 border-t pt-3" style={{ borderColor: "var(--hairline)" }} onSubmit={(event) => { event.preventDefault(); void send(); }}><input className="sketch-input min-w-0 flex-1" placeholder="输入消息…" value={input} onChange={(event) => setInput(event.target.value)} disabled={busy || !providerId}/><button type="submit" className="btn-primary-white" disabled={busy || !input.trim() || !providerId}>{busy ? "请求中" : <><Icon.Send size={14}/>发送</>}</button></form>
		</div>
	</div></section>;
}
