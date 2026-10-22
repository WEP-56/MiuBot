import { describe, expect, it, vi } from "vitest";
import { createPlatformEventBus, type NormalizedPlatformEvent } from "../src/platform/events.ts";

function event(overrides: Partial<NormalizedPlatformEvent> = {}): NormalizedPlatformEvent {
	return {
		eventId: "evt-1",
		type: "platform.friend.added",
		platform: "qq",
		botId: "bot-1",
		timestamp: "2026-10-21T00:00:00Z",
		payload: {},
		...overrides,
	};
}

describe("platform event bus", () => {
	it("isolates subscriber failures and timeouts", async () => {
		const errors: unknown[] = [];
		const bus = createPlatformEventBus({ timeoutMs: 20, onError: (error) => errors.push(error) });
		const received: string[] = [];

		bus.subscribe("platform.friend.added", () => {
			throw new Error("boom");
		});
		bus.subscribe("platform.friend.added", () => new Promise<void>(() => {}));
		const unsubscribe = bus.subscribe("platform.friend.added", () => {
			received.push("ok");
		});
		bus.subscribe("*", (incoming) => {
			received.push(`any:${incoming.type}`);
		});

		await bus.emit(event());

		expect(received).toEqual(["ok", "any:platform.friend.added"]);
		expect(errors).toHaveLength(2);

		unsubscribe();
		expect(bus.listenerCount("platform.friend.added")).toBe(2);
	});

	it("stops delivering after unsubscribe", async () => {
		const bus = createPlatformEventBus();
		const handler = vi.fn();
		const unsubscribe = bus.subscribe("*", handler);
		unsubscribe();
		await bus.emit(event());
		expect(handler).not.toHaveBeenCalled();
	});

	it("aborts the subscriber signal on timeout", async () => {
		const bus = createPlatformEventBus({ timeoutMs: 10, onError: () => {} });
		let observed: AbortSignal | undefined;
		let abortReason: unknown;
		const started = new Promise<void>((resolve) => {
			bus.subscribe("platform.friend.added", (_incoming, signal) => {
				observed = signal;
				signal.addEventListener("abort", () => {
					abortReason = signal.reason;
					resolve();
				});
				// 故意忽略取消信号，验证宿主仍能继续分发。
				return new Promise<void>(() => {});
			});
		});

		await bus.emit(event());
		await started;

		expect(observed?.aborted).toBe(true);
		expect(abortReason).toBeInstanceOf(Error);
	});

	it("passes a live signal to every subscriber", async () => {
		const bus = createPlatformEventBus();
		const signals: AbortSignal[] = [];
		bus.subscribe("*", (_incoming, signal) => {
			signals.push(signal);
		});
		bus.subscribe("platform.friend.added", (_incoming, signal) => {
			signals.push(signal);
		});

		await bus.emit(event());

		expect(signals).toHaveLength(2);
		for (const signal of signals) expect(signal.aborted).toBe(false);
	});
});
