// The tuner scores itself (plan 20261110_1746 P6). The tuner row counts its own down-moves
// (demotions) and undos in the window; an undo rate above 0.5 doubles the bar (capped at 320,
// never lowered), and the bar raises the threshold for every rule's down-step.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { appendMetric, windows } from "../src/core/metrics.ts";
import { readLevels, writeLevels } from "../src/core/rule-levels.ts";
import { nextBar, scoreKinds, TUNER } from "../src/core/rule-tuning.ts";
import { tuneRules } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const NOW = 1_760_000_000;
const utc = (t: number): string => new Date(t * 1000).toISOString();
const dayOf = (t: number): string => utc(t).slice(0, 10);
const KIND = "block-loop";

function cfg(): Config {
	const dir = mkdtempSync(join(tmpdir(), "rule-tuning-self-"));
	DIRS.push(dir);
	mkdirSync(join(dir, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(dir, ".config/neurastream/config.yml"),
		`paths:
  home: "${dir}"
  queue_index: "${join(dir, "INDEX.md")}"
  queue_state: "${join(dir, "queue-state")}"
  guard_log: "${join(dir, "guard.log")}"
  plan_guard_log: "${join(dir, "plan-guard.log")}"
tuning:
  enabled: true
  min_fires: 3
  max_useful: 0.1
  window_days: 7
  probation_days: 7
  guards: false
  keep_off: []
`,
	);
	return loadConfig({ home: dir, env: {} });
}

/** Tell tally lines for `kind`, one second apart from `at`. Each is one fire. */
function tally(c: Config, kind: string, n: number, at: number): void {
	const lines = Array.from({ length: n }, (_, i) => `${utc(at + i)} [test] rule ${kind} tell: tally`);
	appendFileSync(c.paths.guard_log, `${lines.join("\n")}\n`);
}

const ago = (sec: number): number => NOW - sec;

test("the tuner row counts down-moves as demotions, not raises, and undos in the window", () => {
	const c = cfg();
	const events = [
		{ type: "rule-level", rule: "a", from: "block", to: "tell", ts: ago(100) },
		{ type: "rule-level", rule: "b", from: "tell", to: "off", ts: ago(200) },
		{ type: "rule-level", rule: "c", from: "off", to: "tell", ts: ago(300) },
		{ type: "rule-level", rule: "d", from: "block", to: "tell", ts: ago(400 * DAY) },
		{ type: "rule-undo", rule: "a", from: "tell", to: "block", ts: ago(150) },
	];
	const rows = scoreKinds([], "", windows(NOW, 7).cur, c.tuning, events);
	expect(rows.find((r) => r.kind === TUNER)).toMatchObject({ fires: 2, undoRate: 0.5 });
});

test("nextBar doubles only above a 0.5 undo rate, caps at 320, and never lowers", () => {
	expect(nextBar(3, 0.6)).toBe(6);
	expect(nextBar(3, 0.5)).toBe(3);
	expect(nextBar(200, 1)).toBe(320);
	expect(nextBar(400, 1)).toBe(400);
});

test("an undo-heavy window doubles the stored bar and notes it; the tuner never gets a level", () => {
	const c = cfg();
	const at = ago(3 * DAY);
	for (let i = 0; i < 4; i++) appendMetric(c, { type: "rule-level", rule: `r${i}`, from: "block", to: "tell", ts: at + i });
	for (let i = 0; i < 3; i++) appendMetric(c, { type: "rule-undo", rule: `r${i}`, from: "tell", to: "block", ts: at + 10 + i });
	const notes: string[] = [];
	tuneRules(c, NOW, (t) => notes.push(t));
	expect(readLevels(c).tuner).toEqual({ bar: 6 });
	expect(readLevels(c).rules[TUNER]).toBeUndefined();
	expect(notes.join("\n")).toContain("tuner bar 3->6");
});

test("a stored bar above min_fires keeps a rule with fewer fires than the bar from stepping down", () => {
	const c = cfg();
	writeLevels(c, { rules: { [KIND]: { level: "block", date: dayOf(NOW - 30 * DAY) } }, tuner: { bar: 6 } });
	tally(c, KIND, 4, ago(3 * DAY));
	const notes: string[] = [];
	tuneRules(c, NOW, (t) => notes.push(t));
	expect(readLevels(c).rules[KIND]?.level).toBe("block");
	expect(notes.some((t) => t.includes(KIND))).toBe(false);
});

test("without a stored bar the same four fires do step the rule down", () => {
	const c = cfg();
	writeLevels(c, { rules: { [KIND]: { level: "block", date: dayOf(NOW - 30 * DAY) } } });
	tally(c, KIND, 4, ago(3 * DAY));
	const notes: string[] = [];
	tuneRules(c, NOW, (t) => notes.push(t));
	expect(readLevels(c).rules[KIND]?.level).toBe("tell");
	expect(notes.join("\n")).toContain(`${KIND} block→tell`);
	expect(readFileSync(join(c.paths.queue_state, "rule-levels.json"), "utf8")).not.toContain("tuner");
});
