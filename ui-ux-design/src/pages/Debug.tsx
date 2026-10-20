import { useState } from "react";
import { Icon } from "../components/Icon";

export function Debug() {
  const [model, setModel] = useState("gpt-4o");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    { role: "user", text: "@Miu 帮我总结一下今天群里的要点" },
    {
      role: "trace",
      text: "Trace: tr-9b21 | 命中规则: @提及 | 选用模型: gpt-4o | 上下文大小: 18条 | 耗时: 382ms",
    },
    {
      role: "bot",
      text: "今天群里主要聊了三件事喵：\n1. 摸鱼研究所讨论了异步协程的异常处理；\n2. 大家对赛博风生图效果表示好评；\n3. 晚饭吃什么还没定下来。",
    },
  ]);

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([
      ...messages,
      { role: "user", text: input },
      {
        role: "trace",
        text: `Trace: tr-${Math.random().toString(16).slice(2, 6)} | 模拟调用 | 选用模型: ${model} | 耗时: 290ms`,
      },
      { role: "bot", text: `(调试台响应 · 模型 ${model}) 收到模拟请求：${input}` },
    ]);
    setInput("");
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">调试台</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">选择环境与配置，模拟聊天以验证配置是否生效</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setMessages([])} className="btn-pill-dark">
              <span>清空历史</span>
            </button>
          </div>
        </div>

        {/* Configuration bar */}
        <div className="sketch-card p-4 flex items-center justify-between text-[13px]">
          <div className="flex items-center gap-3">
            <span className="text-[#888888]">模拟环境：</span>
            <span className="bg-[#141414] px-3 py-1 rounded-lg border border-[#2a2a2a] text-white">
              群聊 · 摸鱼研究所
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[#888888]">模型：</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="bg-[#141414] px-3 py-1 rounded-lg border border-[#2a2a2a] text-white outline-none cursor-pointer"
            >
              <option value="gpt-4o">gpt-4o (主聊天)</option>
              <option value="claude-3.5-sonnet">claude-3.5-sonnet (备用)</option>
              <option value="o1">o1 (复杂推理)</option>
            </select>
          </div>
        </div>

        {/* Chat Log container */}
        <div className="sketch-card p-5 space-y-3 min-h-[380px] flex flex-col justify-between">
          <div className="space-y-3 overflow-y-auto max-h-[320px] pr-1">
            {messages.map((m, i) => {
              if (m.role === "trace") {
                return (
                  <div
                    key={i}
                    className="p-2.5 rounded-lg bg-[#141414] border border-[#262626] text-[11.5px] font-mono text-[#888888]"
                  >
                    {m.text}
                  </div>
                );
              }
              const isUser = m.role === "user";
              return (
                <div
                  key={i}
                  className={`p-3 rounded-xl text-[13px] ${
                    isUser
                      ? "bg-[#161616] border border-[#2a2a2a] text-[#cccccc] ml-12"
                      : "bg-[#242424] text-white mr-12"
                  }`}
                >
                  <div className="text-[11px] text-[#666666] mb-1 font-medium">
                    {isUser ? "模拟群成员" : "Miu"}
                  </div>
                  <div className="whitespace-pre-line leading-relaxed">{m.text}</div>
                </div>
              );
            })}
          </div>

          <div className="flex gap-2 pt-3 border-t border-[rgba(255,255,255,0.06)]">
            <input
              className="sketch-input flex-1"
              placeholder="输入模拟群消息，如 @Miu 讲个笑话..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
            />
            <button onClick={handleSend} className="btn-primary-white">
              <Icon.Send size={13} />
              <span>发送</span>
            </button>
          </div>
        </div>

        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            调试台不会向真实 QQ 发送任何消息，仅在前端与后端沙箱执行测试
          </p>
        </div>
      </div>
    </div>
  );
}
