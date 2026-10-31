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
import { readBeats, type Heartbeat } from "./heartbeat.ts";
import { runDetectorsGated, type GatedInputs } from "./incident-detectors.ts";
import { log, readStaffingEntries } from "./guards.ts";
import { notifyProviders } from "./notify.ts";
import { addIncident, dismissIncident, openIncidents, readIncidents, type IncidentView } from "./incidents.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";
import { ciScan } from "./ci.ts";
import type { CommandRunner } from "./mr-sweep.ts";

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

/** One watcher pass: heartbeats, failed units, gated detectors — in that order. */
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
		if (inc.source !== "watch" || current.has(inc.fingerprint)) continue;
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
	return { opened, deduped, closed, detectors };
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
