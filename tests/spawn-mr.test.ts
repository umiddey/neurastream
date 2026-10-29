// Plan review gate P3 (plan 20261028_1600): a spawn on a plan with done-but-not-merged work — an
// open MR the plan mentions, or an unlanded branch the plan or its worktree names — is denied
// until the brief says what that work already holds ("MR !N: … — this task: …" / "Branch x: …").
// Everything runs in-process against temp dirs with an injected command runner; no live state
// dir, no real forge.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkPlanEdit, checkSpawn, pendingWorkProblem, reviewHash, spawnProblem } from "../src/core/guards.ts";
import { listOpenMrs, type CommandResult, type CommandRunner } from "../src/core/mr-sweep.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { unlandedRows } from "../src/core/wip-check.ts";
import { fixturePlan } from "./fixtures/plan.ts";

const TMP = mkdtempSync(join(tmpdir(), "spawn-mr-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const PLAN = join(TOY, "docs/plans/20261029_0100_gate.md");

const OPEN_211 = JSON.stringify([{ iid: 211, source_branch: "feat/e2-classification", state: "opened" }]);
const MERGED_211 = JSON.stringify([{ iid: 211, source_branch: "feat/e2-classification", state: "merged" }]);
const UNLANDED = [
	"UNLANDED branches (commits on no remote): 2  limit 5",
	"  toy                           feat/gate                             abc1234 +2   3.0h old",
	"  toy                           feat/other                           def5678 +1   9.0h old",
	"DIRTY worktrees (uncommitted tracked changes): 1",
	"  /some/wt  2 files",
	"",
].join("\n");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

function planText(): string {
	return fixturePlan({
		branch: "feat/gate",
		blocker: "no-push",
		goal: "- Never redo work already pushed as MR !211.",
		reuse: "## Reuse\n- new: pending-work gate — checked: src/a.ts:1 — reuse: mr-sweep's lister and mentioned\n\n",
	});
}

// A repo whose git answers but has no origin: the whole pending-work check degrades off it.
const NO_ORIGIN_RUNNER: CommandRunner = args =>
	args[0] === "git" ? { code: 1, stdout: "", stderr: "no origin", missing: false } : { code: 127, stdout: "", stderr: "", missing: true };

mkdirSync(join(TOY, "src"), { recursive: true });
mkdirSync(join(TOY, ".git"), { recursive: true }); // planRepo walks up to .git; without it citations resolve under docs/plans
for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(TOY, "docs/plans"), STATE, join(HOME, ".config/neurastream")])
	mkdirSync(d, { recursive: true });
writeFileSync(PLAN, planText());
writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(AGENT, "blockers/no-push"), "#!/bin/sh\nexit 0\n");
chmodSync(join(AGENT, "blockers/no-push"), 0o755);
writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `worker`\n- `reviewer`\n");
writeFileSync(join(AGENT, "CANCELLED.md"), "");

