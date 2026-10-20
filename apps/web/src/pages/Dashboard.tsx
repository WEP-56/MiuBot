import { useState } from "react";
import { Icon } from "../components/Icon";

type DashboardProps = {
  onNav: (page: string) => void;
};

export function Dashboard({ onNav }: DashboardProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">概览</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">Miubot 运行情况</p>
          </div>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-[#777777] hover:text-white p-1 rounded-lg hover:bg-[#1a1a1a] transition-colors"
          >
            <Icon.DotsHorizontal size={18} />
          </button>
        </div>

        {/* 2x2 Metric Cards from Sketch */}
        <div className="grid grid-cols-2 gap-3.5">
          {/* 今日消息 */}
          <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("sessions")}>
            <div className="flex items-center justify-between text-[#888888]">
              <span className="text-[13px] text-[#999999]">今日消息</span>
              <Icon.MessageCircle size={15} className="text-[#666666]" />
            </div>
            <div className="text-[26px] font-bold text-white mt-3 tracking-tight">1,284</div>
          </div>

          {/* Token 消耗 */}
          <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("providers")}>
            <div className="flex items-center justify-between text-[#888888]">
              <span className="text-[13px] text-[#999999]">Token 消耗</span>
              <Icon.Zap size={15} className="text-[#666666]" />
            </div>
            <div className="text-[26px] font-bold text-white mt-3 tracking-tight">2.6M</div>
          </div>

          {/* 在线 Bot */}
          <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("platforms")}>
            <div className="flex items-center justify-between text-[#888888]">
              <span className="text-[13px] text-[#999999]">在线 Bot</span>
              <Icon.BotCircle size={15} className="text-[#666666]" />
            </div>
            <div className="text-[26px] font-bold text-white mt-3 tracking-tight">2 / 2</div>
          </div>

          {/* API 成功率 */}
          <div className="sketch-card p-5 relative cursor-pointer" onClick={() => onNav("logs")}>
            <div className="flex items-center justify-between text-[#888888]">
              <span className="text-[13px] text-[#999999]">API 成功率</span>
              <Icon.CheckCircle size={15} className="text-[#666666]" />
            </div>
            <div className="text-[26px] font-bold text-white mt-3 tracking-tight">99.2%</div>
          </div>
        </div>

        {/* 平台连接 Card from Sketch */}
        <div
          className="sketch-card p-5 cursor-pointer"
          onClick={() => onNav("platforms")}
        >
          <div className="flex items-center justify-between mb-4">
            <span className="text-[15px] font-bold text-white">平台连接</span>
            <Icon.ExternalLink size={14} className="text-[#666666]" />
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-full border border-[#22c55e] flex items-center justify-center text-[#22c55e] text-[10px]">
                ✓
              </span>
              <span className="text-[14px] text-white font-medium">Miu · QQ</span>
            </div>
            <span className="text-[13px] text-[#888888]">在线</span>
          </div>
        </div>

        {/* 当前配置 Card from Sketch */}
        <div className="sketch-card p-5 space-y-4">
          <div className="text-[15px] font-bold text-white">当前配置</div>

          <div
            className="flex items-center justify-between pt-1 cursor-pointer group"
            onClick={() => onNav("providers")}
          >
            <span className="text-[13.5px] text-[#999999] group-hover:text-white transition-colors">提供商</span>
            <div className="flex items-center gap-1.5 text-[13px] text-[#dddddd]">
              <span>3 个 / 12 个模型</span>
              <Icon.ChevronRight size={13} className="text-[#777777]" />
            </div>
          </div>

          <div
            className="flex items-center justify-between cursor-pointer group"
            onClick={() => onNav("personas")}
          >
            <span className="text-[13.5px] text-[#999999] group-hover:text-white transition-colors">默认人格</span>
            <div className="flex items-center gap-1.5 text-[13px] text-[#dddddd]">
              <span>Miu</span>
              <Icon.ChevronRight size={13} className="text-[#777777]" />
            </div>
          </div>
        </div>

        {/* Detail drawer / extra info when clicked dots or toggled */}
        {showDetails && (
          <div className="sketch-card p-5 space-y-3 border border-[#333333] animate-fadeIn">
            <div className="flex items-center justify-between text-[13px] text-[#aaaaaa]">
              <span>系统运行详情</span>
              <span className="text-[11px] text-[#666666]">实时采集</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-[12.5px] pt-1">
              <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
                <div className="text-[#777777]">平均耗时</div>
                <div className="text-white font-semibold mt-1">412 ms</div>
              </div>
              <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
                <div className="text-[#777777]">估算费用</div>
                <div className="text-white font-semibold mt-1">¥18.42</div>
              </div>
              <div className="bg-[#161616] p-3 rounded-lg border border-[#262626]">
                <div className="text-[#777777]">Agent 触发</div>
                <div className="text-white font-semibold mt-1">318 次</div>
              </div>
            </div>
          </div>
        )}

        {/* Footnote matching sketch */}
        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            布局概念示意 · 数据为虚构样例
          </p>
        </div>
      </div>
    </div>
  );
}
