// `neurastream traces claims …` (plan 20261024_0300 P3): check what a run's final report CLAIMS
// against what the same run's tool activity shows. Claims come from the run's last assistant
// message; a claim with no backing toolResult line, git output, heavy-run call or edit/write is
// reported as a claim-unbacked finding (src/core/incident-detectors.ts D5).
// `neurastream traces actions …` (plan 20261024_0301 P2): list the suspicious tool actions a
// run's trace shows (src/core/trace-actions.ts); the high ones fold into the incident store as
// realtime `suspicious-action` incidents (D6). Read-only over the sessions root; --json prints
// machine-readable records.

import { join } from "node:path";
import { nowSec } from "../core/clock.ts";
import type { TraceSource } from "../core/adapter.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { claimUnbacked } from "../core/incident-detectors.ts";
import { claimsFromEvents, type RelatedRun } from "../core/trace-claims.ts";
import { actionsRules, suspiciousActions, type ActionsRules, type SuspiciousAction } from "../core/trace-actions.ts";
import { bloatBreakdown, bloatFindings, bloatRules, callSizes, dumpFinding, type BloatBreakdown, type BloatRules } from "../core/trace-bloat.ts";
import { dumpParts, dumpPromptTokens, ompDumps, ompTraceRuns, ompTraceSource, subagentTraces } from "../adapters/omp/traces.ts";

export const TRACES_USAGE = [
	"usage: neurastream traces claims <runId> [--json]",
	"       neurastream traces claims --since <N m|h|d> [--json]",
	"       neurastream traces actions <runId> [--json]",
	"       neurastream traces actions --since <N m|h|d> [--json]",
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

export interface RunBloatReport {
	runId: string;
	/** Model calls in the run (usage-bearing assistant messages, folded per response id). */
	calls: number;
	/** Prompt tokens (input + cacheRead + cacheWrite) of the first call; null when the run made none. */
	firstPrompt: number | null;
	maxPrompt: number | null;
	/** prompt-bloat findings; evidence masked and capped. */
	findings: { kind: string; summary: string; evidence?: string }[];
	/** What filled the prompt, from the run's dumped failed request; present only when a dump sits in the run's window. */
	breakdown?: BloatBreakdown;
	/** The prompt the matched dump's error response states, when it states one — a rejected
	 *  call wrote no usage, so this may be the run's real first call. */
	dumpPrompt?: { tokens: number; limit?: number };
}

/**
 * Scan one run: per-call prompt sizes and the bloat findings — plus, when a dump of the run's
 * failed request exists, what filled the prompt. Dumps are named by the epoch ms of the failed
 * request; a dump belongs to the run whose trace window covers that instant: first readable
 * event ts <= dump <= trace file mtime (the file keeps growing while the run lives, so the
 * dump of a request that never produced an event is still inside). A run with no readable
 * timestamps matches no dump. A rejected call never wrote usage, so when the run's own usage
 * flags nothing, the dump's error response states the prompt and dumpFinding flags from it —
 * a dump stating no count flags nothing, and no size is guessed from bytes.
 */
export function bloatReport(src: TraceSource, runId: string, rules: BloatRules, groupRegex: string, dumps: { file: string; ms: number }[], mtimeSec: number): RunBloatReport {
	const events = src.events(runId);
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

/** `neurastream traces claims|actions|bloat`: one run by id, or every run touched inside a --since window. */
export async function runTraces(args: string[], opts: { home?: string } = {}): Promise<number> {
	const sub = args[0];
	if (sub !== "claims" && sub !== "actions" && sub !== "bloat") {
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
	const rules: ActionsRules | BloatRules | null = sub === "actions" ? actionsRules(cfg) : sub === "bloat" ? bloatRules(cfg) : null;
	// A Main run's report cites its subagents' results: their traces under the Main session dir
	// back the pure result-line claims (P5). No time filter — the text match is the guard, and
	// a sub's file keeps being written while its Main run lives, inside whatever window.
	const relatedOf = (id: string): RelatedRun[] =>
		sub === "claims" ? subagentTraces(root, id).map(({ name, events }) => ({ name, events })) : [];
	const dumps = sub === "bloat" ? ompDumps(cfg.paths.home) : [];
	const mtimeOf = (id: string): number => runs.find((r) => r.runId === id)?.mtimeSec ?? 0;
	const reports: (RunClaimsReport | RunActionsReport | RunBloatReport)[] = [];
	const reportOf = (id: string): RunClaimsReport | RunActionsReport | RunBloatReport => {
		if (sub === "claims") return claimsReport(src, id, relatedOf(id));
		if (sub === "actions") return actionsReport(src, id, rules as ActionsRules);
		return bloatReport(src, id, rules as BloatRules, cfg.traces.bloat.tool_group, dumps, mtimeOf(id));
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
		console.log(JSON.stringify(reports, null, 2));
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
	return 0;
}
