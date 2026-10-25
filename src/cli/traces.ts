// `neurastream traces claims …` (plan 20261024_0300 P3): check what a run's final report CLAIMS
// against what the same run's tool activity shows. Claims come from the run's last assistant
// message; a claim with no backing toolResult line, git output, heavy-run call or edit/write is
// reported as a claim-unbacked finding (src/core/incident-detectors.ts D5).
// `neurastream traces actions …` (plan 20261024_0301 P2): list the suspicious tool actions a
// run's trace shows (src/core/trace-actions.ts); the high ones fold into the incident store as
// realtime `suspicious-action` incidents (D6). Read-only over the sessions root; --json prints
// machine-readable records.
// `neurastream traces efficiency …` (plan 20261024_0304 P2): count the run's wasted tool calls
// under the config's waste rules (src/core/trace-efficiency.ts).

import { join } from "node:path";
import { nowSec } from "../core/clock.ts";
import type { TraceEvent, TraceSource } from "../core/adapter.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { claimUnbacked } from "../core/incident-detectors.ts";
import { claimsFromEvents, type RelatedRun } from "../core/trace-claims.ts";
import { actionsRules, suspiciousActions, type ActionsRules, type SuspiciousAction } from "../core/trace-actions.ts";
import { bloatBreakdown, bloatFindings, bloatRules, callSizes, dumpFinding, type BloatBreakdown, type BloatRules } from "../core/trace-bloat.ts";
import { efficiencyRules, runEfficiency, RULE_ORDER, type EfficiencyRules, type WasteRule } from "../core/trace-efficiency.ts";
import { pyPercent0 } from "../core/pyfmt.ts";
import { dumpModel, dumpParts, dumpPromptTokens, ompDumps, ompTraceRuns, ompTraceSource, ompTraceStart, subagentTraces } from "../adapters/omp/traces.ts";

export const TRACES_USAGE = [
	"usage: neurastream traces claims <runId> [--json]",
	"       neurastream traces claims --since <N m|h|d> [--json]",
	"       neurastream traces actions <runId> [--json]",
	"       neurastream traces actions --since <N m|h|d> [--json]",
	"       neurastream traces efficiency <runId> [--json]",
	"       neurastream traces efficiency --since <N m|h|d> [--json]",
	"       neurastream traces bloat [<runId>] [--since <N m|h|d>] [--json]   # default window 24h",
].join("\n");

const SINCE = /^(\d+)(m|h|d)$/;

export interface RunClaimsReport {
	runId: string;
	claims: number;
	backed: number;
	unbacked: { kind: string; summary: string; evidence?: string }[];
}

/** Verify one run: claims from its final report, findings for the ones no tool output backs. A
 * Main run's report also checks the toolResult text of the subagent runs under its session dir
 * (`related`, INCIDENT I-20261025-23): the evidence for a cited subagent result lives in the
 * subagent's own session, and a match there backs the claim as `subagent:<name>`. */
export function claimsReport(src: TraceSource, runId: string, related: RelatedRun[] = []): RunClaimsReport {
	const events = src.events(runId);
	const claims = claimsFromEvents(events);
	const findings = claimUnbacked(claims, events, related);
	return {
		runId,
		claims: claims.length,
		backed: claims.length - findings.length,
		unbacked: findings.map((f) => ({ kind: f.kind, summary: f.summary, evidence: f.evidence })),
	};
}

export interface RunActionsReport {
	runId: string;
	/** Every suspicious tool action the run's trace shows, evidence masked and capped. */
	actions: SuspiciousAction[];
}

/** Scan one run: every suspicious tool action its trace shows, under the config's rules. */
export function actionsReport(src: TraceSource, runId: string, rules: ActionsRules): RunActionsReport {
	return { runId, actions: suspiciousActions(src.events(runId), rules) };
}

export interface RunEfficiencyReport {
	runId: string;
	calls: number;
	wasted: number;
	wastePct: number;
	byRule: Record<WasteRule, number>;
}

/** Count one run's wasted tool calls under the config's waste rules. */
export function efficiencyReport(src: TraceSource, runId: string, rules: EfficiencyRules): RunEfficiencyReport {
	return { runId, ...runEfficiency(src.events(runId), rules) };
}

export interface RunBloatReport {
	runId: string;
	/** Model calls in the run (usage-bearing assistant messages, folded per response id). */
	calls: number;
	/** Prompt tokens (input + cacheRead + cacheWrite) of the first call; null when the run made none. */
	firstPrompt: number | null;
	maxPrompt: number | null;
	/** prompt-bloat findings; evidence masked and capped. */
	findings: { kind: string; summary: string; evidence?: string }[];
	/** What filled the prompt, from the uniquely assigned failed-request dump. */
	breakdown?: BloatBreakdown;
	/** The prompt the assigned dump's error response states. */
	dumpPrompt?: { tokens: number; limit?: number };
}

/**
 * Scan one run's calls and findings, and report the dump assigned to it by the caller. The
 * command assigns dumps across runs by window, matching model and closest event timestamp.
 */
