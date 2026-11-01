// The watcher (plan 20261027_1430 P2, replaces live_recheck P5d): one pass over the job
// heartbeats (P1), the failed user units and the gated incident detectors — with or without a
// Main session open. Every problem folds into the incident store with source "watch" and a
// fingerprint per job+state, so a still-failing job dedupes into one open incident and a new
// failure after recovery opens a fresh one; a watch incident whose problem is gone is closed
// again via dismissIncident. Each NEW incident also posts one ⚠ message (P3) through the
// injected notifier — the watcher pushes, it never restarts a service or edits plans. The
// clock, the unit lister, the detector gather and the notifier are injected: tests touch only a
// temp queue_state, never a real home, network or service manager.
// CI (P6b, ci.ts) adds four checks per repo of an active plan: a red default branch (ci-red-main),
// a red open MR past watch.ci_red_hours (ci-red-mr), M3 `ci` for every newly merged MR, and a
// `ci-flaky` metric when a commit goes red then green.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { Config } from "./config.ts";
import type { RunSource } from "./adapter.ts";
import { readEvents } from "./agent-score.ts";
import { strftime } from "./clock.ts";
import { readBeats, type Heartbeat } from "./heartbeat.ts";
import { runDetectorsGated, type GatedInputs } from "./incident-detectors.ts";
import { log, readStaffingEntries } from "./guards.ts";
import { appendMetric, inWindow, readBlocks, readMetricEvents, reasonKey, type Window } from "./metrics.ts";
import { notifyProviders, waitingOwnerMessages } from "./notify.ts";
import { addIncident, dismissIncident, openIncidents, readIncidents, type IncidentView } from "./incidents.ts";
import { m7, rowsOf, silentFailures, snap } from "./report.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";
import { ciScan } from "./ci.ts";
import type { CommandRunner } from "./mr-sweep.ts";
import type { ReleaseTag } from "./results.ts";

/** One failed user unit, as the lister reports it. */
export interface FailedUnit {
	/** Unit name as the service manager spells it, e.g. wip-backup.service. */
	name: string;
	/** The unit's last error line; "" or undefined when the journal cannot be read. */
	error?: string;
}

/** Reads the failed user units. Production: systemUnitLister; tests inject their own. */
export type UnitLister = () => FailedUnit[];

