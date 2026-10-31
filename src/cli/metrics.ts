// `neurastream metrics …`: records facts the owner and the CI command decide into
// metrics.jsonl (see src/core/metrics.ts). Each record* function takes the config and the
// clock as arguments so tests run against a temp home.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { appendMetric, readMetricEvents } from "../core/metrics.ts";
import { recordCiMr } from "../core/ci.ts";
import { nowSec } from "../core/clock.ts";
import type { RunSource } from "../core/adapter.ts";
import { buildReport, type BloatSummary, type ProviderSummary } from "../core/report.ts";
import { providerFindings } from "../core/trace-provider.ts";
import { bloatRules } from "../core/trace-bloat.ts";
import { getAdapter } from "../adapters/index.ts";
import { featuresReport, gatherTags, loadPlans, releasesReport, type FeaturesReport, type ReleasesReport } from "../core/results.ts";
import { gitTop } from "../core/queue/lib.ts";
import { assignDumps, bloatReport } from "./traces.ts";
import { withHeartbeat } from "../core/heartbeat.ts";

export const METRICS_USAGE = [
	"usage: neurastream metrics ci <repo-dir> <mr-id>",
	'       neurastream metrics false-alarm <log-ts> --why "<text>"',
	'       neurastream metrics rule "<text>" --approved|--rejected',
	"       neurastream metrics report [--days N]",
	"       neurastream metrics features [--days N] [--json]",
	"       neurastream metrics releases [--days N] [--json]",
].join("\n");

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Runs the configured CI command in the repo and records how many pipelines the MR needed. */
export function recordCi(cfg: Config, repoDir: string, mr: string, now: number): number {
	if (!repoDir || !mr) {
		console.error(METRICS_USAGE);
		return 2;
	}
	if (!existsSync(repoDir)) {
		console.error(`repo-dir not found: ${repoDir}`);
		return 2;
	}
	const r = recordCiMr(cfg, repoDir, mr, now);
	if (!r.ok) {
		console.error(r.error);
		return r.code;
	}
	console.log(`ci: ${mr} needed ${r.tries} pipeline(s)`);
	recordProducts(cfg, repoDir, now);
	return 0;
}

const PRODUCT_TIMEOUT_MS = 10_000;

/**
 * Runs the repo's configured product numbers once each (metrics.product_cmds) and appends one
 * product record per number. A command that fails, times out or prints anything but one finite
 * number is skipped with a stderr line; the ci record itself never fails on a product number.
 */