const cfg: Config = (() => {
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
applyQueueEnv(cfg);

// The P2 PASS gate sits beside the P3 gate: record one review through the guard's named review
// spawn (P4k) so these tests exercise only the pending-work check.
{
	const before = readFileSync(PLAN, "utf8");
	writeFileSync(join(STATE, "review-spawns.json"), JSON.stringify({ rev1: { plan: PLAN, text: before, hash: reviewHash(before), verdicts: 0 } }));
	checkPlanEdit(
		{ path: PLAN, before, after: `${before}\n- PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: !211\n  Findings: none\n`, agent: "sub", agentId: "rev1" },
		cfg,
	);
}

// The injected forge: one gitlab repo with MR !211; every command the gate runs is fake.
let mrsJson = OPEN_211;
let glabFails = false;
let wipOutput = "";
let glabCalls = 0;
const runner: CommandRunner = (args: string[]): CommandResult => {
	const bin = args[0];
	if (bin === "git") return { code: 0, stdout: "git@gitlab.example:acme/toy.git\n", stderr: "", missing: false };
	if (bin === "glab") {
		glabCalls++;
		if (glabFails) return { code: 1, stdout: "", stderr: "forge down", missing: false };
		return { code: 0, stdout: mrsJson, stderr: "", missing: false };
	}
	if (bin === "wip-check") return { code: 0, stdout: wipOutput, stderr: "", missing: false };
	return { code: 127, stdout: "", stderr: `unexpected command ${bin}`, missing: true };
};

function resetForge(mrs = OPEN_211, wip = ""): void {
	mrsJson = mrs;
	glabFails = false;
	wipOutput = wip;
	glabCalls = 0;
	rmSync(join(STATE, "mr-cache.json"), { force: true }); // a reset forge must be asked again, not served the previous test's cache
}

function spawnEv(brief: string): SpawnEvent {
	return { agent: "worker", invocationKind: "task", brief };
}

/** A fresh Progress line so the plan's progress hash is spendable again. */
function refresh(): void {
	appendFileSync(PLAN, "\n- more progress\n");
}

function guardLog(): string {
	try {
		return readFileSync(join(HOME, "main-guard.log"), "utf8");
	} catch {
		return "";
	}
}

// --- the gate's pieces ---

test("listOpenMrs lists open MRs with their token and degrades like the sweep", () => {
	resetForge();
	expect(listOpenMrs(TOY, runner)).toEqual({
		ok: true,
		mrs: [{ forge: "gitlab", number: 211, token: "!211", branch: "feat/e2-classification" }],
	});
	glabFails = true;
	expect(listOpenMrs(TOY, runner)).toEqual({ ok: false, why: "forge unreachable" });
	expect(listOpenMrs(TOY, NO_ORIGIN_RUNNER)).toEqual({ ok: false, why: "no origin remote" });
});

test("unlandedRows parses wip-check's UNLANDED rows and stops at the next block", () => {
	expect(unlandedRows(UNLANDED)).toEqual([
		{ name: "toy", branch: "feat/gate" },
		{ name: "toy", branch: "feat/other" },
	]);
	expect(unlandedRows("UNLANDED branches (commits on no remote): 0  limit 5\nDIRTY worktrees: 0\n")).toEqual([]);
});

// --- P3: the spawn gate (fail-before: all of these denied nothing before the gate existed) ---

test("a plan mentioning open MR !211 denies a silent brief", () => {
	resetForge();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1`), cfg, runner)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("MR !211"),
	});
});

test("the MR !211: line allows the spawn", () => {
	resetForge();
	refresh();
	expect(
		checkSpawn(spawnEv(`Work ${PLAN} on P1\nMR !211: the e2 classification half — this task: only the export half`), cfg, runner),
	).toMatchObject({ allow: true });
});

test("a merged MR is not pending work", () => {
	resetForge(MERGED_211);
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1`), cfg, runner)).toMatchObject({ allow: true });
});

test("a forge outage degrades to a logged allow", () => {
	resetForge();
	glabFails = true;
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1`), cfg, runner)).toMatchObject({ allow: true });
	expect(guardLog()).toMatch(/pending-work: .*forge unreachable/);
});

test("an unlanded branch named by the plan denies a silent brief", () => {
	resetForge("[]", UNLANDED);
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1`), cfg, runner)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("branch feat/gate"),
	});
});

test("the Branch <name>: line allows the spawn", () => {
	resetForge("[]", UNLANDED);
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1\nBranch feat/gate: probe harness — this task: docs only`), cfg, runner)).toMatchObject({
		allow: true,
	});
});

test("the open-MR list is cached for review.mr_cache_minutes", () => {
	resetForge();
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1\nMR !211: the e2 half — this task: export only`), cfg, runner)).toMatchObject({ allow: true });
	refresh();
	expect(checkSpawn(spawnEv(`Work ${PLAN} on P1\nMR !211: the e2 half — this task: export only`), cfg, runner)).toMatchObject({ allow: true });
	expect(glabCalls).toBe(1);
});

test("the task tool path runs the same gate", () => {
	resetForge();
	refresh();
	const files: string[] = [];
	const budgets: Record<string, number | null> = {};
	const staffing: Record<string, string[]> = {};
	const why = spawnProblem(
		{ tasks: [{ name: "w", agent: "worker", task: `Work ${PLAN} on P1`, context: "" }] },
		cfg,
		files,
		budgets,
		staffing,
		undefined,
		runner,
	);
	expect(why).toContain("MR !211");
});

test("pendingWorkProblem passes a clean plan through", () => {
	resetForge("[]", "");
	refresh();
	expect(pendingWorkProblem([PLAN], `Work ${PLAN} on P1`, cfg, runner)).toBeNull();
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});
