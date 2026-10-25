// `neurastream traces claims …` (plan 20261024_0300 P3): check what a run's final report CLAIMS
// against what the same run's tool activity shows. Claims come from the run's last assistant
// message; a claim with no backing toolResult line, git output, heavy-run call or edit/write is
// reported as a claim-unbacked finding (src/core/incident-detectors.ts D5). Read-only over the
// sessions root; --json prints machine-readable records.

import { join } from "node:path";
import { nowSec } from "../core/clock.ts";
import type { TraceSource } from "../core/adapter.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { claimUnbacked } from "../core/incident-detectors.ts";
import { claimsFromEvents } from "../core/trace-claims.ts";
import { ompTraceRuns, ompTraceSource } from "../adapters/omp/traces.ts";

export const TRACES_USAGE = [
	"usage: neurastream traces claims <runId> [--json]",
	"       neurastream traces claims --since <N m|h|d> [--json]",
].join("\n");

const SINCE = /^(\d+)(m|h|d)$/;

export interface RunClaimsReport {
	runId: string;
	claims: number;
	backed: number;
	unbacked: { kind: string; summary: string; evidence?: string }[];
}

/** Verify one run: claims from its final report, findings for the ones no tool output backs. */
export function claimsReport(src: TraceSource, runId: string): RunClaimsReport {
	const events = src.events(runId);
	const claims = claimsFromEvents(events);
	const findings = claimUnbacked(claims, events);
	return {
		runId,
		claims: claims.length,
		backed: claims.length - findings.length,
		unbacked: findings.map((f) => ({ kind: f.kind, summary: f.summary, evidence: f.evidence })),
	};
}

/** `neurastream traces claims`: one run by id, or every run touched inside a --since window. */
export async function runTraces(args: string[]): Promise<number> {
	if (args[0] !== "claims") {
		console.error(TRACES_USAGE);
		return 2;
	}
	let cfg: Config;
	try {
		cfg = loadConfig();
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
	const reports: RunClaimsReport[] = [];
	if (windowSec !== undefined) {
		const cutoff = nowSec() - windowSec;
		for (const r of runs) {
			if (r.mtimeSec < cutoff) continue;
			reports.push(claimsReport(src, r.runId));
		}
	} else {
		if (!runs.some((r) => r.runId === runId)) {
			console.error(`no trace for run ${runId}`);
			return 1;
		}
		reports.push(claimsReport(src, runId!));
	}
	if (json) {
		console.log(JSON.stringify(reports, null, 2));
		return 0;
	}
	for (const r of reports) {
		if (r.claims === 0) {
			console.log(`${r.runId}: no verifiable claims in the final report`);
			continue;
		}
		console.log(`${r.runId}: ${r.claims} claims, ${r.backed} backed, ${r.unbacked.length} unbacked`);
		for (const u of r.unbacked) {
			console.log(`  ${u.kind}: ${u.summary}`);
			if (u.evidence) console.log(`    evidence: ${u.evidence}`);
		}
	}
	return 0;
}
