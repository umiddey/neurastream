// The probe loop (plan 20261027_1500, P2): when the provider rate-limits the main agent, wait for
// the named reset if the provider gave one; otherwise probe it every probe_interval_s until it
// answers, up to max_probes. The state transitions are pure (onLimited, onProbe); runProbe runs the
// configured probe command under the main-limit lock. The episode file (main-limit.json) and
// probeStep (one tick of the loop) live here too. Harness-neutral: nothing here names a harness or a provider.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { strftime } from "./clock.ts";
import { tryLock } from "./file-lock.ts";
import { appendMetric } from "./metrics.ts";
import { postReply } from "./notify.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";

/** One rate-limit episode of the main agent. Times are epoch ms. */
export interface LimitState {
	since: number;
	model: string;
	reset_named: boolean;
	next_probe_at: number;
	probes: number;
	last_error: string;
	back_at: number | null;
}

export interface ProbeTiming {
	probe_interval_s: number;
	max_probes: number;
	slack_s: number;
}

export type ProbeOutcome = { kind: "resume" } | { kind: "again"; at: number } | { kind: "give_up" };

export interface ProbeStep {
	state: LimitState;
	outcome: ProbeOutcome;
}

export interface ProbeResult {
	ok: boolean;
	exitCode: number | null;
	stderr: string;
}

export type ProbeRunner = (
	file: string,
	args: string[],
	opts: { timeout: number },
) => { status: number | null; stderr: string; error?: Error };

const defaultRun: ProbeRunner = (file, args, opts) => spawnSync(file, args, { ...opts, encoding: "utf8" as const });

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The main agent was rate-limited at `now`. A named reset (epoch ms) is waited for, plus slack;
 * without one the first probe comes after probe_interval_s.
 */
export function onLimited(
	state: LimitState | null,
	namedResetMs: number | null,
	errorText: string,
	now: number,
	model: string,
	timing: ProbeTiming,
): LimitState {
	const named = namedResetMs !== null;
	const next = named ? namedResetMs + timing.slack_s * 1000 : now + timing.probe_interval_s * 1000;
	return {
		since: state?.since ?? now,
		model,
		reset_named: named,
		next_probe_at: next,
		probes: state?.probes ?? 0,
		last_error: errorText,
		back_at: named ? next : null,
	};
}

/**
 * A probe finished at `now`. Every probe counts. A successful probe resumes; a failed one probes
 * again after probe_interval_s until max_probes is reached, then gives up.
 */
export function onProbe(state: LimitState, ok: boolean, errorText: string, now: number, timing: ProbeTiming): ProbeStep {
	const probes = state.probes + 1;
	if (ok) return { state: { ...state, probes }, outcome: { kind: "resume" } };
	if (probes >= timing.max_probes) {
		return { state: { ...state, probes, last_error: errorText }, outcome: { kind: "give_up" } };
	}
	const at = now + timing.probe_interval_s * 1000;
	return { state: { ...state, probes, last_error: errorText, next_probe_at: at }, outcome: { kind: "again", at } };
}

/**
 * Run guards.rate_limit.probe_cmd once, with {model} replaced by the shell-quoted model, under the
 * main-limit lock. Returns "busy" when another probe holds the lock. The output is never logged in
 * full: stderr is redacted, then cut to 200 characters.
 */
export function runProbe(cfg: Config, model: string, run: ProbeRunner = defaultRun): ProbeResult | "busy" {
	const lock = tryLock(join(cfg.paths.queue_state, "main-limit.lock"));
	if (!lock) return "busy";
	try {
		const rl = cfg.guards.rate_limit;
		const cmd = rl.probe_cmd.replaceAll("{model}", shellQuote(model));
		const r = run("sh", ["-c", cmd], { timeout: rl.probe_timeout_s * 1000 });
		const stderr = redactSecrets(r.stderr, loadKnownSecrets(cfg), cfg.secrets.extra_patterns).text.slice(0, 200);
		return { ok: r.status === 0 && !r.error, exitCode: r.status, stderr };
	} finally {
		lock.release();
	}
}

/** Where the open episode lives: one JSON file in queue_state, replaced atomically. */
export function limitStatePath(cfg: Config): string {
	return join(cfg.paths.queue_state, "main-limit.json");
}

