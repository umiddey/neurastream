// The watcher (plan 20261027_1430 P2, replaces live_recheck P5d): one pass over the job
// heartbeats (P1), the failed user units and the gated incident detectors — with or without a
// Main session open. Every problem folds into the incident store with source "watch" and a
// fingerprint per job+state, so a still-failing job dedupes into one open incident and a new
// failure after recovery opens a fresh one; a watch incident whose problem is gone is closed
// again via dismissIncident. The watcher reports — it never restarts a service or edits plans.
// The clock, the unit lister and the detector gather are injected: tests touch only a temp
// queue_state, never a real home, network or service manager.

import { spawnSync } from "node:child_process";
import { Glob } from "bun";
import type { Config } from "./config.ts";
import { readBeats, type Heartbeat } from "./heartbeat.ts";
import { runDetectorsGated, type GatedInputs } from "./incident-detectors.ts";
import { log } from "./guards.ts";
import { addIncident, dismissIncident, openIncidents, readIncidents, type IncidentView } from "./incidents.ts";

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

/** One problem the watcher found: exactly one addIncident input. */
interface WatchProblem {
	fingerprint: string;
	kind: string;
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
			summary: `${name} heartbeat stale: last beat ${Math.round(ageH * 10) / 10}h ago, expect ${hours}h`,
			evidence: `heartbeat at ${hb.at} (watch.expect: ${hours}h)`,
		});
	}
	return out;
}

/** (c) failed units from the injected lister, filtered by the watch.units globs. */
function unitProblems(cfg: Config, listUnits: UnitLister): WatchProblem[] {
	const globs = cfg.watch.units.map(p => new Glob(p));
	const out: WatchProblem[] = [];
	for (const unit of listUnits()) {
		if (!globs.some(g => g.match(unit.name))) continue;
		const err = unit.error || "state failed";
		out.push({
			fingerprint: `watch:unit-failed:${unit.name}`,
			kind: "unit-failed",
			summary: `${unit.name} unit failed: ${err}`,
			evidence: `failed user unit (watch.units: ${cfg.watch.units.join(", ")}); last error line: ${err}`,
		});
	}
	return out;
}

/** One watcher pass: heartbeats, failed units, gated detectors — in that order. */
export function watchOnce(cfg: Config, deps: WatchDeps): WatchReport {
	const now = deps.now();
	const problems = [...beatProblems(cfg, readBeats(cfg), now), ...unitProblems(cfg, deps.listUnits)];
	const current = new Set(problems.map(p => p.fingerprint));

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
	for (const p of problems) {
		const { incident, deduped: seen } = addIncident(
			cfg,
			{ source: "watch", kind: p.kind, summary: p.summary, evidence: p.evidence, fingerprint: p.fingerprint },
			now,
		);
		log(cfg.paths.guard_log, `incident ${incident.id} [watch/${p.kind}]${seen ? ` sighting #${incident.count}` : " opened"}: ${p.summary}`);
		(seen ? deduped : opened).push(incident);
	}

	// (d) the gated detectors fold their own incidents (D1/D3 behind incidents.scan_interval_sec).
	const detectors = runDetectorsGated(cfg, {}, deps.gather, now);
	return { opened, deduped, closed, detectors };
}
