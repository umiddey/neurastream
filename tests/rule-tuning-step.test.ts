// Daily rule-tuning step (plan 20261110_1746 P4): the write side. Drives watchOnce with a temp
// home only. Tally lines and incidents carry explicit timestamps, so each window is exact.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { beat } from "../src/core/heartbeat.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { addIncident, incidentsFile } from "../src/core/incidents.ts";
import { readMetricEvents } from "../src/core/metrics.ts";
import { readLevels, writeLevels, type RuleLevels } from "../src/core/rule-levels.ts";
import { watchOnce, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const NOW = 1_760_000_000;
const utc = (t: number): string => new Date(t * 1000).toISOString();
const dayOf = (t: number): string => utc(t).slice(0, 10);
const TODAY = dayOf(NOW);
const KIND = "block-loop";

function cfg(keepOff: string[] = []): Config {
	const dir = mkdtempSync(join(tmpdir(), "rule-tuning-step-"));
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
  keep_off: ${JSON.stringify(keepOff)}
`,
	);
	return loadConfig({ home: dir, env: {} });
}

/** Tell/off tally lines at `at`, one second apart. Each is one fire in the window. */
function tally(c: Config, kind: string, n: number, at: number): void {
	const lines = Array.from({ length: n }, (_, i) => `${utc(at + i)} [test] rule ${kind} tell: tally`);
	appendFileSync(c.paths.guard_log, `${lines.join("\n")}\n`);
}

/** Realtime incidents: `fixed` of them get a fixed resolution (useful). Realtime, not watch,
 * so the watch recovery loop never dismisses them. */
function incidents(c: Config, kind: string, n: number, at: number, fixed = 0): void {
	for (let i = 0; i < n; i++) {
		const { incident } = addIncident(c, { source: "realtime", kind, summary: `${kind} ${i}`, fingerprint: `${kind}:${at}:${i}` }, at);
		if (i < fixed) {
			appendFileSync(incidentsFile(c), `${JSON.stringify({ type: "fixed", id: incident.id, plan: "fix.md", ts: at })}\n`);
		}
	}
}

function healthy(c: Config): void {
	for (const name of Object.keys(c.watch.expect)) beat(c, name, { ok: true });
}

function deps(at: number, sent: string[], units: FailedUnit[] = []): WatchDeps {
	return {
		now: () => at,
		listUnits: () => units,
		gather: (): GatedInputs => ({ results: [], runs: [], blocks: [] }),
		notify: text => sent.push(text),
		runner: () => ({ code: 1, stdout: "", stderr: "no forge in this test" }),
		plans: () => [],
		staffed: () => [],
	};
}

/** One watcher pass at `at`; returns the notify lines it sent. */
function step(c: Config, at: number): string[] {
	healthy(c);
	const sent: string[] = [];
	watchOnce(c, deps(at, sent));
	return sent;
}

function writeRules(c: Config, rules: RuleLevels["rules"]): void {
	writeLevels(c, { rules });
}

/** Level-move ledger events only: rule-level and rule-probe. */
function moves(c: Config): Record<string, unknown>[] {
	return readMetricEvents(c).filter(e => e.type === "rule-level" || e.type === "rule-probe");
}

function logLines(c: Config): string[] {
	return readFileSync(c.paths.guard_log, "utf8").split("\n").filter(Boolean);
}

test("a noisy block rule with no useful share steps down to tell", () => {
	const c = cfg();
	incidents(c, KIND, 3, NOW - DAY);
	const sent = step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "tell", prev: "block", date: TODAY });
	expect(moves(c)).toEqual([{ type: "rule-level", rule: KIND, from: "block", to: "tell", ts: NOW }]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(KIND);
});

test("a quiet tell rule steps back up to block", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "tell", prev: "block", date: dayOf(NOW - 2 * DAY) } });
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "block", prev: "tell", date: TODAY });
});

test("a quiet off rule steps up to tell at once, without probation", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "off", prev: "tell", date: dayOf(NOW - 2 * DAY) } });
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "tell", prev: "off", date: TODAY });
	expect(moves(c)).toEqual([{ type: "rule-level", rule: KIND, from: "off", to: "tell", ts: NOW }]);
});

test("a noisy off rule not yet probation-due does not move", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "off", prev: "tell", date: dayOf(NOW - 2 * DAY) } });
	tally(c, KIND, 3, NOW - DAY);
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "off", prev: "tell", date: dayOf(NOW - 2 * DAY) });
	expect(moves(c)).toEqual([]);
});

test("probation: a noisy off rule rises to tell after probation_days, is held for window_days, then is judged", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "off", prev: "tell", date: dayOf(NOW - 8 * DAY) } });
	tally(c, KIND, 3, NOW - DAY);
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "tell", prev: "off", date: TODAY, probation: true });
	expect(moves(c)).toEqual([{ type: "rule-probe", rule: KIND, from: "off", to: "tell", ts: NOW }]);

	// Held: three days later the probe is still inside window_days, so nothing moves.
	tally(c, KIND, 3, NOW + 2 * DAY);
	step(c, NOW + 3 * DAY);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "tell", prev: "off", date: TODAY, probation: true });
	expect(moves(c)).toHaveLength(1);

	// Judged: window_days after the probe, the window holds only post-raise fires, still noisy
	// and useless, so the rule falls back to off and the probation flag is gone.
	tally(c, KIND, 3, NOW + DAY);
	step(c, NOW + 7 * DAY);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "off", prev: "tell", date: dayOf(NOW + 7 * DAY) });
	expect(moves(c).at(-1)).toEqual({ type: "rule-level", rule: KIND, from: "tell", to: "off", ts: NOW + 7 * DAY });
});

test("probation judged quiet rises back to block", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "tell", prev: "off", date: TODAY, probation: true } });
	step(c, NOW + 7 * DAY);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "block", prev: "tell", date: dayOf(NOW + 7 * DAY) });
});

test("probation judged with a useful share clears the flag and moves nothing", () => {
	const c = cfg();
	writeRules(c, { [KIND]: { level: "tell", prev: "off", date: TODAY, probation: true } });
	tally(c, KIND, 3, NOW + DAY);
	incidents(c, KIND, 1, NOW + DAY, 1);
	step(c, NOW + 7 * DAY);
	expect(readLevels(c).rules[KIND]).toEqual({ level: "tell", prev: "off", date: TODAY });
	expect(readLevels(c).date).toBeUndefined();
	expect(moves(c)).toEqual([]);
});

test("a pinned rule never moves, even with a stored off entry and noisy fires", () => {
	const c = cfg();
	const entry = { level: "off" as const, prev: "tell" as const, date: dayOf(NOW - 30 * DAY) };
	writeRules(c, { "beat-failed": entry });
	tally(c, "beat-failed", 3, NOW - DAY);
	step(c, NOW);
	expect(readLevels(c).rules["beat-failed"]).toEqual(entry);
	expect(moves(c)).toEqual([]);
});

test("a rule whose held_until is in the future never moves", () => {
	const c = cfg();
	const entry = { level: "tell" as const, prev: "block" as const, date: TODAY, held_until: NOW + DAY };
	writeRules(c, { [KIND]: entry });
	tally(c, KIND, 3, NOW - DAY);
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual(entry);
	expect(moves(c)).toEqual([]);
});

test("a keep_off rule is never probation-raised", () => {
	const c = cfg([KIND]);
	const entry = { level: "off" as const, prev: "tell" as const, date: dayOf(NOW - 8 * DAY) };
	writeRules(c, { [KIND]: entry });
	tally(c, KIND, 3, NOW - DAY);
	step(c, NOW);
	expect(readLevels(c).rules[KIND]).toEqual(entry);
	expect(moves(c)).toEqual([]);
});

test("a corrupt levels file moves nothing, is left as it is, and logs one guard line", () => {
	const c = cfg();
	const path = join(c.paths.queue_state, "rule-levels.json");
	mkdirSync(c.paths.queue_state, { recursive: true });
	writeFileSync(path, "{not json");
	incidents(c, KIND, 3, NOW - DAY);
	const sent = step(c, NOW);
	expect(readFileSync(path, "utf8")).toBe("{not json");
	expect(moves(c)).toEqual([]);
	expect(sent).toEqual([]);
	expect(logLines(c).filter(l => l.includes("rule-levels"))).toHaveLength(1);
});

test("a second tick on the same UTC day does not rescan", () => {
	const c = cfg();
	step(c, NOW);
	incidents(c, KIND, 3, NOW - DAY);
	step(c, NOW + 3600);
	expect(readLevels(c).rules[KIND]).toBeUndefined();
	expect(moves(c)).toEqual([]);
});

test("a no-move day writes only checked", () => {
	const c = cfg();
	step(c, NOW);
	expect(JSON.parse(readFileSync(join(c.paths.queue_state, "rule-levels.json"), "utf8"))).toEqual({ rules: {}, checked: TODAY });
});
