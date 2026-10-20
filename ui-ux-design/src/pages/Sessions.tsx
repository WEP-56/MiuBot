import { useState } from "react";
import { Icon } from "../components/Icon";

type SessionItem = {
  id: string;
  name: string;
  type: string;
  bot: string;
  enabled: boolean;
  persona: string;
  chatModel: string;
  proactive: string;
  stickers: string;
  imageVoice: string;
};

const sessionList: SessionItem[] = [
  {
    id: "s1",
    name: "摸鱼研究所",
    type: "QQ群",
    bot: "Miu",
    enabled: true,
    persona: "Miu",
    chatModel: "继承默认",
    proactive: "智能模式",
    stickers: "已启用",
    imageVoice: "启用 / 关闭",
  },
  {
    id: "s2",
    name: "V 圈杂谈",
    type: "QQ群",
    bot: "Miu",
    enabled: true,
    persona: "兔猫酱",
    chatModel: "claude-3.5-sonnet",
    proactive: "智能插话",
    stickers: "已启用",
    imageVoice: "已启用",
  },
  {
    id: "s3",
    name: "Alice (私聊)",
    type: "私聊",
    bot: "Miu",
    enabled: true,
    persona: "Miu",
    chatModel: "继承默认",
    proactive: "仅主动提问",
    stickers: "已启用",
    imageVoice: "已启用",
  },
];

const mockChatLogs = [
  { user: "摸鱼队长", text: "@Miu 这个报错怎么解决？", time: "12:42" },
  { user: "Miu", text: "看这个堆栈信息，是异步任务并发时没有捕获异常喵。加个 try/except 或者 return_exceptions=True 就行啦。", time: "12:42", isBot: true },
  { user: "小透明", text: "今天天气真好", time: "12:43" },
  { user: "Miu", text: "适合摸鱼晒太阳喵~", time: "12:43", isBot: true },
];

export function Sessions() {
  const [selectedId, setSelectedId] = useState("s1");
  const [activeTab, setActiveTab] = useState<"chat" | "config" | "context">("config");

  const current = sessionList.find((s) => s.id === selectedId) || sessionList[0];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Top Header */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">会话</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">群聊与私聊独立配置及记录</p>
          </div>
          {/* Quick Session Switcher Pill */}
          <div className="flex gap-1.5 bg-[#141414] p-1 rounded-full border border-[#222222]">
            {sessionList.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`px-3 py-1 rounded-full text-[12px] transition-colors ${
                  selectedId === s.id
                    ? "bg-[#282828] text-white font-medium shadow-sm"
                    : "text-[#888888] hover:text-white"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        {/* The Card exactly from Screenshot 2 / 3 */}
        <div className="sketch-card p-6 space-y-6">
          {/* Top Title Row from sketch */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <Icon.Users size={20} className="text-[#888888] mt-0.5" />
              <div>
                <div className="text-[18px] font-bold text-white tracking-tight leading-snug">
                  {current.name}
                </div>
                <div className="text-[13px] text-[#777777] font-normal">
                  {current.type} · {current.bot}
                </div>
              </div>
            </div>

            <div>
              {current.enabled ? (
                <span className="pill-green">已启用</span>
              ) : (
                <span className="pill-gray">已禁用</span>
              )}
            </div>
          </div>

          {/* Pill Tabs exactly from sketch */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setActiveTab("chat")}
              className={`btn-pill-dark ${activeTab === "chat" ? "active" : ""}`}
            >
              聊天记录
            </button>
            <button
              onClick={() => setActiveTab("config")}
              className={`btn-pill-dark ${activeTab === "config" ? "active" : ""}`}
            >
              会话配置
            </button>
            <button
              onClick={() => setActiveTab("context")}
              className={`btn-pill-dark ${activeTab === "context" ? "active" : ""}`}
            >
              上下文 / 记忆
            </button>
          </div>

          {/* TAB 1: 会话配置 (Exactly matches the sketch rows!) */}
          {activeTab === "config" && (
            <div className="space-y-4 pt-2">
              <div className="text-[13px] text-[#888888]">当前会话配置</div>

              <div className="space-y-3.5 text-[14px]">
                {/* 人格 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-[#cccccc]">人格</span>
                  <span className="text-white font-medium">{current.persona}</span>
                </div>

                {/* 聊天模型 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-[#cccccc]">聊天模型</span>
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{current.chatModel}</span>
                    <span className="text-[11px] text-[#666666] bg-[#171717] px-2 py-0.5 rounded border border-[#262626]">
                      全局默认
                    </span>
                  </div>
                </div>

                {/* 主动回复 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-[#cccccc]">主动回复</span>
                  <span className="text-white font-medium">{current.proactive}</span>
                </div>

                {/* 表情包 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-[#cccccc]">表情包</span>
                  <span className="text-white font-medium">{current.stickers}</span>
                </div>

                {/* 生图 / 语音 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-[#cccccc]">生图 / 语音</span>
                  <span className="text-white font-medium">{current.imageVoice}</span>
                </div>
              </div>

              {/* Inheritance note & override controls */}
              <div className="mt-6 pt-5 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between text-[12.5px] text-[#777777]">
                <div className="flex items-center gap-1.5">
                  <span>继承链：</span>
                  <span className="text-[#aaaaaa]">全局默认</span>
                  <span>→</span>
                  <span className="text-[#aaaaaa]">{current.bot} (实例)</span>
                  <span>→</span>
                  <span className="text-white font-medium">{current.name}</span>
                </div>
                <button className="text-[#22c55e] hover:underline cursor-pointer">
                  覆盖配置
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: 聊天记录 */}
          {activeTab === "chat" && (
            <div className="space-y-3 pt-2">
              <div className="text-[13px] text-[#888888]">会话实时记录</div>
              <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-1">
                {mockChatLogs.map((log, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-xl border text-[13px] ${
                      log.isBot
                        ? "bg-[#181818] border-[#292929] text-white"
                        : "bg-[#111111] border-[#202020] text-[#cccccc]"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11.5px] text-[#666666] mb-1">
                      <span className="font-semibold text-[#999999]">{log.user}</span>
                      <span>{log.time}</span>
                    </div>
                    <div>{log.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: 上下文 / 记忆 */}
          {activeTab === "context" && (
            <div className="space-y-4 pt-2 text-[13px]">
              <div className="text-[13px] text-[#888888]">注入上下文与长期群记忆</div>
              <div className="bg-[#141414] p-4 rounded-xl border border-[#242424] space-y-3">
                <div className="flex justify-between">
                  <span className="text-[#777777]">保留历史条数</span>
                  <span className="text-white font-mono">20 条</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#777777]">上下文压缩策略</span>
                  <span className="text-white">智能提取摘要</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#777777]">群偏好标签</span>
                  <span className="text-[#22c55e]">#代码调试 #闲聊 #不爱长篇大论</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footnote matching sketch */}
        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            会话层级规则配置，支持一键向上继承全局设定
          </p>
        </div>
      </div>
    </div>
  );
}
