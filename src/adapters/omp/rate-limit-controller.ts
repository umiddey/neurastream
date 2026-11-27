// Rate-limit probe loop & provider-out recording (plans 20261025_1700, 20261027_1500).

import { spawn } from "node:child_process";
import { join } from "node:path";
import { strftime } from "../../core/clock.ts";
import type { Config } from "../../core/config.ts";
import { backPost, clearLimitState, limitMetric, limitedPost, onLimited, readLimitState, timingOf, writeLimitState } from "../../core/limit-probe.ts";
import { appendMetric } from "../../core/metrics.ts";
import { postReply } from "../../core/notify.ts";
import { pinModel, providerOfModel, recordOut, resetEpochFromText } from "../../core/provider-state.ts";
import { rateLimited } from "../../core/rate-limit.ts";
import { adapterLog, MAIN_ENV } from "./launch.ts";
import { asRecord, asString, type EventReply, type ExtensionHost, type HostCtx } from "./types.ts";

// Provider out-until from live data (plan 20261025_1700 P1). Two automatic recordings, both
// keyed on the provider half of an agent pin's `model:` frontmatter, both best effort and
// logged once. The reset-time case trusts the provider's own words; the no-time case falls
// back to the armed rate-limit wait, so a provider without a quoted reset time still lands in
// the file the guards and the ledger read.
const resetRule = (cfg: Config): { pattern: string; zone: string } => ({ pattern: cfg.quota.reset_pattern, zone: cfg.quota.reset_tz });

/** Task result that quotes a reset time: record it for the sub's provider. A batch naming
 *  several providers cannot attribute the time to one of them, so it records nothing. */
export function recordProviderOutFromTask(e: Record<string, unknown>, content: unknown[], cfg: Config): void {
	if (asString(e.toolName) !== "task" || e.isError === true) return;
	const text = content.map(p => asString(asRecord(p).text)).join("\n");
	const epoch = resetEpochFromText(text, resetRule(cfg));
	if (epoch === null) return;
	const tasks = Array.isArray(asRecord(e.input).tasks) ? (asRecord(e.input).tasks as unknown[]) : [];
	const providers = new Set<string>();
	for (const t of tasks) {
		const provider = providerOfModel(pinModel(cfg, asString(asRecord(t).agent)));
		if (provider) providers.add(provider);
	}
	if (providers.size !== 1) return;
	const provider = [...providers][0]!;
	recordOut(cfg, provider, epoch, "task-result");
	adapterLog(cfg, `PROVIDER-OUT recorded: ${provider} out until ${new Date(epoch * 1000).toISOString()} (task result)`);
}

/** Rate-limited turn end: record the reset time the error text names, else the armed wait. Returns the
 *  named reset in epoch ms (null when the text names none): the one parse of that text, which the call
 *  site passes on to the rate-limit episode (plan 20261027_1500 P2/P3). */
export function recordProviderOutFromRateLimit(reply: EventReply | null, untilMs: number, cfg: Config): number | null {
	const named = reply ? resetEpochFromText(reply.errorMessage ?? "", resetRule(cfg)) : null;
	const provider = reply?.provider ?? providerOfModel(reply?.model ?? null);
	if (provider) {
		const epoch = named ?? Math.floor(untilMs / 1000);
		recordOut(cfg, provider, epoch, named !== null ? "rate-limit-reset" : "rate-limit");
		adapterLog(cfg, `PROVIDER-OUT recorded: ${provider} out until ${new Date(epoch * 1000).toISOString()} (${named !== null ? "reset time in error text" : "rate limit, no reset time"})`);
	}
	return named === null ? null : named * 1000;
}

/** The limit tick: one check of the open episode every 30 s (plan 20261027_1500 P3). */
export const LIMIT_TICK_MS = 30_000;

/** The probe's command line and env. Never process.execPath: inside the harness that is the omp
 * binary, so the child was a full Main session (2026-11-03: stray Mains). bun comes from PATH, as
 * every bin's `#!/usr/bin/env bun` shebang does; the child env drops MAIN_ENV. */
export function limitProbeSpawn(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
	const { [MAIN_ENV]: _main, ...rest } = env;
	return { cmd: "nice", args: ["-n", "19", "bun", join(import.meta.dir, "../../cli/limit-probe.ts")], env: rest };
}

/** One limit probe as a niced child (cli/limit-probe.ts). It writes the episode state itself;
 * a failed start is logged and the next tick tries again. */
function spawnLimitProbeChild(cfg: Config): void {
	const p = limitProbeSpawn();
	const child = spawn(p.cmd, p.args, { detached: true, stdio: "ignore", env: p.env });
	child.on("error", err => adapterLog(cfg, `RATE-LIMIT probe: could not start: ${err.message}`));
	child.unref();
}

