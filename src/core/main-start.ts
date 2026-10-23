import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSource } from "./adapter.ts";
import { readEvents } from "./agent-score.ts";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { runDetectors, type TaskResult } from "./incident-detectors.ts";
import { addIncident, type IncidentView } from "./incidents.ts";
import { log as logGuard } from "./guards.ts";
import { dailyChecks, readBlocks, readMetricEvents, worseThanMean } from "./metrics.ts";
import { buildReport } from "./report.ts";
import { loadavgLine } from "./host.ts";

function bin(name: string, cfg: Config): string {
	return join(cfg.paths.home, ".local/bin", name);
}

interface RunOpts {
	stdin?: "inherit" | "ignore" | "pipe";
	/** Written to the child's stdin when stdin is "pipe". */
	input?: string;
	stderr?: "inherit" | "pipe" | "ignore";
}

interface RunResult {
	stdout: string;
	stderr: string;
	/** Set when the child could not start (e.g. ENOENT). */
	error?: Error;
}

// Runs a child without blocking the caller's event loop. Resolves once the child has closed its
// streams, or immediately when it fails to start. The handoff runs inside a live agent session,
// which must keep handling events while Main's state is gathered.
function run(file: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const child = spawn(file, args, {
		stdio: [opts.stdin ?? "ignore", "pipe", opts.stderr ?? "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", chunk => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	// A filter such as awk may exit before it has read all its input.
	child.stdin?.on("error", () => {});
	if (opts.stdin === "pipe") child.stdin?.end(opts.input ?? "");
	child.on("error", error => resolve({ stdout, stderr, error }));
	child.on("close", () => resolve({ stdout, stderr }));
	return promise;
}

// Main's session-start preflight as one text. The CLI prints it; the session rollover handoff
// (src/core/rollover.ts) carries the same text into the new session. Children's stdout is
// collected in order, so the printed output matches the original script line for line.
// inheritStdin: the CLI passes its terminal to the children that ask the operator something;
// an agent host passes false, because its stdin is the session's input.
// stderr: the CLI lets a child's stderr reach the terminal. An agent host captures it and appends it
// after that child's stdout, because a write to the terminal would draw over the session's UI.
/** What the caller supplies for the detector run and (later phases) the daily/weekly checks. */
export interface MainStartDeps {
	/** Runs for the ledger-contradiction detector; null/absent skips what needs one. */
	source?: RunSource | null;
	/** Finished task results parsed from Main's session file (the adapter's format knowledge). */
	results?: TaskResult[];
}

// Real-time detectors at main-start (plan 20261022_2330 P3): best effort, logged, never thrown.
function runMainStartDetectors(cfg: Config, deps: MainStartDeps): void {
	if (!deps.source && !deps.results) return;
	try {
		runDetectors(cfg, { results: deps.results, runs: deps.source ? deps.source.listRuns(nowSec() - 2 * 86400) : undefined });
	} catch (err) {
		logGuard(cfg.paths.guard_log, `main-start detectors failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function mainStartText(args: string[], cfg: Config, opts: { inheritStdin: boolean }, deps: MainStartDeps = {}): Promise<string> {
	const out: string[] = [];
	const say = (line: string) => out.push(`${line}\n`);
	runMainStartDetectors(cfg, deps);
	// Config notices (legacy keys renamed or removed by loadConfig): one line each, above the sections.
	for (const n of cfg.notices) say(`notice: ${n}`);
	const h = args[0] ?? String(cfg.health.default_hours);
	const childStdin = opts.inheritStdin ? "inherit" : "ignore";
	const childStderr = opts.inheritStdin ? "inherit" : "pipe";
	// Daily metrics check and the forced weekly report (plan 20261022_2330 P4): best effort, each
	// failure logged, never thrown — the preflight must print even when a check fails.
	if (deps.source) {
		try {
			for (const i of runDailyCheck(cfg, deps.source, nowSec())) say(`incident ${i.id} [daily/${i.kind}]: ${i.summary}`);
		} catch (err) {
			logGuard(cfg.paths.guard_log, `daily check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			const weekly = runWeeklyCheck(cfg, deps.source, nowSec());
			if (weekly) say(weekly);
		} catch (err) {
			logGuard(cfg.paths.guard_log, `weekly check failed: ${err instanceof Error ? err.message : String(err)}`);
			const due = metricsDueLine(cfg, Date.now());
			if (due) say(due);
		}
	} else {
		// Weekly self-metrics: nudge the owner's report when notes/metrics.md is missing or older than the window.
		const due = metricsDueLine(cfg, Date.now());
		if (due) say(due);
	}
	say("=== machine");
	const mg = await run(bin("machine-guard", cfg), [], { stderr: "ignore" });
	const mgLines = mg.stdout.trim().split("\n");
	say(mgLines.at(-1) ?? "");
	say(loadavgLine());
	say("");
	say(`=== agents (last ${h}h; DIED = check its worktree, relaunch FRESH with its progress file)`);
	const ledger = await run(bin("agent-ledger", cfg), ["--hours", h], { stderr: "ignore" });
	const awk = await run(
		"awk",
		["NR==1 || /DIED/ {print; next} {ok[++n]=$0} END {for (i=1;i<=n;i++) print ok[i]}"],
		{ stdin: "pipe", input: ledger.stdout, stderr: "ignore" },
	);
	out.push(awk.stdout);
	const cap = await run(bin("agent-ledger", cfg), ["--cap"], { stderr: "ignore" });
	for (const line of cap.stdout.split("\n")) {
		if (/^(PRIORITY IDLE|FULL)/.test(line)) say(line);
	}
	say("");
	say("=== main thread");
	const health = await run(bin("main-health", cfg), [], { stdin: childStdin, stderr: childStderr });
	out.push(health.stdout + health.stderr);
	say("");
	say("=== queue");
	const check = await run(bin("queue-check", cfg), [], { stdin: childStdin, stderr: childStderr });
	out.push(check.stdout + check.stderr);
	say("");
	say("=== heavy-run lock");
	try {
		const lines = readFileSync(cfg.paths.heavy_lock, "utf8").split("\n").slice(0, 2);
		while (lines.length && lines.at(-1) === "") lines.pop();
		if (lines.length) say(lines.join("\n"));
	} catch {}
	say("=== doctor");
	// The CLI file itself (shebang `#!/usr/bin/env bun`), never process.execPath: inside a host
	// harness that is the harness binary, which would start a new agent session instead.
	const cli = join(dirname(fileURLToPath(import.meta.url)), "../cli/main.ts");
	const doctor = await run(cli, ["doctor"]);
	const text = `${doctor.stdout}${doctor.stderr}`;
	out.push(text.endsWith("\n") || text === "" ? text : `${text}\n`);
	if (doctor.error) say(doctor.error.message);
	return out.join("");
}

export async function mainStart(args: string[], cfg: Config, deps: MainStartDeps = {}): Promise<number> {
	process.stdout.write(await mainStartText(args, cfg, { inheritStdin: true }, deps));
	return 0;
}

// Due line for the weekly self-metrics report; null when notes/metrics.md is fresh.
export function metricsDueLine(cfg: Config, nowMs: number): string | null {
	const reportFile = join(cfg.paths.notes, "metrics.md");
	const stamp = existsSync(reportFile) ? statSync(reportFile).mtime : null;
	if (stamp && nowMs - stamp.getTime() <= cfg.metrics.report_days * 86400 * 1000) return null;
	const last = stamp ? stamp.toISOString().slice(0, 10) : "never";
	return `metrics: report due (last: ${last}) — neurastream writes the report itself and the worst metric becomes an incident; plan or dismiss that incident`;
}

// ---- daily and weekly, forced (plan 20261022_2330 P4) ----

const DAY = 86400;

function dailyStateFile(cfg: Config): string {
	return join(cfg.paths.queue_state, "incidents-daily.json");
}

function fmtMetric(v: number | null): string {
	return v === null ? "n/a" : v >= 10 ? String(Math.round(v)) : v.toFixed(2);
}

/**
 * Once per calendar day (state file in queue_state), at the first main-start or Main
 * before_agent_start: M1-M5 for the last 24h against the mean of the 7 days before; each metric
 * worse by ≥ incidents.daily_worse_pct and above its floor opens a daily incident. Returns the
 * incidents opened; [] when today is already checked. The day is marked only after the check
 * ran, so a failed check is retried at the next event.
 */
export function runDailyCheck(cfg: Config, source: RunSource, now: number): IncidentView[] {
	const today = strftime(now, "%Y-%m-%d");
	const file = dailyStateFile(cfg);
	try {
		const st = JSON.parse(readFileSync(file, "utf8")) as { date?: string };
		if (st.date === today) return [];
	} catch {}
	const inp = {
		runs: source.listRuns(now - 8 * DAY),
		events: [...readEvents(cfg), ...readMetricEvents(cfg)],
	};
	const out: IncidentView[] = [];
	for (const c of dailyChecks(cfg, inp, readBlocks(cfg), now)) {
		if (!worseThanMean(c, cfg.incidents.daily_worse_pct)) continue;
		const { incident } = addIncident(
			cfg,
			{
				source: "daily",
				kind: "daily-regression",
				summary: `${c.label} regressed: ${fmtMetric(c.cur)} last 24h vs ${fmtMetric(c.mean)}/day over the 7 days before (floor ${fmtMetric(c.floor)})`,
				evidence: `${c.label}: last 24h ${fmtMetric(c.cur)} vs 7-day daily mean ${fmtMetric(c.mean)}`,
				fingerprint: `daily:${c.key}:${today}`,
			},
			now,
		);
		logGuard(cfg.paths.guard_log, `incident ${incident.id} [daily/${incident.kind}] opened: ${incident.summary}`);
		out.push(incident);
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ date: today })}\n`);
	return out;
}

/**
 * When the weekly report is due, the code writes notes/metrics.md itself (as `metrics report`
 * does) and the worst ranked metric becomes an incident (source "weekly"). Returns the due line
 * for the main-start text — the incident id where "propose ONE rule change" used to be — and ""
 * while the report is fresh. Best effort: a failed write returns the plain due line.
 */
export function runWeeklyCheck(cfg: Config, source: RunSource, now: number): string {
	const due = metricsDueLine(cfg, now * 1000);
	if (!due) return "";
	const last = /\(last: ([^)]+)\)/.exec(due)?.[1] ?? "never";
	try {
		const rep = buildReport(cfg, source, cfg.metrics.report_days, now);
		mkdirSync(cfg.paths.notes, { recursive: true });
		writeFileSync(join(cfg.paths.notes, "metrics.md"), rep.md);
		const w = rep.worst;
		if (!w || w.change === null) {
			return `metrics: report due (last: ${last}) — wrote ${join(cfg.paths.notes, "metrics.md")}; no ranked metric moved this window`;
		}
		const pct = `${w.change >= 0 ? "+" : ""}${w.change.toFixed(1)}%`;
		const { incident } = addIncident(
			cfg,
			{
				source: "weekly",
				kind: "weekly-regression",
				summary: `${w.name} is the worst mover this report: ${pct} (${fmtMetric(w.cur)} vs ${fmtMetric(w.prev)})`,
				evidence: `${w.name}: ${fmtMetric(w.cur)} this window vs ${fmtMetric(w.prev)} the window before (${pct})`,
				fingerprint: `weekly:${w.key}:${strftime(now, "%Y%m%d")}`,
			},
			now,
		);
		logGuard(cfg.paths.guard_log, `incident ${incident.id} [weekly/${incident.kind}] opened: ${incident.summary}`);
		return (
			`metrics: report due (last: ${last}) — wrote ${join(cfg.paths.notes, "metrics.md")}; worst metric ${w.name} is incident ${incident.id}: ` +
			`plan it (\`neurastream incident plan ${incident.id} <plan.md>\`) or dismiss it (\`neurastream incident dismiss ${incident.id} --why "<text>"\`)`
		);
	} catch (err) {
		return `metrics: report due (last: ${last}) — the report write failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
