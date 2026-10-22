import type { createAgentHost } from "./agent-host.ts";
import type { LogLevel } from "./logging.ts";
import type { AppConfig } from "./runtime.ts";
import { tagStickerImage } from "./sticker-tagger.ts";
import type { StickerStore } from "./stickers.ts";

type AgentHost = ReturnType<typeof createAgentHost>;

export type StickerTagging = {
	/** 排一次打标；已有排期或未配置打标模型时直接返回。 */
	schedule(delayMs?: number): void;
	/** 有新对话：推进版本号并中止在跑的打标，避免和用户回复抢模型。 */
	notifyConversationActivity(): void;
	/** 打标模型变化：中止任务，清空重试计数与定时器（调用方随后自行排期）。 */
	reset(): void;
};

/**
 * 表情包自动打标：串行、单飞、对话优先。
 *
 * 同一时间只处理一张；Agent Loop 在跑（或期间有新消息）就让路，30 秒后再试。
 * 每张最多重试 3 次，成功后清计数。
 */
export function createStickerTagging(deps: {
	getConfig(): AppConfig;
	stickerStore: StickerStore;
	agentHost: AgentHost;
	log(level: LogLevel, text: string, sessionId?: string): void;
}): StickerTagging {
	const { getConfig, stickerStore, agentHost, log } = deps;
	const attempts = new Map<string, number>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: { stickerId: string; controller: AbortController } | undefined;
	/** 对话版本号：每次有新消息就前进，用于丢弃「打标期间情况已变」的结果。 */
	let activityVersion = 0;

	function schedule(delayMs = 5_000): void {
		const config = getConfig();
		if (timer || !config.tools.stickerTaggerProviderId || !config.tools.stickerTaggerModelId) return;
		timer = setTimeout(() => {
			timer = undefined;
			void runNext().catch((error: unknown) => {
				log("WARN", `表情包打标任务异常：${error instanceof Error ? error.message : String(error)}`);
				schedule(30_000);
			});
		}, delayMs);
	}

	async function runNext(): Promise<void> {
		if (active) return;
		const version = activityVersion;
		if (agentHost.anyAgentLoopRunning()) {
			schedule(30_000);
			return;
		}
		const config = getConfig();
		const provider = config.providers.find(
			(item) => item.id === config.tools.stickerTaggerProviderId && item.enabled && item.apiKey,
		);
		const modelConfig = provider?.models.find(
			(item) => item.id === config.tools.stickerTaggerModelId && item.supportsVision,
		);
		if (!provider || !modelConfig) return;
		const sticker = (await stickerStore.list()).find(
			(item) =>
				item.status === "pending" &&
				!item.description &&
				item.tags.length === 0 &&
				(attempts.get(item.id) ?? 0) < 3,
		);
		if (!sticker) return;
		if (version !== activityVersion || agentHost.anyAgentLoopRunning()) {
			schedule(30_000);
			return;
		}
		const controller = new AbortController();
		active = { stickerId: sticker.id, controller };
		const loopMonitor = setInterval(() => {
			if (agentHost.anyAgentLoopRunning()) controller.abort();
		}, 250);
		try {
			const bytes = await stickerStore.image(sticker.id);
			if (!bytes) throw new Error("表情包文件不存在");
			const model = await agentHost.getPiModel(provider, modelConfig);
			if (controller.signal.aborted || version !== activityVersion || agentHost.anyAgentLoopRunning()) {
				controller.abort();
				return;
			}
			const annotation = await tagStickerImage(
				await agentHost.getModelRuntime(),
				model,
				bytes,
				sticker.mimeType,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			const current = await stickerStore.get(sticker.id);
			if (current?.status === "pending" && !current.description && current.tags.length === 0) {
				await stickerStore.update(sticker.id, { description: annotation.description, tags: annotation.tags });
				attempts.delete(sticker.id);
				log("INFO", `表情包自动打标完成：${sticker.fileName}`);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const count = (attempts.get(sticker.id) ?? 0) + 1;
				attempts.set(sticker.id, count);
				log(
					"WARN",
					`表情包自动打标失败（${count}/3）：${sticker.fileName}；${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			clearInterval(loopMonitor);
			active = undefined;
			schedule(30_000);
		}
	}

	return {
		schedule,
		notifyConversationActivity() {
			activityVersion++;
			if (!active) return;
			active.controller.abort();
			log("INFO", `收到新对话，中止表情包打标：${active.stickerId}`);
		},
		reset() {
			// 不在这里清 `active`：在跑的任务会在 finally 里自己收尾，否则会与其清理过程重叠。
			active?.controller.abort();
			attempts.clear();
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
