// INCIDENT I-20261031-254 (plan 20261027_1430 P6b): the timer run reads its staffed plans from
// staffing.json, the same record the spawn gate reads, not a fixed empty list. Runs in a sandbox
// queue state dir; no real home is touched.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { timerStaffedPlans } from "../src/core/watch.ts";

const TMP = mkdtempSync(join(tmpdir(), "watch-staffed-"));
const PREV_STATE = process.env.QUEUE_STATE;

afterAll(() => {
	if (PREV_STATE === undefined) delete process.env.QUEUE_STATE;
	else process.env.QUEUE_STATE = PREV_STATE;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});

test("the timer run reads staffed plans from staffing.json; a plan with no task names is not staffed", () => {
	mkdirSync(join(TMP, "state"), { recursive: true });
	writeFileSync(join(TMP, "state", "staffing.json"), JSON.stringify({ "/p/staffed.md": ["w1"], "/p/idle.md": [] }));
	process.env.QUEUE_STATE = join(TMP, "state");
	refreshQueuePaths();
	expect(timerStaffedPlans()).toEqual(["/p/staffed.md"]);
});
