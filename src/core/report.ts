// The self-metrics report: this window against the previous one, the worst change, and a
// before/after check for each approved rule. Pure over RunSource, the ledger, metrics.jsonl
// and the guard logs; the caller decides where the text goes.

import type { Config } from "./config.ts";
import type { RunSource } from "./adapter.ts";
import { readIncidents, type IncidentView } from "./incidents.ts";
import {
	m1,
	m2,
	m3,
	m4,
	m5,
	readBlocks,
	readMetricEvents,
	windows,
	loadInputs,
	type Ev,
	type GuardBlock,
	type M1,
	type M2,
	type M3,
	type M4,
	type M5,
	type Window,
} from "./metrics.ts";

const DAY = 86400;

const CAVEAT =
	"M4 is a whole-run measure: a main run counts entirely by its last write time, so a run that spans a window edge counts in the window it ends in.";

interface Snap {
	m1: M1;
	m2: M2;
	m3: M3;
	m4: M4;
	m5: M5;
	m6: M6;
}

function day(t: number): string {
	return new Date(t * 1000).toISOString().slice(0, 10);
}

function snap(cfg: Config, source: RunSource, events: Ev[], blocks: GuardBlock[], incidents: IncidentView[], w: Window): Snap {
	const runs = source.listRuns(w.from);
	const patterns = cfg.metrics.correction_patterns.map((p) => new RegExp(p, "i"));
	return {
		m1: m1({ runs, events }, w),
		m2: m2({ runs, events }, w),
		m3: m3(events, w),
		m4: m4(runs, w, patterns),
		m5: m5(blocks, events, w),
		m6: m6(incidents, w),
	};
}

export interface M6 {
	/** Incidents opened in the window. */
	opened: number;
	/** Of those, how many stories ended in each resolution. */
	planned: number;
	dismissed: number;
	fixed: number;
	/** Median hours from opened to fixed among them; null without a fixed record's timestamp. */
	medianHours: number | null;
}

/** When the incident was fixed, or null while it is open / resolved otherwise / fixed by an old
 * record without a timestamp. */
function fixedAt(i: IncidentView): number | null {
	const r = i.resolution;
	return r !== null && r.type === "fixed" && typeof r.ts === "number" ? r.ts : null;
}

/** M6 (plan P5): the incident loop's own numbers for one window. Incidents opened before the
 * window belong to that window even if they were fixed inside this one. */
export function m6(incidents: IncidentView[], w: Window): M6 {
	const inW = incidents.filter((i) => i.ts >= w.from && i.ts < w.to);
	const byType = (type: string) => inW.filter((i) => i.resolution?.type === type).length;
	const hours = inW
		.map((i) => ({ opened: i.ts, at: fixedAt(i) }))
		.filter((x): x is { opened: number; at: number } => x.at !== null)
		.map((x) => (x.at - x.opened) / 3600)
		.sort((a, b) => a - b);
	const mid = Math.floor(hours.length / 2);
	const median = hours.length === 0 ? null : hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
	return { opened: inW.length, planned: byType("plan"), dismissed: byType("dismiss"), fixed: byType("fixed"), medianHours: median };
}

interface Row {
	/** Stable metric key (m1, m2, m3, m4_corrections, m4_questions, m4_users, m5). */
	key: string;
	name: string;
	cur: number | null;
	prev: number | null;
	fmt: (v: number | null) => string;
	/** M4 owner-message count is shown but never ranked: it measures volume, not quality. */
	rank: boolean;
}

function rowsOf(c: Snap, p: Snap): Row[] {
	const usd = (v: number | null) => (v === null ? "n/a (0 merged)" : `$${v.toFixed(2)}`);
	const num = (v: number | null) => (v === null ? "n/a" : String(v));
	const mean = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
	return [
		{ key: "m1", name: "M1 cost per merge", cur: c.m1.perMerge, prev: p.m1.perMerge, fmt: usd, rank: true },
		{ key: "m2", name: "M2 idle calls", cur: c.m2.calls, prev: p.m2.calls, fmt: num, rank: true },
		{ key: "m3", name: "M3 mean CI tries", cur: c.m3.mean, prev: p.m3.mean, fmt: mean, rank: true },
		{ key: "m4_corrections", name: "M4 owner corrections", cur: c.m4.corrections, prev: p.m4.corrections, fmt: num, rank: true },
		{ key: "m4_questions", name: "M4 Main questions", cur: c.m4.questions, prev: p.m4.questions, fmt: num, rank: true },
		{ key: "m4_users", name: "M4 owner messages", cur: c.m4.users, prev: p.m4.users, fmt: num, rank: false },
		{ key: "m5", name: "M5 guard blocks", cur: c.m5.blocks, prev: p.m5.blocks, fmt: num, rank: true },
	];
}

/** Percent change of this window against the previous one; null when either is missing or the base is 0. */
function change(r: Row): number | null {
	if (r.cur === null || r.prev === null || r.prev === 0) return null;
	return ((r.cur - r.prev) / r.prev) * 100;
}