function recordProducts(cfg: Config, repoDir: string, now: number): void {
	for (const [name, cmd] of Object.entries(cfg.metrics.product_cmds[repoDir] ?? {})) {
		const proc = Bun.spawnSync(["sh", "-c", cmd], { cwd: repoDir, stdout: "pipe", stderr: "pipe", timeout: PRODUCT_TIMEOUT_MS });
		const out = proc.stdout.toString().trim();
		const value = Number(out);
		if (proc.exitCode !== 0 || out === "" || !Number.isFinite(value)) {
			const why = proc.exitCode !== 0 ? `exit ${proc.exitCode ?? "signal"}` : `not one number: "${out.slice(0, 40)}"`;
			console.error(`product_cmds.${name}: skipped (${why})`);
			continue;
		}
		appendMetric(cfg, { type: "product", repo: repoDir, name, value, ts: now });
	}
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
	const a = getAdapter(cfg);
	const cutoff = now - days * 86400;
	const src = a.traceSource(root);
	const rules = cfg.traces.provider;
	const byKind: Record<string, number> = {};
	let runs = 0;
	for (const r of a.traceRuns(root)) {
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
	const a = getAdapter(cfg);
	const cutoff = now - days * 86400;
	const src = a.traceSource(root);
	const rules = bloatRules(cfg);
	const dumps = a.dumps(cfg.paths.home);
	let runs = 0;
	let flagged = 0;
	let largest: BloatSummary["largest"] = null;
	const allRuns = a.traceRuns(root);
	const { owners, events: assignmentEvents } = assignDumps(allRuns, src, dumps, a);
	for (const r of allRuns) {
		if (r.mtimeSec < cutoff) continue;
		runs++;
		const owned = dumps.filter((dump) => owners.get(dump.file) === r.runId);
		const rep = bloatReport(src, r.runId, rules, cfg.traces.bloat.tool_group, owned, r.mtimeSec, a, assignmentEvents.get(r.runId));
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

/** Local `YYYY-MM-DD HH:MM`, the stamp style Progress entries use. */
function localStamp(ts: number): string {
	const d = new Date(ts * 1000);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function featuresTable(r: FeaturesReport): string {
	const out = [`Results: last ${r.days} days [${localStamp(r.from)} to ${localStamp(r.to)})`];
	out.push("stem                           kind        plans fix  $total  $first  closed at");
	for (const row of r.rows) {
		out.push(
			`${row.stem.padEnd(30)} ${row.kind.padEnd(11)} ${String(row.plans).padEnd(5)} ${String(row.fixPlans).padEnd(4)} ` +
				`${row.total.toFixed(2).padEnd(7)} ${row.first.toFixed(2).padEnd(7)} ${localStamp(row.closedAt)}`,
		);
	}
	for (const s of r.summaries) {
		const perFeature = s.perFeature === null ? "n/a" : `$${s.perFeature.toFixed(2)}`;
		const firstPass = s.firstPass === null ? "n/a" : `$${s.firstPass.toFixed(2)}`;
		const overhead = s.overheadPct === null ? "n/a" : `${s.overheadPct.toFixed(0)}%`;
		out.push(
			`${s.kind}: finished ${s.finished} (${s.perDay.toFixed(2)}/day), ${perFeature}/feature, first-pass ${firstPass}, ` +
				`overhead ${overhead}, open chains ${s.openChains} ($${s.openSunk.toFixed(2)} sunk)`,
		);
	}
	return out.join("\n");
}

/** `metrics features`: $ per finished feature over the queue's own plan chains. */
export function featuresCmd(cfg: Config, source: RunSource, args: string[], now: number): number {
	const raw = flagValue(args, "--days");
	const days = raw === undefined ? cfg.metrics.report_days : Number(raw);
	if (!Number.isInteger(days) || days < 1) {
		console.error(METRICS_USAGE);
		return 2;
	}
	const report = featuresReport(source.listRuns(now - days * 86400), loadPlans(cfg), gitTop(import.meta.dir)?.repo ?? null, now - days * 86400, now);
	if (args.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(featuresTable(report));
	return 0;
}

function releasesTable(r: ReleasesReport): string {
	const out = [
		`Releases: per release, ${r.days} days before vs after (measuring = the after window is still filling); ` +
			"columns: $/feature, features/day, main calls/feature, tokens/call, fix plans/feature, product numbers",
	];
	for (const row of r.rows) {
		// Five columns share the before→after cell shape; digits differ per column.
		const pair = (a: number | null, b: number | null, digits = 2) =>
			`${a === null ? "n/a" : a.toFixed(digits)}→${b === null ? "n/a" : b.toFixed(digits)}`;
		const products = row.before.products.map((p, i) => {
			const after = row.after.products[i]?.value ?? null;
			return `${p.name} ${p.value === null ? "-" : String(p.value)}→${after === null ? "-" : String(after)}`;
		});
		out.push(
			`${row.name.padEnd(20)} ${row.kind.padEnd(12)} ${localStamp(row.ts)}  ` +
				`${pair(row.before.perFeature, row.after.perFeature)}  ` +
				`${pair(row.before.featuresPerDay, row.after.featuresPerDay)}  ` +
				`${pair(row.before.callsPerFeature, row.after.callsPerFeature, 1)}  ` +
				`${pair(row.before.tokensPerCall, row.after.tokensPerCall, 1)}  ` +
				`${pair(row.before.fixPlansPerFeature, row.after.fixPlansPerFeature)}  ` +
				products.join("  ") +
				(row.measuring ? "  measuring" : ""),
		);
	}
	return out.join("\n");
}

/** `metrics releases`: per release — a self `v*` tag or another repo's `metrics ci` merge — the
 *  same ledger metrics for the N days before vs after it. */
export function releasesCmd(cfg: Config, source: RunSource, args: string[], now: number): number {
	const raw = flagValue(args, "--days");
	const days = raw === undefined ? 7 : Number(raw);
	if (!Number.isInteger(days) || days < 1) {
		console.error(METRICS_USAGE);
		return 2;
	}
	const selfRepo = gitTop(import.meta.dir)?.repo ?? null;
	const tags = gatherTags(selfRepo);
	const events = readMetricEvents(cfg);
	// A release's before window reaches back past the features window, so ask for runs since the
	// oldest release's window start.
	const oldest = Math.min(now, ...tags.map(t => t.ts), ...events.filter(e => e.type === "ci").map(e => Number(e.ts)));
	const report = releasesReport(source.listRuns(oldest - days * 86400), loadPlans(cfg), selfRepo, days, now, tags, events);
	if (args.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return 0;
	}
	console.log(releasesTable(report));
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
	if (sub === "report") return withHeartbeat(cfg, "metrics-report", () => reportCmd(cfg, getAdapter(cfg).runSource(cfg), rest, now));
	if (sub === "features") return featuresCmd(cfg, getAdapter(cfg).runSource(cfg), rest, now);
	if (sub === "releases") return releasesCmd(cfg, getAdapter(cfg).runSource(cfg), rest, now);
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
