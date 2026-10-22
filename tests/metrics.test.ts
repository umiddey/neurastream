import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { loadConfig } from "../src/core/config.ts";
import {
	appendMetric,
	inWindow,
	loadInputs,
	m1,
	m2,
	m3,
	m4,
	m5,
	parseBlocks,
	readMetricEvents,
	windows,
	type Inputs,
} from "../src/core/metrics.ts";
import { recordCi, recordFalseAlarm, recordRule, reportCmd } from "../src/cli/metrics.ts";
import { buildReport } from "../src/core/report.ts";
import { metricsDueLine } from "../src/core/main-start.ts";

const TMP = mkdtempSync(join(tmpdir(), "metrics-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 86400;
const NOW = 1_000_000_000;
const DAYS = 7;
const cur = windows(NOW, DAYS).cur;

function run(over: Partial<Run> & Pick<Run, "id" | "kind" | "lastWriteAt">): Run {
	return { calls: 0, cost: 0, status: "done", messages: [], ...over } as Run;
}

function iso(ts: number): string {
	return new Date(ts * 1000).toISOString();
}

test("windows split the last 2N days into current and previous, half-open", () => {
	const w = windows(NOW, DAYS);
	expect(w.cur).toEqual({ from: NOW - 7 * DAY, to: NOW });
	expect(w.prev).toEqual({ from: NOW - 14 * DAY, to: NOW - 7 * DAY });
	expect(inWindow(NOW - 7 * DAY, w.cur)).toBe(true);
	expect(inWindow(NOW, w.cur)).toBe(false);
});

const inp: Inputs = {
	runs: [
		run({ id: "a", kind: "sub", lastWriteAt: NOW - 100, calls: 10, cost: 1 }),
		run({ id: "b", kind: "sub", lastWriteAt: NOW - 200, calls: 7, cost: 2 }),
		run({ id: "c", kind: "sub", lastWriteAt: NOW - 300, calls: 50, cost: 9, status: "running" }),
		run({ id: "d", kind: "sub", lastWriteAt: NOW - 500, calls: 5, cost: 0.25 }),
		run({ id: "e", kind: "sub", lastWriteAt: NOW - 600, calls: 12, cost: 0.5 }),
		run({ id: "f", kind: "sub", lastWriteAt: NOW - 700, calls: 3, cost: 0.5, status: "died" }),
		run({ id: "g", kind: "sub", lastWriteAt: NOW - 800, calls: 12, cost: 0.5 }),
		run({ id: "old", kind: "sub", lastWriteAt: NOW - 8 * DAY, calls: 99, cost: 100 }),
		run({ id: "20261020-main", kind: "main", lastWriteAt: NOW - 400, cost: 0.5 }),
	],
	events: [
		{ type: "accept", agent: "a", ts: NOW - 50 },
		// Accepted long before the window: must not count in M1, but still clears M2 for "d".
		{ type: "accept", agent: "d", ts: NOW - 20 * DAY },
	],
};

test("M1 sums sub and main cost written in the window, per in-window accept", () => {
	const r = m1(inp, cur);
	// Worker: a+b+c+d+e+f+g = 1+2+9+0.25+0.5+0.5+0.5 (running c included); main 0.5; "old" excluded.
	expect(r.worker).toBeCloseTo(13.75);
	expect(r.main).toBeCloseTo(0.5);
	expect(r.accepts).toBe(1);
	expect(r.perMerge).toBeCloseTo(14.25);
});

test("M1 with no accepts in the window has no per-merge figure", () => {
	const r = m1({ runs: inp.runs, events: [] }, cur);
	expect(r.accepts).toBe(0);
	expect(r.perMerge).toBeNull();
});

test("M2 counts calls of finished or died sub runs with no judgement, top 3 by calls", () => {
	const r = m2(inp, cur);
	// Unjudged in window: b(7), e(12), f(3, died), g(12). a and d have accepts; c is running; old is outside.
	expect(r.calls).toBe(34);
	expect(r.top).toEqual([
		{ id: "e", calls: 12 },
		{ id: "g", calls: 12 },
		{ id: "b", calls: 7 },
	]);
});

test("loadInputs reads the ledger from the configured state dir and asks for two windows of runs", () => {
	const home = join(TMP, "home");
	const stateDir = join(home, ".local", "state", "agent-score");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({ type: "accept", agent: "x", ts: NOW - 1 })}\n`);
	const cfg = loadConfig({ home });

	let asked = -1;
	const source = {
		listRuns(since: number) {
			asked = since;
			return [];
		},
	} as unknown as RunSource;

	const got = loadInputs(cfg, source, NOW, DAYS);
	expect(asked).toBe(NOW - 14 * DAY);
	expect(got.runs).toEqual([]);
	expect(got.events).toEqual([{ type: "accept", agent: "x", ts: NOW - 1 }]);
	expect(cfg.metrics.report_days).toBe(7);
});

test("M3 is the mean tries of ci events in the window, with MRs at 3 or more", () => {
	const events = [
		{ type: "ci", mr: "10", tries: 1, ts: NOW - 10 },
		{ type: "ci", mr: "11", tries: 3, ts: NOW - 20 },
		{ type: "ci", mr: "12", tries: 4, ts: NOW - 30 },
		{ type: "ci", mr: "old", tries: 9, ts: NOW - 20 * DAY },
	];
	const r = m3(events, cur);
	expect(r.n).toBe(3);
	expect(r.mean).toBeCloseTo(8 / 3);
	expect(r.big).toEqual(["11", "12"]);
	expect(m3([], cur)).toEqual({ n: 0, mean: null, big: [] });
});

test("M4 counts owner messages, corrections and Main's trailing-? questions from JSON-dumped content", () => {
	const main = run({
		id: "20261021-main",
		kind: "main",
		lastWriteAt: NOW - 100,
		messages: [
			{ role: "user", cost: 0, text: JSON.stringify([{ type: "text", text: "no, that is wrong" }]) },
			{ role: "user", cost: 0, text: JSON.stringify("ok thanks") },
			{ role: "assistant", cost: 0, text: JSON.stringify([{ type: "text", text: "Shall I continue?" }]) },
			{ role: "assistant", cost: 0, text: JSON.stringify([{ type: "text", text: "Done." }]) },
		],
	});
	const sub = run({ id: "s", kind: "sub", lastWriteAt: NOW - 100, messages: [{ role: "user", cost: 0, text: "no" }] });
	const patterns = ["\\bno\\b", "wrong"].map((p) => new RegExp(p, "i"));
	expect(m4([main, sub], cur, patterns)).toEqual({ users: 2, corrections: 1, questions: 1 });
});

test("M5 counts BLOCK lines in the window, groups reasons, and counts in-window false alarms", () => {
	const longPath = "/home/ukd/some/very/long/path/that/keeps/going/forever";
	const logText = [
		`${iso(NOW - 100)} BLOCK rm -rf ${longPath} 1`,
		`${iso(NOW - 200)} BLOCK rm -rf ${longPath} 2`,
		`${iso(NOW - 300)} BLOCK plan edit outside scope`,
		`${iso(NOW - 20 * DAY)} BLOCK plan edit outside scope`,
		`${iso(NOW - 10)} ALLOW ok`,
	].join("\n");
	const blocks = parseBlocks(logText);
	const events = [
		{ type: "false-alarm", log_ts: iso(NOW - 100), why: "fine", ts: NOW - 50 },
		{ type: "false-alarm", log_ts: iso(NOW - 20 * DAY), why: "old", ts: NOW - 20 * DAY },
	];
	const r = m5(blocks, events, cur);
	expect(r.blocks).toBe(3);
	expect(r.falseAlarms).toBe(1);
	expect(r.top).toEqual([
		{ reason: "rm -rf /home/ukd/some/very/long/path/that/keeps… N", count: 2 },
		{ reason: "plan edit outside scope", count: 1 },
	]);
});

test("M5 groups every open: <plan list> block reason into one key", () => {
	const logText = [
		`${iso(NOW - 100)} BLOCK stop; open: /a/x.md`,
		`${iso(NOW - 200)} BLOCK stop; open: /a/x.md | /b/y.md`,
		`${iso(NOW - 300)} BLOCK stop; open: /a/x.md`,
	].join("\n");
	const r = m5(parseBlocks(logText), [], cur);
	expect(r.blocks).toBe(3);
	expect(r.top).toEqual([{ reason: "stop; open: <list>", count: 3 }]);
});

function cfgWith(home: string, ciCmd: string) {
	const cfg = loadConfig({ home });
	cfg.metrics.ci_pipelines_cmd = ciCmd;
	return cfg;
}

test("metrics ci runs the configured command in the repo and records tries = array length", () => {
	const cfg = cfgWith(join(TMP, "home-ci"), "printf '[1,2,3]' # {mr}");
	expect(recordCi(cfg, TMP, "42", NOW)).toBe(0);
	const ci = readMetricEvents(cfg).filter((e) => e.type === "ci");
	expect(ci).toEqual([{ type: "ci", mr: "42", repo: TMP, tries: 3, ts: NOW }]);
});

test("metrics ci with an empty command template exits 2", () => {
	const cfg = cfgWith(join(TMP, "home-empty"), "");
	expect(recordCi(cfg, TMP, "42", NOW)).toBe(2);
	expect(readMetricEvents(cfg)).toEqual([]);
});

test("metrics false-alarm and metrics rule append valid JSON lines", () => {
	const cfg = cfgWith(join(TMP, "home-cmds"), "");
	expect(recordFalseAlarm(cfg, iso(NOW - 100), "guard was wrong", NOW)).toBe(0);
	expect(recordRule(cfg, "stop asking about tests", "approved", NOW)).toBe(0);
	expect(readMetricEvents(cfg)).toEqual([
		{ type: "false-alarm", log_ts: iso(NOW - 100), why: "guard was wrong", ts: NOW },
		{ type: "rule", text: "stop asking about tests", decision: "approved", ts: NOW },
	]);
});

test("appendMetric creates the state dir and writes one JSON object per line", () => {
	const cfg = cfgWith(join(TMP, "home-append"), "");
	appendMetric(cfg, { type: "ci", mr: "1", tries: 1, ts: NOW });
	appendMetric(cfg, { type: "ci", mr: "2", tries: 2, ts: NOW });
	expect(readMetricEvents(cfg).map((e) => e.mr)).toEqual(["1", "2"]);
});

test("report compares this window with the previous one, marks the worst change, and gates approved rules", () => {
	const cfg = cfgWith(join(TMP, "home-report"), "");
	cfg.metrics.correction_patterns = ["\\bno\\b"];
	cfg.metrics.report_days = DAYS;
	mkdirSync(cfg.paths.score_state, { recursive: true });
	writeFileSync(
		join(cfg.paths.score_state, "events.jsonl"),
		[
			{ type: "accept", agent: "cur", ts: NOW - 50 },
			{ type: "accept", agent: "prev", ts: NOW - 8 * DAY },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);
	appendMetric(cfg, { type: "rule", text: "recent rule", decision: "approved", ts: NOW - 2 * DAY });
	appendMetric(cfg, { type: "rule", text: "old rule", decision: "approved", ts: NOW - 20 * DAY });
	const runs = [
		run({ id: "cur", kind: "sub", lastWriteAt: NOW - 100, cost: 2, calls: 1 }),
		run({ id: "prev", kind: "sub", lastWriteAt: NOW - 8 * DAY, cost: 1, calls: 1 }),
	];
	const source = {
		listRuns: (since: number) => runs.filter((r) => r.lastWriteAt >= since),
		mainSession: () => null,
	} as unknown as RunSource;

	const r = buildReport(cfg, source, DAYS, NOW);
	expect(r.text).toContain("| M1 cost per merge | $2.00 | $1.00 | +100.0% ◀ worst |");
	expect(r.text.match(/◀ worst/g)?.length).toBe(1);
	expect(r.text).toContain("| M4 owner messages | 0 | 0 | n/a |");
	expect(r.text).toContain("recent rule (approved");
	expect(r.text).toContain("): measuring");
	expect(r.text).toContain("- old rule (approved");
	expect(r.text).toContain("→");
	expect(r.md).toContain("GENERATED");
});

test("metrics report writes notes/metrics.md and exits 0; a bad --days exits 2", () => {
	const cfg = cfgWith(join(TMP, "home-write"), "");
	const source = { listRuns: () => [], mainSession: () => null } as unknown as RunSource;
	expect(reportCmd(cfg, source, ["--days", "0"], NOW)).toBe(2);
	expect(reportCmd(cfg, source, ["--days", "7"], NOW)).toBe(0);
	const written = Bun.file(join(cfg.paths.notes, "metrics.md"));
	expect(written.size).toBeGreaterThan(0);
});

test("metricsDueLine: missing report says never, an 8-day-old report is due, a 1-day-old one is fresh", () => {
	const cfg = cfgWith(join(TMP, "home-due"), "");
	cfg.metrics.report_days = DAYS;
	mkdirSync(cfg.paths.notes, { recursive: true });
	const file = join(cfg.paths.notes, "metrics.md");
	const nowMs = NOW * 1000;
	expect(metricsDueLine(cfg, nowMs)).toContain("(last: never)");
	writeFileSync(file, "report");
	utimesSync(file, new Date(nowMs - 8 * DAY * 1000), new Date(nowMs - 8 * DAY * 1000));
	expect(metricsDueLine(cfg, nowMs)).toContain("report due");
	utimesSync(file, new Date(nowMs - DAY * 1000), new Date(nowMs - DAY * 1000));
	expect(metricsDueLine(cfg, nowMs)).toBeNull();
});
