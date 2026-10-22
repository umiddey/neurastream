// Self-metrics: numbers about Neurastream's own work, per time window. Pure functions over
// runs (via RunSource), the score ledger (events.jsonl) and metrics.jsonl (ci, false-alarm,
// rule). No harness names, no literals beyond the event types; every knob comes from the
// `metrics:` config section.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// ---- metrics.jsonl: the facts the owner and the CI command record ----

export function metricsPath(cfg: Config): string {
	return join(cfg.paths.score_state, "metrics.jsonl");
}

/** Appends one JSON line; the state directory is created on first use. */
export function appendMetric(cfg: Config, rec: Ev): void {
	mkdirSync(cfg.paths.score_state, { recursive: true });
	appendFileSync(metricsPath(cfg), `${JSON.stringify(rec)}\n`);
}

export function readMetricEvents(cfg: Config): Ev[] {
	const path = metricsPath(cfg);
	if (!existsSync(path)) return [];
	const out: Ev[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as Ev);
		} catch {
			// A torn line from an interrupted append is skipped, not fatal.
		}
	}
	return out;
}

// ---- M1, M2: cost and idle calls per merge ----

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

// ---- M3: CI tries ----

export interface M3 {
	n: number;
	/** null when no ci events fall in the window. */
	mean: number | null;
	/** MRs that needed 3 or more pipelines. */
	big: string[];
}

/** M3: mean `tries` of `ci` events in the window, and the MRs that needed 3 or more. */
export function m3(events: Ev[], w: Window): M3 {
	const ci = events.filter((e) => e.type === "ci" && inWindow(Number(e.ts), w));
	const sum = ci.reduce((s, e) => s + Number(e.tries), 0);
	return {
		n: ci.length,
		mean: ci.length > 0 ? sum / ci.length : null,
		big: ci.filter((e) => Number(e.tries) >= 3).map((e) => String(e.mr)),
	};
}

// ---- M4: owner corrections and Main's questions ----

interface Block {
	type: string;
	text: string;
}

/**
 * Content blocks from RunMessage.text, which is a JSON dump of the message content. A plain
 * string content counts as one text block; a dump that is not JSON is taken as plain text.
 */
function blocks(raw: string): Block[] {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return [{ type: "text", text: raw }];
	}
	if (typeof v === "string") return [{ type: "text", text: v }];
	if (!Array.isArray(v)) return [];
	const out: Block[] = [];
	for (const b of v) {
		if (typeof b !== "object" || b === null) continue;
		const o = b as Record<string, unknown>;
		if (typeof o.text === "string") out.push({ type: String(o.type ?? ""), text: o.text });
	}
	return out;
}

export interface M4 {
	users: number;
	corrections: number;
	questions: number;
}

/**
 * M4: user messages in main runs written in the window, how many match a correction pattern,
 * and assistant messages whose last text block ends in "?". RunMessage has no timestamp, so
 * a main run counts whole by its lastWriteAt.
 */
export function m4(runs: Run[], w: Window, patterns: RegExp[]): M4 {
	const out: M4 = { users: 0, corrections: 0, questions: 0 };
	for (const r of runs) {
		if (r.kind !== "main" || !inWindow(r.lastWriteAt, w)) continue;
		for (const m of r.messages) {
			if (m.role === "user") {
				out.users++;
				const text = blocks(m.text)
					.map((b) => b.text)
					.join("\n");
				if (patterns.some((p) => p.test(text))) out.corrections++;
			} else if (m.role === "assistant") {
				const last = blocks(m.text)
					.filter((b) => b.type === "text")
					.at(-1);
				if (last?.text.trimEnd().endsWith("?")) out.questions++;
			}
		}
	}
	return out;
}

// ---- M5: guard BLOCK lines and false alarms ----

export interface GuardBlock {
	ts: number;
	reason: string;
}

/** Groups reasons by shape: paths cut to 40 chars, then digit runs collapsed to N. */
function reasonKey(text: string): string {
	return text.replace(/\S*\/\S*/g, (p) => (p.length > 40 ? `${p.slice(0, 40)}…` : p)).replace(/\d+/g, "N");
}

/** BLOCK lines of one guard log, each `<ISO UTC> BLOCK <reason>`. Other lines are ignored. */
export function parseBlocks(text: string): GuardBlock[] {
	const out: GuardBlock[] = [];
	for (const line of text.split("\n")) {
		const m = /^(\S+) BLOCK (.*)$/.exec(line);
		if (!m) continue;
		const ts = Date.parse(m[1] ?? "") / 1000;
		if (Number.isNaN(ts)) continue;
		out.push({ ts, reason: reasonKey(m[2] ?? "") });
	}
	return out;
}

/** BLOCK lines from both guard logs named in config. A missing log counts as none. */
export function readBlocks(cfg: Config): GuardBlock[] {
	return [cfg.paths.guard_log, cfg.paths.plan_guard_log].flatMap((p) =>
		existsSync(p) ? parseBlocks(readFileSync(p, "utf8")) : [],
	);
}

export interface M5 {
	blocks: number;
	falseAlarms: number;
	top: { reason: string; count: number }[];
}

/** M5: BLOCK lines in the window, false-alarm events in the window, and the 3 most common reasons. */
export function m5(blocks: GuardBlock[], events: Ev[], w: Window): M5 {
	const inBlocks = blocks.filter((b) => inWindow(b.ts, w));
	const counts = new Map<string, number>();
	for (const b of inBlocks) counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
	const top = [...counts]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
		.slice(0, 3);
	return {
		blocks: inBlocks.length,
		falseAlarms: events.filter((e) => e.type === "false-alarm" && inWindow(Number(e.ts), w)).length,
		top,
	};
}