export interface DumpAssignmentRun { runId: string; file: string; mtimeSec: number }
export interface DumpAssignment { owners: Map<string, string>; unmatched: { file: string; ms: number }[]; events: Map<string, TraceEvent[]> }

/** Assign each dump once, parsing only traces whose session start and mtime contain it. */
export function assignDumps(runs: DumpAssignmentRun[], src: TraceSource, dumps: { file: string; ms: number }[]): DumpAssignment {
	const owners = new Map<string, string>();
	const unmatched: { file: string; ms: number }[] = [];
	const cached = new Map<string, ReturnType<TraceSource["events"]>>();
	for (const dump of dumps) {
		const model = dumpModel(dump.file);
		const eligible: { ts: number; runId: string }[] = [];
		for (const run of runs) {
			if (dump.ms > Math.round(run.mtimeSec * 1000)) continue;
			const start = ompTraceStart(run.file);
			if (start !== null && dump.ms < start * 1000) continue;
			let events = cached.get(run.runId);
			if (!events) {
				events = src.events(run.runId);
				cached.set(run.runId, events);
			}
			let firstTs: number | undefined;
			let closestTs: number | undefined;
			for (const event of events) {
				if (event.ts === null || event.ts * 1000 > dump.ms) continue;
				if (firstTs === undefined || event.ts < firstTs) firstTs = event.ts;
				if (model !== undefined && event.model === model && (closestTs === undefined || event.ts > closestTs)) closestTs = event.ts;
			}
			if (firstTs !== undefined && dump.ms >= firstTs * 1000 && closestTs !== undefined) eligible.push({ runId: run.runId, ts: closestTs });
		}
		const bestTs = eligible.reduce((best, item) => Math.max(best, item.ts), -Infinity);
		const best = eligible.filter((item) => item.ts === bestTs);
		if (best.length === 1) owners.set(dump.file, best[0]!.runId);
		else unmatched.push(dump);
	}
	return { owners, unmatched, events: cached };
}

export function bloatReport(src: TraceSource, runId: string, rules: BloatRules, groupRegex: string, dumps: { file: string; ms: number }[], mtimeSec: number, parsedEvents?: TraceEvent[]): RunBloatReport {
	const events = parsedEvents ?? src.events(runId);
	const sizes = callSizes(events);
	const findings = bloatFindings(events, rules);
	let breakdown: BloatBreakdown | undefined;
	let dumpPrompt: { tokens: number; limit?: number } | undefined;
	let first: number | undefined;
	for (const e of events) {
		if (e.ts !== null) {
			first = e.ts;
			break;
		}
	}
	if (first !== undefined) {
		const dump = dumps.find((d) => d.ms >= first * 1000 && d.ms <= Math.round(mtimeSec * 1000));
		if (dump) {
			breakdown = bloatBreakdown(dumpParts(dump.file), groupRegex);
			const stated = dumpPromptTokens(dump.file);
			if (stated) {
				dumpPrompt = { tokens: stated.tokens, ...(stated.limit !== undefined ? { limit: stated.limit } : {}) };
				if (findings.length === 0) {
					const f = dumpFinding(runId, stated, rules);
					if (f) findings.push(f);
				}
			}
		}
	}
	return {
		runId,
		calls: sizes.length,
		firstPrompt: sizes[0]?.prompt ?? null,
		maxPrompt: sizes.length > 0 ? sizes.reduce((m, c) => Math.max(m, c.prompt), 0) : null,
		findings,
		...(breakdown ? { breakdown } : {}),
		...(dumpPrompt ? { dumpPrompt } : {}),
	};
}

