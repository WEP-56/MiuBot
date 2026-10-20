import { useState } from "react";
import { Icon } from "../components/Icon";

export function Providers() {
  const [activeTab, setActiveTab] = useState<"providers" | "tasks">("providers");

  const providers = [
    {
      name: "OpenAI",
      protocol: "OpenAI Responses / Chat",
      models: "gpt-4o, o1, gpt-4o-mini",
      status: "connected",
      latency: "340ms",
    },
    {
      name: "Anthropic",
      protocol: "Anthropic Messages",
      models: "claude-3.5-sonnet, claude-3-haiku",
      status: "connected",
      latency: "410ms",
    },
    {
      name: "LmStudio Local",
      protocol: "OpenAI Compatible",
      models: "qwen2.5-32b-instruct",
      status: "connected",
      latency: "68ms",
    },
  ];

  const tasks = [
    { task: "日常聊天", defaultModel: "gpt-4o", fallback: "claude-3.5-sonnet" },
    { task: "复杂任务 / Agent", defaultModel: "o1", fallback: "gpt-4o" },
    { task: "主动回复判断", defaultModel: "gpt-4o-mini", fallback: "规则判断" },
    { task: "图片理解", defaultModel: "claude-3.5-sonnet", fallback: "备用视觉模型" },
    { task: "图片生成", defaultModel: "dall-e-3", fallback: "本地 SD" },
    { task: "语音识别 STT", defaultModel: "whisper-1", fallback: "本地引擎" },
    { task: "语音合成 TTS", defaultModel: "tts-1", fallback: "文字回复" },
    { task: "对话摘要 / 记忆提取", defaultModel: "gpt-4o-mini", fallback: "延后执行" },
  ];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Header matching sketch */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">提供商</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">AI 能力中心与模型任务路由</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>添加提供商</span>
          </button>
        </div>

        {/* Tab pills */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("providers")}
            className={`btn-pill-dark ${activeTab === "providers" ? "active" : ""}`}
          >
            提供商与模型
          </button>
          <button
            onClick={() => setActiveTab("tasks")}
            className={`btn-pill-dark ${activeTab === "tasks" ? "active" : ""}`}
          >
            任务模型分配
          </button>
        </div>

        {activeTab === "providers" ? (
          <div className="space-y-3">
            {providers.map((p) => (
              <div key={p.name} className="sketch-card p-5 cursor-pointer">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icon.Provider size={18} className="text-white" />
                    <div>
                      <div className="text-[15px] font-bold text-white">{p.name}</div>
                      <div className="text-[12.5px] text-[#777777]">{p.protocol}</div>
                    </div>
                  </div>
                  <span className="pill-green">已连接</span>
                </div>
                <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between text-[13px] text-[#888888]">
                  <div>包含模型：<span className="text-white">{p.models}</span></div>
                  <div>延迟：<span className="text-white font-mono">{p.latency}</span></div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="sketch-card p-5 space-y-4">
            <div className="text-[14px] font-bold text-white mb-2">默认任务分类分配</div>
            <div className="space-y-3 text-[13.5px]">
              {tasks.map((t) => (
                <div key={t.task} className="flex items-center justify-between py-1.5 border-b border-[rgba(255,255,255,0.04)]">
                  <span className="text-[#cccccc]">{t.task}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium bg-[#141414] px-2.5 py-1 rounded-lg border border-[#2a2a2a]">
                      {t.defaultModel}
                    </span>
                    <span className="text-[#555555]">→</span>
                    <span className="text-[#888888] bg-[#141414] px-2.5 py-1 rounded-lg border border-[#242424] text-[12.5px]">
                      回退: {t.fallback}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            失败或限流时自动触发回退策略，支持用量与预算限制
          </p>
        </div>
      </div>
    </div>
  );
}
