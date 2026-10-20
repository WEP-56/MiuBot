import { useState } from "react";
import { Icon } from "../components/Icon";

export function Personas() {
  const [selectedPersona, setSelectedPersona] = useState("Miu");
  const [testInput, setTestInput] = useState("");
  const [testChat, setTestChat] = useState([
    { role: "user", text: "今天好累啊，感觉摸不动鱼了…" },
    { role: "bot", text: "辛苦啦喵~ 先喝杯温水歇歇眼睛，要不要我给你念两句轻松的段子？" },
  ]);

  const personas = [
    { name: "Miu", role: "猫娘助手 · 温柔治愈", default: true, tone: "温和、善用波浪号与表情" },
    { name: "兔猫酱", role: "活泼二次元 · 元气", default: false, tone: "爱开玩笑、高频表情包" },
    { name: "通用助手", role: "干练中性 · 职业", default: false, tone: "精简、直奔要点" },
  ];

  const handleSend = () => {
    if (!testInput.trim()) return;
    setTestChat([
      ...testChat,
      { role: "user", text: testInput },
      { role: "bot", text: `[${selectedPersona}] 收到啦喵！这行提示词即时生效中。` },
    ]);
    setTestInput("");
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[840px] space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">人格</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">角色的身份与行为设定，右侧支持即时测试</p>
          </div>
          <button className="btn-primary-white">
            <Icon.Plus size={14} />
            <span>新建人格</span>
          </button>
        </div>

        {/* Two-column layout in sketch style */}
        <div className="grid grid-cols-2 gap-4">
          {/* Left Column: Settings */}
          <div className="space-y-3">
            {/* Persona Switcher Cards */}
            <div className="space-y-2">
              {personas.map((p) => (
                <div
                  key={p.name}
                  onClick={() => setSelectedPersona(p.name)}
                  className={`sketch-card p-4 cursor-pointer transition-colors ${
                    selectedPersona === p.name ? "border-white bg-[#262626]" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Icon.Persona size={16} className="text-white" />
                      <span className="text-[14px] font-bold text-white">{p.name}</span>
                    </div>
                    {p.default ? (
                      <span className="pill-green !text-[11px]">默认人格</span>
                    ) : (
                      <span className="pill-gray !text-[11px]">可选</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#777777] mt-2">{p.role}</div>
                </div>
              ))}
            </div>

            {/* Prompt Editor */}
            <div className="sketch-card p-5 space-y-3">
              <div className="text-[14px] font-bold text-white">核心设定 (System Prompt)</div>
              <textarea
                className="sketch-input w-full h-[120px] text-[13px] resize-none leading-relaxed"
                defaultValue="你是 Miu，一只温柔而可靠的猫娘助手。语气平稳治愈，适度使用表情，回复尽量控制在 3 句以内。"
              />
              <div className="flex items-center justify-between text-[12px] text-[#777777] pt-1">
                <span>语言风格：温和、爱开玩笑</span>
                <span className="text-[#22c55e]">已保存</span>
              </div>
            </div>
          </div>

          {/* Right Column: Instant Test Chat */}
          <div className="sketch-card p-5 flex flex-col justify-between h-[420px]">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-[rgba(255,255,255,0.06)]">
                <span className="text-[14px] font-bold text-white">即时测试面板</span>
                <span className="text-[12px] text-[#888888]">测试人格：{selectedPersona}</span>
              </div>

              <div className="space-y-3 pt-3 overflow-y-auto max-h-[280px] pr-1">
                {testChat.map((msg, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-xl text-[13px] ${
                      msg.role === "user"
                        ? "bg-[#161616] border border-[#2b2b2b] text-[#dddddd] ml-6"
                        : "bg-[#242424] text-white mr-6"
                    }`}
                  >
                    <div className="text-[10.5px] text-[#666666] mb-1">
                      {msg.role === "user" ? "测试者" : selectedPersona}
                    </div>
                    <div>{msg.text}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-3 border-t border-[rgba(255,255,255,0.06)]">
              <input
                className="sketch-input flex-1"
                placeholder={`向 ${selectedPersona} 发送测试消息...`}
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
              />
              <button onClick={handleSend} className="btn-primary-white">
                <Icon.Send size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
