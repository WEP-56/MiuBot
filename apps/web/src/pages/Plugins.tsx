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
  /** manifest 是否声明了 `config`；只有声明过的插件才有配置表单。 */
  hasConfig?: boolean;
  /** 插件目录绝对路径；卸载提示要用。 */
  directory: string;
  /** 是否可卸载：内置插件随代码分发，工作台不给卸载按钮。 */
  removable: boolean;
  source: "plugin" | "invalid" | "duplicate";
};

/** manifest 里 `config` 的字段声明（宿主只支持这一层子集）。 */
type ConfigField = {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: (string | number)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** 敏感值：不回显，留空表示保持原值。 */
  secret?: boolean;
  "x-ui"?: { widget?: string; placeholder?: string; group?: string };
};

type ConfigSchema = {
  type: "object";
  properties: Record<string, ConfigField>;
  required?: string[];
};

type ConfigPayload = {
  ok: boolean;
  schema?: ConfigSchema;
  values: Record<string, string | number | boolean>;
  secretKeys: string[];
  restarted?: boolean;
  message?: string;
  issues?: { field: string; message: string }[];
};

/** 表单草稿：布尔用原生值，其余统一按字符串暂存，提交时再转回声明类型。 */
type Draft = Record<string, string | boolean | null>;


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

/** 安装接口的失败响应：校验问题逐项回来，逐项展示比一句「安装失败」有用。 */
type InstallIssue = { field: string; message: string };

/** 把 schema 的 `default` 与已保存值合成为表单初始值。 */
function initialDraft(schema: ConfigSchema, values: ConfigPayload["values"]): Draft {
  const draft: Draft = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.type === "boolean") {
      draft[key] = values[key] === undefined ? field.default === true : values[key] === true;
      continue;
    }
    // secret 永远从空开始：宿主压根没把它回显出来。
    if (field.secret) {
      draft[key] = "";
      continue;
    }
    const current = values[key] ?? field.default;
    // 枚举没有当前值时用第一个候选：select 本来就显示第一项，草稿要跟显示一致，
    // 否则用户看到「fast」却被判「必须选择一项」。
    if (current === undefined && field.enum?.length) {
      draft[key] = String(field.enum[0]);
      continue;
    }
    draft[key] = current === undefined ? "" : String(current);
  }
  return draft;
}

/** 按 `x-ui.group` 分组，保持声明顺序；没写分组的进「设置」。 */
function groupFields(schema: ConfigSchema): { title: string; keys: string[] }[] {
  const groups: { title: string; keys: string[] }[] = [];
  for (const [key, field] of Object.entries(schema.properties)) {
    const title = field["x-ui"]?.group ?? "设置";
    const group = groups.find((item) => item.title === title);
    if (group) group.keys.push(key);
    else groups.push({ title, keys: [key] });
  }
  return groups;
}

/**
 * 插件配置表单。
 *
 * 校验完全交给服务端：这里只负责把输入按声明类型转换后提交，并把 `issues` 标到具体字段上。
 * 在浏览器里再实现一套规则，很快就会出现「前端放行、保存失败」或反过来的错位。
 */