/** The last error-looking line of a unit's user journal, or "" when none is readable. */
function lastErrorLine(unit: string): string {
	try {
		const r = spawnSync("journalctl", ["--user", "-u", unit, "-n", "200", "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 30000 });
		if (r.status !== 0 || !r.stdout) return "";
		const lines = r.stdout.split("\n").filter(l => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/fail|error|exit-code|exception|fatal|panic|denied|timeout/i.test(lines[i]!)) return lines[i]!.slice(0, 200);
		}
		return "";
	} catch {
		return "";
	}
}

/** Production lister: failed systemd user units, read-only. launchd keeps no failed state to
 *  list; the timer side of the service-manager seam is P4. A missing or erroring manager (no
 *  user bus, non-Linux box) lists nothing — a watcher must not crash for lack of systemd. */
export const systemUnitLister: UnitLister = () => {
	let names: string[] = [];
	try {
		const r = spawnSync("systemctl", ["--user", "list-units", "--state=failed", "--no-legend", "--no-pager"], { encoding: "utf8", timeout: 30000 });
		if (r.status !== 0 || !r.stdout) return [];
		names = r.stdout.split("\n").map(l => l.trim().split(/\s+/)[0] ?? "").filter(n => n.includes("."));
	} catch {
		return [];
	}
	return names.map(name => ({ name, error: lastErrorLine(name) }));
};

/** Injectable seams of one watch run. */
export interface WatchDeps {
	/** Unix seconds "now"; injected so tests control the staleness windows. */
	now: () => number;
	/** The failed user units; injected so tests never touch a service manager. */
	listUnits: UnitLister;
	/** Expensive detector inputs; the same gather mainDetectors uses (src/core/main-start.ts). */
	gather: () => GatedInputs;
	/** The chat notifier, e.g. a fire-and-forget postReply — injected so tests never post for
	 *  real. Called at most watch.max_posts_per_run times per run plus one overflow line, and
	 *  only when a notify provider is configured. */
	notify: (text: string) => void;
	/** The forge CLI runner the CI check uses (mr-sweep's CommandRunner), so tests never run glab or gh. */
	runner: CommandRunner;
	/** The active plans: the CI check reads their repos and the MRs they name. */
	plans: () => { file: string; repo: string; text: string }[];
	/** Plan files held back from ci-red-mr: a running agent right now (a timer run passes timerStaffedPlans, the spawn record). `now` is this pass's clock. */
	staffed: (now: number) => string[];
	/** Run data for the release verdict (P11): Main tool calls and run costs per window. Absent — the caller has no session source — and no verdicts happen. */
	source?: RunSource;
	/** The self repo's `v*` tags (results.ts gatherTags, handed in by the CLI). Absent or empty — no verdicts. */
	tags?: ReleaseTag[];
}

export interface WatchReport {
	/** Incidents this run opened (first sighting). */
	opened: IncidentView[];
	/** Open incidents this run re-sighted (count and last seen updated, no new incident). */
	deduped: IncidentView[];
	/** Open watch incidents whose problem is gone — dismissed by this run. */
	closed: IncidentView[];
	/** Incidents the gated detectors folded themselves (their own sources and kinds). */
	detectors: IncidentView[];
	/** Owner messages that first crossed notify.answer_within_min this pass (M8, P9). */
	ownerWaits: number;
}

/** One problem the watcher found: exactly one addIncident input plus the fields its ⚠ post
 *  needs — the job it is about, when it happened, and the first error line. */
interface WatchProblem {
	fingerprint: string;
	kind: string;
	/** The job or unit the problem is about: the post's subject. */
	job: string;
	/** When it happened: the heartbeat time, or the run time when there is none. */
	at: string;
	/** The first error line (a heartbeat detail or a journal line, already cut to 200). */
	line: string;
	summary: string;
	evidence: string;
}

/** (a) heartbeats with ok:false — every job, listed in watch.expect or not. Then (b) stale
 *  heartbeats: only jobs listed in watch.expect are expected to beat at all, and only while
 *  healthy — a failed beat is already reported by (a), one incident per job and state. */
function beatProblems(cfg: Config, beats: Record<string, Heartbeat>, now: number): WatchProblem[] {
	const out: WatchProblem[] = [];
	for (const name of Object.keys(beats).toSorted()) {
		const hb = beats[name]!;
		if (hb.ok) continue;
		const detail = hb.detail || "no detail";
		out.push({
			fingerprint: `watch:beat-failed:${name}`,
			kind: "beat-failed",
			job: name,
			at: hb.at,
			line: detail,
			summary: `${name} heartbeat failed: ${detail}`,
			evidence: `heartbeat at ${hb.at}: ${detail}`,
		});
	}
	for (const [name, hours] of Object.entries(cfg.watch.expect)) {
		const hb = beats[name];
		if (!hb) {
			out.push({
				fingerprint: `watch:beat-stale:${name}`,
				kind: "beat-stale",
				job: name,
				at: new Date(now * 1000).toISOString(),
				line: `no heartbeat ever (watch.expect ${hours}h)`,
				summary: `${name}: no heartbeat ever (watch.expect ${hours}h)`,
				evidence: `listed in watch.expect (${hours}h), no heartbeats/${name}.json`,
			});
			continue;
		}
		if (!hb.ok) continue;
		const ageH = (now - Date.parse(hb.at) / 1000) / 3600;
		if (!(ageH > hours)) continue;
		out.push({
			fingerprint: `watch:beat-stale:${name}`,
			kind: "beat-stale",
			job: name,
			at: hb.at,
			line: `last beat ${Math.round(ageH * 10) / 10}h ago, expect ${hours}h`,
			summary: `${name} heartbeat stale: last beat ${Math.round(ageH * 10) / 10}h ago, expect ${hours}h`,
			evidence: `heartbeat at ${hb.at} (watch.expect: ${hours}h)`,
		});
	}
	return out;
}

/** (c) failed units from the injected lister, filtered by the watch.units globs. */
function unitProblems(cfg: Config, listUnits: UnitLister, now: number): WatchProblem[] {
	const globs = cfg.watch.units.map(p => new Glob(p));
	const out: WatchProblem[] = [];
	for (const unit of listUnits()) {
		if (!globs.some(g => g.match(unit.name))) continue;
		const err = unit.error || "state failed";
		out.push({
			fingerprint: `watch:unit-failed:${unit.name}`,
			kind: "unit-failed",
			job: unit.name,
			at: new Date(now * 1000).toISOString(),
			line: err,
			summary: `${unit.name} unit failed: ${err}`,
			evidence: `failed user unit (watch.units: ${cfg.watch.units.join(", ")}); last error line: ${err}`,
		});
	}
	return out;
}

/** One watcher pass: heartbeats, failed units, CI, gated detectors, release verdicts — in that order. */
export function watchOnce(cfg: Config, deps: WatchDeps): WatchReport {
	const now = deps.now();
	const ci = ciScan(cfg, { run: deps.runner, now, plans: deps.plans(), staffed: deps.staffed(now) });
	for (const s of ci.skipped) log(cfg.paths.guard_log, `ci: skipped ${s}`);
	if (ci.recorded) log(cfg.paths.guard_log, `ci: recorded M3 for ${ci.recorded} merged MR(s)`);
	if (ci.flaky) log(cfg.paths.guard_log, `ci: recorded ${ci.flaky} flaky commit(s)`);
	const problems = [...beatProblems(cfg, readBeats(cfg), now), ...unitProblems(cfg, deps.listUnits, now), ...ci.problems];
	// A ci-red-mr a staffed plan held back is still red: it stays open, it is not dismissed as recovered.
	const current = new Set([...problems.map(p => p.fingerprint), ...ci.held]);

	// Recovery first, so a problem that recovers and re-fails between two runs opens a new
	// incident instead of sighting the old one: dedup counts open incidents only. Views are
	// re-read after the dismissals: a pushed pre-dismissal view would carry resolution null
	// (IncidentView's "open" marker) for an incident this run just closed.
	const closedIds: string[] = [];
	for (const inc of openIncidents(cfg)) {
		// A release-regression incident (P11) is a finding, not a live problem: a later run seeing
		// nothing is not a recovery — Main plans or dismisses it.
		if (inc.source !== "watch" || inc.kind === "release-regression" || current.has(inc.fingerprint)) continue;
		const subject = inc.fingerprint.split(":").slice(2).join(":") || inc.kind;
		const refusal = dismissIncident(cfg, inc.id, `watch: recovered — ${subject} healthy again (watch run ${new Date(now * 1000).toISOString()})`);
		if (refusal) {
			log(cfg.paths.guard_log, `watch recovery refused for ${inc.id}: ${refusal}`);
			continue;
		}
		log(cfg.paths.guard_log, `incident ${inc.id} [watch/${inc.kind}] closed: recovered`);
		closedIds.push(inc.id);
	}
	const closed: IncidentView[] = [];
	if (closedIds.length) {
		const views = readIncidents(cfg);
		for (const id of closedIds) {
			const v = views.find(i => i.id === id);
			if (v) closed.push(v);
		}
	}

	const opened: IncidentView[] = [];
	const deduped: IncidentView[] = [];
	const posts: string[] = [];
	for (const p of problems) {
		const { incident, deduped: seen } = addIncident(
			cfg,
			{ source: "watch", kind: p.kind, summary: p.summary, evidence: p.evidence, fingerprint: p.fingerprint },
			now,
		);
		log(cfg.paths.guard_log, `incident ${incident.id} [watch/${p.kind}]${seen ? ` sighting #${incident.count}` : " opened"}: ${p.summary}`);
		(seen ? deduped : opened).push(incident);
		// Push, not pull (P3): one ⚠ post per NEW incident only — a deduped sighting stays silent.
		if (!seen) posts.push(`⚠ ${p.job}: ${p.kind} at ${p.at} — ${p.line} (incident ${incident.id})`);
	}

	// At most watch.max_posts_per_run posts per run; the rest fold into one "+N more" line.
	// Nothing at all when no notify provider is configured (the incidents still opened above).
	// The seam is injected; the text goes through the same redactor the notify path applies,
	// since the injected notifier may not scrub by itself (redactSecrets is idempotent, so a
	// postReply hand-off scrubbing again is stable).
	if (posts.length > 0 && notifyProviders(cfg).length > 0) {
		const overflow = posts.splice(cfg.watch.max_posts_per_run);
		if (overflow.length > 0) posts.push(`+${overflow.length} more, see \`neurastream incident list --open\``);
		for (const post of posts) {
			deps.notify(cfg.secrets.redact ? redactSecrets(post, loadKnownSecrets(cfg), cfg.secrets.extra_patterns).text : post);
		}
	}

	// (d) the gated detectors fold their own incidents (D1/D3 behind incidents.scan_interval_sec).
	const detectors = runDetectorsGated(cfg, {}, deps.gather, now);
	// (e) P11: the release verdict — one judgment per tag whose after-window has closed and
	// whose tag has no `{type:"release-verdict"}` record on the metrics ledger yet.
	if (deps.source && deps.tags && deps.tags.length > 0) {
		releaseVerdicts(cfg, {
			now,
			tags: deps.tags,
			source: deps.source,
			notify: text => deps.notify(cfg.secrets.redact ? redactSecrets(text, loadKnownSecrets(cfg), cfg.secrets.extra_patterns).text : text),
		});
	}
	// (f) P9: an owner message that crossed notify.answer_within_min with no hand-back counts M8,
	// one metric per message — the ledger is the once-only marker, not per-pass state.
	let ownerWaits = 0;
	const m8Done = new Set(readMetricEvents(cfg).filter(e => e.type === "m8").map(e => String(e.id)));
	for (const m of waitingOwnerMessages(cfg, now)) {
		if (m8Done.has(m.id)) continue;
		appendMetric(cfg, { type: "m8", id: m.id, waited_sec: now - m.ts, ts: now });
		ownerWaits++;
	}
	if (ownerWaits > 0) log(cfg.paths.guard_log, `watch: M8 ${ownerWaits} owner wait(s) past notify.answer_within_min`);
	return { opened, deduped, closed, detectors, ownerWaits };
}

// ---- P11: the release verdict — is the new version better or worse? ----

/** The inputs of one verdict pass. Tags and the run source are injected: core never runs git or
 * reads harness sessions itself. */
export interface ReleaseVerdictDeps {
	/** Unix seconds now; an after-window is closed once this passes its end. */
	now: number;
	/** The self repo's `v*` tags, oldest first. */
	tags: ReleaseTag[];
	/** Run data for the windows: Main tool calls and run costs. */
	source: RunSource;
	/** The chat notifier: one line per newly closable tag. */
	notify: (text: string) => void;
}

export type VerdictWord = "BETTER" | "WORSE" | "MIXED" | "watcher-off";

export interface ReleaseVerdict {
	tag: string;
	verdict: VerdictWord;
	/** The notify line, when one posted. */
	post: string | null;
}

/** An after-window runs from the tag to the next tag or 24 h, whichever is first (the heartbeat
 * is one overwritten file, so longer outages are not provable). */
const VERDICT_CAP_SEC = 86400;

/** The value per 100 Main tool calls in the window, so a busy night is not read as a worse version. */
const rate = (v: number | null, calls: number): number | null => (v === null ? null : (v * 100) / calls);

/** Percent change of one judged number from before to after; null reads "not comparable"
 * (nothing before — a counter new in this release — or a zero before value). Owner pain
 * appearing from zero is the exception: any positive after vetoes, reported as +100%. */
const pctOf = (n: VerdictNum): number | null => {
	if (n.before === null || n.after === null) return null;
	if (n.group === 1 && n.after > 0 && (n.before === 0 || n.beforeCount === 0)) return 100;
	if (n.beforeCount === 0 || n.before === 0) return null;
	return ((n.after - n.before) / n.before) * 100;
};

const isBetter = (n: VerdictNum, pct: number): boolean => (n.group === 5 ? pct > 0 : pct < 0);

/** Phases ticked in the window: a scored accept or validate names the plan and phase it
 * finished (the only time series the ledger holds for output). */
const phasesTicked = (cfg: Config, w: Window): number => new Set(readEvents(cfg).filter(e => (e.type === "accept" || e.type === "validate") && inWindow(Number(e.ts), w)).map(e => `${String(e.plan)}/${String(e.phase)}`)).size;

/** Dot-version compare for the launcher's version-change events: "0.2.9" < "0.2.10". */
function verCompare(a: string, b: string): number {
	const pa = a.split(".").map(p => Number.parseInt(p, 10) || 0);
	const pb = b.split(".").map(p => Number.parseInt(p, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Was the incident alive at some point of the window: opened before the window ended, and
 * either still open or seen again after the window began — a resolution record carries no close
 * time, so the last sighting stands in for it. */
function overlapsWindow(i: IncidentView, w: Window): boolean {
	return i.ts < w.to && (i.resolution === null || i.lastSeen > w.from);
}

const signed = (pct: number): string => `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(0)}%`;
const fmtNum = (v: number): string => String(Number(v.toFixed(1)));

/** One judged number: the same value in both windows. Rates are per 100 Main tool calls. */
interface VerdictNum {
	name: string;
	/** 1 = owner pain (any of it worse reads WORSE outright), 2-4 = worse when higher, 5 = output (worse when lower). */
	group: 1 | 2 | 3 | 4 | 5;
	before: number | null;
	after: number | null;
	/** The raw counts: 0 before means the counter is new in the release — "new, not compared". */
	beforeCount: number;
	afterCount: number;
	/** The daily-check metric key whose open incident this may not double, when one exists. */
	dailyKey?: string;
}

/** One verdict per tag once its after-window closes; the `{type:"release-verdict"}` metrics
 * record is the ledger marker, so no tag is ever judged twice. */
export function releaseVerdicts(cfg: Config, deps: ReleaseVerdictDeps): ReleaseVerdict[] {
	const done = new Set(readMetricEvents(cfg).filter(e => e.type === "release-verdict").map(e => String(e.tag)));
	const tags = deps.tags.toSorted((a, b) => a.ts - b.ts);
	const out: ReleaseVerdict[] = [];
	for (let i = 0; i < tags.length; i++) {
		const tag = tags[i]!;
		if (done.has(tag.name)) continue;
		const end = Math.min(tag.ts + VERDICT_CAP_SEC, tags[i + 1]?.ts ?? tag.ts + VERDICT_CAP_SEC);
		if (deps.now < end) continue;
		const verdict = judgeRelease(cfg, tag.name, { from: tag.ts - (end - tag.ts), to: tag.ts }, { from: tag.ts, to: end }, deps);
		if (verdict === null) continue; // not enough data yet: no verdict, nothing recorded, nothing posted
		appendMetric(cfg, { type: "release-verdict", tag: tag.name, verdict: verdict.verdict, ts: deps.now });
		if (verdict.post !== null) deps.notify(verdict.post);
		out.push(verdict);
	}
	return out;
}

/** Judges one closed after-window against the same-length before window; null reads "not enough data yet". */
function judgeRelease(cfg: Config, tag: string, before: Window, after: Window, deps: ReleaseVerdictDeps): ReleaseVerdict | null {
	const incidents = readIncidents(cfg);
	// Watcher gap: a not-running incident open at any time in either window means that window's
	// watcher-fed numbers read ~0 for want of a watcher — no verdict is possible.
	if (incidents.some(i => i.fingerprint === "watch:not-running" && (overlapsWindow(i, before) || overlapsWindow(i, after)))) {
		return { tag, verdict: "watcher-off", post: `${tag}: watcher off, no verdict` };
	}
	const callsOf = (w: Window) => deps.source.listRuns(w.from).filter(r => r.kind === "main" && inWindow(r.lastWriteAt, w)).reduce((s, r) => s + r.calls, 0);
	const bc = callsOf(before);
	const ac = callsOf(after);
	if (bc < cfg.watch.release_min_calls || ac < cfg.watch.release_min_calls) return null;
	const metricEvents = readMetricEvents(cfg);
	const events = [...readEvents(cfg), ...metricEvents];
	const blocks = readBlocks(cfg);
	const b = snap(cfg, deps.source, events, blocks, incidents, before);
	const a = snap(cfg, deps.source, events, blocks, incidents, after);
	// The weekly report's own rows carry M2 idle calls, M3 mean tries and both M4 counts: the
	// verdict reads the same numbers the owner sees.
	const rows = new Map(rowsOf(a, b).map(r => [r.key, r]));
	const row = (key: string) => rows.get(key)!;
	const inCount = (type: string, w: Window) => metricEvents.filter(e => e.type === type && inWindow(Number(e.ts), w)).length;
	const kindIn = (kind: string, w: Window) => incidents.filter(i => i.kind === kind && inWindow(i.ts, w)).length;
	const merges = (w: Window) => inCount("ci", w);
	const nums: VerdictNum[] = [
		// 1 owner pain (veto — any of these worse reads WORSE outright)
		{ name: "corrections", group: 1, before: rate(row("m4_corrections").prev, bc), after: rate(row("m4_corrections").cur, ac), beforeCount: row("m4_corrections").prev ?? 0, afterCount: row("m4_corrections").cur ?? 0, dailyKey: "m4_corrections" },
		{ name: "questions", group: 1, before: rate(row("m4_questions").prev, bc), after: rate(row("m4_questions").cur, ac), beforeCount: row("m4_questions").prev ?? 0, afterCount: row("m4_questions").cur ?? 0, dailyKey: "m4_questions" },
		{ name: "m8 waits", group: 1, before: rate(inCount("m8", before), bc), after: rate(inCount("m8", after), ac), beforeCount: inCount("m8", before), afterCount: inCount("m8", after) },
		// 2 stuck
		{ name: "idle", group: 2, before: rate(row("m2").prev, bc), after: rate(row("m2").cur, ac), beforeCount: row("m2").prev ?? 0, afterCount: row("m2").cur ?? 0, dailyKey: "m2" },
		{ name: "false blocks", group: 2, before: rate(m7(incidents, b.m5.falseAlarms, before), bc), after: rate(m7(incidents, a.m5.falseAlarms, after), ac), beforeCount: m7(incidents, b.m5.falseAlarms, before), afterCount: m7(incidents, a.m5.falseAlarms, after) },
		// 3 quality
		{ name: "ci tries", group: 3, before: row("m3").prev, after: row("m3").cur, beforeCount: merges(before), afterCount: merges(after), dailyKey: "m3" },
		{ name: "silent failures", group: 3, before: rate(silentFailures(incidents, before), bc), after: rate(silentFailures(incidents, after), ac), beforeCount: silentFailures(incidents, before), afterCount: silentFailures(incidents, after) },
		{ name: "open→fix median h", group: 3, before: b.m6.medianHours, after: a.m6.medianHours, beforeCount: b.m6.fixed, afterCount: a.m6.fixed },
		{ name: "ci-flaky", group: 3, before: rate(inCount("ci-flaky", before), bc), after: rate(inCount("ci-flaky", after), ac), beforeCount: inCount("ci-flaky", before), afterCount: inCount("ci-flaky", after) },
		{ name: "ci-red-main", group: 3, before: rate(kindIn("ci-red-main", before), bc), after: rate(kindIn("ci-red-main", after), ac), beforeCount: kindIn("ci-red-main", before), afterCount: kindIn("ci-red-main", after) },
		{ name: "incidents", group: 3, before: rate(b.m6.opened, bc), after: rate(a.m6.opened, ac), beforeCount: b.m6.opened, afterCount: a.m6.opened },
		{ name: "fix plans", group: 3, before: rate(b.m6.planned, bc), after: rate(a.m6.planned, ac), beforeCount: b.m6.planned, afterCount: a.m6.planned },
		// 4 cost — merges counted from the forge merges P6b records, so a missing `agent-score accept` does not blank it
		{ name: "$/merge", group: 4, before: merges(before) > 0 ? (b.m1.worker + b.m1.main) / merges(before) : null, after: merges(after) > 0 ? (a.m1.worker + a.m1.main) / merges(after) : null, beforeCount: merges(before), afterCount: merges(after) },
		// 5 output — worse when lower
		{ name: "merges", group: 5, before: rate(merges(before), bc), after: rate(merges(after), ac), beforeCount: merges(before), afterCount: merges(after) },
		{ name: "phases", group: 5, before: rate(phasesTicked(cfg, before), bc), after: rate(phasesTicked(cfg, after), ac), beforeCount: phasesTicked(cfg, before), afterCount: phasesTicked(cfg, after) },
	];
	// M5 by reason: each refusal shape is its own number; the daily m5 total stays the fingerprint.
	const shaped = new Map<string, { b: number; a: number }>();
	for (const bl of blocks) {
		if (!inWindow(bl.ts, before) && !inWindow(bl.ts, after)) continue;
		const k = reasonKey(bl.reason);
		const e = shaped.get(k) ?? { b: 0, a: 0 };
		if (inWindow(bl.ts, before)) e.b++;
		else e.a++;
		shaped.set(k, e);
	}
	for (const [k, e] of shaped) nums.push({ name: `blocks(${k})`, group: 2, before: rate(e.b, bc), after: rate(e.a, ac), beforeCount: e.b, afterCount: e.a, dailyKey: "m5" });

	const isWorse = (n: VerdictNum, pct: number): boolean => {
		if (n.group === 1) return n.after! > n.before!;
		return n.group === 5 ? pct <= -cfg.watch.release_regress_pct : pct >= cfg.watch.release_regress_pct;
	};
	const downgrade = metricEvents
		.filter(e => e.type === "version-change" && inWindow(Number(e.ts), after))
		.map(e => ({ from: String(e.from ?? ""), to: String(e.to ?? "") }))
		.find(v => verCompare(v.to, v.from) < 0) ?? null;
	const judged = nums.map(n => ({ n, pct: pctOf(n) })).filter((jd): jd is { n: VerdictNum; pct: number } => jd.pct !== null);
	const worseOnes = judged.filter(jd => isWorse(jd.n, jd.pct));
	const improved24 = judged.some(jd => jd.n.group >= 2 && jd.n.group <= 4 && isBetter(jd.n, jd.pct));
	let verdict: "BETTER" | "WORSE" | "MIXED";
	if (downgrade !== null || worseOnes.length > 0) verdict = "WORSE";
	else if (judged.filter(jd => jd.n.group >= 2).every(jd => !isWorse(jd.n, jd.pct)) && improved24) verdict = "BETTER";
	else verdict = "MIXED";

	const parts: string[] = [];
	if (downgrade !== null) parts.push(`downgrade ${downgrade.from}→${downgrade.to}`);
	for (const v of judged.filter(jd => jd.n.group === 1)) parts.push(`${v.n.name} ${signed(v.pct)}`);
	for (const g of [2, 3, 4, 5] as const) {
		const top = judged.filter(jd => jd.n.group === g).toSorted((p, q) => Math.abs(q.pct) - Math.abs(p.pct))[0];
		if (top) parts.push(`${top.n.name} ${signed(top.pct)}`);
	}
	const fresh = nums.filter(n => n.beforeCount === 0 && pctOf(n) === null).map(n => n.name);
	const freshLine = fresh.length === 0 ? "" : `${(fresh.length > 4 ? [...fresh.slice(0, 4), `+${fresh.length - 4} more`] : fresh).join(", ")} new, not compared`;
	const post = `${tag}: ${verdict} — ${[...parts, freshLine].filter(p => p !== "").join(", ")}`;

	if (verdict === "WORSE") {
		const top = worseOnes.toSorted((p, q) => Math.abs(q.pct) - Math.abs(p.pct))[0];
		const name = top ? top.n.name : "downgrade";
		const vals = top ? `${fmtNum(top.n.before!)}→${fmtNum(top.n.after!)}` : `${downgrade!.from}→${downgrade!.to}`;
		// The daily/weekly check may already hold today's open incident on this metric: the shared
		// fingerprint dedups into it instead of doubling the story.
		const fingerprint = top?.n.dailyKey !== undefined ? `daily:${top.n.dailyKey}:${strftime(deps.now, "%Y-%m-%d")}` : `release:${tag}:${name}`;
		addIncident(cfg, { source: "watch", kind: "release-regression", summary: `release ${tag} worse: ${name} ${vals}`, evidence: post, fingerprint }, deps.now);
	}
	return { tag, verdict, post };
}

/** The plan files a timer run treats as staffed: a plan whose newest spawn (staffing.json) names tasks and is newer than `ciRedHours` before `now`. An older spawn's agent is gone, so its red MR is not held back (I-20261031-265). A timer run has no live job list, so the spawn record is the only signal it has. */
export function timerStaffedPlans(now: number, ciRedHours: number): string[] {
	const since = now - ciRedHours * 3600;
	return Object.entries(readStaffingEntries()).filter(([, e]) => e.names.length > 0 && e.at > since).map(([file]) => file);
}

/** The watcher's unit files under one home: the systemd user service and timer on Linux, the
 *  LaunchAgent plist on macOS. `watch on|off` (src/cli/watch-setup.ts) writes and removes them. */
export function watchUnitPaths(home: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "darwin") return [join(home, "Library/LaunchAgents/neurastream-watch.plist")];
	return [join(home, ".config/systemd/user/neurastream-watch.service"), join(home, ".config/systemd/user/neurastream-watch.timer")];
}

/** Whether the watcher timer is installed, and when its "watch" heartbeat last beat. */
export interface WatchHealth {
	installed: boolean;
	/** ISO time of the last watch run, or null when it never beat. */
	lastRunAt: string | null;
	/** Whole minutes since lastRunAt, or null when it never beat. */
	lastRunMin: number | null;
	/** watch.interval_min: the timer's period, the basis of the stale rule. */
	intervalMin: number;
}

/** Read-only: unit files present and the "watch" heartbeat age. No service-manager call. */
export function watchHealth(cfg: Config, nowMs: number, platform: NodeJS.Platform = process.platform): WatchHealth {
	const installed = watchUnitPaths(cfg.paths.home, platform).every(p => existsSync(p));
	const lastRunAt = readBeats(cfg).watch?.at ?? null;
	const lastRunMin = lastRunAt === null ? null : Math.max(0, Math.floor((nowMs - Date.parse(lastRunAt)) / 60000));
	return { installed, lastRunAt, lastRunMin, intervalMin: cfg.watch.interval_min };
}

/** The doctor line: `watch: on, last run 5 min ago`, or `watch: off, last run never`. */
export function watchDoctorLine(h: WatchHealth): string {
	return `watch: ${h.installed ? "on" : "off"}, last run ${h.lastRunMin === null ? "never" : `${h.lastRunMin} min ago`}`;
}
