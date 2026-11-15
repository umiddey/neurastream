// P5b/P10 (plan 20261110_1746): a WORSE verdict on a rule-level step puts back that step's own
// rule, to the level its event moved it from, with a hold that the daily step respects.
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
// block-loop moved at T0; ci-red-main moved at T1 (levels.date = T1's day).
const T0 = NOW - 20 * DAY;
const T1 = NOW - 10 * DAY;
const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const TODAY = iso(NOW);
const heldUntil = (cfg: Config): number => NOW + cfg.tuning.window_days * DAY;

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

/** Main calls at each instant: enough in a window for a verdict to be read. */
const runsAt = (...ts: number[]): Run[] => ts.map(t => mainRun(400, t));
/** Calls on either side of T1, so a step at T1 reads a verdict. */
const runs = (): Run[] => runsAt(T1 - 3600, T1 + 3600);
const deps = (rs: Run[]) => ({ now: NOW, tags: [], source: source(rs), notify: () => {} });

/** A version downgrade at `ts`: any window that holds it reads WORSE. */
const downgradeAt = (cfg: Config, ts: number): void => appendMetric(cfg, { type: "version-change", from: "1.0.1", to: "1.0.0", ts });
/** The verdict of each rule-undo-check marker, keyed `rule@change` (change = the judged step's ts). */
const verdicts = (cfg: Config): Record<string, unknown> => Object.fromEntries(readMetricEvents(cfg).filter(e => e.type === "rule-undo-check").map(e => [`${String(e.rule)}@${String(e.change)}`, e.verdict]));
/** The rule-undo events as [rule, from, to]. */
const undoPairs = (cfg: Config): unknown[][] => readMetricEvents(cfg).filter(e => e.type === "rule-undo").map(e => [e.rule, e.from, e.to]);

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
	if (downgrade) downgradeAt(cfg, T1 + 3600);
}

test("a WORSE verdict undoes its own rule, to the level its event moved it from, with a hold", () => {
	const cfg = tempCfg("worse");
	setup(cfg, true);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "block", prev: "tell", date: TODAY, held_until: heldUntil(cfg) });
	// block-loop's own after-window [T0, T0+7d) ends before the downgrade and its before-window has no
	// calls, so its verdict is no-data and it is not restored.
	expect(verdicts(cfg)).toEqual({ [`ci-red-main@${T1}`]: "WORSE", [`block-loop@${T0}`]: "no-data" });
	expect(undoPairs(cfg)).toEqual([["ci-red-main", "tell", "block"]]);
});

test("a rule moved only by an older step is not restored by a newer step's WORSE verdict", () => {
	const cfg = tempCfg("older");
	setup(cfg, true);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readLevels(cfg).rules["block-loop"]).toEqual({ level: "tell", prev: "block", date: iso(T0) });
	expect(undoPairs(cfg).some(p => p[0] === "block-loop")).toBe(false);
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
	const held = heldUntil(cfg);
	// Loud and useless: a block-level rule like this moves to tell when not held.
	const score: KindScore = { kind: "ci-red-main", fires: cfg.tuning.min_fires, planned: 0, fixed: 0, dismissed: 0, usefulShare: 0 };
	expect(decideStep(levels, [score], NOW + DAY, iso(NOW + DAY), cfg.tuning).moves).toEqual([]);
	expect(decideStep(levels, [score], held + 1, iso(held + 1), cfg.tuning).moves.map(m => m.rule)).toEqual(["ci-red-main"]);
});

test("two rules moved by one step: a WORSE verdict on one never restores the other", () => {
	const cfg = tempCfg("one-step-one-judged");
	// ci-flaky changed once before this step, inside the step's before-window: that verdict reads
	// no-before, so ci-flaky stays put even though ci-red-main's WORSE verdict covers the same instant.
	const Y0 = T1 - 3 * DAY;
	writeLevels(cfg, {
		date: iso(T1),
		checked: iso(T1),
		rules: {
			"ci-red-main": { level: "tell", prev: "block", date: iso(T1) },
			"ci-flaky": { level: "block", prev: "tell", date: iso(T1) },
		},
	});
	appendMetric(cfg, { type: "rule-level", rule: "ci-flaky", from: "block", to: "tell", ts: Y0 });
	appendMetric(cfg, { type: "rule-level", rule: "ci-flaky", from: "tell", to: "block", ts: T1 });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "block", to: "tell", ts: T1 });
	downgradeAt(cfg, T1 + 3600);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "block", prev: "tell", date: TODAY, held_until: heldUntil(cfg) });
	expect(readLevels(cfg).rules["ci-flaky"]).toEqual({ level: "block", prev: "tell", date: iso(T1) });
	expect(verdicts(cfg)[`ci-flaky@${T1}`]).toBe("no-before");
	expect(undoPairs(cfg)).toEqual([["ci-red-main", "tell", "block"]]);
});

