// Staffing record and priority gate (plan 20261025_0215_index_priority P2/P3): the spawn records
// which task names it was spawned with (staffing.json), running job labels mark a plan staffed,
// and a spawn on a lower plan needs a `Priority skip: <path> — <why>` line for every higher idle
// plan. Everything runs in-process against a sandbox HOME (applyQueueEnv points the queue library
// at it; the caller's QUEUE_* and NEURASTREAM_NOW are restored afterAll).

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnEvent, ToolEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkSpawn, checkTool, priorityProblem, readStaffing, recordSpawns, staffedPlans } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { activePlans, closeLog, stateDirPath } from "../src/core/queue/lib.ts";

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

// --- P3: priority gate (index order is priority) ---

function spawnEv(brief: string, runningJobs?: string[]): SpawnEvent {
	return { agent: "toy-worker", invocationKind: "task", brief, ...(runningJobs === undefined ? {} : { runningJobs }) };
}

function guardLog(): string[] {
	try {
		return readFileSync(join(HOME, "main-guard.log"), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** Reset HIGH to a plain open plan. */
function resetHigh(extra = ""): void {
	writeFileSync(HIGH, planText(extra));
}

test("priorityProblem: pure ranks, staffing and the unknown-jobs pass", () => {
	const plans = activePlans();
	expect(plans.map(p => p.file)).toEqual([HIGH, MID, LOW]);
	// nothing higher than rank 1
	expect(priorityProblem(plans, [HIGH], [], "")).toBeNull();
	// HIGH staffed, MID idle: refused on MID at rank 2
	expect(priorityProblem(plans, [LOW], staffedPlans({ [HIGH]: ["w-high"] }, ["w-high"]), "")).toEqual({
		problem: expect.stringContaining(`higher plan ${MID} (rank 2) is idle`),
	});
	// both higher plans staffed: allowed
	expect(priorityProblem(plans, [LOW], [HIGH, MID], "")).toBeNull();
	// both skips justified
	expect(priorityProblem(plans, [LOW], [], `Priority skip: ${HIGH} — first\nPriority skip: ${MID} — also first`)).toEqual({
		skips: [
			{ plan: HIGH, why: "first" },
			{ plan: MID, why: "also first" },
		],
	});
	// no job info: never refuse
	expect(priorityProblem(plans, [LOW], undefined, "")).toEqual({ unknown: true });
	// one batch naming both ends needs no skip for its own higher plan
	expect(priorityProblem(plans, [HIGH, LOW], [], "")).toBeNull();
});

test("a spawn under an idle higher plan is refused with its rank", () => {
	resetHigh();
	refresh(LOW); // the previous test's allowed spawn spent LOW's progress hash
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1`, []), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`higher plan ${HIGH} (rank 1) is idle`);
	expect(d.reason).toContain(`Priority skip: ${HIGH}`);
	expect(guardLog().at(-1)).toContain(`BLOCK spawn toy-worker: toy-worker: higher plan ${HIGH} (rank 1) is idle`);
});

test("a higher plan that is WAITING, awaiting merge, fully ticked or staffed does not block", () => {
	// MID (rank 2) is held by a running subagent throughout: only HIGH's state varies.
	writeFileSync(STAFFING, JSON.stringify({ [MID]: ["w-mid"] }));
	const jobs = ["w-mid"];
	// WAITING on owner
	resetHigh("\n\nWAITING on owner: tell me when\n");
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg)).toMatchObject({ allow: true });
	// awaiting merge
	writeFileSync(HIGH, planText().replace("Status: open", "Status: complete"));
	appendFileSync(closeLog(HIGH), "queue-close: AWAITING merge: done check green; branch feat/high is not merged yet\n");
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg)).toMatchObject({ allow: true });
	// no unticked phase
	resetHigh();
	writeFileSync(HIGH, planText().replace("- [ ] P1 do the thing", "- [x] P1 do the thing"));
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg)).toMatchObject({ allow: true });
	// staffed: a running subagent holds the higher plan (worker slots may fill below)
	resetHigh();
	writeFileSync(STAFFING, JSON.stringify({ [HIGH]: ["w-high"], [MID]: ["w-mid"] }));
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, ["w-high", "w-mid"]), cfg)).toMatchObject({ allow: true });
	// a name that only shares a prefix is not the staffed plan
	writeFileSync(STAFFING, JSON.stringify({ [HIGH]: ["w-hi"], [MID]: ["w-mid"] }));
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, ["w-high", "w-mid"]), cfg)).toMatchObject({ allow: false });
	resetHigh();
});

test("a Priority skip line with a reason lets the spawn through and is logged", () => {
	resetHigh();
	refresh(LOW);
	const why = "owner ranked the traces series first, this fills the free slot";
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1\nPriority skip: ${HIGH} — ${why}\nPriority skip: ${MID} — behind HIGH\n`, []), cfg);
	expect(d).toMatchObject({ allow: true });
	const lines = guardLog().join("\n");
	expect(lines).toContain(`PRIORITY skip ${HIGH}: ${why}`);
	expect(lines).toContain(`PRIORITY skip ${MID}: behind HIGH`);
});

test("a skip line without a reason is refused", () => {
	resetHigh();
	refresh(LOW);
	for (const line of [`Priority skip: ${HIGH} —`, `Priority skip: ${HIGH} —   `, `Priority skip: ${HIGH}`]) {
		const d = checkSpawn(spawnEv(`Work ${LOW} on P1\n${line}\n`, []), cfg);
		expect(d.allow).toBe(false);
	}
});

test("without job info the gate never refuses and logs PRIORITY unknown jobs", () => {
	resetHigh();
	refresh(LOW);
	const before = guardLog().length;
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1`), cfg);
	expect(d).toMatchObject({ allow: true });
	expect(guardLog().slice(before).some(l => l.includes("PRIORITY unknown jobs"))).toBe(true);
});

test("one batch naming HIGH and LOW needs no skip for its own higher plan; only MID would block a later LOW spawn", () => {
	resetHigh();
	refresh(LOW);
	refresh(HIGH);
	const input = {
		tasks: [
			{ name: "w-high", agent: "toy-worker", task: `Work ${HIGH} on P1`, context: "" },
			{ name: "w-low", agent: "toy-worker", task: `Work ${LOW} on P1`, context: "" },
		],
	};
	const d = checkTool({ tool: "task", input, cwd: TOY, agent: "main", agentId: "m0", calls: 0, paths: [], writes: [], command: "", runningJobs: [] }, cfg);
	expect(d).toMatchObject({ allow: true });
	// HIGH is now staffed by w-high: a further LOW spawn is refused on MID (rank 2), not HIGH
	refresh(LOW);
	const later = checkSpawn(spawnEv(`Work ${LOW} on P1`, ["w-high"]), cfg);
	expect(later.allow).toBe(false);
	expect(later.reason).toContain(`higher plan ${MID} (rank 2) is idle`);
	expect(later.reason).not.toContain(HIGH);
});
