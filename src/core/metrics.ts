// Self-metrics: numbers about Neurastream's own work, per time window. Pure functions over
// runs (via RunSource) and the score ledger (events.jsonl). No harness names, no literals
// beyond the ledger event types; every knob comes from the `metrics:` config section.

import type { Config } from "./config.ts";
import type { Run, RunSource } from "./adapter.ts";
import { readEvents } from "./agent-score.ts";

export type Ev = Record<string, unknown>;

/** Half-open window [from, to) in unix seconds. */
export interface Window {
	from: number;
	to: number;
}

export interface Inputs {
	runs: Run[];
	events: Ev[];
}

const DAY = 86400;

/** Current window [now-N, now) and the one before it [now-2N, now-N). */
export function windows(now: number, days: number): { cur: Window; prev: Window } {
	const span = days * DAY;
	return {
		cur: { from: now - span, to: now },
		prev: { from: now - 2 * span, to: now - span },
	};
}

export function inWindow(t: number, w: Window): boolean {
	return t >= w.from && t < w.to;
}

/** Loads every run touched in the last two windows plus the full event ledger. */
export function loadInputs(cfg: Config, source: RunSource, now: number, days: number): Inputs {
	return {
		runs: source.listRuns(now - 2 * days * DAY),
		events: readEvents(cfg),
	};
}

export interface M1 {
	accepts: number;
	worker: number;
	main: number;
	/** null when nothing was merged in the window. */
	perMerge: number | null;
}

/** M1: cost of sub and main runs written in the window, per accepted merge in the window. */
export function m1(inp: Inputs, w: Window): M1 {
	let worker = 0;
	let main = 0;
	for (const r of inp.runs) {
		if (!inWindow(r.lastWriteAt, w)) continue;
		if (r.kind === "sub") worker += r.cost;
		else if (r.kind === "main") main += r.cost;
	}
	const accepts = inp.events.filter((e) => e.type === "accept" && inWindow(Number(e.ts), w)).length;
	return {
		accepts,
		worker,
		main,
		perMerge: accepts > 0 ? (worker + main) / accepts : null,
	};
}

/** Event types that mean a worker's output was judged at some point. */
const JUDGED: Record<string, true> = { accept: true, diagnose: true, validate: true };

export interface M2 {
	calls: number;
	top: { id: string; calls: number }[];
}

/**
 * M2: calls spent by finished-or-died sub runs written in the window that never got an
 * accept, diagnose or validate event (checked over the whole ledger, not just the window).
 */
export function m2(inp: Inputs, w: Window): M2 {
	const judged = new Set(inp.events.filter((e) => JUDGED[String(e.type)] === true).map((e) => String(e.agent)));
	const idle = inp.runs.filter(
		(r) =>
			r.kind === "sub" &&
			inWindow(r.lastWriteAt, w) &&
			(r.status === "done" || r.status === "died") &&
			!judged.has(r.id),
	);
	const top = idle
		.map((r) => ({ id: r.id, calls: r.calls }))
		.sort((a, b) => b.calls - a.calls || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, 3);
	return { calls: idle.reduce((s, r) => s + r.calls, 0), top };
}