test("two rules moved by one step: each is restored by its own WORSE verdict", () => {
	const cfg = tempCfg("one-step-both");
	writeLevels(cfg, {
		date: iso(T1),
		checked: iso(T1),
		rules: {
			"ci-red-main": { level: "tell", prev: "block", date: iso(T1) },
			"ci-flaky": { level: "tell", prev: "block", date: iso(T1) },
		},
	});
	appendMetric(cfg, { type: "rule-level", rule: "ci-flaky", from: "block", to: "tell", ts: T1 });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "block", to: "tell", ts: T1 });
	downgradeAt(cfg, T1 + 3600);
	ruleLevelVerdicts(cfg, deps(runs()));
	const undone = { level: "block" as const, prev: "tell" as const, date: TODAY, held_until: heldUntil(cfg) };
	expect(readLevels(cfg).rules).toEqual({ "ci-red-main": undone, "ci-flaky": undone });
	expect(undoPairs(cfg).toSorted()).toEqual([["ci-flaky", "tell", "block"], ["ci-red-main", "tell", "block"]]);
});

// A (block→tell at TA) then B (tell→block at TB) on the same rule. TA sits outside B's before-window
// [TB-7d, TB), so B's verdict is not contaminated by A.
const TA = NOW - 30 * DAY;
const TB = NOW - 20 * DAY;

function setupAThenB(cfg: Config): void {
	writeLevels(cfg, { date: iso(TB), checked: iso(TB), rules: { "ci-red-main": { level: "block", prev: "tell", date: iso(TB) } } });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "block", to: "tell", ts: TA });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "tell", to: "block", ts: TB });
	downgradeAt(cfg, TA + 3600);
}

test("A then B on the same rule: A's WORSE does not restore the rule, its level is B's to, not A's", () => {
	const cfg = tempCfg("a-then-b");
	setupAThenB(cfg);
	// B has no calls in either window: its verdict is no-data, so only A's WORSE is in play.
	ruleLevelVerdicts(cfg, deps(runsAt(TA - 3600, TA + 3600)));
	expect(verdicts(cfg)).toEqual({ [`ci-red-main@${TA}`]: "WORSE", [`ci-red-main@${TB}`]: "no-data" });
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "block", prev: "tell", date: iso(TB) });
	expect(readMetricEvents(cfg).some(e => e.type === "rule-undo")).toBe(false);
});

test("A then B on the same rule: B's own WORSE verdict restores B's step, not A's", () => {
	const cfg = tempCfg("a-then-b-worse");
	setupAThenB(cfg);
	downgradeAt(cfg, TB + 3600);
	ruleLevelVerdicts(cfg, deps(runsAt(TA - 3600, TA + 3600, TB - 3600, TB + 3600)));
	expect(verdicts(cfg)).toEqual({ [`ci-red-main@${TA}`]: "WORSE", [`ci-red-main@${TB}`]: "WORSE" });
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual({ level: "tell", prev: "block", date: TODAY, held_until: heldUntil(cfg) });
	expect(undoPairs(cfg)).toEqual([["ci-red-main", "block", "tell"]]);
});

test("a WORSE verdict does not restore a rule whose hold is still in force", () => {
	const cfg = tempCfg("held");
	const entry = { level: "block" as const, prev: "tell" as const, date: iso(T1), held_until: NOW + DAY };
	writeLevels(cfg, { date: iso(T1), checked: iso(T1), rules: { "ci-red-main": entry } });
	appendMetric(cfg, { type: "rule-level", rule: "ci-red-main", from: "tell", to: "block", ts: T1 });
	downgradeAt(cfg, T1 + 3600);
	ruleLevelVerdicts(cfg, deps(runs()));
	expect(verdicts(cfg)).toEqual({ [`ci-red-main@${T1}`]: "WORSE" });
	expect(readLevels(cfg).rules["ci-red-main"]).toEqual(entry);
	expect(undoPairs(cfg)).toEqual([]);
});