function signed(d: number | null): string {
	if (d === null) return "n/a";
	return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function detail(c: Snap): string[] {
	const top2 = c.m2.top.map((t) => `${t.id} ${t.calls}`).join(", ") || "none";
	const reasons = c.m5.top.map((t) => `${t.count}× ${t.reason}`).join("; ") || "none";
	const median = c.m6.medianHours === null ? "n/a" : `${c.m6.medianHours.toFixed(1)}h`;
	return [
		`M1 worker $${c.m1.worker.toFixed(2)}, main $${c.m1.main.toFixed(2)}, accepts ${c.m1.accepts}`,
		`M2 top idle runs: ${top2}`,
		`M3 CI runs ${c.m3.n}; MRs at 3+ tries: ${c.m3.big.join(", ") || "none"}`,
		`M4 owner messages ${c.m4.users}, corrections ${c.m4.corrections}, Main questions ${c.m4.questions}`,
		`M5 guard blocks ${c.m5.blocks}, false alarms ${c.m5.falseAlarms}; top reasons: ${reasons}`,
		`M6 incidents ${c.m6.opened} opened, ${c.m6.planned} planned, ${c.m6.dismissed} dismissed, ${c.m6.fixed} fixed; median open→fixed ${median}`,
	];
}

/** Before/after per approved rule. A rule younger than one window reads "measuring". */
function ruleLines(cfg: Config, source: RunSource, events: Ev[], blocks: GuardBlock[], incidents: IncidentView[], days: number, now: number): string[] {
	const out: string[] = [];
	for (const e of events) {
		if (e.type !== "rule" || e.decision !== "approved") continue;
		const ts = Number(e.ts);
		const head = `- ${String(e.text)} (approved ${day(ts)})`;
		if (now - ts < days * DAY) {
			out.push(`${head}: measuring`);
			continue;
		}
		const before = snap(cfg, source, events, blocks, incidents, { from: ts - days * DAY, to: ts });
		const after = snap(cfg, source, events, blocks, incidents, { from: ts, to: ts + days * DAY });
		const perMerge = (s: Snap) => (s.m1.perMerge === null ? "n/a" : `$${s.m1.perMerge.toFixed(2)}`);
		const tries = (s: Snap) => (s.m3.mean === null ? "n/a" : s.m3.mean.toFixed(2));
		out.push(
			`${head}: M1 ${perMerge(before)} → ${perMerge(after)}; M2 idle calls ${before.m2.calls} → ${after.m2.calls}; ` +
				`M3 tries ${tries(before)} → ${tries(after)}; M5 blocks ${before.m5.blocks} → ${after.m5.blocks}`,
		);
	}
	return out.length ? out : ["(none approved yet)"];
}

export interface Report {
	/** The full markdown written to notes/metrics.md. */
	md: string;
	/** The same content without the generated header, for stdout. */
	text: string;
	/** The ranked row with the biggest percent increase; null when nothing ranked moved. */
	worst: { key: string; name: string; cur: number | null; prev: number | null; change: number | null } | null;
}

/** Weekly provider-honesty counts the report appends; the CLI caller builds them from the
 *  sessions root (core has no adapter), folding src/core/trace-provider.ts findings by kind. */
export interface ProviderSummary {
	/** Runs scanned inside the window. */
	runs: number;
	/** Findings by rule kind over those runs. */
	byKind: Record<string, number>;
}

/** Weekly prompt-bloat counts the report appends; built next to ProviderSummary by the same
 *  CLI caller, folding src/core/trace-bloat.ts findings over the runs touched in the window. */
export interface BloatSummary {
	/** Runs scanned inside the window. */
	runs: number;
	/** Runs with at least one prompt-bloat finding over those runs. */
	flagged: number;
	/** The largest first call among the flagged runs — the run's usage, else its matched
	 *  dump's stated prompt (a rejected call wrote no usage) — with the run id. */
	largest: { runId: string; firstCall: number } | null;
}

export function buildReport(cfg: Config, source: RunSource, days: number, now: number, provider?: ProviderSummary, bloat?: BloatSummary): Report {
	const inp = loadInputs(cfg, source, now, days);
	const events = [...inp.events, ...readMetricEvents(cfg)];
	const blocks = readBlocks(cfg);
	const incidents = readIncidents(cfg);
	const { cur, prev } = windows(now, days);
	const c = snap(cfg, source, events, blocks, incidents, cur);
	const p = snap(cfg, source, events, blocks, incidents, prev);

	const rows = rowsOf(c, p);
	let worst: Row | null = null;
	let worstPct = 0;
	for (const r of rows) {
		const d = change(r);
		if (r.rank && d !== null && d > worstPct) {
			worst = r;
			worstPct = d;
		}
	}
	const table = [
		"| metric | this window | previous | change |",
		"|---|---|---|---|",
		...rows.map((r) => {
			const mark = r === worst ? " ◀ worst" : "";
			return `| ${r.name} | ${r.fmt(r.cur)} | ${r.fmt(r.prev)} | ${signed(change(r))}${mark} |`;
		}),
	];
	const body = [
		`Self-metrics: last ${days} days [${day(cur.from)} to ${day(cur.to)}) vs previous ${days} days.`,
		"",
		...table,
		"",
		...detail(c),
		"",
		"Approved rules, before vs after:",
		...ruleLines(cfg, source, events, blocks, incidents, days, now),
		...(provider
			? [
					"",
					`Provider honesty over ${provider.runs} runs: ` +
						(Object.entries(provider.byKind)
							.filter(([, n]) => n > 0)
							.map(([k, n]) => `${n} ${k}`)
							.join(", ") || "no findings"),
				]
			: []),
		...(bloat
			? [
					"",
					`Prompt bloat over ${bloat.runs} runs: ${bloat.flagged} flagged` +
						(bloat.largest ? `, largest first call ${bloat.largest.firstCall} tokens (${bloat.largest.runId})` : ""),
				]
			: []),
	].join("\n");

	const md = [
		"# Self-metrics (GENERATED by `neurastream metrics report`; do not hand-edit)",
		"",
		CAVEAT,
		"",
		body,
		"",
	].join("\n");
	return {
		md,
		text: body,
		worst: worst ? { key: worst.key, name: worst.name, cur: worst.cur, prev: worst.prev, change: change(worst) } : null,
	};
}
