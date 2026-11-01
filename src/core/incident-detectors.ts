// Real-time incident detectors (plan 20261022_2330 P3): every detector is a pure function over
// plain inputs, so tests feed fixtures and the callers (the harness adapter at Main's prompt and
// after each Main bash result, and main-start) gather the real ones. runDetectors folds each
// finding into the incident store (src/core/incidents.ts) as source "realtime"; a detector
// failure is logged to the guard log and swallowed — a broken detector must never break the
// turn it runs in. Kinds:
//   D1 ledger-contradiction: a subagent's task-result said done, the ledger run source
//     still shows it RUNNING/WAITING past incidents.contradiction_grace_min.
//   D2 tool-crash: a Main bash command running one of this package's bins printed a JS stack
//     frame from the neurastream package or "internal error".
//   D3 block-loop: the same guard BLOCK reason (keyed like M5) logged incidents.block_repeat
//     times within one hour.
//   D4 owner-correction: an owner message matching the M4 correction patterns.
//   D5 claim-unbacked: a run's final report claims something its own tool output never
//     showed (gathered by the traces claims CLI, src/cli/traces.ts).
//   D6 suspicious-action: a high-severity suspicious tool action the run's trace shows
//     (gathered by the traces actions CLI, src/cli/traces.ts).
//   D7 unreported-finding: a subagent run read files of another owned repo (config
//     traces.owned_repos) while its final report says "Findings: none"; folds as source
//     "traces" and records an agent-score penalty event for that agent on the plan.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, TraceEvent } from "./adapter.ts";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { log } from "./guards.ts";
import { addIncident, type IncidentView } from "./incidents.ts";
import type { GuardBlock } from "./metrics.ts";
import { maskEvidence, verifyClaims, type Claim, type RelatedRun } from "./trace-claims.ts";
import { recordPenalty } from "./agent-score.ts";
import type { SuspiciousAction, UnreportedFinding } from "./trace-actions.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Finding {
	kind: string;
	summary: string;
	evidence?: string;
	/** Stable identity of the problem; an open incident with it dedupes (count + last seen). */
	fingerprint?: string;
}

function iso(t: number): string {
	return new Date(t * 1000).toISOString();
}

// ---- D1: the ledger contradicts the finished task-result ----

export interface TaskResult {
	/** The `<task-result id="…">` agent name, as the ledger spells it. */
	agent: string;
	/** Unix seconds of the async-result line that announced the result. */
	ts: number;
}

/**
 * Finished task-results the ledger still shows as RUNNING/WAITING more than `graceMin` minutes
 * after the result. A result with no ledger row at all is fine: the row may have aged out.
 */
export function ledgerContradictions(results: TaskResult[], runs: Run[], now: number, graceMin: number): Finding[] {
	const newest: Record<string, TaskResult> = {};
	for (const r of results) {
		const prev = newest[r.agent];
		if (!prev || r.ts > prev.ts) newest[r.agent] = r;
	}
	const byId: Record<string, Run> = Object.fromEntries(runs.map(r => [r.id, r]));
	const out: Finding[] = [];
	for (const agent of Object.keys(newest)) {
		const res = newest[agent]!;
		const run = byId[agent];
		if (!run || (run.status !== "running" && run.status !== "waiting")) continue;
		if (now - res.ts <= graceMin * 60) continue;
		const lateMin = Math.round((now - res.ts) / 60);
		out.push({
			kind: "ledger-contradiction",
			summary: `ledger still shows ${agent} ${run.status} ${lateMin}m after its task-result said done`,
			evidence: `task-result finished at ${iso(res.ts)}; ledger: ${run.statusDetail || run.status}, last write ${iso(run.lastWriteAt)}`,
			fingerprint: `ledger-contradiction:${agent}`,
		});
	}
	return out;
}

// ---- D2: a neurastream tool crashed in a Main bash result ----

/** The package's own CLI bin names (package.json "bin"), for D2's "runs a neurastream tool". */
export function toolBins(packageJson = join(HERE, "../../package.json")): string[] {
	try {
		const bin = (JSON.parse(readFileSync(packageJson, "utf8")) as Record<string, unknown>).bin as unknown;
		return bin && typeof bin === "object" ? Object.keys(bin) : [];
	} catch {
		return [];
	}
}

/** One Main bash result: a neurastream tool whose output shows this package in a JS stack frame, or "internal error". */
export function toolCrash(command: string, output: string, bins: string[]): Finding | null {
	const tool = bins.find(b => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(command));
	if (!tool) return null;
	const lines = output.split("\n");
	const frame = lines.find(l => /^\s*at\s/.test(l) && /neurastream/.test(l));
	const internal = lines.find(l => /internal error/i.test(l));
	if (!frame && !internal) return null;
	const first = (frame ?? internal!).trim().slice(0, 200);
	return {
		kind: "tool-crash",
		summary: `${tool} crashed: ${first}`,
		evidence: frame ? `stack frame: ${frame.trim()}` : `output line: ${internal!.trim()}`,
		fingerprint: `tool-crash:${tool}:${first.replace(/\s+/g, " ").trim()}`,
	};
}