function PluginConfigPanel({ pluginId, onSaved }: { pluginId: string; onSaved: (message: string) => void }) {
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [secretSet, setSecretSet] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`);
      const data = (await response.json()) as ConfigPayload;
      if (cancelled) return;
      if (!response.ok) {
        setNotice(data.message ?? "读取配置失败");
        return;
      }
      if (!data.schema) {
        // 理论上不会发生：hasConfig 为真才显示这个面板。留一条兜底文案而不是白屏。
        setNotice("该插件未声明配置项");
        return;
      }
      setSchema(data.schema);
      setDraft(initialDraft(data.schema, data.values));
      setSecretSet(data.secretKeys ?? []);
    })().catch((error: unknown) => {
      if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  const save = async () => {
    if (!schema) return;
    const values: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      const raw = draft[key];
      if (field.type === "boolean") {
        values[key] = raw === true;
        continue;
      }
      if (raw === null) {
        // 只有 secret 字段会走到这里：显式清除。
        values[key] = null;
        continue;
      }
      const text = typeof raw === "string" ? raw : "";
      if (field.secret) {
        // 空字符串 = 保持原值（宿主按三态语义处理）。
        values[key] = text;
        continue;
      }
      if (text.trim() === "") continue;
      // 枚举以字符串形式存在 select 里，回填时按原候选还原类型，否则数字枚举会被判「必须是数字」。
      if (field.enum) {
        const candidate = field.enum.find((item) => String(item) === text);
        values[key] = candidate ?? text;
        continue;
      }
      // 数字字段只在能解析成数字时才转换。解析不了就原样提交，
      // 让服务端回「必须是数字」——`Number("abc")` 得到 NaN 再被 JSON 化成 null，
      // 只会换来一句「不能为空」，排查方向就错了。
      if (field.type === "number" || field.type === "integer") {
        const numeric = Number(text);
        values[key] = Number.isFinite(numeric) ? numeric : text;
        continue;
      }
      values[key] = text;
    }

    setBusy(true);
    setErrors({});
    setNotice("");
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const data = (await response.json()) as ConfigPayload;
      if (!response.ok) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of data.issues ?? []) {
          if (issue.field === "$" || issue.field === "config") continue;
          fieldErrors[issue.field] = issue.message;
        }
        setErrors(fieldErrors);
        setNotice(data.message ?? "保存失败");
        return;
      }
      if (data.schema) {
        setSchema(data.schema);
        setDraft(initialDraft(data.schema, data.values));
        setSecretSet(data.secretKeys ?? []);
      }
      const message = data.restarted
        ? "已保存，插件已重启生效"
        : "已保存（插件当前未运行，下次启动时生效）";
      setNotice(message);
      onSaved(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!schema) {
    return <div className="rounded-lg border border-[rgba(255,255,255,0.08)] p-3 text-[12px] text-[#888888]">{notice || "读取中…"}</div>;
  }

  return (
    <div className="space-y-4 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-4">
      {groupFields(schema).map((group) => (
        <div key={group.title} className="space-y-3">
          <p className="text-[11.5px] font-medium text-[#888888]">{group.title}</p>
          {group.keys.map((key) => {
            const field = schema.properties[key]!;
            const error = errors[key];
            const label = field.title ?? key;
            const required = schema.required?.includes(key) ?? false;
            return (
              <label key={key} className="block text-[12.5px] text-[#cccccc]">
                <span className="flex items-center gap-1.5">
                  {label}
                  {required && <span className="text-[#f87171]">*</span>}
                  <span className="font-mono text-[10.5px] text-[#555555]">{key}</span>
                </span>

                {field.type === "boolean" ? (
                  <button
                    type="button"
                    className="btn-pill-dark mt-1.5"
                    onClick={() => setDraft({ ...draft, [key]: draft[key] !== true })}
                  >
                    {draft[key] === true ? "已开启" : "已关闭"}
                  </button>
                ) : field.enum ? (
                  <select
                    className="sketch-input mt-1.5 w-full"
                    value={String(draft[key] ?? "")}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  >
                    {field.enum.map((candidate) => (
                      <option key={String(candidate)} value={String(candidate)}>
                        {String(candidate)}
                      </option>
                    ))}
                  </select>
                ) : field["x-ui"]?.widget === "textarea" ? (
                  <textarea
                    className="sketch-input mt-1.5 w-full resize-y"
                    rows={3}
                    placeholder={field["x-ui"]?.placeholder}
                    value={typeof draft[key] === "string" ? (draft[key] as string) : ""}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                ) : (
                  <input
                    className="sketch-input mt-1.5 w-full"
                    type={
                      field.secret || field["x-ui"]?.widget === "password"
                        ? "password"
                        : field.type === "number" || field.type === "integer"
                          ? "number"
                          : "text"
                    }
                    step={field.type === "integer" ? 1 : undefined}
                    placeholder={
                      field.secret && secretSet.includes(key) ? "已设置，留空保持不变" : field["x-ui"]?.placeholder
                    }
                    value={typeof draft[key] === "string" ? (draft[key] as string) : ""}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                )}

                <span className="mt-1 flex items-center gap-2">
                  {field.description && <span className="text-[11.5px] text-[#777777]">{field.description}</span>}
                  {field.secret && secretSet.includes(key) && (
                    <button
                      type="button"
                      className="text-[11px] text-[#f59e0b] hover:underline"
                      onClick={() => {
                        setDraft({ ...draft, [key]: null });
                        setSecretSet(secretSet.filter((item) => item !== key));
                      }}
                    >
                      清除已保存的值
                    </button>
                  )}
                </span>
                {error && <span className="mt-1 block text-[11.5px] text-[#f87171]">{error}</span>}
              </label>
            );
          })}
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-[11.5px] text-[#888888]">{notice}</span>
        <button className="btn-primary-white" disabled={busy} onClick={() => void save()}>
          {busy ? "保存中…" : "保存配置"}
        </button>
      </div>
    </div>
  );
}


/** 插件工作台：列出插件、启停与重载。 */
export function Plugins() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  /** 当前展开配置表单的插件 id；同时只开一个，避免多个表单争同一个视口。 */
  const [openConfig, setOpenConfig] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [installPath, setInstallPath] = useState("");
  const [installIssues, setInstallIssues] = useState<InstallIssue[]>([]);
  /** 正在二次确认卸载的插件 id。 */
  const [uninstalling, setUninstalling] = useState("");
  const [dropData, setDropData] = useState(false);
  const [dropConfig, setDropConfig] = useState(false);

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

  const install = async () => {
    const path = installPath.trim();
    if (!path) {
      setNotice("请填写插件目录的绝对路径");
      return;
    }
    setBusy(":install");
    setNotice("");
    setInstallIssues([]);
    try {
      const response = await fetch("/api/plugins/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = (await response.json()) as Snapshot & {
        message?: string;
        issues?: InstallIssue[];
        installed?: string;
      };
      if (!response.ok) {
        // 校验问题逐条展示：目录填错、manifest 坏、符号链接、体积超限的原因完全不同。
        setInstallIssues(data.issues ?? []);
        setNotice(data.message ?? "安装失败");
        return;
      }
      setSnapshot(data);
      setInstallOpen(false);
      setInstallPath("");
      setNotice(`已安装 ${data.installed ?? path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const uninstall = async (id: string) => {
    setBusy(`${id}:uninstall`);
    setNotice("");
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(id)}/uninstall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteData: dropData, deleteConfig: dropConfig }),
      });
      const data = (await response.json()) as Snapshot & { message?: string };
      if (!response.ok) throw new Error(data.message ?? "卸载失败");
      setSnapshot(data);
      setUninstalling("");
      setDropData(false);
      setDropConfig(false);
      setNotice(`已卸载 ${id}${dropData || dropConfig ? "（含所选数据）" : "，数据与配置已保留"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        <div className="flex items-start justify-between gap-4 pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">插件</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">事件插件与出站能力；启停状态同时写入配置</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="btn-pill-dark"
              disabled={busy !== ""}
              title="从本地目录安装插件包"
              onClick={() => {
                setInstallOpen(!installOpen);
                setInstallIssues([]);
              }}
            >
              <Icon.Plus size={13} className="text-[#888888]" />
              <span>安装</span>
            </button>
            <button className="btn-pill-dark" disabled={busy !== ""} onClick={() => void act("", "discover")}>
              <Icon.Refresh size={13} className="text-[#888888]" />
              <span>重新扫描</span>
            </button>
          </div>
        </div>

        {installOpen && (
          <section className="sketch-card space-y-3 p-4">
            <div>
              <p className="text-[12.5px] text-[#cccccc]">插件目录的绝对路径</p>
              <p className="mt-1 text-[11.5px] text-[#777777]">
                目录里要有 <code className="font-mono">miubot.plugin.json</code> 与入口文件。
                不支持压缩包，也不支持网页上传——把目录解压到本机，填路径即可。
              </p>
            </div>
            <input
              className="sketch-input w-full font-mono"
              placeholder="D:\\plugins\\miubot.myplugin"
              value={installPath}
              onChange={(event) => setInstallPath(event.target.value)}
            />
            {installIssues.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.08)] p-2.5">
                {installIssues.map((issue) => (
                  <li key={`${issue.field}:${issue.message}`} className="font-mono text-[11.5px] text-[#f87171]">
                    {issue.field}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="btn-pill-dark"
                disabled={busy !== ""}
                onClick={() => {
                  setInstallOpen(false);
                  setInstallIssues([]);
                }}
              >
                取消
              </button>
              <button className="btn-primary-white" disabled={busy !== ""} onClick={() => void install()}>
                {busy === ":install" ? "安装中…" : "安装"}
              </button>
            </div>
          </section>
        )}

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
                      {plugin.hasConfig && (
                        <button
                          className="btn-pill-dark"
                          disabled={pending}
                          title="编辑该插件在 manifest 中声明的配置项"
                          onClick={() => setOpenConfig(openConfig === plugin.id ? "" : plugin.id)}
                        >
                          {openConfig === plugin.id ? "收起" : "配置"}
                        </button>
                      )}
                      {plugin.removable && (
                        <button
                          className="btn-pill-dark"
                          disabled={pending}
                          title="删除插件目录（数据与配置默认保留）"
                          onClick={() => {
                            setUninstalling(uninstalling === plugin.id ? "" : plugin.id);
                            setDropData(false);
                            setDropConfig(false);
                          }}
                        >
                          <Icon.X size={12} className="text-[#f87171]" />
                          <span>卸载</span>
                        </button>
                      )}
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

              {openConfig === plugin.id && (
                <PluginConfigPanel
                  pluginId={plugin.id}
                  onSaved={(message) => {
                    setNotice(message);
                    // 配置保存会重启插件，状态可能从 active 变成 failed（例如新配置让 setup 抛错）。
                    void load().catch(() => undefined);
                  }}
                />
              )}

              {uninstalling === plugin.id && (
                <div className="space-y-2.5 rounded-lg border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.06)] p-3">
                  <p className="text-[12.5px] text-[#f87171]">将删除插件目录，之后可以重新安装。</p>
                  <p className="break-all font-mono text-[11px] text-[#888888]">{plugin.directory}</p>
                  <label className="flex items-center gap-2 text-[12px] text-[#cccccc]">
                    <input type="checkbox" checked={dropData} onChange={(event) => setDropData(event.target.checked)} />
                    同时删除该插件的数据（{`plugin-data/${plugin.id}.json`}）
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-[#cccccc]">
                    <input
                      type="checkbox"
                      checked={dropConfig}
                      onChange={(event) => setDropConfig(event.target.checked)}
                    />
                    同时删除该插件的配置（{`plugin-config/${plugin.id}.json`}）
                  </label>
                  <div className="flex justify-end gap-2">
                    <button className="btn-pill-dark" disabled={pending} onClick={() => setUninstalling("")}>
                      取消
                    </button>
                    <button
                      className="btn-primary-white"
                      disabled={pending}
                      onClick={() => void uninstall(plugin.id)}
                    >
                      {pending ? "卸载中…" : "确认卸载"}
                    </button>
                  </div>
                </div>
              )}
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
