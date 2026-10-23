import { Toggle } from "../components/Controls";
import { PageShell } from "../components/PageShell";
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";

/**
 * 斜杠命令页。
 *
 * 命令的注册由代码与插件决定，这里只管两件管理面的事：谁能执行管理员命令、
 * 哪些命令暂时关掉。关掉的命令当作不存在——消息按普通聊天继续处理。
 */

type CommandEntry = {
  name: string;
  description: string;
  permission: "admin" | "all";
  source: "builtin" | "plugin";
  pluginId?: string;
  enabled: boolean;
};

type Snapshot = {
  commands: CommandEntry[];
  admins: string[];
  disabled: string[];
  adminsConfigured: boolean;
};

export function Commands() {
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  /** 已保存的管理员名单；用来判断输入框里有没有未保存的改动。 */
  const [admins, setAdmins] = useState<string[]>([]);
  const [adminText, setAdminText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const apply = (data: Snapshot) => {
    setCommands(data.commands);
    setAdmins(data.admins);
    setAdminText(data.admins.join("\n"));
  };

  const load = async () => {
    const response = await fetch("/api/commands");
    const data = (await response.json()) as Snapshot & { message?: string };
    if (!response.ok || !Array.isArray(data.commands)) throw new Error(data.message ?? "读取命令清单失败");
    apply(data);
  };

  useEffect(() => {
    void load()
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
  }, []);

  const save = async (payload: { admins?: string[]; disabled?: string[] }, message: string) => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as Snapshot & { message?: string };
      if (!response.ok || !Array.isArray(data.commands)) throw new Error(data.message ?? "保存失败");
      apply(data);
      setNotice(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const typedAdmins = adminText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uniqueAdmins = [...new Set(typedAdmins)];
  const adminsDirty = uniqueAdmins.join("\n") !== admins.join("\n");

  const toggle = (entry: CommandEntry) => {
    // 以服务端返回的 enabled 为准重新算一遍禁用清单：逐个切换时不依赖本地推断。
    const disabled = commands.filter((item) => !item.enabled).map((item) => item.name);
    const next = entry.enabled ? [...disabled, entry.name] : disabled.filter((name) => name !== entry.name);
    void save({ disabled: next }, entry.enabled ? `已停用 /${entry.name}` : `已启用 /${entry.name}`);
  };

  return (
    <PageShell>
        <div>
          <h1 className="text-[20px] font-bold">斜杠命令</h1>
          <p className="mt-0.5 text-[13px] text-[#777777]">
            以 / 开头的消息会被命令接管：不进插话、不进 Agent，也不写入会话上下文。群里不 @ 机器人同样可用。
          </p>
        </div>

        {admins.length === 0 && (
          <article className="sketch-card p-4 space-y-1" style={{ borderColor: "#7f1d1d" }}>
            <div className="text-[13px] font-bold text-[#f87171]">尚未配置管理员</div>
            <p className="text-xs text-[#888888]">
              管理员名单为空时，<b>没有人</b>能执行管理员命令（如 <code className="text-[#cccccc]">/admin</code>
              ），这是刻意的安全默认。需要在下面填入 QQ 用户 openid 才会生效。
            </p>
          </article>
        )}

        <section className="sketch-card space-y-3 p-5">
          <div className="text-[14px] font-bold text-white">管理员</div>
          <p className="text-[12px] text-[#888888]">
            一行一个 QQ 用户 openid（不是 QQ 号）。openid 按 Bot 隔离，可以在「会话」页的对象信息里看到。
            管理员只影响斜杠命令，不会绕过入站白名单。
          </p>
          <textarea
            className="sketch-input w-full font-mono text-[12px]"
            rows={4}
            value={adminText}
            disabled={busy}
            spellCheck={false}
            placeholder={"8A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D"}
            onChange={(event) => setAdminText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="btn-pill-dark"
              disabled={busy || !adminsDirty}
              onClick={() =>
                void save(
                  { admins: uniqueAdmins },
                  uniqueAdmins.length
                    ? `已保存 ${uniqueAdmins.length} 位管理员`
                    : "已清空管理员：没有人能执行管理员命令",
                )
              }
            >
              {busy ? "保存中…" : "保存管理员"}
            </button>
            <span className="text-[12px] text-[#777777]">
              已保存 {admins.length} 人
              {typedAdmins.length !== uniqueAdmins.length
                ? `；输入里去掉 ${typedAdmins.length - uniqueAdmins.length} 条重复`
                : ""}
            </span>
          </div>
        </section>

        <section className="sketch-card space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[14px] font-bold text-white">命令清单</div>
            <div className="flex items-center gap-2">
              <span className="pill-gray">{commands.filter((item) => item.enabled).length} 个启用</span>
              <button
                className="btn-pill-dark"
                title="刷新"
                aria-label="刷新命令清单"
                disabled={busy}
                onClick={() =>
                  void load().catch((error: unknown) =>
                    setNotice(error instanceof Error ? error.message : String(error)),
                  )
                }
              >
                <Icon.Refresh size={14} />
              </button>
            </div>
          </div>
          {loading && commands.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#888888]">读取中…</p>
          ) : commands.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#888888]">没有可用命令</p>
          ) : (
            <div className="space-y-2">
              {commands.map((entry) => (
                <div
                  key={entry.name}
                  className="flex flex-wrap items-center justify-between gap-3 border-t py-2 first:border-t-0 first:pt-0"
                  style={{ borderColor: "var(--hairline)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[13px] text-white">/{entry.name}</code>
                      {entry.permission === "admin" ? <span className="pill-gray">仅管理员</span> : null}
                      {entry.source === "plugin" ? (
                        <span className="pill-green" title="由插件注册">
                          {entry.pluginId ?? "插件"}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[#666666]">内置</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-[#888888]">{entry.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-sm">
                    <Toggle
                      checked={entry.enabled}
                      disabled={busy}
                      onChange={() => toggle(entry)}
                      label={`${entry.enabled ? "停用" : "启用"} ${entry.name}`}
                    />
                    <span>{entry.enabled ? "启用" : "已停用"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#777777]">
            停用的命令会被当作不存在：以 / 开头的消息照常按普通聊天处理（群里非 @ 的仍走插话）。
          </p>
        </section>

        {notice && (
          <p className="text-sm text-[#aaaaaa]" role="status">
            {notice}
          </p>
        )}
    </PageShell>
  );
}