// ---- D3: the same guard block reason in a loop ----

/** How far back one block-loop sighting looks. */
export const BLOCK_LOOP_WINDOW_SEC = 3600;

/** The same reason (keyed like M5) logged `repeat` times within `windowSec` ending at `now`. */
export function blockLoop(blocks: GuardBlock[], now: number, repeat: number, windowSec = BLOCK_LOOP_WINDOW_SEC): Finding[] {
	const counts: Record<string, number> = {};
	for (const b of blocks) {
		if (b.ts <= now - windowSec || b.ts > now) continue;
		counts[b.reason] = (counts[b.reason] ?? 0) + 1;
	}
	return Object.entries(counts)
		.filter(([, count]) => count >= repeat)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.map(([reason, count]) => ({
			kind: "block-loop",
			summary: `the same guard block fired ${count}× in ${Math.round(windowSec / 60)}m: ${reason.slice(0, 160)}`,
			evidence: `${count} BLOCK lines for this reason between ${iso(now - windowSec)} and ${iso(now)}`,
			fingerprint: `block-loop:${reason}`,
		}));
}

// ---- D8: a guard block the same action got past ----

const GUARD_BLOCK = /^(main|plan)-guard:/;

/** Token-set Jaccard similarity in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

/**
 * A Main call a guard refused (an error result whose text starts main-guard:/plan-guard:) and the
 * first later call of the same tool, within windowSec, whose result is not an error and whose args
 * are token-similar (≥ similarity): a possible guard false positive. One finding per refused call.
 */
export function blockThenBypass(events: TraceEvent[], windowSec: number, similarity: number, since = -Infinity): Finding[] {
	const results = new Map<string, TraceEvent>();
	for (const e of events) if (e.kind === "toolResult" && e.callId) results.set(e.callId, e);
	// A call with no timestamp cannot be placed in the window, so it is neither a block nor a bypass.
	const calls = events.filter((e): e is TraceEvent & { callId: string; ts: number } => e.kind === "toolCall" && !!e.callId && e.ts !== null);
	const tokens = new Map(calls.map(c => [c.callId, new Set(JSON.stringify(c.args ?? null).toLowerCase().split(/\W+/).filter(Boolean))]));
	const out: Finding[] = [];
	for (const block of calls) {
		// Blocks at or before `since` were decided by an earlier gated scan (the D8 frontier).
		if (block.ts <= since) continue;
		const refused = results.get(block.callId!);
		if (!refused?.isError || !GUARD_BLOCK.test(refused.text ?? "")) continue;
		const bypass = calls.find(c => {
			const dt = c.ts - block.ts;
			const r = results.get(c.callId!);
			return c.callId !== block.callId && c.tool === block.tool && dt >= 0 && dt <= windowSec && r !== undefined && !r.isError && jaccard(tokens.get(block.callId!)!, tokens.get(c.callId!)!) >= similarity;
		});
		if (!bypass) continue;
		const head = (refused.text ?? "").replace(/\s+/g, " ").trim();
		const sha = createHash("sha256").update(head).digest("hex").slice(0, 16);
		const blockedArgs = maskEvidence(JSON.stringify(block.args).slice(0, 200));
		const allowedArgs = maskEvidence(JSON.stringify(bypass.args).slice(0, 200));
		out.push({
			kind: "block-then-bypass",
			summary: `possible guard false positive: ${head.slice(0, 120)}`,
			evidence: `blocked ${block.tool} at ${iso(block.ts)}: ${blockedArgs}; same tool allowed at ${iso(bypass.ts)}: ${allowedArgs}`,
			fingerprint: `block-then-bypass:${block.tool}:${sha}`,
		});
	}
	return out;
}

// ---- D4: an owner message that corrects Main ----

/** An owner message matching an M4 correction pattern, folded per day so a bad afternoon is one incident. */
export function ownerCorrection(text: string, patterns: RegExp[], now: number): Finding | null {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return null;
	const matched = patterns.filter(p => p.test(flat));
	if (matched.length === 0) return null;
	return {
		kind: "owner-correction",
		summary: flat.slice(0, 200),
		evidence: `matched: ${matched.map(p => `/${p.source}/`).join(", ")}`,
		fingerprint: `owner-correction:${strftime(now, "%Y%m%d")}`,
	};
}

// ---- D5: the final report claims something the run's own tool output never showed ----

