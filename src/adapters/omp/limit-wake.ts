// Main's limit wake (plan 20261127_1005 P2). When a counted Main call cap or edit window resets
// while plans are still open, Main gets ONE continuation at the reset instead of sitting parked
// until the owner speaks. The wake lives in memory only: a restart or reload drops it, and the
// next owner prompt or stop re-evaluates the limits anyway.

import { currentTier } from "../../core/autonomy.ts";
import type { Config } from "../../core/config.ts";
import { editWindowEndMs, mainCallsCapOn, mainCallsResetMs, mainEditLimit, openQueue, readWindow } from "../../core/guards.ts";
import { adapterLog } from "./launch.ts";
import { LIMIT_TICK_MS } from "./rate-limit-controller.ts";
import type { ExtensionHost, HostCtx } from "./types.ts";

const WAKE_TEXT = "main-guard: the call/edit limit has reset — continue the queue where you stopped.";

export interface LimitWake {
	/** At session_stop's allow: one tick at the latest reset still holding Main, when plans are open. */
	arm(c: HostCtx): void;
	/** An owner prompt, or a reset of the adapter, drops the wake. */
	cancel(): void;
}

/** The latest reset (ms since epoch) of a limit still holding Main at `now`; null when none does. */
function pendingResetMs(cfg: Config, now: number): number | null {
	const w = readWindow(cfg.paths);
	const tier = currentTier(cfg);
	const resets: number[] = [];
	const calls = mainCallsResetMs(w);
	if (mainCallsCapOn(cfg, tier) && w.mainCalls >= cfg.guards.main_max_calls && calls !== null && calls > now) resets.push(calls);
	const edits = editWindowEndMs(w, cfg);
	if (w.used.length >= mainEditLimit(cfg, tier) && edits > now) resets.push(edits);
	return resets.length > 0 ? Math.max(...resets) : null;
}

/** Plans still open; none when the queue cannot be read (logged: the stop path reports that itself). */
function openPlans(cfg: Config): string[] {
	try {
		return openQueue(cfg.paths, cfg.review.agents);
	} catch (err) {
		adapterLog(cfg, `LIMIT-WAKE skipped: queue unreadable: ${err}`);
		return [];
	}
}

export function createLimitWake(pi: ExtensionHost, getCfg: () => Config): LimitWake {
	// The arm snapshots the reset time; the tick only compares the clock with it and never re-reads
	// the window, because the terminal hand-back zeroes mainCalls right after session_stop.
	let wakeAt: number | null = null;
	let tick: NodeJS.Timeout | null = null;

	const cancel = (): void => {
		wakeAt = null;
		if (tick !== null) {
			clearInterval(tick);
			tick = null;
		}
	};

	const fire = (): void => {
		if (wakeAt === null || Date.now() < wakeAt) return;
		const cfg = getCfg();
		cancel();
		if (openPlans(cfg).length === 0) {
			adapterLog(cfg, "LIMIT-WAKE none: the limit reset with no open plan");
			return;
		}
		adapterLog(cfg, "LIMIT-WAKE sent: the limit reset with plans open");
		pi.sendUserMessage(WAKE_TEXT);
	};

	return {
		arm(c) {
			cancel();
			const cfg = getCfg();
			const reset = pendingResetMs(cfg, Date.now());
			if (reset === null || openPlans(cfg).length === 0) return;
			wakeAt = reset;
			const t: unknown = c.setInterval ? c.setInterval(fire, LIMIT_TICK_MS) : setInterval(fire, LIMIT_TICK_MS);
			if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
			tick = t as NodeJS.Timeout;
		},
		cancel,
	};
}
