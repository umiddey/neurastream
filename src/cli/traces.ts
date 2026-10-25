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
import { ompTraceRuns, ompTraceSource, subagentTraces } from "../adapters/omp/traces.ts";

export const TRACES_USAGE = [
	"usage: neurastream traces claims <runId> [--json]",
	"       neurastream traces claims --since <N m|h|d> [--json]",
	"       neurastream traces actions <runId> [--json]",
	"       neurastream traces actions --since <N m|h|d> [--json]",
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

/** `neurastream traces claims|actions`: one run by id, or every run touched inside a --since window. */
export async function runTraces(args: string[], opts: { home?: string } = {}): Promise<number> {
	const sub = args[0];
	if (sub !== "claims" && sub !== "actions") {
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
	if ((runId !== undefined) === (windowSec !== undefined)) {
		console.error(TRACES_USAGE);
		return 2;
	}
	const runs = ompTraceRuns(root);
	const src = ompTraceSource(root);
	const rules = sub === "actions" ? actionsRules(cfg) : null;
	// A Main run's report cites its subagents' results: their traces under the Main session dir
	// back the pure result-line claims (P5). No time filter — the text match is the guard, and
	// a sub's file keeps being written while its Main run lives, inside whatever window.
	const relatedOf = (id: string): RelatedRun[] =>
		sub === "claims" ? subagentTraces(root, id).map(({ name, events }) => ({ name, events })) : [];
	const reports: (RunClaimsReport | RunActionsReport)[] = [];
	const reportOf = (id: string): RunClaimsReport | RunActionsReport =>
		sub === "claims" ? claimsReport(src, id, relatedOf(id)) : actionsReport(src, id, rules!);
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
