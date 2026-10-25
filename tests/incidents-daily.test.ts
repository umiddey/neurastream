// Daily and weekly incidents (src/core/main-start.ts, plan P4): the daily check compares the
// last 24h against the mean of the 7 days before and runs once per calendar day; the weekly
// check writes notes/metrics.md itself and its worst ranked metric becomes an incident.
// nowSec() reads NEURASTREAM_NOW, so windows and ids are exact (tests/ledger-not-live.test.ts).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { strftime } from "../src/core/clock.ts";
import { readIncidents } from "../src/core/incidents.ts";
import { worseThanMean } from "../src/core/metrics.ts";
import { metricsDueLine, runDailyCheck, runWeeklyCheck } from "../src/core/main-start.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-daily-"));
const DAY = 86400;
const NOW = 1_000_000_000;
const TODAY = strftime(NOW, "%Y-%m-%d");

const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(NOW);
afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function cfg(): Config {
	const home = join(TMP, `home-${++n}`);
	const queueState = join(home, ".local/state/queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  queue_state: "${queueState}"
  notes: "${join(home, "notes")}"
  score_state: "${join(home, ".local/state/agent-score")}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
`,
	);
	return loadConfig({ home, env: {} });
}

const noRuns: RunSource = { listRuns: () => [], mainSession: () => null };

/** BLOCK lines with one reason (no digits, no paths: the reason key is the line itself). */
function seedBlocks(file: string, ats: number[]): void {
	writeFileSync(file, ats.map(t => `${new Date(t * 1000).toISOString()} BLOCK stop: plan not parked`).join("\n"));
}

function spread(from: number, to: number, count: number): number[] {
	const step = (to - from) / count;
	return Array.from({ length: count }, (_, i) => Math.round(from + (i + 0.5) * step));
}

test("worseThanMean: nulls never fire; the floor and the percent are both required", () => {
	const base = { key: "m5", label: "M5", floor: 50 };
	expect(worseThanMean({ ...base, cur: 120, mean: null }, 25)).toBe(false);
	expect(worseThanMean({ ...base, cur: null, mean: 10 }, 25)).toBe(false);
	expect(worseThanMean({ ...base, cur: 45, mean: 10 }, 25)).toBe(false); // worse 4.5× but below the floor
	expect(worseThanMean({ ...base, cur: 60, mean: 55 }, 25)).toBe(false); // above the floor, under the percent
	expect(worseThanMean({ ...base, cur: 69, mean: 55 }, 25)).toBe(true); // +25.45%: at least 25 counts
	expect(worseThanMean({ ...base, cur: 68, mean: 55 }, 25)).toBe(false); // +23.6%: under
	expect(worseThanMean({ ...base, cur: 50.01, mean: 10 }, 25)).toBe(true); // just above the floor
});

test("daily: a metric worse than the 7-day mean and above its floor opens one incident", () => {
	const c = cfg();
	seedBlocks(c.paths.guard_log, [...spread(NOW - DAY + 600, NOW - 600, 120), ...spread(NOW - 8 * DAY, NOW - DAY, 70)]);
	const out = runDailyCheck(c, noRuns, NOW);
	expect(out).toHaveLength(1);
	expect(out[0]).toMatchObject({ source: "daily", kind: "daily-regression", fingerprint: `daily:m5:${TODAY}` });
	expect(out[0]!.evidence).toContain("120");
	expect(out[0]!.evidence).toContain("10");
	expect(readIncidents(c)).toHaveLength(1);
});

test("daily runs once per calendar day; the next day it runs again", () => {
	const c = cfg();
	seedBlocks(c.paths.guard_log, [...spread(NOW - DAY + 600, NOW - 600, 120), ...spread(NOW - 8 * DAY, NOW - DAY, 70)]);
	expect(runDailyCheck(c, noRuns, NOW)).toHaveLength(1);
	expect(runDailyCheck(c, noRuns, NOW + 3600)).toEqual([]); // same day: marked, no second incident
	expect(readIncidents(c)).toHaveLength(1);
	// Five days later the same shape (fresh blocks) is a new day and a new fingerprint.
	seedBlocks(c.paths.guard_log, [...spread(NOW + 5 * DAY - DAY + 600, NOW + 5 * DAY - 600, 120), ...spread(NOW + 5 * DAY - 8 * DAY, NOW + 5 * DAY - DAY, 70)]);
	const out = runDailyCheck(c, noRuns, NOW + 5 * DAY);
	expect(out).toHaveLength(1);
	expect(out[0]!.fingerprint).not.toBe(readIncidents(c)[0]!.fingerprint);
	expect(readIncidents(c)).toHaveLength(2);
});

test("daily negative: an even week and a below-floor spike open nothing, but the day is still marked", () => {
	const even = cfg();
	seedBlocks(even.paths.guard_log, [...spread(NOW - DAY + 600, NOW - 600, 10), ...spread(NOW - 8 * DAY, NOW - DAY, 70)]);
	expect(runDailyCheck(even, noRuns, NOW)).toEqual([]);
	expect(readFileSync(join(even.paths.queue_state, "incidents-daily.json"), "utf8")).toContain(TODAY);
	expect(readIncidents(even)).toEqual([]);

	const floored = cfg();
	seedBlocks(floored.paths.guard_log, [...spread(NOW - DAY + 600, NOW - 600, 45), ...spread(NOW - 8 * DAY, NOW - DAY, 70)]);
	expect(runDailyCheck(floored, noRuns, NOW)).toEqual([]);
	expect(readIncidents(floored)).toEqual([]);
});

test("weekly: the forced report is written and its worst metric becomes an incident", () => {
	const c = cfg();
	mkdirSync(c.paths.notes, { recursive: true });
	const report = join(c.paths.notes, "metrics.md");
	writeFileSync(report, "old report");
	utimesSync(report, new Date((NOW - 9 * DAY) * 1000), new Date((NOW - 9 * DAY) * 1000));
	seedBlocks(c.paths.guard_log, [...spread(NOW - 7 * DAY, NOW, 500), ...spread(NOW - 14 * DAY, NOW - 7 * DAY, 100)]);

	const line = runWeeklyCheck(c, noRuns, NOW);
	expect(line.startsWith("metrics: report due (last: ")).toBe(true);
	const id = /\bI-\d{8}-\d+\b/.exec(line)?.[0];
	expect(id).toBeDefined();
	expect(line).toContain(`incident ${id!}`);
	// The report is fresh now, so a second check is quiet.
	expect(runWeeklyCheck(c, noRuns, NOW)).toBe("");
	// The report was really rewritten.
	expect(readFileSync(report, "utf8")).toContain("◀ worst");
	const inc = readIncidents(c)[0]!;
	expect(inc.id).toBe(id!);
	expect(inc).toMatchObject({ source: "weekly", kind: "weekly-regression" });
	expect(inc.fingerprint).toMatch(/^weekly:m5:\d{8}$/);
	expect(inc.summary).toContain("+400.0%");
});

test("weekly: a fresh report and an unchanged window open nothing", () => {
	const fresh = cfg();
	mkdirSync(fresh.paths.notes, { recursive: true });
	writeFileSync(join(fresh.paths.notes, "metrics.md"), "fresh");
	utimesSync(join(fresh.paths.notes, "metrics.md"), new Date(NOW * 1000), new Date(NOW * 1000));
	expect(runWeeklyCheck(fresh, noRuns, NOW)).toBe("");
	expect(readIncidents(fresh)).toEqual([]);

	const quiet = cfg();
	mkdirSync(quiet.paths.notes, { recursive: true });
	writeFileSync(join(quiet.paths.notes, "metrics.md"), "old");
	utimesSync(join(quiet.paths.notes, "metrics.md"), new Date((NOW - 9 * DAY) * 1000), new Date((NOW - 9 * DAY) * 1000));
	const line = runWeeklyCheck(quiet, noRuns, NOW);
	expect(line).toContain("no ranked metric moved this window");
	expect(readIncidents(quiet)).toEqual([]);
});

test("the due line no longer asks Main to propose a rule change", () => {
	const c = cfg();
	mkdirSync(c.paths.notes, { recursive: true });
	const file = join(c.paths.notes, "metrics.md");
	expect(metricsDueLine(c, (NOW - 9 * DAY) * 1000)).toContain("(last: never)");
	expect(metricsDueLine(c, (NOW - 9 * DAY) * 1000)).toContain("report due");
	expect(metricsDueLine(c, (NOW - 9 * DAY) * 1000)).not.toContain("propose ONE rule change");
	writeFileSync(file, "report");
	utimesSync(file, new Date(NOW * 1000), new Date(NOW * 1000));
	expect(metricsDueLine(c, NOW * 1000)).toBeNull();
});

test("a fake run source drives the daily M2 metric: idle calls spike opens its own incident", () => {
	const c = cfg();
	const idle: Run = {
		id: "s1",
		kind: "sub",
		model: "t/m",
		calls: 90,
		tokens: 1,
		cacheRead: 0,
		cost: 0,
		inputTokens: 0,
		prefillTokens: 0,
		status: "done",
		statusDetail: "done",
		startedAt: NOW - 7200,
		lastWriteAt: NOW - 3600,
		endedAt: NOW - 3600,
		messages: [],
		scoreModel: "t/m",
		scoreCost: 0,
		scoreHours: 0,
		scoreRunning: false,
		scoreSurvived: false,
		scoreEnd: "",
	};
	const src: RunSource = {
		listRuns: () => [idle, { ...idle, id: "s0", calls: 7, lastWriteAt: NOW - 3 * DAY }],
		mainSession: () => null,
	};
	const out = runDailyCheck(c, src, NOW);
	const m2 = out.find(i => i.fingerprint === `daily:m2:${TODAY}`);
	expect(m2).toBeDefined();
	expect(m2!.summary).toContain("M2 idle calls regressed: 90 last 24h vs 1.00/day");
});
