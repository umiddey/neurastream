// P5b (plan 20261110_1746): a WORSE verdict on a rule-level step undoes the most recent step's
// rules, to the level they had before, with a hold that the daily step respects.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { appendMetric, readMetricEvents } from "../src/core/metrics.ts";
import { readLevels, writeLevels } from "../src/core/rule-levels.ts";
import { decideStep, type KindScore } from "../src/core/rule-tuning.ts";
import { ruleLevelVerdicts } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempCfg(label: string): Config {
	const dir = mkdtempSync(join(tmpdir(), `undo-${label}-`));
	DIRS.push(dir);
	return loadConfig({ home: dir, env: {} });
}

const DAY = 86_400;
const NOW = 1_760_000_000;
// The older step moved block-loop; the most recent step moved ci-red-main (levels.date = its day).
const T0 = NOW - 20 * DAY;
const T1 = NOW - 10 * DAY;
const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const TODAY = iso(NOW);

let runNo = 0;
function mainRun(calls: number, at: number): Run {
	runNo++;
	return {
		id: `ur${runNo}`, kind: "main", model: "test", calls, tokens: 0, cacheRead: 0, cost: 0,
		inputTokens: 0, prefillTokens: 0, status: "done", statusDetail: "", startedAt: null,
		lastWriteAt: at, endedAt: null, messages: [],
		scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: false, scoreEnd: "",
	};
}
const source = (runs: Run[]): RunSource => ({ listRuns: () => runs, mainSession: () => null });

/** Both steps have enough Main calls in their windows on either side of the step. */
const runs = (): Run[] => [mainRun(400, T1 - 3600), mainRun(400, T1 + 3600)];
const deps = (rs: Run[]) => ({ now: NOW, tags: [], source: source(rs), notify: () => {} });

/** Two steps, the levels they left, and (when `downgrade`) a downgrade inside the most recent step's after-window. */
function setup(cfg: Config, downgrade: boolean): void {
	writeLevels(cfg, {
		date: iso(T1),
		checked: iso(T1),
		rules: {
			"block-loop": { level: "tell", prev: "block", date: iso(T0) },
			"ci-red-main": { level: "tell", prev: "block", date: iso(T1) },
		},
	});
	appendMetric(cfg, { type: "rule-level", rule: "block-loop", from: "block", to: "tell", ts: T0 });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "block", to: "tell", ts: T1 });
	if (downgrade) appendMetric(cfg, { type: "version-change", from: "1.0.1", to: "1.0.0", ts: T1 + 3600 });
}

test("a WORSE verdict undoes only the most recent step's rules, to their previous level, with a hold", () => {
	const cfg = tempCfg("worse");
	setup(cfg, true);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "block", prev: "tell", date: TODAY, held_until: NOW + cfg.tuning.window_days * DAY });
	const undos = readMetricEvents(cfg).filter(e => e.type === "rule-undo");
	expect(undos.map(e => [e.rule, e.from, e.to])).toEqual([["ci-red-main", "tell", "block"]]);
});

test("a rule moved only by an older step is not restored by a WORSE verdict", () => {
	const cfg = tempCfg("older");
	setup(cfg, true);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readLevels(cfg).rules["block-loop"]).toEqual({ level: "tell", prev: "block", date: iso(T0) });
	expect(readMetricEvents(cfg).some(e => e.type === "rule-undo" && e.rule === "block-loop")).toBe(false);
});

test("a verdict that is not WORSE restores nothing", () => {
	const cfg = tempCfg("not-worse");
	setup(cfg, false);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readMetricEvents(cfg).some(e => e.type === "rule-undo")).toBe(false);
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "tell", prev: "block", date: iso(T1) });
});

test("the daily step leaves a restored rule alone until its hold passes", () => {
	const cfg = tempCfg("hold");
	setup(cfg, true);
	ruleLevelVerdicts(cfg, deps(runs()));
	const levels = readLevels(cfg);
	const heldUntil = NOW + cfg.tuning.window_days * DAY;
	// Loud and useless: a block-level rule like this moves to tell when not held.
	const score: KindScore = { kind: "ci-red-main", fires: cfg.tuning.min_fires, planned: 0, fixed: 0, dismissed: 0, usefulShare: 0 };
	expect(decideStep(levels, [score], NOW + DAY, iso(NOW + DAY), cfg.tuning).moves).toEqual([]);
	expect(decideStep(levels, [score], heldUntil + 1, iso(heldUntil + 1), cfg.tuning).moves.map(m => m.rule)).toEqual(["ci-red-main"]);
});
