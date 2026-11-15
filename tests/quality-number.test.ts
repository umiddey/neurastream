// M9, the quality number (plan 20261110_1746 P7): adjusted merges per dollar = (accepts - flips) /
// (worker + main). Flips come from the label ledger inside the window; a net-bad window reads negative.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import type { RunSource } from "../src/core/adapter.ts";
import { appendLabel } from "../src/core/labels.ts";
import { adjustedPerDollar, rowsOf, snap } from "../src/core/report.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const NOW = 1_760_000_000;
const W = { from: NOW - 7 * DAY, to: NOW };
const IN = W.from + DAY;

function cfg() {
	const dir = mkdtempSync(join(tmpdir(), "quality-number-"));
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
  score_state: "${join(dir, "score-state")}"
`,
	);
	return loadConfig({ home: dir, env: {} });
}

/** A source with two runs in the window: $1.00 of sub work and $1.00 of main work. */
const SOURCE = {
	listRuns: () => [
		{ id: "s", kind: "sub", cost: 1, lastWriteAt: IN },
		{ id: "m", kind: "main", cost: 1, lastWriteAt: IN },
	],
	mainSession: () => null,
} as unknown as RunSource;

/** One accept event per count, in the window. */
const accepts = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "accept", ts: IN + i }));

test("adjusted merges per dollar is (accepts - flips) / dollars", () => {
	expect(adjustedPerDollar(10, 3, 2)).toBe(3.5);
	expect(adjustedPerDollar(0, 0, 4)).toBe(0);
});

test("zero dollars reads null, and flips above accepts read honestly negative", () => {
	expect(adjustedPerDollar(5, 0, 0)).toBeNull();
	expect(adjustedPerDollar(1, 3, 1)).toBe(-2);
});

test("snap counts only in-window flips from the label ledger and divides by worker + main cost", () => {
	const c = cfg();
	// Episode a: good then bad inside the window -> one flip. Episode b: good, bad before the window -> none.
	appendLabel(c.paths.score_state, { ts: IN, episode: "a", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	appendLabel(c.paths.score_state, { ts: IN + 10, episode: "a", label: "bad", reason: "reverted", party: "implementer", evidence: "fix" });
	appendLabel(c.paths.score_state, { ts: W.from - 100, episode: "b", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	appendLabel(c.paths.score_state, { ts: W.from - 50, episode: "b", label: "bad", reason: "reverted", party: "implementer", evidence: "fix" });

	const s = snap(c, SOURCE, accepts(4), [], [], W);
	// (4 accepts - 1 flip) / ($1 sub + $1 main)
	expect(s.m9).toBe(1.5);
});

test("the ranked rows carry an M9 row with three decimals, and n/a for null", () => {
	const c = cfg();
	const cur = snap(c, SOURCE, accepts(2), [], [], W);
	const prev = snap(c, SOURCE, [], [], [], { from: W.from - 7 * DAY, to: W.from });
	const row = rowsOf(cur, prev).find((r) => r.key === "m9");
	expect(row).toBeDefined();
	expect(row!.name).toBe("M9 adjusted merges per $");
	expect(row!.fmt(1.5)).toBe("1.500");
	expect(row!.fmt(null)).toBe("n/a");
});
