// Plan review gate (plan 20261028_1600): P1 reuse lines in queue problems, P2 reviewer PASS lock.
// Everything runs in-process against temp dirs; no live state dir, no real forge.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { checkPlanEdit, checkSpawn } from "../src/core/guards.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { parsePlan, queueProblems, type Plan } from "../src/core/queue/lib.ts";

const TMP = mkdtempSync(join(tmpdir(), "plan-review-"));
const REPO = join(TMP, "repo");
const BLOCKERS = join(TMP, "blockers");
const SINCE = "2026-10-28";

mkdirSync(join(REPO, "docs/plans"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
mkdirSync(BLOCKERS, { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(BLOCKERS, "ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "ok.sh"), 0o755);

const REUSE_OK = "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the existing helper\n\n";

function planText(stamp: string, reuse = REUSE_OK): string {
	return `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Reuse-line toy.

## Forbidden
- Never skip tests.

## Blockers
- ok.sh

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Code read by Main
- \`src/a.ts\`

## Reuse-placeholder

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.
`.replace("## Reuse-placeholder", reuse);
}

function planFile(stamp: string, reuse?: string): string {
	const file = join(REPO, "docs/plans", `${stamp}_toy.md`);
	writeFileSync(file, planText(stamp, reuse));
	return file;
}

function parsed(file: string): Plan {
	return parsePlan(REPO, file, readFileSync(file, "utf8"), BLOCKERS, SINCE);
}

// --- P1: reuse lines ---

test("a plan with phases and no Reuse section is a queue problem", () => {
	const p = parsed(planFile("20261029_0100", ""));
	expect(p.errors.join("\n")).toMatch(/## Reuse/);
});

test("a reuse line without checked: <path>:<line> is a problem", () => {
	const p = parsed(planFile("20261029_0102", "## Reuse\n- new: gate — reuse: checked nowhere\n\n"));
	expect(p.errors.join("\n")).toMatch(/checked: <path>:<line>/);
});

test("a reuse line citing a nonexistent path is a problem", () => {
	const p = parsed(planFile("20261029_0103", "## Reuse\n- new: gate — checked: src/missing.ts:7 — reuse: would be nice\n\n"));
	expect(p.errors.join("\n")).toMatch(/does not exist/);
});

test("a valid reuse line (including new: none) is clean", () => {
	expect(parsed(planFile("20261029_0104")).errors).toEqual([]);
});

test("a plan stamped before review.since is exempt", () => {
	const p = parsed(planFile("20261020_0100", ""));
	expect(p.errors).toEqual([]);
});

test("Reuse is an allowed plan section", () => {
	const p = parsed(planFile("20261029_0105"));
	expect(p.errors.join("\n")).not.toMatch(/unknown section/);
});

test("queueProblems reports the missing Reuse section under the plan's file", () => {
	const file = planFile("20261029_0106", "");
	const index = join(TMP, "INDEX.md");
	writeFileSync(index, `${file}\n`);
	const probs = queueProblems(index, BLOCKERS, SINCE);
	expect(probs.map(q => `${q.where}: ${q.problem}`).join("\n")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*## Reuse"));
});

// --- P2: reviewer PASS lock (fail-before: the gate and the record do not exist yet) ---

const GHOME = join(TMP, "ghome");
const GAGENT = join(GHOME, ".omp/agent");
const GSTATE = join(GHOME, ".local/state/queue");
const LOCKED = join(REPO, "docs/plans/20261030_0100_locked.md");
const REVIEWS = join(GSTATE, "plan-reviews.json");

mkdirSync(join(GAGENT, "blockers"), { recursive: true });
mkdirSync(join(GAGENT, "notes"), { recursive: true });
mkdirSync(GSTATE, { recursive: true });
mkdirSync(join(GHOME, ".config/neurastream"), { recursive: true });
writeFileSync(join(GAGENT, "INDEX.md"), `${LOCKED}\n`);
writeFileSync(join(GAGENT, "notes/subagents.md"), "## Allowed\n\n- `worker`\n- `reviewer`\n");
writeFileSync(join(GAGENT, "CANCELLED.md"), "");
writeFileSync(LOCKED, planText("20261030_0100"));
writeFileSync(
	join(GHOME, ".config/neurastream/config.yml"),
	`paths:
  home: "${GHOME}"
  work_roots: ["${REPO}"]
  agent_dir: "${GAGENT}"
  queue_index: "${join(GAGENT, "INDEX.md")}"
  blockers: "${BLOCKERS}"
  queue_state: "${GSTATE}"
  subagents: "${join(GAGENT, "notes/subagents.md")}"
  cancelled: "${join(GAGENT, "CANCELLED.md")}"
  unlock: "${join(GAGENT, ".guard-unlock")}"
  guard_log: "${join(GHOME, "main-guard.log")}"
  plan_guard_log: "${join(GHOME, "plan-guard.log")}"
review:
  since: "2026-10-28"
  agents: ["reviewer"]
`,
);

const gcfg = loadConfig({ home: GHOME, env: {} });
applyQueueEnv(gcfg);

// No origin remote: the P3 pending-work check degrades off the toy repo, so these tests see only the PASS gate.
const gRunner: CommandRunner = args =>
	args[0] === "git" ? { code: 1, stdout: "", stderr: "no origin", missing: false } : { code: 127, stdout: "", stderr: "", missing: true };

function gspawn(brief: string, agent = "worker") {
	return checkSpawn({ agent, invocationKind: "task", brief }, gcfg, gRunner);
}

/** A fresh Progress entry so the plan's progress hash is spendable again. */
function freshProgress(): void {
	writeFileSync(LOCKED, `${readFileSync(LOCKED, "utf8")}- more progress\n`);
}

/** A subagent edit adding `entry` (the guard's record path); returns the decision. */
function reviewerEdit(entry: string) {
	const before = readFileSync(LOCKED, "utf8");
	return checkPlanEdit({ path: LOCKED, before, after: before + entry, agent: "sub" }, gcfg);
}

const PASS_ENTRY = "\n- PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: none\n";
const FAIL_ENTRY =
	"\n- PLAN REVIEW: FAIL — redundant: P1 redoes the sweep — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";

test("a spawn on a plan with no recorded review is denied", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a recorded PASS with the same hash allows the spawn", () => {
	expect(reviewerEdit(PASS_ENTRY).allow).toBe(true);
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a phase edited after the PASS expires it", () => {
	// Main's outside-Progress edit: written directly, the way the plan file really changes.
	writeFileSync(LOCKED, readFileSync(LOCKED, "utf8").replace("P1 do the thing", "P1 do it differently"));
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("changed since review"),
	});
});

test("a progress-only edit after the PASS keeps it valid", () => {
	expect(reviewerEdit(PASS_ENTRY).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a recorded FAIL denies with the finding", () => {
	rmSync(REVIEWS, { force: true });
	expect(reviewerEdit(FAIL_ENTRY).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("Main writing the PASS line records nothing", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "main" }, gcfg).allow).toBe(true);
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a review spawn is exempt without a record", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Plan review: ${LOCKED}\nReview this plan against its phases.`, "reviewer")).toMatchObject({ allow: true });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
