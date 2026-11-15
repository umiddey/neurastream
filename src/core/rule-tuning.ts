// Kind scoring for the tuner (plan 20261110_1746 P3). Pure over the incidents and the
// guard-log text the caller injects: no clock, no files, no home. The daily step applies
// `tuning`; this function only counts.
import type { Config } from "./config.ts";
import type { IncidentView } from "./incidents.ts";
import { inWindow, type Window } from "./metrics.ts";
import { TUNABLE } from "./rule-levels.ts";

export type Tuning = Config["tuning"];

export interface KindScore {
	kind: string;
	/** Incidents opened in the window plus tell/off tally lines in the window. */
	fires: number;
	planned: number;
	fixed: number;
	dismissed: number;
	/** (planned + fixed) / fires, or 0 when nothing fired. */
	usefulShare: number;
}

const TALLY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \[[^\]]*\] rule (\S+) (tell|off): /;

export function scoreKinds(incidents: IncidentView[], logText: string, w: Window, tuning: Tuning): KindScore[] {
	if (!Number.isFinite(tuning.min_fires) || !Number.isFinite(tuning.max_useful)) {
		throw new Error("tuning thresholds must be numbers");
	}
	const opened = new Map<string, IncidentView[]>();
	for (const kind of TUNABLE) opened.set(kind, []);
	for (const incident of incidents) {
		if (!opened.has(incident.kind) || !inWindow(incident.ts, w)) continue;
		opened.get(incident.kind)!.push(incident);
	}
	const tallies = new Map<string, number>();
	for (const line of logText.split("\n")) {
		const hit = TALLY.exec(line);
		if (!hit) continue;
		const ts = Date.parse(hit[1]!) / 1000;
		const kind = hit[2]!;
		if (!opened.has(kind) || !inWindow(ts, w)) continue;
		tallies.set(kind, (tallies.get(kind) ?? 0) + 1);
	}
	return TUNABLE.map((kind) => {
		const list = opened.get(kind) ?? [];
		const fires = list.length + (tallies.get(kind) ?? 0);
		const planned = list.filter((i) => i.resolution?.type === "plan").length;
		const fixed = list.filter((i) => i.resolution?.type === "fixed").length;
		const dismissed = list.filter((i) => i.resolution?.type === "dismiss").length;
		return { kind, fires, planned, fixed, dismissed, usefulShare: fires === 0 ? 0 : (planned + fixed) / fires };
	});
}