export interface RateLimitController {
	stopTick(): void;
	disarmEpisode(): void;
	onOwnerPrompt(): void;
	rateLimitOf(reply: EventReply | null): { untilMs: number } | null;
	onRateLimitedStop(c: HostCtx, namedResetMs: number | null, errorText: string, model: string): void;
}

/**
 * Creates the per-adapter rate-limit episode controller managing probe ticks, resume notifications,
 * and episode cleanup on clean turns or owner prompts.
 *
 * Args:
 *     pi (ExtensionHost): Active extension host used to send resume messages
 *     getCfg (() => Config): Accessor returning the adapter's current config
 *
 * Returns:
 *     RateLimitController: Controller methods bound to this adapter instance
 */
export function createRateLimitController(pi: ExtensionHost, getCfg: () => Config): RateLimitController {
	// Rate-limit probe loop (plan 20261027_1500 P3). A limited turn end opens one episode in
	// main-limit.json: a named reset is waited for; otherwise a niced probe child runs every
	// probe_interval_s until one gets through or max_probes is spent. ONE tick (LIMIT_TICK_MS)
	// reads the episode: it spawns a due probe, or, once the provider is back, sends Main ONE new
	// turn. A new Main turn cancels the tick and keeps the episode (probe count kept); a turn that
	// ends without a limit clears it.
	let limitTickArmed = false;
	let limitTick: NodeJS.Timeout | null = null;
	const rateClock = (ms: number): string => strftime(ms / 1000, "%H:%M");

	const stopTick = (): void => {
		limitTickArmed = false;
		if (limitTick !== null) {
			clearInterval(limitTick);
			limitTick = null;
		}
	};

	const disarmEpisode = (): void => {
		stopTick();
		clearLimitState(getCfg());
	};

	const limitTickFire = (c: HostCtx): void => {
		if (!limitTickArmed) return;
		const cfg = getCfg();
		const state = readLimitState(cfg);
		if (state === null) {
			stopTick();
			adapterLog(cfg, "RATE-LIMIT give up: episode state gone (max_probes spent or unreadable)");
			return;
		}
		const now = Date.now();
		if (state.back_at !== null) {
			if (now < state.back_at) return;
			stopTick();
			clearLimitState(cfg);
			// P4: the finished episode is recorded once and the owner hears one back post; both are
			// times and counts only — the episode's last_error never reaches chat or ledger.
			appendMetric(cfg, limitMetric(state, now));
			adapterLog(cfg, `RATE-LIMIT back: provider limit over (back at ${rateClock(state.back_at)}); new turn sent`);
			void postReply(backPost(state), cfg).then(results => {
				for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
			});
			pi.sendUserMessage(`main-guard: the provider limit is over (back at ${rateClock(state.back_at)}). Continue the queue where you stopped.`);
			return;
		}
		if (now < state.next_probe_at) return;
		(c.spawnLimitProbe ?? (() => spawnLimitProbeChild(cfg)))();
	};

	const armLimitTick = (c: HostCtx): void => {
		stopTick();
		limitTickArmed = true;
		const t: unknown = c.setInterval ? c.setInterval(() => limitTickFire(c), LIMIT_TICK_MS) : setInterval(() => limitTickFire(c), LIMIT_TICK_MS);
		if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
		limitTick = t as NodeJS.Timeout;
	};

	const onRateLimitedStop = (c: HostCtx, namedResetMs: number | null, errorText: string, model: string): void => {
		const cfg = getCfg();
		const prev = readLimitState(cfg);
		const timing = timingOf(cfg);
		const state = onLimited(prev, namedResetMs, errorText, Date.now(), model, timing);
		try {
			writeLimitState(cfg, state);
		} catch (err) {
			adapterLog(cfg, `RATE-LIMIT state write failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		adapterLog(cfg, `RATE-LIMIT stop: ${state.reset_named ? "named reset" : "probe"} at ${rateClock(state.next_probe_at)} (probes ${state.probes} of ${timing.max_probes})`);
		if (prev === null) {
			adapterLog(cfg, "notify: posted (rate-limit)");
			void postReply(limitedPost(state, timing.probe_interval_s), cfg).then(results => {
				for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
			});
		}
		armLimitTick(c);
	};

	const rateLimitOf = (reply: EventReply | null): { untilMs: number } | null => {
		const rl = getCfg().guards.rate_limit;
		const hit = rateLimited(reply?.stopReason ?? null, reply?.errorMessage ?? null, rl);
		if (!hit) return null;
		const waitMs = (hit.retryAfterMs ?? rl.probe_interval_s * 1000) + rl.slack_s * 1000;
		return { untilMs: Date.now() + waitMs };
	};

	const onOwnerPrompt = (): void => {
		if (!limitTickArmed) return;
		stopTick();
		adapterLog(getCfg(), "RATE-LIMIT tick cancelled: owner message (probe count kept)");
	};

	return {
		stopTick,
		disarmEpisode,
		onOwnerPrompt,
		rateLimitOf,
		onRateLimitedStop,
	};
}
