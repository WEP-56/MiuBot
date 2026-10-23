import { PageShell } from "../components/PageShell";
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";

type DashboardProps = {
  onNav: (page: string) => void;
};

/** 与服务端 `GET /api/overview` 一一对应；没有数据源的指标这里就没有字段。 */
type Overview = {
  version: string;
  uptimeSeconds: number;
  today: {
    messages: number;
    sessions: number;
    activePeers: number;
    proactiveSent: number;
    proactiveBlocked: number;
  };
  bots: { online: number; total: number };
  errorsLast24h: number;
  tokens: { input: number; output: number; cost: number } | null;
};

const numberFormat = new Intl.NumberFormat("zh-CN");

/** 秒 → `3h 12m`；不足 1 分钟给 `刚刚启动`。 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return "刚刚启动";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function Dashboard({ onNav }: DashboardProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/overview")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("bad status"))))
        .then((data: Overview) => {
          if (cancelled) return;
          setOverview(data);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    // 首页长期开着也不该显示一小时前的数字。
    const timer = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 首帧是 null：显示占位符而不是 0，否则会先闪一下「0 条消息」再跳变。
  const value = (text: string) => (overview ? text : "—");

  return (
    <PageShell>
      <div className="flex items-start justify-between pb-1">
        <div>
          <h1 className="text-[20px] font-bold text-white tracking-tight">概览</h1>
          <p className="text-[13px] text-[#777777] mt-0.5">Miubot 运行情况</p>
        </div>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-[#777777] hover:text-white p-1 rounded-lg hover:bg-[#1a1a1a] transition-colors"
          title="运行详情"
        >
          <Icon.DotsHorizontal size={18} />
        </button>
      </div>

      {failed && (
        <p className="text-[13px] text-red-400" role="status">
          无法连接 Miubot Server，数字为上次成功获取的值。
        </p>
      )}

      <div className="grid grid-cols-2 gap-3.5">
        <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("sessions")}>
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-[13px] text-[#999999]">今日消息</span>
            <Icon.MessageCircle size={15} className="text-[#666666]" />
          </div>
          <div className="text-[26px] font-bold text-white mt-3 tracking-tight">
            {value(numberFormat.format(overview?.today.messages ?? 0))}
          </div>
          <p className="text-[12px] text-[#666666] mt-1">
            今日会话 {overview?.today.sessions ?? 0} · 活跃对象 {overview?.today.activePeers ?? 0}
          </p>
        </div>

        <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("providers")}>
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-[13px] text-[#999999]">Token 消耗</span>
            <Icon.Zap size={15} className="text-[#666666]" />
          </div>
          <div className="text-[26px] font-bold text-white mt-3 tracking-tight">
            {overview?.tokens
              ? numberFormat.format(overview.tokens.input + overview.tokens.output)
              : value("未统计")}
          </div>
          <p className="text-[12px] text-[#666666] mt-1">
            {overview?.tokens ? `估算费用 ¥${overview.tokens.cost.toFixed(2)}` : "用量累计尚未接入"}
          </p>
        </div>

        <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("platforms")}>
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-[13px] text-[#999999]">在线 Bot</span>
            <Icon.BotCircle size={15} className="text-[#666666]" />
          </div>
          <div className="text-[26px] font-bold text-white mt-3 tracking-tight">
            {value(`${overview?.bots.online ?? 0} / ${overview?.bots.total ?? 0}`)}
          </div>
          <p className="text-[12px] text-[#666666] mt-1">
            {overview && overview.bots.total === 0 ? "还没有配置 Bot" : "已连接 / 已配置"}
          </p>
        </div>

        <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("proactive")}>
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-[13px] text-[#999999]">今日主动消息</span>
            <Icon.Zap size={15} className="text-[#666666]" />
          </div>
          <div className="text-[26px] font-bold text-white mt-3 tracking-tight">
            {value(numberFormat.format(overview?.today.proactiveSent ?? 0))}
          </div>
          <p className="text-[12px] text-[#666666] mt-1">被拦截 {overview?.today.proactiveBlocked ?? 0} 条</p>
        </div>
      </div>

      {showDetails && (
        <div className="sketch-card p-5 space-y-3 border border-[#333333] animate-fadeIn">
          <div className="flex items-center justify-between text-[13px] text-[#aaaaaa]">
            <span>系统运行详情</span>
            <span className="text-[11px] text-[#666666]">每 15 秒刷新</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[12.5px] pt-1 sm:grid-cols-4">
            <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
              <div className="text-[#777777]">今日会话</div>
              <div className="text-white font-semibold mt-1">{value(String(overview?.today.sessions ?? 0))}</div>
            </div>
            <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
              <div className="text-[#777777]">活跃对象</div>
              <div className="text-white font-semibold mt-1">{value(String(overview?.today.activePeers ?? 0))}</div>
            </div>
            <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
              <div className="text-[#777777]">近 24h 错误</div>
              <div className="text-white font-semibold mt-1">{value(String(overview?.errorsLast24h ?? 0))}</div>
            </div>
            <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
              <div className="text-[#777777]">版本 / 运行时长</div>
              <div className="text-white font-semibold mt-1">
                {overview ? `${overview.version} · ${formatUptime(overview.uptimeSeconds)}` : "—"}
              </div>
            </div>
          </div>
          <p className="text-[11.5px] text-[#666666]">
            错误数取自运行日志里的 ERROR 行，只说明「有报错」，不等于失败率。
          </p>
        </div>
      )}

      <div className="pt-2">
        <p className="text-[12.5px] text-[#555555]">
          数据每 15 秒刷新 · 今日口径为服务器本地时间的当天 0 点起
        </p>
      </div>
    </PageShell>
  );
}
