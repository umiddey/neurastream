// Plan review gate (plan 20261028_1600): P1 reuse lines in queue problems, P2 reviewer PASS lock.
// Everything runs in-process against temp dirs; no live state dir, no real forge.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { checkPlanEdit, checkSpawn, reviewHash } from "../src/core/guards.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { parsePlan, queueProblems, queueSummary, reviewAgentsProblem, type Plan } from "../src/core/queue/lib.ts";
import { fixturePlan } from "./fixtures/plan.ts";

const TMP = mkdtempSync(join(tmpdir(), "plan-review-"));
const REPO = join(TMP, "repo");
const BLOCKERS = join(TMP, "blockers");
const SINCE = "2026-10-28";

mkdirSync(join(REPO, ".git"), { recursive: true }); // planRepo walks up to .git; without it planGate resolves citations under docs/plans
mkdirSync(join(REPO, "docs/plans"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
mkdirSync(BLOCKERS, { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(BLOCKERS, "ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "ok.sh"), 0o755);

const REUSE_OK = "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the existing helper\n\n";

function planFile(stamp: string, reuse?: string): string {
	const file = join(REPO, "docs/plans", `${stamp}_toy.md`);
	writeFileSync(file, fixturePlan({ reuse: reuse ?? REUSE_OK }));
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
writeFileSync(LOCKED, fixturePlan());
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

function gspawn(brief: string, agent = "worker", cfg = gcfg) {
	return checkSpawn({ agent, invocationKind: "task", brief }, cfg, gRunner);
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
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true }); // the FAIL test's finding is an open incident; this test is about the PASS gate
	freshProgress();
	expect(gspawn(`Plan review: ${LOCKED}\nReview P1 against its phases.`, "reviewer")).toMatchObject({ allow: true });
});

// --- P4c: the PASS gate honours review.since (plans stamped before the cutover are exempt) ---

const PRE_SINCE = join(REPO, "docs/plans/20261020_0100_presince.md");
writeFileSync(join(GAGENT, "INDEX.md"), `${LOCKED}\n${PRE_SINCE}\n`);
writeFileSync(PRE_SINCE, fixturePlan());

test("a plan stamped before review.since spawns with no PASS", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${PRE_SINCE} on P1`)).toMatchObject({ allow: true });
});

test("a plan stamped on/after review.since is still refused with no PASS", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test(`since: "" turns the PASS gate off`, () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`, "worker", { ...gcfg, review: { ...gcfg.review, since: "" } })).toMatchObject({
		allow: true,
	});
});

// --- P4g: the review line is matched exactly; a PLAN REVIEW line outside that form is restored ---

const DATED_PASS = "\n- 2026-10-29 09:55 RevX: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: none\n";
const DATED_FAIL = "\n- 2026-10-29 09:55 RevX: PLAN REVIEW: FAIL — redundant: P1 redoes the sweep — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";
const SPOOFED_FAIL = "\n- PLAN REVIEW: FAIL: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";
const LOOSE_LINE = "\n- PLAN REVIEW - pass\n  Findings: none\n";

test("a dated PASS line from a reviewer records a PASS", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(DATED_PASS).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a dated FAIL line denies with its finding", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(DATED_FAIL).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("a verdict word inside a FAIL line does not flip it to PASS", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(SPOOFED_FAIL).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("a PLAN REVIEW line outside the exact form is restored with a reason", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + LOOSE_LINE, agent: "sub" }, gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/PLAN REVIEW/),
		restore: { path: LOCKED, text: before },
	});
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

// --- P4h: the queue summary counts done phases; ticking a phase box does not expire a PASS ---

const THREE_PHASES = fixturePlan().replace(
	"- [ ] P1 do the thing — verify: `test -f src/a.ts`",
	"- [x] P1 do the thing — verify: `test -f src/a.ts`\n- [x] P2 do the next thing — verify: `test -f src/a.ts`\n- [ ] P3 do the last thing — verify: `test -f src/a.ts`",
);

test("the queue summary shows N/M done for a plan's phases", () => {
	const file = join(REPO, "docs/plans/20261029_0110_threephase.md");
	writeFileSync(file, THREE_PHASES);
	const index = join(TMP, "INDEX3.md");
	writeFileSync(index, `${file}\n`);
	expect(queueSummary(index, SINCE)).toMatch(/\[open, 2\/3 done\]/);
});

test("ticking a phase box does not change the review hash", () => {
	const text = fixturePlan();
	expect(reviewHash(text.replace("- [ ] P1", "- [x] P1"))).toBe(reviewHash(text));
});

test("editing a phase's text changes the review hash", () => {
	const text = fixturePlan();
	expect(reviewHash(text.replace("P1 do the thing", "P1 do it differently"))).not.toBe(reviewHash(text));
});

// --- P4d: a review spawn needs a review.agents entry that Main may spawn (## Allowed) ---

const withAgents = (agents: string[]) => ({ ...gcfg, review: { ...gcfg.review, agents } });

test("review.agents with no entry in Allowed is a problem naming review.agents", () => {
	const r = reviewAgentsProblem(withAgents(["reviewer"]), new Set(["glm"]));
	expect(r.problem).toContain("review.agents");
});

test("review.agents of an allowed agent alone is clean", () => {
	const r = reviewAgentsProblem(withAgents(["glm"]), new Set(["glm"]));
	expect(r.problem).toBeNull();
	expect(r.warnings).toEqual([]);
});

test("review.agents with an allowed and a not-allowed entry warns naming the other, exit stays clean", () => {
	const r = reviewAgentsProblem(withAgents(["glm", "reviewer"]), new Set(["glm"]));
	expect(r.problem).toBeNull();
	expect(r.warnings.join("\n")).toContain("reviewer");
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
