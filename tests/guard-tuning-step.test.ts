// Guard tuning step red tests (plan 20261110_1746_rule_tuning, P9b): the daily step reaches guard
// ids only when tuning.guards is on, with the same thresholds as the kinds. A noisy, useless guard
// id steps block -> tell with one notify line, and its refusals then become allow + note. Pinned
// ids never move, and a WORSE verdict undoes a guard step. Temp dirs only.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource, ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkTool } from "../src/core/guards.ts";
import { addIncident } from "../src/core/incidents.ts";
import { appendMetric, readMetricEvents } from "../src/core/metrics.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { readLevels, writeLevels } from "../src/core/rule-levels.ts";
import { ruleLevelVerdicts, tuneRules } from "../src/core/watch.ts";

const QUEUE_ENV_BEFORE = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const DIRS: string[] = [];
afterAll(() => {
	// applyQueueEnv writes process.env; later test files in this process must not see it.
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, QUEUE_ENV_BEFORE);
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const NOW = 1_760_000_000;
const T1 = NOW - 10 * DAY;
const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const TODAY = iso(NOW);
const RELATIVE = "tool.relative-plan";

function cfg(guards: boolean): Config {
	const dir = mkdtempSync(join(tmpdir(), "guard-tuning-step-"));
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
  guards: ${guards}
  keep_off: []
`,
	);
	return loadConfig({ home: dir, env: {} });
}

/** `n` BLOCK lines one second apart from `at`, each naming `rule` in its ` rule=<id>` tail. */
function blocks(c: Config, rule: string, n: number, at: number): void {
	const lines = Array.from(
		{ length: n },
		(_, i) => `${new Date((at + i) * 1000).toISOString()} BLOCK refused: x rule=${rule}`,
	);
	appendFileSync(c.paths.guard_log, `${lines.join("\n")}\n`);
}

/** `n` block-then-bypass incidents opened at `at`, each naming `rule`: the refusals were overridden. */
function bypass(c: Config, n: number, at: number, rule: string): void {
	for (let i = 0; i < n; i++) {
		addIncident(c, { source: "realtime", kind: "block-then-bypass", summary: `bypass ${i}`, fingerprint: `bp:${at}:${i}`, rule }, at);
	}
}

// A main write to a plan by a relative path: refused under tool.relative-plan, a non-pinned id.
function relativePlanWrite(c: Config): ToolEvent {
	return {
		tool: "write",
		input: { path: "docs/plans/20261110_1746_scratch.md", content: "" },
		cwd: c.paths.home,
		agent: "main",
		agentId: "MAIN",
		calls: 0,
		paths: [],
		writes: [],
		command: "",
		runningJobs: [],
	};
}

let runNo = 0;
function mainRun(calls: number, at: number): Run {
	runNo++;
	return {
		id: `gs${runNo}`, kind: "main", model: "test", calls, tokens: 0, cacheRead: 0, cost: 0,
		inputTokens: 0, prefillTokens: 0, status: "done", statusDetail: "", startedAt: null,
		lastWriteAt: at, endedAt: null, messages: [],
		scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: false, scoreEnd: "",
	};
}

test("tuning.guards off: a noisy, useless guard id does not move and is never named in a notify line", () => {
	const c = cfg(false);
	blocks(c, RELATIVE, 4, NOW - DAY);
	bypass(c, 4, NOW - DAY, RELATIVE);
	const sent: string[] = [];
	tuneRules(c, NOW, t => sent.push(t));
	expect(readLevels(c).rules[RELATIVE]).toBeUndefined();
	expect(readMetricEvents(c).some(e => e.type === "rule-level" && e.rule === RELATIVE)).toBe(false);
	expect(sent.some(t => t.includes(RELATIVE))).toBe(false);
});

test("tuning.guards on: a noisy, useless guard id steps block to tell, logs one move, sends one notify line", () => {
	const c = cfg(true);
	blocks(c, RELATIVE, 4, NOW - DAY);
	bypass(c, 4, NOW - DAY, RELATIVE);
	const sent: string[] = [];
	tuneRules(c, NOW, t => sent.push(t));
	expect(readLevels(c).rules[RELATIVE]).toEqual({ level: "tell", prev: "block", date: TODAY });
	expect(readMetricEvents(c).filter(e => e.type === "rule-level" && e.rule === RELATIVE).map(e => [e.rule, e.from, e.to])).toEqual([[RELATIVE, "block", "tell"]]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain(`${RELATIVE} block→tell`);
});

test("tuning.guards on: after the step, a refusal of that id is allowed with its reason kept", () => {
	const c = cfg(true);
	applyQueueEnv(c);
	blocks(c, RELATIVE, 4, NOW - DAY);
	bypass(c, 4, NOW - DAY, RELATIVE);
	tuneRules(c, NOW, () => {});
	const d = checkTool(relativePlanWrite(c), c);
	expect(d.allow).toBe(true);
	expect(d.reason).toContain(`[rule ${RELATIVE}]`);
});

test("tuning.guards on: a pinned guard id never moves, however noisy", () => {
	const c = cfg(true);
	blocks(c, "tool.protected", 6, NOW - DAY);
	tuneRules(c, NOW, () => {});
	expect(readLevels(c).rules).toEqual({});
});

test("a WORSE verdict undoes a guard step: the id goes back to block, with a hold", () => {
	const c = cfg(true);
	writeLevels(c, { date: iso(T1), checked: iso(T1), rules: { [RELATIVE]: { level: "tell", prev: "block", date: iso(T1) } } });
	appendMetric(c, { type: "rule-level", rule: RELATIVE, from: "block", to: "tell", ts: T1 });
	appendMetric(c, { type: "version-change", from: "1.0.1", to: "1.0.0", ts: T1 + 3600 });
	const runs: Run[] = [mainRun(400, T1 - 3600), mainRun(400, T1 + 3600)];
	const source: RunSource = { listRuns: () => runs, mainSession: () => null };
	ruleLevelVerdicts(c, { now: NOW, source, notify: () => {} });
	expect(readLevels(c).rules[RELATIVE]).toEqual({ level: "block", prev: "tell", date: TODAY, held_until: NOW + c.tuning.window_days * DAY });
	expect(readMetricEvents(c).filter(e => e.type === "rule-undo").map(e => [e.rule, e.from, e.to])).toEqual([[RELATIVE, "tell", "block"]]);
});
