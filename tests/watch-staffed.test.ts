// INCIDENT I-20261031-254 (plan 20261027_1430 P6b): the timer run reads its staffed plans from
// staffing.json, the same record the spawn gate reads, not a fixed empty list.
// INCIDENT I-20261031-265: staffing.json is never pruned, so a plan that ever had a spawn stayed
// staffed forever and its red MR never opened ci-red-mr. A spawn counts only while it is newer
// than watch.ci_red_hours. Runs in a sandbox queue state dir; no real home is touched.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timerStaffedPlans } from "../src/core/watch.ts";

const TMP = mkdtempSync(join(tmpdir(), "watch-staffed-"));
const STATE = join(TMP, "state");
const NOW = 1_800_000_000;
const HOURS = 2;

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function writeStaffing(body: unknown): void {
	mkdirSync(STATE, { recursive: true });
	writeFileSync(join(STATE, "staffing.json"), JSON.stringify(body));
}

test("a spawn 1 h ago with ci_red_hours 2 counts as staffed", () => {
	writeStaffing({ "/p/recent.md": { names: ["w1"], at: NOW - 3600 } });
	expect(timerStaffedPlans(NOW, HOURS, { queue_state: STATE })).toEqual(["/p/recent.md"]);
});

test("a spawn 3 h ago with ci_red_hours 2 does NOT count: ci-red-mr may open", () => {
	writeStaffing({ "/p/stale.md": { names: ["w1"], at: NOW - 3 * 3600 } });
	expect(timerStaffedPlans(NOW, HOURS, { queue_state: STATE })).toEqual([]);
});

test("an old bare-array staffing entry (no spawn time) is not staffed", () => {
	writeStaffing({ "/p/old.md": ["w1"] });
	expect(timerStaffedPlans(NOW, HOURS, { queue_state: STATE })).toEqual([]);
});

test("a plan with no task names is not staffed, however recent", () => {
	writeStaffing({ "/p/idle.md": { names: [], at: NOW - 60 } });
	expect(timerStaffedPlans(NOW, HOURS, { queue_state: STATE })).toEqual([]);
});