/**
 * Final-report claims (src/core/trace-claims.ts) with no backing activity in the same run's
 * trace: a "13 passed" no toolResult shows, a SHA no git command printed, a label never passed
 * to a heavy-run call, a path no edit/write call carried. `related` — the traces of the
 * subagent runs under a Main run's session dir (INCIDENT I-20261025-23) — backs the pure
 * result-line claims Main's report cites from its subagents. Evidence is the claiming line,
 * which the extractor already masked and capped, so nothing secret reaches the incident store.
 */
export function claimUnbacked(claims: Claim[], events: TraceEvent[], related: RelatedRun[] = []): Finding[] {
	const out: Finding[] = [];
	for (const v of verifyClaims(claims, events, related)) {
		if (v.backed) continue;
		const c = v.claim;
		const what = c.count !== undefined ? `${c.kind} ${c.count}` : `${c.kind} ${c.value ?? ""}`;
		out.push({
			kind: "claim-unbacked",
			summary: `final report claims ${what.trim()} but the run's tool output never shows it`,
			evidence: c.evidence,
			fingerprint: `claim-unbacked:${c.kind}:${c.count ?? c.value ?? ""}`,
		});
	}
	return out;
}

// ---- D6: a high-severity suspicious tool action ----

/**
 * Suspicious tool actions (src/core/trace-actions.ts) at severity high: secret-path reads and
 * exfil-shaped network commands. Medium and low findings stay in the `traces actions` report;
 * only the ones worth waking the owner for become incidents. Evidence is already masked and
 * capped by the rule engine, so nothing secret reaches the incident store.
 */
export function suspiciousAction(actions: SuspiciousAction[]): Finding[] {
	return actions
		.filter((a) => a.severity === "high")
		.map((a) => ({
			kind: "suspicious-action",
			summary: `${a.runId}: ${a.summary}`,
			evidence: a.evidence,
			fingerprint: `suspicious-action:${a.rule}:${a.target}`,
		}));
}

// ---- the runner ----

/** The plain inputs the callers gather; a detector without its input does not run. */
export interface DetectorInput {
	/** D1: finished task results (the harness adapter parses Main's session file) and the ledger runs. */
	results?: TaskResult[];
	runs?: Run[];
	/** D3: the guard BLOCK lines, gathered by the caller behind the scan gate (runDetectorsGated). */
	blocks?: GuardBlock[];
	/** D2: the last Main bash tool result. */
	bash?: { command: string; output: string };
	/** D4: the owner prompt at before_agent_start; never a main-guard continuation. */
	prompt?: string;
	/** D5: one run's final-report claims plus the same run's trace events (the traces CLI gathers both). */
	claims?: Claim[];
	events?: TraceEvent[];
	/** D6: suspicious tool actions from one or more scanned runs (the traces actions CLI gathers them). */
	actions?: SuspiciousAction[];
	/** D7: cross-product reads a subagent run hid behind a Findings: none line (src/core/trace-actions.ts). */
	unreported?: UnreportedFinding[];
	/** D8: Main's session trace events, gathered behind the scan gate (runDetectorsGated). */
	mainEvents?: TraceEvent[];
	/** D8 frontier: the newest Main event time an earlier gated scan already saw (incident-scan.json mainTs). */
	mainSince?: number;
}

/**
 * Runs every detector that has its inputs, folds findings into the incident store and logs each
 * one. Detector failures are logged, never thrown. Returns the incidents (new or deduped).
 */
