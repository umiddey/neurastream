import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { loadConfig } from "../src/core/config.ts";
import { inWindow, loadInputs, m1, m2, windows, type Inputs } from "../src/core/metrics.ts";

const TMP = mkdtempSync(join(tmpdir(), "metrics-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DAY = 86400;
const NOW = 1_000_000_000;
const DAYS = 7;
const cur = windows(NOW, DAYS).cur;

function run(over: Partial<Run> & Pick<Run, "id" | "kind" | "lastWriteAt">): Run {
	return { calls: 0, cost: 0, status: "done", messages: [], ...over } as Run;
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
	const source: RunSource = {
		listRuns(since: number) {
			asked = since;
			return [];
		},
		mainSession: () => undefined,
	} as unknown as RunSource;

	const got = loadInputs(cfg, source, NOW, DAYS);
	expect(asked).toBe(NOW - 14 * DAY);
	expect(got.runs).toEqual([]);
	expect(got.events).toEqual([{ type: "accept", agent: "x", ts: NOW - 1 }]);
	expect(cfg.metrics.report_days).toBe(7);
});
