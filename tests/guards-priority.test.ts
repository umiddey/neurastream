// Staffing record and priority gate (plan 20261025_0215 P2/P3, tightened by 20261025_1040): the spawn records
// which task names it was spawned with (staffing.json), running job labels mark a plan staffed,
// and a spawn on a lower plan needs proof for every higher idle plan: the higher plan's own
// `Waits on: <plan>` line for an open indexed plan, or a `Priority skip: <plan> — owner: "<words>"`
// quote (≥ 4 words) that owner-messages.jsonl recorded in the last 24 h. Everything runs in-process
// against a sandbox HOME (applyQueueEnv points the queue library
// at it; the caller's QUEUE_* and NEURASTREAM_NOW are restored afterAll).

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectEvent, SpawnEvent, ToolEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkInject, checkPlanEdit, checkSpawn, checkTool, priorityProblem, readStaffing, recordSpawns, staffedPlans } from "../src/core/guards.ts";
import { ownerSaid } from "../src/core/incidents.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { activePlans, closeLog, stateDirPath, type Plan } from "../src/core/queue/lib.ts";

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
	// planRepo anchors a plan's repo at the nearest .git (repoRoot); without one it falls back to
	// docs/plans itself or whatever repo sits above the OS tmpdir, so pin the toy repo to TOY.
	mkdirSync(join(TOY, ".git"));
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
review:
  agents: []
  plan: false
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
	// both skips justified by the owner's recorded words (normalised: case and spacing folded)
	const said = [{ at: NOW, text: "the traces series gets first prio today" }];
	expect(
		priorityProblem(plans, [LOW], [], `Priority skip: ${HIGH} — owner: "traces series gets first"\nPriority skip: ${MID} — owner: "TRACES   SERIES gets first prio today"`, said, NOW),
	).toEqual({
		skips: [
			{ plan: HIGH, why: `owner: "traces series gets first"` },
			{ plan: MID, why: `owner: "TRACES   SERIES gets first prio today"` },
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

test("a Priority skip with words the owner said lets the spawn through and is logged with the quote", () => {
	resetHigh();
	refresh(LOW);
	writeFileSync(join(STATE, "owner-messages.jsonl"), `${JSON.stringify({ at: NOW, text: "the traces series gets first prio today" })}\n`);
	const why = `owner: "traces series gets first"`;
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1\nPriority skip: ${HIGH} — ${why}\nPriority skip: ${MID} — owner: "gets first prio today"\n`, []), cfg);
	expect(d).toMatchObject({ allow: true });
	const lines = guardLog().join("\n");
	expect(lines).toContain(`PRIORITY skip ${HIGH}: ${why}`);
	expect(lines).toContain(`PRIORITY skip ${MID}: owner: "gets first prio today"`);
});

test("a plain-reason skip is refused while the higher plan is idle; so is a quote nobody said and one older than 24 h", () => {
	resetHigh();
	refresh(LOW);
	const refusal = `higher plan ${HIGH} (rank 1) is idle; a skip needs the owner's words (Priority skip: ${HIGH} — owner: "<quote>") or a "Waits on: ${HIGH}" line in that plan`;
	// the acceptance case: "— busy" carries no owner's words
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1\nPriority skip: ${HIGH} — busy\n`, []), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(refusal);
	const plans = activePlans();
	// an owner-form quote nobody recorded says
	expect(priorityProblem(plans, [LOW], [], `Priority skip: ${HIGH} — owner: "words that nobody ever recorded"`, [], NOW)?.problem).toBe(refusal);
	// a recorded quote older than 24 h
	const old = [{ at: NOW - 86401, text: "the traces series gets first prio today" }];
	expect(priorityProblem(plans, [LOW], [], `Priority skip: ${HIGH} — owner: "traces series gets first"`, old, NOW)?.problem).toBe(refusal);
	// a shorter-than-4-word quote never matches, however recent
	const short = [{ at: NOW, text: "the traces series gets first prio today" }];
	expect(priorityProblem(plans, [LOW], [], `Priority skip: ${HIGH} — owner: "gets first prio"`, short, NOW)?.problem).toBe(refusal);
});

test("a skip line without a reason is refused", () => {
	resetHigh();
	refresh(LOW);
	for (const line of [`Priority skip: ${HIGH} —`, `Priority skip: ${HIGH} —   `, `Priority skip: ${HIGH}`]) {
		const d = checkSpawn(spawnEv(`Work ${LOW} on P1\n${line}\n`, []), cfg);
		expect(d.allow).toBe(false);
	}
});

test("a higher plan with Waits on: an open indexed plan does not block; once that plan is closed it blocks again", () => {
	writeFileSync(STAFFING, JSON.stringify({ [MID]: ["w-mid"] }));
	const jobs = ["w-mid"];
	// without a waits line HIGH blocks
	resetHigh();
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg).allow).toBe(false);
	// `Waits on: <open indexed plan>` (plain and bullet form) frees the slot with no skip line
	for (const extra of [`\n\nWaits on: ${MID}\n`, `\n\n- Waits on: ${MID}\n`]) {
		resetHigh(extra);
		refresh(LOW);
		expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg)).toMatchObject({ allow: true });
	}
	// MID closed (removed from the index): HIGH waits on nothing that is indexed and blocks again
	resetHigh(`\n\nWaits on: ${MID}\n`);
	writeFileSync(join(AGENT, "INDEX.md"), `${HIGH}\n${LOW}\n`);
	refresh(LOW);
	const d = checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`higher plan ${HIGH} (rank 1) is idle`);
	// a waits path that is merely open on disk but absent from the index never counts
	resetHigh(`\n\nWaits on: ${join(TOY, "docs/plans/20261020_0199_ghost.md")}\n`);
	writeFileSync(join(TOY, "docs/plans/20261020_0199_ghost.md"), planText());
	writeFileSync(join(AGENT, "INDEX.md"), `${HIGH}\n${MID}\n${LOW}\n`);
	refresh(LOW);
	expect(checkSpawn(spawnEv(`Work ${LOW} on P1`, jobs), cfg).allow).toBe(false);
	resetHigh();
	writeFileSync(join(TOY, "docs/plans/20261020_0199_ghost.md"), "");
});

test("a subagent edit that adds a Waits on: line to a plan is restored", () => {
	const before = readFileSync(HIGH, "utf8");
	const after = before.replace("- Started.", `- Started.\n\nWaits on: ${MID}`);
	const d = checkPlanEdit({ path: HIGH, before, after, agent: "sub" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.restore).toEqual({ path: HIGH, text: before });
});

test("owner messages are recorded, bounded, and matched as recent normalized quotes", () => {
	const event = (inject: string): InjectEvent => ({ agent: "main", inject });
	const file = join(STATE, "owner-messages.jsonl");
	rmSync(file, { force: true });
	checkInject(event("The owner wants priority for the traces series"), cfg);
	checkInject(event("main-guard: continuation"), cfg);
	checkInject(event("<system-notice> harness notice"), cfg);
	let messages = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(messages).toHaveLength(1);
	expect(messages[0].text).toContain("traces series");
	for (let i = 0; i < 50; i++) checkInject(event(`owner message ${i}`), cfg);
	messages = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(messages).toHaveLength(50);
	expect(messages[0].text).toBe("owner message 0");
	expect(ownerSaid("PRIORITY   for the traces series", [{ at: NOW, text: "The owner wants priority for the traces series" }], NOW)).toBe(true);
	expect(ownerSaid("one two three", [{ at: NOW, text: "one two three" }], NOW)).toBe(false);
	expect(ownerSaid("four words minimum", [{ at: NOW - 86401, text: "four words minimum" }], NOW)).toBe(false);
});

// Live-recheck P5b review fix: real task results carry attributes (`<task-result id="…" agent="glm"
// status="completed">`), so the machine-text exclusion must match the bare open tag, not
// `<task-result>` — an attributed result is a subagent's words, never the owner's.
test("a task-result with attributes is machine text, not an owner message", () => {
	const file = join(STATE, "owner-messages.jsonl");
	rmSync(file, { force: true });
	checkInject(
		{ agent: "main", inject: `<task-result id="x" agent="glm" status="completed">\nStopped per Main's order.\n</task-result>` },
		cfg,
	);
	expect(existsSync(file)).toBe(false);
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

// --- P3b (plan 20261029_1530): a higher plan whose branch has an open MR is landing, not idle ---

/** HIGH rewritten with the branch the cache's MR carries; activePlans() re-reads it fresh. */
function plansWithHighMr(): Plan[] {
	writeFileSync(HIGH, planText().replace("Branch: feat/toy", "Branch: feat/high"));
	return activePlans();
}

/** Seed the open-MR cache the main-start sweep and pendingWorkProblem maintain, keyed by the plan's repo. */
function writeMrCacheFile(at: number, mrs: object[] = [{ forge: "github", number: 7, token: "#7", branch: "feat/high" }]): void {
	const repo = activePlans().find(p => p.file === HIGH)!.repo;
	writeFileSync(join(STATE, "mr-cache.json"), JSON.stringify({ at, repos: { [repo]: mrs } }));
}

test("priorityProblem: a higher plan whose branch has an open MR in a fresh cache does not block (I-20261029-435)", () => {
	const plans = plansWithHighMr();
	writeMrCacheFile(NOW);
	expect(priorityProblem(plans, [MID], [], "", [], NOW, cfg)).toBeNull();
});

test("priorityProblem: a fresh cache without the higher plan's MR still refuses the spawn", () => {
	const plans = plansWithHighMr();
	writeMrCacheFile(NOW, []);
	expect(priorityProblem(plans, [MID], [], "", [], NOW, cfg)?.problem).toContain(`higher plan ${HIGH} (rank 1) is idle`);
});

test("priorityProblem: a stale cache proves no MR, forge unreachable still refuses", () => {
	const plans = plansWithHighMr();
	writeMrCacheFile(NOW - (cfg.review.mr_cache_minutes + 1) * 60);
	expect(priorityProblem(plans, [MID], [], "", [], NOW, cfg)?.problem).toContain(`higher plan ${HIGH} (rank 1) is idle`);
});

// --- P8 (plan 20261028_1600, I-20261031-353): a review spawn skips the priority gate ---

/** LOW with the `## Reuse` line planGate demands once review.agents is non-empty (planGate loads plans with cfg.review.agents; priorityGate's own load keeps the default [], so HIGH stays idle without one). */
function readyLow(): void {
	writeFileSync(LOW, planText().replace("## Done check", "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the toy gate checks src/a.ts\n\n## Done check"));
}

/** A named review spawn by the fixture's one allowed agent; the caller toggles cfg.review.agents. */
function reviewEv(plan: string, runningJobs?: string[]): SpawnEvent {
	return { ...spawnEv(`Plan review: ${plan}\nConfirm the plan's P1.`, runningJobs), name: "rev-low" };
}

test("P8: a review spawn on rank 3 passes the priority gate while rank 1 is idle, with no skip line", () => {
	resetHigh();
	readyLow();
	refresh(LOW);
	cfg.review.agents = ["toy-worker"];
	try {
		const before = guardLog().length;
		expect(checkSpawn(reviewEv(LOW, []), cfg)).toMatchObject({ allow: true });
		const logged = guardLog().slice(before).join("\n");
		expect(logged).not.toContain("PRIORITY skip");
		expect(logged).not.toContain(`higher plan ${HIGH}`);
	} finally {
		cfg.review.agents = [];
	}
});

test("P8: an implementer spawn keeps the priority refusal while rank 1 is idle (not a review spawn)", () => {
	resetHigh();
	readyLow();
	refresh(LOW);
	refresh(LOW); // the review spawn above was allowed and spent LOW's previous progress entry
	cfg.review.agents = ["toy-worker"];
	try {
		const d = checkSpawn(spawnEv(`Work ${LOW} on P1`, []), cfg);
		expect(d.allow).toBe(false);
		expect(d.reason).toContain(`higher plan ${HIGH} (rank 1) is idle`);
	} finally {
		cfg.review.agents = [];
	}
});

test("P8: a Plan review: line from an agent outside review.agents keeps the priority refusal (not a review spawn)", () => {
	resetHigh();
	refresh(LOW);
	const d = checkSpawn(reviewEv(LOW, []), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`higher plan ${HIGH} (rank 1) is idle`);
});