export function runDetectors(cfg: Config, input: DetectorInput, now = nowSec()): IncidentView[] {
	const out: IncidentView[] = [];
	const attempt = (name: string, findings: () => Finding[]): void => {
		try {
			for (const f of findings()) {
				const { incident, deduped } = addIncident(
					cfg,
					{ source: "realtime", kind: f.kind, summary: f.summary, evidence: f.evidence, fingerprint: f.fingerprint },
					now,
				);
				log(
					cfg.paths.guard_log,
					`incident ${incident.id} [realtime/${incident.kind}]${deduped ? ` sighting #${incident.count}` : " opened"}: ${incident.summary}`,
				);
				out.push(incident);
			}
		} catch (err) {
			log(cfg.paths.guard_log, `detector ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	if (input.results && input.runs) {
		attempt("ledger-contradiction", () => ledgerContradictions(input.results!, input.runs!, now, cfg.incidents.contradiction_grace_min));
	}
	if (input.bash) {
		attempt("tool-crash", () => {
			const f = toolCrash(input.bash!.command, input.bash!.output, toolBins());
			return f ? [f] : [];
		});
	}
	if (input.blocks) {
		attempt("block-loop", () => blockLoop(input.blocks!, now, cfg.incidents.block_repeat));
	}
	if (input.prompt !== undefined) {
		attempt("owner-correction", () => {
			const f = ownerCorrection(input.prompt!, cfg.metrics.correction_patterns.map(p => new RegExp(p, "i")), now);
			return f ? [f] : [];
		});
	}
	if (input.claims && input.events) {
		attempt("claim-unbacked", () => claimUnbacked(input.claims!, input.events!));
	}
	if (input.actions) {
		attempt("suspicious-action", () => suspiciousAction(input.actions!));
	}
	if (input.mainEvents) {
		attempt("block-then-bypass", () => blockThenBypass(input.mainEvents!, cfg.incidents.bypass_window_sec, cfg.incidents.bypass_similarity, input.mainSince));
	}
	if (input.unreported) {
		for (const f of input.unreported!) {
			try {
				const { incident, deduped } = addIncident(
					cfg,
					{ source: "traces", kind: "unreported-finding", summary: f.summary, evidence: f.evidence, fingerprint: `unreported-finding:${f.agent}:${f.target}` },
					now,
				);
				if (!deduped) recordPenalty(cfg, { agent: f.agent, kind: "unreported-finding", plan: f.plan, note: f.summary });
				log(
					cfg.paths.guard_log,
					`incident ${incident.id} [traces/${incident.kind}]${deduped ? ` sighting #${incident.count}` : " opened"}: ${incident.summary}`,
				);
				out.push(incident);
			} catch (err) {
				log(cfg.paths.guard_log, `detector unreported-finding failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	return out;
}

/** The expensive detector inputs (D1 ledger contradiction, D3 block loop): read in one scan. */
export interface GatedInputs {
	results: TaskResult[];
	runs: Run[];
	blocks: GuardBlock[];
	/** D8: Main's session trace events (optional: a caller without a session file omits them). */
	mainEvents?: TraceEvent[];
}

/** The scan gate state in <queue_state>/incident-scan.json: `lastScan` is the time of the last gated
 * scan; `mainTs` is the newest Main session event time that scan saw (the D8 frontier). */
interface ScanState {
	lastScan: number;
	mainTs: number;
}

function readScan(file: string): ScanState {
	const st: ScanState = { lastScan: 0, mainTs: 0 };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { lastScan?: unknown; mainTs?: unknown };
		if (typeof raw.lastScan === "number") st.lastScan = raw.lastScan;
		if (typeof raw.mainTs === "number") st.mainTs = raw.mainTs;
	} catch {}
	return st;
}

function writeScan(file: string, st: ScanState): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(st)}\n`);
}

/**
 * Whether a gated scan is due. The stamp is written BEFORE the inputs are read, so a slow or
 * crashing scan cannot stack: the next attempt is a full interval away. An unreadable state counts
 * as never scanned; an unwritable one throws (the caller logs it and runs the cheap detectors only).
 */
export function scanDue(cfg: Config, now: number): boolean {
	const file = join(cfg.paths.queue_state, "incident-scan.json");
	const st = readScan(file);
	if (now - st.lastScan < cfg.incidents.scan_interval_sec) return false;
	writeScan(file, { ...st, lastScan: now });
	return true;
}

/**
 * The cheap detectors (D2 bash, D4 prompt) run on every call; D1 and D3 read Main's session
 * file, the ledger runs and both guard logs — seconds on a real machine — so they run at most
 * once per incidents.scan_interval_sec and `gather` is never called inside the interval. A
 * failed gate or gather is logged and the cheap detectors still run.
 *
 * D8 frontier: a gated scan records the newest Main event time it saw; the next scan's
 * block-then-bypass only considers blocks after it, so a pair already seen is never raised twice.
 * A bypass that lands only in a later scan than its block is not caught (the retry normally
 * lands in the same turn, before the next prompt-start scan).
 */
export function runDetectorsGated(
	cfg: Config,
	cheap: { bash?: { command: string; output: string }; prompt?: string },
	gather: () => GatedInputs,
	now = nowSec(),
): IncidentView[] {
	const file = join(cfg.paths.queue_state, "incident-scan.json");
	const input: DetectorInput = { ...cheap };
	let frontier: number | null = null;
	try {
		if (scanDue(cfg, now)) {
			const since = readScan(file).mainTs;
			const gathered = gather();
			Object.assign(input, gathered, { mainSince: since });
			frontier = (gathered.mainEvents ?? []).reduce((m, e) => Math.max(m, e.ts ?? 0), since);
		}
	} catch (err) {
		log(cfg.paths.guard_log, `incident scan skipped: ${err instanceof Error ? err.message : String(err)}`);
	}
	const out = runDetectors(cfg, input, now);
	if (frontier !== null) writeScan(file, { ...readScan(file), mainTs: frontier });
	return out;
}
