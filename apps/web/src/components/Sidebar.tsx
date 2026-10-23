import { useState } from "react";
import { Icon } from "./Icon";
import { useTheme } from "../theme";
import { logout } from "../utils/api";

export type PageId =
  | "dashboard"
  | "platforms"
  | "providers"
  | "personas"
  | "sessions"
  | "debug"
  | "stickers"
  | "proactive"
  | "mcp"
  | "skills"
  | "memory"
  | "scheduler"
  | "tools"
  | "extensions"
  | "logs"
  | "settings";

type SidebarProps = {
  current: PageId;
  onChange: (id: PageId) => void;
};

type Item = {
  id: PageId;
  label: string;
  icon: keyof typeof Icon;
};

const mainItems: Item[] = [
  { id: "dashboard", label: "首页", icon: "Dashboard" },
  { id: "platforms", label: "平台", icon: "Antenna" },
  { id: "providers", label: "提供商", icon: "Provider" },
  { id: "personas", label: "人格", icon: "Persona" },
  { id: "sessions", label: "会话", icon: "Chat" },
  { id: "debug", label: "调试台", icon: "Flask" },
];

const advancedSubItems: { id: PageId; label: string }[] = [
  { id: "tools", label: "Tools" },
  { id: "stickers", label: "表情包" },
  { id: "proactive", label: "主动行为" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "插件" },
  { id: "memory", label: "记忆与知识库" },
  { id: "scheduler", label: "定时任务" },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isLight = theme === "light";
  return (
    <button
      onClick={toggle}
      title={isLight ? "切换到深色模式" : "切换到浅色模式"}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] text-left transition-colors text-[#999999] hover:text-white hover:bg-[#151515]"
    >
      {isLight ? <Icon.Sun size={16} className="text-[#888888]" /> : <Icon.Moon size={16} className="text-[#888888]" />}
      <span className="flex-1">{isLight ? "浅色模式" : "深色模式"}</span>
      {/* 小开关 */}
      <span
        className={`relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full px-[2px] transition-colors ${
          isLight ? "bg-[#22c55e] justify-end" : "bg-[#333333] justify-start"
        }`}
      >
        <span className="h-[14px] w-[14px] rounded-full bg-white shadow" />
      </span>
    </button>
  );
}

export function Sidebar({ current, onChange }: SidebarProps) {
  const [openAdvanced, setOpenAdvanced] = useState(true);

  const isAdvActive = advancedSubItems.some((sub) => sub.id === current);

  return (
    <aside className="w-[210px] shrink-0 h-full flex flex-col justify-between py-5 px-3 bg-black select-none">
      {/* Top Header */}
      <div>
        <div className="flex items-center justify-between px-2 mb-6">
          <div className="flex items-center gap-2.5">
            <Icon.BotFace size={20} className="text-white" />
            <div className="leading-tight">
              <div className="text-[16px] font-bold text-white tracking-tight">Miubot</div>
              <div className="text-[11.5px] text-[#777777] font-normal">Agent Workspace</div>
            </div>
          </div>
          <span className="pill-green !text-[11px] !py-[2px] !px-2">运行中</span>
        </div>

        {/* Navigation items */}
        <nav className="space-y-1">
          {mainItems.map((item) => {
            const IconComp = Icon[item.icon];
            const active = current === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onChange(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] transition-colors text-left ${
                  active
                    ? "bg-[#262626] text-white font-medium shadow-sm"
                    : "text-[#999999] hover:text-white hover:bg-[#151515]"
                }`}
              >
                <IconComp size={16} className={active ? "text-white" : "text-[#888888]"} />
                <span>{item.label}</span>
              </button>
            );
          })}

          {/* Collapsible Advanced Config */}
          <div className="pt-1">
            <button
              onClick={() => setOpenAdvanced(!openAdvanced)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-[13.5px] transition-colors ${
                isAdvActive ? "text-white" : "text-[#999999] hover:text-white hover:bg-[#151515]"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon.ChevronDown
                  size={13}
                  className={`transition-transform text-[#888888] ${openAdvanced ? "rotate-0" : "-rotate-90"}`}
                />
                <span className="text-[13px]">高级配置</span>
              </div>
            </button>

            {openAdvanced && (
              <div className="pl-6 pt-1 space-y-0.5">
                {advancedSubItems.map((sub) => {
                  const active = current === sub.id;
                  return (
                    <button
                      key={sub.id}
                      onClick={() => onChange(sub.id)}
                      className={`w-full flex items-center px-3 py-1.5 rounded-lg text-[13px] text-left transition-colors ${
                        active
                          ? "bg-[#262626] text-white font-medium"
                          : "text-[#888888] hover:text-white hover:bg-[#151515]"
                      }`}
                    >
                      {sub.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </nav>
      </div>

      {/* Bottom fixed items */}
      <div className="space-y-1 pt-4 border-t border-transparent">
        <ThemeToggle />
        <button
          onClick={() => onChange("logs")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] text-left transition-colors ${
            current === "logs"
              ? "bg-[#262626] text-white font-medium"
              : "text-[#999999] hover:text-white hover:bg-[#151515]"
          }`}
        >
          <Icon.Scroll size={16} className={current === "logs" ? "text-white" : "text-[#888888]"} />
          <span>运行日志</span>
        </button>

        <button
          onClick={() => onChange("settings")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] text-left transition-colors ${
            current === "settings"
              ? "bg-[#262626] text-white font-medium"
              : "text-[#999999] hover:text-white hover:bg-[#151515]"
          }`}
        >
          <Icon.Gear size={16} className={current === "settings" ? "text-white" : "text-[#888888]"} />
          <span>设置</span>
        </button>

        <button
          onClick={() => {
            // 服务端撤销会话后刷新：AuthGate 会重新探测并停在登录页。
            void logout().finally(() => window.location.reload());
          }}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] text-left transition-colors text-[#999999] hover:text-white hover:bg-[#151515]"
        >
          <Icon.X size={16} className="text-[#888888]" />
          <span>退出登录</span>
        </button>
      </div>
    </aside>
  );
}