/** The open episode, or null when there is none (or the file cannot be parsed). */
export function readLimitState(cfg: Config): LimitState | null {
	try {
		return JSON.parse(readFileSync(limitStatePath(cfg), "utf8")) as LimitState;
	} catch {
		return null;
	}
}

export function writeLimitState(cfg: Config, state: LimitState): void {
	const path = limitStatePath(cfg);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`);
	renameSync(`${path}.tmp`, path);
}

export function clearLimitState(cfg: Config): void {
	rmSync(limitStatePath(cfg), { force: true });
}

export function timingOf(cfg: Config): ProbeTiming {
	const rl = cfg.guards.rate_limit;
	return { probe_interval_s: rl.probe_interval_s, max_probes: rl.max_probes, slack_s: rl.slack_s };
}

/**
 * One tick of the probe loop at `now`. Returns "idle" when no episode is open, the episode is
 * already back, or the next probe is not due; "busy" when another probe holds the lock. Otherwise
 * runs one probe and records its outcome. A give-up closes the episode: one ⚠ post to the owner
 * chat (via `notify`, default the redacting postReply) and one `limit` metric. If the episode was
 * closed (turn-end disarm) or replaced while the probe ran, the result is dropped instead of
 * written back. A resume only marks the episode back — the adapter's tick posts the ✅ and the
 * metric when it sends Main's new turn.
 */
export function probeStep(
	cfg: Config,
	now: number,
	run: ProbeRunner = defaultRun,
	notify: (text: string) => void = (text) => {
		void postReply(text, cfg);
	},
): "idle" | "busy" | ProbeOutcome["kind"] {
	const st = readLimitState(cfg);
	if (!st || st.back_at !== null || now < st.next_probe_at) return "idle";
	const r = runProbe(cfg, st.model, run);
	if (r === "busy") return "busy";
	const current = readLimitState(cfg);
	if (!current || current.since !== st.since) return "idle";
	const timing = timingOf(cfg);
	const step = onProbe(current, r.ok, r.stderr, now, timing);
	if (step.outcome.kind === "give_up") {
		clearLimitState(cfg);
		appendMetric(cfg, limitMetric(step.state, now));
		notify(giveUpPost(timing));
	} else if (step.outcome.kind === "resume") writeLimitState(cfg, { ...step.state, back_at: now });
	else writeLimitState(cfg, step.state);
	return step.outcome.kind;
}

// ---- P4 tell + record: the owner-facing texts and the metric record of a finished episode ----
// Every text here is built from times and counts only; the error text in LimitState.last_error is
// unredacted, so no builder takes it — a post, the metric and the report line cannot carry it.

/** Minutes the main agent has been limited, from `since` to the episode's end. */
function limitedMinutes(state: LimitState, now: number): number {
	return Math.max(0, Math.round(((state.back_at ?? now) - state.since) / 60000));
}

/** A duration in whole units the owner reads at a glance: "24 h", "15 min", "5 s". */
function durationText(seconds: number): string {
	if (seconds >= 3600) return `${Math.round(seconds / 360) / 10} h`;
	if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
	return `${seconds} s`;
}

const clockHM = (ms: number): string => strftime(ms / 1000, "%H:%M");

/** The post when an episode opens: a named reset announces when it lifts, an unnamed one the probe cadence. */
export function limitedPost(state: LimitState, interval_s: number): string {
	const at = clockHM(state.since);
	return state.reset_named
		? `⏳ Main hit its limit at ${at}; resets at ${clockHM(state.next_probe_at)}`
		: `⏳ Main hit its limit at ${at}; checking every ${durationText(interval_s)}`;
}

/** The post when the provider answered or the named reset passed: times and counts only. */
export function backPost(state: LimitState): string {
	return `✅ Main is back at ${clockHM(state.back_at!)} (limited ${limitedMinutes(state, state.back_at!)} min, ${state.probes} checks)`;
}

/** The post when max_probes is spent without an answer. */
export function giveUpPost(timing: ProbeTiming): string {
	return `⚠ Main still limited after ${durationText(timing.max_probes * timing.probe_interval_s)}`;
}

/** The metric record of one finished episode: numbers and a boolean, never the error text. */
export function limitMetric(state: LimitState, now: number): Record<string, unknown> {
	return {
		type: "limit",
		since: state.since,
		back_at: state.back_at,
		minutes: limitedMinutes(state, now),
		probes: state.probes,
		reset_named: state.reset_named,
	};
}
