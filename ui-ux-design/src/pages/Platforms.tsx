import { useState } from "react";
import { Icon } from "../components/Icon";

type BotItem = {
  id: string;
  name: string;
  type: string;
  status: "connected" | "disconnected";
  heartbeat?: string;
  msgStatus?: string;
  protocol: string;
  adapter: string;
  endpoint: string;
};

const initialBots: BotItem[] = [
  {
    id: "b1",
    name: "Miu",
    type: "QQ 官方机器人",
    status: "connected",
    heartbeat: "正常",
    msgStatus: "正常",
    protocol: "QQ 官方开放平台",
    adapter: "官方 WebSocket Gateway",
    endpoint: "wss://api.sgroup.qq.com/websocket",
  },
  {
    id: "b2",
    name: "Miu Dev",
    type: "OneBot v11 · NapCat",
    status: "disconnected",
    protocol: "OneBot v11",
    adapter: "NapCat Core (v4.5.2)",
    endpoint: "ws://127.0.0.1:3001",
  },
];

export function Platforms() {
  const [bots, setBots] = useState<BotItem[]>(initialBots);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedBot, setSelectedBot] = useState<BotItem | null>(null);

  // Add bot wizard step
  const [wizardStep, setWizardStep] = useState(1);
  const [newPlatform, setNewPlatform] = useState("QQ 官方");
  const [newProtocol, setNewProtocol] = useState("OneBot v11 (NapCat)");

  return (
    <div className="flex-1 h-full overflow-y-auto bg-black text-white p-7 select-none">
      <div className="max-w-[760px] space-y-4">
        {/* Header from Sketch */}
        <div className="flex items-start justify-between pb-1">
          <div>
            <h1 className="text-[20px] font-bold text-white tracking-tight">平台</h1>
            <p className="text-[13px] text-[#777777] mt-0.5">管理消息平台和机器人连接</p>
          </div>
          <button
            onClick={() => {
              setWizardStep(1);
              setShowAddModal(true);
            }}
            className="btn-primary-white"
          >
            <Icon.Plus size={14} />
            <span>添加 Bot</span>
          </button>
        </div>

        {/* Bot Cards List from Sketch */}
        <div className="space-y-3">
          {bots.map((b) => (
            <div
              key={b.id}
              onClick={() => setSelectedBot(b)}
              className="sketch-card p-5 cursor-pointer transition-all hover:border-[#444444]"
            >
              {/* Top Row: icon + name + status pill + chevron */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="text-white">
                    <Icon.BotFace size={18} />
                  </div>
                  <div>
                    <div className="text-[15px] font-bold text-white tracking-tight leading-snug">
                      {b.name}
                    </div>
                    <div className="text-[12.5px] text-[#777777] font-normal">
                      {b.type}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {b.status === "connected" ? (
                    <span className="pill-green">已连接</span>
                  ) : (
                    <span className="pill-gray">未连接</span>
                  )}
                  <Icon.ChevronRight size={14} className="text-[#666666]" />
                </div>
              </div>

              {/* Bottom Row: Heartbeat & Message Status (only if connected, exactly like sketch) */}
              {b.status === "connected" && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-[rgba(255,255,255,0.06)] text-[13px]">
                  <div className="text-[#888888]">
                    最近心跳：<span className="text-white font-medium">{b.heartbeat}</span>
                  </div>
                  <div className="text-[#888888]">
                    消息收发：<span className="text-white font-medium">{b.msgStatus}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footnote matching sketch */}
        <div className="pt-2">
          <p className="text-[12.5px] text-[#555555]">
            页面组件示意，非真实连接状态
          </p>
        </div>
      </div>

      {/* Bot Detail Drawer / Modal */}
      {selectedBot && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm"
          onClick={() => setSelectedBot(null)}
        >
          <div
            className="sketch-card w-full max-w-[540px] p-6 space-y-4 border border-[#333333] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[#2a2a2a]">
              <div className="flex items-center gap-2.5">
                <Icon.BotFace size={18} className="text-white" />
                <span className="text-[16px] font-bold text-white">{selectedBot.name} 实例详情</span>
              </div>
              <button
                onClick={() => setSelectedBot(null)}
                className="text-[#777777] hover:text-white"
              >
                <Icon.X size={16} />
              </button>
            </div>

            <div className="space-y-3 text-[13px]">
              <div className="bg-[#141414] p-3 rounded-xl border border-[#262626] space-y-2">
                <div className="flex justify-between">
                  <span className="text-[#777777]">接入协议</span>
                  <span className="text-white font-mono">{selectedBot.protocol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#777777]">底层适配器</span>
                  <span className="text-white">{selectedBot.adapter}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#777777]">连接端点</span>
                  <span className="text-white font-mono text-[12px]">{selectedBot.endpoint}</span>
                </div>
              </div>

              <div className="p-3 bg-[#141414] rounded-xl border border-[#262626]">
                <div className="text-[13px] font-semibold text-white mb-2">适配能力说明</div>
                <div className="grid grid-cols-2 gap-2 text-[12px] text-[#aaaaaa]">
                  <div className="flex items-center gap-1.5"><span className="text-[#22c55e]">✓</span> 群聊消息与 @</div>
                  <div className="flex items-center gap-1.5"><span className="text-[#22c55e]">✓</span> 私聊与好友消息</div>
                  <div className="flex items-center gap-1.5"><span className="text-[#22c55e]">✓</span> 图片识别与收发</div>
                  <div className="flex items-center gap-1.5"><span className="text-[#22c55e]">✓</span> 语音/音频消息</div>
                  <div className="flex items-center gap-1.5"><span className="text-[#22c55e]">✓</span> 表情回应</div>
                  <div className="flex items-center gap-1.5"><span className="text-[#666666]">×</span> 频道 Markdown</div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  setBots(
                    bots.map((b) =>
                      b.id === selectedBot.id
                        ? {
                            ...b,
                            status: b.status === "connected" ? "disconnected" : "connected",
                            heartbeat: b.status === "connected" ? undefined : "正常",
                            msgStatus: b.status === "connected" ? undefined : "正常",
                          }
                        : b
                    )
                  );
                  setSelectedBot(null);
                }}
                className="btn-pill-dark"
              >
                {selectedBot.status === "connected" ? "断开连接" : "重连实例"}
              </button>
              <button
                onClick={() => setSelectedBot(null)}
                className="btn-primary-white"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Bot Step Wizard Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50 backdrop-blur-sm"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="sketch-card w-full max-w-[520px] p-6 space-y-4 border border-[#333333] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-[#2a2a2a]">
              <div>
                <div className="text-[16px] font-bold text-white">添加 Bot 实例</div>
                <div className="text-[12px] text-[#777777]">分步引导：平台 → 接入协议 → 连接参数</div>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-[#777777] hover:text-white"
              >
                <Icon.X size={16} />
              </button>
            </div>

            {/* Wizard Steps */}
            {wizardStep === 1 && (
              <div className="space-y-3">
                <div className="text-[13px] text-[#bbbbbb]">第 1 步：选择平台</div>
                <div className="space-y-2">
                  {["QQ 官方开放平台", "OneBot v11 (NapCat / LLOneBot)", "Kook (开黑啦)", "Telegram"].map((p) => (
                    <div
                      key={p}
                      onClick={() => setNewPlatform(p)}
                      className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between text-[13px] transition-colors ${
                        newPlatform === p
                          ? "bg-[#282828] border-white text-white font-medium"
                          : "bg-[#141414] border-[#292929] text-[#999999] hover:bg-[#1a1a1a]"
                      }`}
                    >
                      <span>{p}</span>
                      {newPlatform === p && <span className="text-[#22c55e]">✓</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-3">
                <div className="text-[13px] text-[#bbbbbb]">第 2 步：选择接入协议与方式</div>
                <div className="space-y-2">
                  {[
                    { title: "NapCat WebSocket (推荐)", desc: "无头 QQ 客户端，直接连接本地 WebSocket" },
                    { title: "AppID / AppSecret 官方直连", desc: "使用腾讯开放平台开发者凭证" },
                    { title: "扫码登录适配器", desc: "在适配器端扫码，自动下发登录 Token" },
                  ].map((proto) => (
                    <div
                      key={proto.title}
                      onClick={() => setNewProtocol(proto.title)}
                      className={`p-3 rounded-xl border cursor-pointer text-[13px] transition-colors ${
                        newProtocol === proto.title
                          ? "bg-[#282828] border-white text-white"
                          : "bg-[#141414] border-[#292929] text-[#999999] hover:bg-[#1a1a1a]"
                      }`}
                    >
                      <div className="font-medium text-white">{proto.title}</div>
                      <div className="text-[11.5px] text-[#777777] mt-0.5">{proto.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-3">
                <div className="text-[13px] text-[#bbbbbb]">第 3 步：填写连接参数并测试</div>
                <div className="space-y-2.5">
                  <div>
                    <div className="text-[12px] text-[#777777] mb-1">Bot 实例名称</div>
                    <input className="sketch-input w-full" defaultValue="Miu Ops" />
                  </div>
                  <div>
                    <div className="text-[12px] text-[#777777] mb-1">WebSocket 端点地址</div>
                    <input className="sketch-input w-full" defaultValue="ws://127.0.0.1:3002" />
                  </div>
                  <div>
                    <div className="text-[12px] text-[#777777] mb-1">访问令牌 Token (可选)</div>
                    <input className="sketch-input w-full" type="password" placeholder="留空或填 Access Token" />
                  </div>
                </div>
              </div>
            )}

            {/* Wizard actions */}
            <div className="flex justify-between items-center pt-2">
              <span className="text-[12px] text-[#666666]">步骤 {wizardStep} / 3</span>
              <div className="flex gap-2">
                {wizardStep > 1 && (
                  <button
                    onClick={() => setWizardStep(wizardStep - 1)}
                    className="btn-pill-dark"
                  >
                    上一步
                  </button>
                )}
                {wizardStep < 3 ? (
                  <button
                    onClick={() => setWizardStep(wizardStep + 1)}
                    className="btn-primary-white"
                  >
                    下一步
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setBots([
                        ...bots,
                        {
                          id: `b-${Date.now()}`,
                          name: "Miu Ops",
                          type: newPlatform,
                          status: "connected",
                          heartbeat: "正常",
                          msgStatus: "正常",
                          protocol: newProtocol,
                          adapter: "OneBot v11 Core",
                          endpoint: "ws://127.0.0.1:3002",
                        },
                      ]);
                      setShowAddModal(false);
                    }}
                    className="btn-primary-white"
                  >
                    保存并连接
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
