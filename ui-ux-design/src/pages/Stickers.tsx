import { useState } from "react";
import { Icon } from "../components/Icon";

export function Stickers() {
  const [activeTab, setActiveTab] = useState<"all" | "labeled" | "pending">("all");

  const stickers = [
    { emoji: "🐱", title: "摸摸头", emotion: "开心 / 安慰", status: "已标注", count: "142次" },
    { emoji: "😑", title: "无语凝噎", emotion: "无语 / 吐槽", status: "已标注", count: "89次" },
    { emoji: "😴", title: "深夜躺平", emotion: "疲惫 / 晚安", status: "已标注", count: "51次" },
    { emoji: "👍", title: "赞同点赞", emotion: "得意 / 鼓励", status: "已标注", count: "64次" },
    { emoji: "☕", title: "优雅喝茶", emotion: "摸鱼 / 闲适", status: "待审核", count: "12次" },
    { emoji: "❓", title: "疑问歪头", emotion: "好奇 / 困惑", status: "待审核", count: "33次" },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">表情包管理</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">表情包库 · 视觉理解与自动标注识别</p>
          </div>
          <div className="flex gap-2">
            <button className="btn-pill-dark">
              <span>批量导入</span>
            </button>
            <button className="btn-primary-white">
              <Icon.Plus size={14} />
              <span>添加表情</span>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("all")}
            className={`btn-pill-dark ${activeTab === "all" ? "active" : ""}`}
          >
            全部 (124)
          </button>
          <button
            onClick={() => setActiveTab("labeled")}
            className={`btn-pill-dark ${activeTab === "labeled" ? "active" : ""}`}
          >
            已标注 (89)
          </button>
          <button
            onClick={() => setActiveTab("pending")}
            className={`btn-pill-dark ${activeTab === "pending" ? "active" : ""}`}
          >
            待审核 / AI建议 (35)
          </button>
        </div>

        {/* Stickers Grid */}
        <div className="grid grid-cols-3 gap-3.5">
          {stickers.map((s, i) => (
            <div key={i} className="sketch-card p-4 space-y-3 cursor-pointer">
              <div className="h-[90px] bg-[#141414] rounded-xl flex items-center justify-center text-[40px] border border-[#252525]">
                {s.emoji}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-bold text-white">{s.title}</span>
                  {s.status === "已标注" ? (
                    <span className="pill-green !text-[10px] !py-[1px] !px-2">已标注</span>
                  ) : (
                    <span className="pill-gray !text-[10px] !py-[1px] !px-2">AI 建议</span>
                  )}
                </div>
                <div className="text-[12px] text-[#777777] mt-1">{s.emotion}</div>
                <div className="text-[11.5px] text-[#555555] mt-2 flex justify-between">
                  <span>被触发 {s.count}</span>
                  <span className="text-[#888888] hover:text-white">编辑标签</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            视觉模型自动提取情绪与语义标签，用户审核确认后生效
          </p>
        </div>
      </div>
    </div>
  );
}
