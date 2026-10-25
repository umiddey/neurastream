// Brief quality (plan 20261024_0305 traces_06): what a spawn brief says, joined to how its run went.
// Plain data in, plain data out. The harness adapter (src/adapters/<harness>/) finds the spawns;
// every regex and threshold comes from `traces.briefs` and `traces.efficiency` in config.

import type { TraceSource } from "./adapter.ts";
import { briefBudget } from "./guards.ts";
import { type EfficiencyRules, runEfficiency } from "./trace-efficiency.ts";

export interface BriefRules {
	verify_pattern: string;
	phase_pattern: string;
	plan_pattern: string;
}

export interface BriefJoinRules {
	brief: BriefRules;
	efficiency: EfficiencyRules;
}

export interface BriefFeatures {
	/** Length of the brief text in characters. */
	chars: number;
	/** The brief names a `path:line` location. */
	fileLines: boolean;
	/** The brief names a verify command (`traces.briefs.verify_pattern`). */
	verify: boolean;
	/** The brief sets a `Call budget: <N>` line (guards.briefBudget). */
	budget: boolean;
	/** Non-empty lines under the brief's Acceptance headings, summed. */
	acceptance: number;
	/** The brief names a phase (`traces.briefs.phase_pattern`). */
	phase: boolean;
	/** The brief names a plan file (`traces.briefs.plan_pattern`). */
	plan: boolean;
}

/** One spawned agent of a Main run and the brief it was spawned with. */
export interface SpawnBrief {
	agent: string;
	brief: string;
	/** Unix seconds of the spawn call; null when the line carries no readable timestamp. */
	ts: number | null;
}

export interface BriefRow {
	agent: string;
	ts: number | null;
	features: BriefFeatures;
	calls: number;
	wasted: number;
	/** null when the agent has no trace with calls: its waste is unknown, not zero. */
	waste_pct: number | null;
	accepted: boolean;
}

export interface BriefReportOpts {
	min_n: number;
	char_buckets: number[];
}

/** One side of a split: rows in the group, and the means that have at least min_n behind them. */
export interface SideStat {
	/** Rows on this side. */
	n: number;
	/** Rows on this side with a known waste percentage. */
	wasteN: number;
	/** Mean waste fraction over wasteN rows; null when wasteN < min_n. */
	waste: number | null;
	/** Accepted fraction over n rows; null when n < min_n. */
	accept: number | null;
}

export type BooleanFeature = "fileLines" | "verify" | "budget" | "phase" | "plan";

export interface FeatureReport {
	feature: BooleanFeature;
	with: SideStat;
	without: SideStat;
}

export interface BucketReport {
	label: string;
	stat: SideStat;
}

export interface BriefReport {
	features: FeatureReport[];
	buckets: BucketReport[];
}

const BOOLEAN_FEATURES: BooleanFeature[] = ["fileLines", "verify", "budget", "phase", "plan"];
/** A `path.ext:line` location. */
const FILE_LINE = /[\w./-]+\.[A-Za-z]{1,8}:\d+/;
const ACCEPTANCE_HEADING = /^#{1,6}\s*acceptance\b/i;
const HEADING = /^#{1,6}\s/;
/** Trace-score event types that count as the agent's work being accepted. */
const ACCEPT_TYPES: Record<string, true> = { accept: true, validate: true, diagnose: true };

/** Non-empty lines under each Acceptance heading, up to the next markdown heading. */
function acceptanceLines(brief: string): number {
	let inSection = false;
	let count = 0;
	for (const line of brief.split("\n")) {
		if (ACCEPTANCE_HEADING.test(line)) {
			inSection = true;
			continue;
		}
		if (HEADING.test(line)) inSection = false;
		else if (inSection && line.trim() !== "") count++;
	}
	return count;
}

export function briefFeatures(brief: string, rules: BriefRules): BriefFeatures {
	return {
		chars: brief.length,
		fileLines: FILE_LINE.test(brief),
		verify: new RegExp(rules.verify_pattern).test(brief),
		budget: briefBudget(brief) !== null,
		acceptance: acceptanceLines(brief),
		phase: new RegExp(rules.phase_pattern).test(brief),
		plan: new RegExp(rules.plan_pattern).test(brief),
	};
}

/**
 * One row per spawned agent. Waste comes from the agent's own trace (the run whose id is the
 * agent name); accepted is true when any score event of an accept type names that agent.
 */
export function briefRows(briefs: SpawnBrief[], traces: TraceSource, scores: Record<string, unknown>[], rules: BriefJoinRules): BriefRow[] {
	const accepted = new Set<string>();
	for (const e of scores) {
		if (typeof e.type === "string" && ACCEPT_TYPES[e.type] === true && typeof e.agent === "string") accepted.add(e.agent);
	}
	return briefs.map((b) => {
		const eff = runEfficiency(traces.events(b.agent), rules.efficiency);
		return {
			agent: b.agent,
			ts: b.ts,
			features: briefFeatures(b.brief, rules.brief),
			calls: eff.calls,
			wasted: eff.wasted,
			waste_pct: eff.calls > 0 ? eff.wastePct : null,
			accepted: accepted.has(b.agent),
		};
	});
}

function sideStat(rows: BriefRow[], minN: number): SideStat {
	const wastes = rows.map((r) => r.waste_pct).filter((w): w is number => w !== null);
	const accepted = rows.filter((r) => r.accepted).length;
	return {
		n: rows.length,
		wasteN: wastes.length,
		waste: wastes.length >= minN ? wastes.reduce((a, b) => a + b, 0) / wastes.length : null,
		accept: rows.length >= minN ? accepted / rows.length : null,
	};
}

/** Labels for the char buckets: `<e0`, `e0-(e1-1)`, ..., `>=eLast`; no edges means one bucket. */
function bucketLabels(edges: number[]): string[] {
	if (edges.length === 0) return ["all"];
	const labels = [`<${edges[0]}`];
	edges.forEach((lo, i) => {
		const hi = edges[i + 1];
		labels.push(hi === undefined ? `>=${lo}` : `${lo}-${hi - 1}`);
	});
	return labels;
}

export function briefReport(rows: BriefRow[], opts: BriefReportOpts): BriefReport {
	const features = BOOLEAN_FEATURES.map((feature) => ({
		feature,
		with: sideStat(
			rows.filter((r) => r.features[feature]),
			opts.min_n,
		),
		without: sideStat(
			rows.filter((r) => !r.features[feature]),
			opts.min_n,
		),
	}));
	// Bucket index = number of edges at or below the row's char count (edges are ascending).
	const buckets = bucketLabels(opts.char_buckets).map((label, i) => ({
		label,
		stat: sideStat(
			rows.filter((r) => opts.char_buckets.filter((e) => r.features.chars >= e).length === i),
			opts.min_n,
		),
	}));
	return { features, buckets };
}
