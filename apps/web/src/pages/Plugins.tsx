import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";

type PluginState = "inactive" | "loading" | "active" | "failed";

type Plugin = {
  id: string;
  name: string;
  version: string;
  description?: string;
  state: PluginState;
  /** 配置层是否放行；与 `state` 不是一回事——放行但没起来通常是 setup 失败。 */
  enabled: boolean;
  error?: string;
  permissions: string[];
  disposers: number;
  /** 该插件向 Agent 注册的工具名；停用后为空。 */
  tools: string[];
  /** 该插件贡献的对话钩子名（插件内短名，会话里挂成 `plugin:{id}/{name}`）；停用后为空。 */
  extensions: string[];
  source: "plugin" | "invalid" | "duplicate";
};

type Snapshot = {
  plugins: Plugin[];
  settings: { enabled: string[]; disabled: string[] };
  directories: string[];
  message?: string;
};

const STATE_LABEL: Record<PluginState, string> = {
  active: "运行中",
  inactive: "已停用",
  loading: "加载中",
  failed: "失败",
};

const STATE_CLASS: Record<PluginState, string> = {
  active: "pill-green",
  inactive: "pill-gray",
  loading: "pill-gray",
  failed: "pill-red",
};

/** 插件工作台：列出插件、启停与重载。 */
export function Plugins() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = async () => {
    const response = await fetch("/api/plugins");
    const data = (await response.json()) as Snapshot;
    if (!response.ok) throw new Error(data.message ?? "读取插件失败");
    setSnapshot(data);
  };

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  const act = async (id: string, kind: "enable" | "disable" | "reload" | "discover") => {
    setBusy(`${id}:${kind}`);
    setNotice("");
    try {
      const url = kind === "discover" ? "/api/plugins/discover" : `/api/plugins/${encodeURIComponent(id)}/${kind}`;
      const response = await fetch(url, { method: "POST" });
      const data = (await response.json()) as Snapshot & { ok?: boolean };
      if (!response.ok) throw new Error(data.message ?? "操作失败");
      setSnapshot(data);
      if (kind === "discover") setNotice(`已重新扫描：${data.plugins.length} 个条目`);
    } catch (error) {
      // 失败时不刷新列表：错误文字已经说明原因，保留现场比刷成空白更有用。
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const plugins = snapshot?.plugins ?? [];
  const runnable = plugins.filter((plugin) => plugin.source === "plugin");
  const activeCount = runnable.filter((plugin) => plugin.state === "active").length;

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between gap-4 pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">插件</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">事件插件与出站能力；启停状态同时写入配置</p>
          </div>
          <button
            className="btn-pill-dark shrink-0"
            disabled={busy !== ""}
            onClick={() => void act("", "discover")}
          >
            <Icon.Refresh size={13} className="text-[#888888]" />
            <span>重新扫描</span>
          </button>
        </div>

        {notice && (
          <div className="sketch-card p-3 text-[12.5px] text-[#f59e0b]">{notice}</div>
        )}

        <div className="flex items-center gap-2 text-[12.5px] text-[#888888]">
          <span className="pill-green">{activeCount} 个运行中</span>
          <span className="pill-gray">共 {runnable.length} 个插件</span>
          {plugins.length > runnable.length && (
            <span className="pill-red">{plugins.length - runnable.length} 个异常条目</span>
          )}
        </div>

        {plugins.length === 0 && (
          <div className="sketch-card p-5 text-[13px] text-[#888888]">
            还没有发现插件。把插件目录放到下方任意一个位置，再点「重新扫描」。
          </div>
        )}

        {plugins.map((plugin) => {
          const pending = busy.startsWith(`${plugin.id}:`) || busy === ":discover";
          return (
            <section key={plugin.id} className="sketch-card p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold truncate">{plugin.name}</h2>
                    <span className="text-[11.5px] text-[#666666]">v{plugin.version}</span>
                    <span className={STATE_CLASS[plugin.state]}>{STATE_LABEL[plugin.state]}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11.5px] text-[#666666] truncate">{plugin.id}</p>
                  {plugin.description && (
                    <p className="mt-1.5 text-[12.5px] text-[#999999]">{plugin.description}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {plugin.source !== "plugin" ? (
                    <span className="text-[11.5px] text-[#666666]">不可启停</span>
                  ) : (
                    <>
                      {plugin.state === "active" ? (
                        <button
                          className="btn-pill-dark"
                          disabled={pending}
                          onClick={() => void act(plugin.id, "disable")}
                        >
                          {pending ? "处理中…" : "停用"}
                        </button>
                      ) : (
                        <button
                          className="btn-pill-dark"
                          disabled={pending}
                          onClick={() => void act(plugin.id, "enable")}
                        >
                          {pending ? "处理中…" : "启用"}
                        </button>
                      )}
                      <button
                        className="btn-pill-dark"
                        disabled={pending || !plugin.enabled}
                        title={plugin.enabled ? "重新读取 manifest 并重启" : "插件已禁用，先启用再重载"}
                        onClick={() => void act(plugin.id, "reload")}
                      >
                        重载
                      </button>
                    </>
                  )}
                </div>
              </div>

              {plugin.error && (
                <p className="rounded-lg border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.08)] p-2.5 font-mono text-[11.5px] text-[#f87171] whitespace-pre-wrap">
                  {plugin.error}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                {plugin.tools?.length > 0 && (
                  <span className="text-[11.5px] text-[#888888]">Agent 工具</span>
                )}
                {(plugin.tools ?? []).map((tool) => (
                  <span
                    key={tool}
                    className="rounded-md border border-[rgba(34,197,94,0.25)] bg-[rgba(34,197,94,0.08)] px-1.5 py-0.5 font-mono text-[11px] text-[#22c55e]"
                  >
                    {tool}
                  </span>
                ))}
                {plugin.extensions?.length > 0 && (
                  <span className="text-[11.5px] text-[#888888]">对话钩子</span>
                )}
                {(plugin.extensions ?? []).map((extension) => (
                  <span
                    key={extension}
                    className="rounded-md border border-[rgba(56,189,248,0.25)] bg-[rgba(56,189,248,0.08)] px-1.5 py-0.5 font-mono text-[11px] text-[#38bdf8]"
                  >
                    {extension}
                  </span>
                ))}
                {plugin.permissions.length === 0 && (
                  <span className="text-[11.5px] text-[#666666]">未声明能力</span>
                )}
                {plugin.permissions.map((permission) => (
                  <span
                    key={permission}
                    className="rounded-md border border-[rgba(255,255,255,0.08)] px-1.5 py-0.5 font-mono text-[11px] text-[#999999]"
                  >
                    {permission}
                  </span>
                ))}
                {plugin.state === "active" && (
                  <span className="ml-1 text-[11px] text-[#666666]">清理函数 {plugin.disposers}</span>
                )}
              </div>
            </section>
          );
        })}

        <section className="sketch-card p-5 space-y-2">
          <h2 className="font-semibold text-[13.5px]">插件目录</h2>
          <p className="text-[12px] text-[#888888]">
            按顺序扫描，同名 id 以内置目录为准。每个子目录放一个 <code className="font-mono">miubot.plugin.json</code>。
          </p>
          <ul className="space-y-1">
            {(snapshot?.directories ?? []).map((directory) => (
              <li key={directory} className="font-mono text-[11.5px] text-[#777777] break-all">
                {directory}
              </li>
            ))}
          </ul>
          {snapshot && snapshot.settings.disabled.length > 0 && (
            <p className="text-[11.5px] text-[#777777]">
              配置中禁用：<span className="font-mono">{snapshot.settings.disabled.join(", ")}</span>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
