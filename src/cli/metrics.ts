// `neurastream metrics …`: records facts the owner and the CI command decide into
// metrics.jsonl (see src/core/metrics.ts). Each record* function takes the config and the
// clock as arguments so tests run against a temp home.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { appendMetric } from "../core/metrics.ts";
import { nowSec } from "../core/clock.ts";
import type { RunSource } from "../core/adapter.ts";
import { buildReport, type BloatSummary, type ProviderSummary } from "../core/report.ts";
import { providerFindings } from "../core/trace-provider.ts";
import { bloatRules } from "../core/trace-bloat.ts";
import { defaultRunSource } from "../adapters/omp/sessions.ts";
import { ompDumps, ompTraceRuns, ompTraceSource } from "../adapters/omp/traces.ts";
import { assignDumps, bloatReport } from "./traces.ts";

export const METRICS_USAGE = [
	"usage: neurastream metrics ci <repo-dir> <mr-id>",
	'       neurastream metrics false-alarm <log-ts> --why "<text>"',
	'       neurastream metrics rule "<text>" --approved|--rejected',
	"       neurastream metrics report [--days N]",
].join("\n");

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Single-quotes a value for `sh -c`, so an MR id cannot inject shell syntax. */
function shellQuote(v: string): string {
	return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Runs the configured CI command in the repo and records how many pipelines the MR needed. */
export function recordCi(cfg: Config, repoDir: string, mr: string, now: number): number {
	if (!repoDir || !mr) {
		console.error(METRICS_USAGE);
		return 2;
	}
	const template = cfg.metrics.ci_pipelines_cmd;
	if (!template) {
		console.error("metrics.ci_pipelines_cmd not set");
		return 2;
	}
	if (!existsSync(repoDir)) {
		console.error(`repo-dir not found: ${repoDir}`);
		return 2;
	}
	const proc = Bun.spawnSync(["sh", "-c", template.replaceAll("{mr}", shellQuote(mr))], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		console.error(`ci command exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
		return 1;
	}
	let pipelines: unknown;
	try {
		pipelines = JSON.parse(proc.stdout.toString());
	} catch {
		pipelines = undefined;
	}
	if (!Array.isArray(pipelines)) {
		console.error("ci command must print a JSON array on stdout");
		return 1;
	}
	appendMetric(cfg, { type: "ci", mr, repo: repoDir, tries: pipelines.length, ts: now });
	console.log(`ci: ${mr} needed ${pipelines.length} pipeline(s)`);
	return 0;
}

/** Marks one guard BLOCK line (by its ISO timestamp) as a false alarm. */
export function recordFalseAlarm(cfg: Config, logTs: string, why: string, now: number): number {
	if (!logTs || !why) {
		console.error(METRICS_USAGE);
		return 2;
	}
	appendMetric(cfg, { type: "false-alarm", log_ts: logTs, why, ts: now });
	console.log(`false-alarm recorded for ${logTs}`);
	return 0;
}

/** Records the owner's decision on one proposed rule change. */
export function recordRule(cfg: Config, text: string, decision: "approved" | "rejected", now: number): number {
	if (!text) {
		console.error(METRICS_USAGE);
		return 2;
	}
	appendMetric(cfg, { type: "rule", text, decision, ts: now });
	console.log(`rule ${decision}: ${text}`);
	return 0;
}

/** Provider-honesty counts over every run touched inside the window, folded from the five
 *  rules of src/core/trace-provider.ts under the config's provider rules and price table. */
function providerSummary(cfg: Config, now: number, days: number): ProviderSummary {
	const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
	const cutoff = now - days * 86400;
	const src = ompTraceSource(root);
	const rules = cfg.traces.provider;
	const byKind: Record<string, number> = {};
	let runs = 0;
	for (const r of ompTraceRuns(root)) {
		if (r.mtimeSec < cutoff) continue;
		runs++;
		for (const f of providerFindings(src.events(r.runId), rules, rules.prices)) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
	}
	return { runs, byKind };
}

/** Prompt-bloat counts over every run touched inside the window, folded from the
 *  src/core/trace-bloat.ts findings the same scans build (dump flag included, since a
 *  rejected call flags only through its dump). */
function bloatSummary(cfg: Config, now: number, days: number): BloatSummary {
	const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
	const cutoff = now - days * 86400;
	const src = ompTraceSource(root);
	const rules = bloatRules(cfg);
	const dumps = ompDumps(cfg.paths.home);
	let runs = 0;
	let flagged = 0;
	let largest: BloatSummary["largest"] = null;
	const allRuns = ompTraceRuns(root);
	const { owners, events: assignmentEvents } = assignDumps(allRuns, src, dumps);
	for (const r of allRuns) {
		if (r.mtimeSec < cutoff) continue;
		runs++;
		const owned = dumps.filter((dump) => owners.get(dump.file) === r.runId);
		const rep = bloatReport(src, r.runId, rules, cfg.traces.bloat.tool_group, owned, r.mtimeSec, assignmentEvents.get(r.runId));
		if (rep.findings.length === 0) continue;
		flagged++;
		const firstCall = Math.max(rep.firstPrompt ?? 0, rep.dumpPrompt?.tokens ?? 0);
		if (firstCall > 0 && (largest === null || firstCall > largest.firstCall)) largest = { runId: r.runId, firstCall };
	}
	return { runs, flagged, largest };
}

/** Writes notes/metrics.md and prints the same report: this window against the previous one. */
export function reportCmd(cfg: Config, source: RunSource, args: string[], now: number): number {
	const raw = flagValue(args, "--days");
	const days = raw === undefined ? cfg.metrics.report_days : Number(raw);
	if (!Number.isInteger(days) || days < 1) {
		console.error(METRICS_USAGE);
		return 2;
	}
	const { md, text } = buildReport(cfg, source, days, now, providerSummary(cfg, now, days), bloatSummary(cfg, now, days));
	mkdirSync(cfg.paths.notes, { recursive: true });
	writeFileSync(join(cfg.paths.notes, "metrics.md"), md);
	console.log(text);
	return 0;
}

export async function runMetrics(args: string[]): Promise<number> {
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const [sub = "", ...rest] = args;
	const now = nowSec();
	if (sub === "ci") return recordCi(cfg, rest[0] ?? "", rest[1] ?? "", now);
	if (sub === "report") return reportCmd(cfg, defaultRunSource(cfg), rest, now);
	if (sub === "false-alarm") return recordFalseAlarm(cfg, rest[0] ?? "", flagValue(rest, "--why") ?? "", now);
	if (sub === "rule") {
		const approved = rest.includes("--approved");
		const rejected = rest.includes("--rejected");
		if (approved === rejected) {
			console.error(METRICS_USAGE);
			return 2;
		}
		return recordRule(cfg, rest[0] ?? "", approved ? "approved" : "rejected", now);
	}
	console.error(METRICS_USAGE);
	return 2;
}
