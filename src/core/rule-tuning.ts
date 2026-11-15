// Kind scoring for the tuner (plan 20261110_1746 P3). Pure over the incidents and the
// guard-log text the caller injects: no clock, no files, no home. The daily step applies
// `tuning`; this function only counts.
import type { Config } from "./config.ts";
import type { IncidentView } from "./incidents.ts";
import { inWindow, type Window } from "./metrics.ts";
import { PINNED, TUNABLE, levelFor, type Level, type RuleEntry, type RuleLevels } from "./rule-levels.ts";

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

const DAY_MS = 86_400_000;

/** One level move the daily step made; `probe` marks a probation raise (off -> tell). */
export interface RuleMove {
	rule: string;
	from: Level;
	to: Level;
	probe: boolean;
}

export interface StepResult {
	levels: RuleLevels;
	moves: RuleMove[];
}

/**
 * The daily tuner step (plan 20261110_1746 P4), pure: the caller reads the levels and scores,
 * writes the returned levels and appends the moves. At most one move per rule. Pinned rules and
 * rules under `held_until` never move; a probation ends after `window_days` and is judged then;
 * a `keep_off` rule is never probation-raised. `checked` is always today; `date` only on a move.
 */
export function decideStep(levels: RuleLevels, scores: KindScore[], now: number, today: string, tuning: Tuning): StepResult {
	const rules: Record<string, RuleEntry> = { ...levels.rules };
	const moves: RuleMove[] = [];
	const move = (rule: string, from: Level, to: Level, entry: RuleEntry, probe = false) => {
		rules[rule] = entry;
		moves.push({ rule, from, to, probe });
	};
	for (const s of scores) {
		const id = s.kind;
		if ((PINNED as readonly string[]).includes(id)) continue;
		const own: RuleEntry | undefined = levels.rules[id];
		if (own?.held_until !== undefined && own.held_until > now) continue;
		const level = levelFor(levels, id);
		const noisy = s.fires >= tuning.min_fires;
		const useless = s.usefulShare < tuning.max_useful;
		const age = own ? Math.round((Date.parse(today) - Date.parse(own.date)) / DAY_MS) : 0;
		if (level === "off" && own) {
			if (!noisy) move(id, "off", "tell", { level: "tell", prev: "off", date: today });
			else if (!tuning.keep_off.includes(id) && age >= tuning.probation_days) {
				move(id, "off", "tell", { level: "tell", prev: "off", date: today, probation: true }, true);
			}
		} else if (level === "tell" && own) {
			if (own.probation && age < tuning.window_days) continue;
			if (!noisy) move(id, "tell", "block", { level: "block", prev: "tell", date: today });
			else if (useless) move(id, "tell", "off", { level: "off", prev: "tell", date: today });
			else if (own.probation) {
				const kept: RuleEntry = { level: own.level, date: own.date };
				if (own.prev !== undefined) kept.prev = own.prev;
				if (own.held_until !== undefined) kept.held_until = own.held_until;
				rules[id] = kept;
			}
		} else if (level === "block" && noisy && useless) {
			move(id, "block", "tell", { level: "tell", prev: "block", date: today });
		}
	}
	const next: RuleLevels = { ...levels, rules, checked: today };
	if (moves.length > 0) next.date = today;
	return { levels: next, moves };
}
