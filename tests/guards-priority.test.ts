// Staffing record and priority gate (plan 20261025_0215_index_priority P2/P3): the spawn records
// which task names it was spawned with (staffing.json), running job labels mark a plan staffed,
// and a spawn on a lower plan needs a `Priority skip: <path> — <why>` line for every higher idle
// plan. Everything runs in-process against a sandbox HOME (applyQueueEnv points the queue library
// at it; the caller's QUEUE_* and NEURASTREAM_NOW are restored afterAll).

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkSpawn, checkTool, readStaffing, recordSpawns, staffedPlans } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { stateDirPath } from "../src/core/queue/lib.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-guard-priority-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const STAFFING = join(STATE, "staffing.json");
const NOW = 1760000000;

// Index order is priority: HIGH is rank 1, MID rank 2, LOW rank 3. The 20261020_* stamps
// grandfather the toy plans out of the "## Code read by Main" template check.
const HIGH = join(TOY, "docs/plans/20261020_0100_high.md");
const MID = join(TOY, "docs/plans/20261020_0101_mid.md");
const LOW = join(TOY, "docs/plans/20261020_0102_low.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(NOW);

function planText(extraProgress = ""): string {
	return `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Priority gate toy.

## Forbidden
- Never skip tests.

## Blockers
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.${extraProgress}
`;
}

const baseCfg: Config = (() => {
	for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(TOY, "docs/plans"), join(TOY, "src"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(AGENT, "INDEX.md"), `${HIGH}\n${MID}\n${LOW}\n`);
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(HIGH, planText());
	writeFileSync(MID, planText());
	writeFileSync(LOW, planText());
	// The blocker script's relative import must survive the copy (tests-only rewrite, as in incident-guards.test.ts).
	const noPush = join(AGENT, "blockers/no-push");
	const repo = join(import.meta.dir, "..");
	writeFileSync(noPush, readFileSync(join(repo, "blockers/no-push"), "utf8").replace("../src/core/blockers.ts", join(repo, "src/core/blockers.ts")));
	chmodSync(noPush, 0o755);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	return loadConfig({ home: HOME, env: {} });
})();

applyQueueEnv(baseCfg);
const cfg = baseCfg;

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

/** A fresh Progress line so the plan's progress hash is spendable again. */
function refresh(plan: string): void {
	appendFileSync(plan, "\n- more progress\n");
}

/** Main's `task` tool call with one named task. */
function taskSpawn(name: string, task: string, runningJobs?: string[]): ToolEvent {
	return {
		tool: "task",
		input: { tasks: [{ name, agent: "toy-worker", task, context: "" }] },
		cwd: TOY,
		agent: "main",
		agentId: "m0",
		calls: 0,
		paths: [],
		writes: [],
		command: "",
		...(runningJobs === undefined ? {} : { runningJobs }),
	};
}

// --- P2: staffing record ---

test("staffedPlans: exact name and its uniqueness suffix match; other names and unknown jobs do not", () => {
	const staffing = { "/p/a.md": ["w"], "/p/b.md": ["w2"], "/p/c.md": ["z"] };
	expect(staffedPlans(staffing, ["w", "other"])).toEqual(["/p/a.md"]);
	expect(staffedPlans(staffing, ["w-2"])).toEqual(["/p/a.md"]);
	expect(staffedPlans(staffing, ["w2"])).toEqual(["/p/b.md"]);
	expect(staffedPlans(staffing, ["nothing"])).toEqual([]);
	expect(staffedPlans(staffing, undefined)).toEqual([]);
});

test("an allowed task spawn records the task names per plan in staffing.json; the newest spawn wins", () => {
	expect(checkTool(taskSpawn("w1", `Work ${LOW} on P1`), cfg)).toMatchObject({ allow: true });
	expect(readStaffing()).toEqual({ [LOW]: ["w1"] });
	// spawns.json keeps its old job (progress hash per plan)
	const spawns = JSON.parse(readFileSync(join(stateDirPath(), "spawns.json"), "utf8")) as Record<string, string>;
	expect(typeof spawns[LOW]).toBe("string");
	refresh(LOW);
	expect(checkTool(taskSpawn("w2", `Work ${LOW} on P1`), cfg)).toMatchObject({ allow: true });
	expect(readStaffing()[LOW]).toEqual(["w2"]);
});

test("a spawn event records the agent name per plan; a nameless recordSpawns leaves staffing alone", () => {
	writeFileSync(STAFFING, JSON.stringify({ [MID]: ["keeper"] }));
	expect(checkSpawn({ agent: "toy-worker", invocationKind: "task", brief: `Work ${HIGH} on P1` }, cfg)).toMatchObject({ allow: true });
	expect(readStaffing()).toEqual({ [MID]: ["keeper"], [HIGH]: ["toy-worker"] });
	recordSpawns([MID]);
	expect(readStaffing()).toEqual({ [MID]: ["keeper"], [HIGH]: ["toy-worker"] });
	refresh(HIGH);
});