/** `neurastream traces claims|actions|efficiency|bloat`: one run by id, or every run touched inside a --since window. */
export async function runTraces(args: string[], opts: { home?: string } = {}): Promise<number> {
	const sub = args[0];
	if (sub !== "claims" && sub !== "actions" && sub !== "efficiency" && sub !== "bloat") {
		console.error(TRACES_USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig(opts.home === undefined ? undefined : { home: opts.home });
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
	const rest = args.slice(1);
	let runId: string | undefined;
	let windowSec: number | undefined;
	let json = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--json") {
			json = true;
		} else if (a === "--since") {
			const m = SINCE.exec(rest[++i] ?? "");
			if (!m) {
				console.error(TRACES_USAGE);
				return 2;
			}
			// SINCE only matches digits followed by m, h or d, so the unit is one of the three.
			windowSec = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "d" ? 86400 : 60);
		} else if (runId !== undefined) {
			console.error(TRACES_USAGE);
			return 2;
		} else {
			runId = a;
		}
	}
	// `bloat` without a selector scans the plan's default window instead of demanding one.
	if (sub === "bloat" && runId === undefined && windowSec === undefined) windowSec = 24 * 3600;
	if ((runId !== undefined) === (windowSec !== undefined)) {
		console.error(TRACES_USAGE);
		return 2;
	}
	const runs = ompTraceRuns(root);
	const src = ompTraceSource(root);
	const rules: ActionsRules | EfficiencyRules | BloatRules | null = sub === "actions" ? actionsRules(cfg) : sub === "efficiency" ? efficiencyRules(cfg) : sub === "bloat" ? bloatRules(cfg) : null;
	// A Main run's report cites its subagents' results: their traces under the Main session dir
	// back the pure result-line claims (P5). No time filter — the text match is the guard, and
	// a sub's file keeps being written while its Main run lives, inside whatever window.
	const relatedOf = (id: string): RelatedRun[] =>
		sub === "claims" ? subagentTraces(root, id).map(({ name, events }) => ({ name, events })) : [];
	const dumps = sub === "bloat" ? ompDumps(cfg.paths.home) : [];
	const assignment = sub === "bloat" ? assignDumps(runs, src, dumps) : { owners: new Map<string, string>(), unmatched: [] as { file: string; ms: number }[], events: new Map<string, TraceEvent[]>() };
	const dumpOwners = assignment.owners;
	const unmatchedDumps = assignment.unmatched;
	const mtimeOf = (id: string): number => runs.find((r) => r.runId === id)?.mtimeSec ?? 0;
	const assignedDumps = (id: string) => dumps.filter((dump) => dumpOwners.get(dump.file) === id);
	const reports: (RunClaimsReport | RunActionsReport | RunEfficiencyReport | RunBloatReport)[] = [];
	const reportOf = (id: string): RunClaimsReport | RunActionsReport | RunEfficiencyReport | RunBloatReport => {
		if (sub === "claims") return claimsReport(src, id, relatedOf(id));
		if (sub === "actions") return actionsReport(src, id, rules as ActionsRules);
		if (sub === "efficiency") return efficiencyReport(src, id, rules as EfficiencyRules);
		return bloatReport(src, id, rules as BloatRules, cfg.traces.bloat.tool_group, assignedDumps(id), mtimeOf(id), assignment.events.get(id));
	};
	if (windowSec !== undefined) {
		const cutoff = nowSec() - windowSec;
		for (const r of runs) {
			if (r.mtimeSec < cutoff) continue;
			reports.push(reportOf(r.runId));
		}
	} else {
		if (!runs.some((r) => r.runId === runId)) {
			console.error(`no trace for run ${runId}`);
			return 1;
		}
		reports.push(reportOf(runId!));
	}
	if (json) {
		console.log(JSON.stringify(sub === "bloat" ? { reports, unmatchedDumps } : reports, null, 2));
		return 0;
	}
	for (const r of reports) {
		if ("claims" in r) {
			if (r.claims === 0) {
				console.log(`${r.runId}: no verifiable claims in the final report`);
				continue;
			}
			console.log(`${r.runId}: ${r.claims} claims, ${r.backed} backed, ${r.unbacked.length} unbacked`);
			for (const u of r.unbacked) {
				console.log(`  ${u.kind}: ${u.summary}`);
				if (u.evidence) console.log(`    evidence: ${u.evidence}`);
			}
		} else if ("byRule" in r) {
			console.log(`${r.runId}: ${r.calls} calls, ${r.wasted} wasted (${pyPercent0(r.wastePct)})`);
			for (const rule of RULE_ORDER) console.log(`  ${rule}: ${r.byRule[rule]}`);
		} else if ("calls" in r) {
			if (r.calls === 0 && r.findings.length === 0) {
				console.log(`${r.runId}: no model calls in the trace`);
				continue;
			}
			console.log(`${r.runId}: ${r.calls} calls, first ${r.firstPrompt ?? "-"}, max ${r.maxPrompt ?? "-"} (${r.findings.length === 0 ? "no prompt-bloat" : `${r.findings.length} prompt-bloat`})`);
			for (const f of r.findings) {
				console.log(`  ${f.kind}: ${f.summary}`);
				if (f.evidence) console.log(`    evidence: ${f.evidence}`);
			}
			if (r.breakdown) {
				console.log(`  prompt parts: ${r.breakdown.parts.map((p) => `${p.name} ${p.bytes}`).join(", ")}`);
				console.log(`  top tools: ${r.breakdown.tools.map((t) => `${t.name} ${t.bytes}`).join(", ")}`);
			}
		} else {
			if (r.actions.length === 0) {
				console.log(`${r.runId}: no suspicious actions in the trace`);
				continue;
			}
			const high = r.actions.filter((a) => a.severity === "high").length;
			console.log(`${r.runId}: ${r.actions.length} suspicious actions (${high} high)`);
			for (const a of r.actions) {
				console.log(`  [${a.severity}] ${a.rule}: ${a.summary}`);
				if (a.evidence) console.log(`    evidence: ${a.evidence}`);
			}
		}
	}
	if (unmatchedDumps.length > 0) {
		console.log("unmatched dumps:");
		for (const dump of unmatchedDumps) console.log(`  ${dump.ms} ${dump.file}`);
	}
	return 0;
}
