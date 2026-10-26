// One index (plan 20261024_1400_one_index P1): the queue is ONE file, the main index, listing one
// absolute plan path per line. A plan's repo is the main checkout holding the plan file; a plan file
// must live in a main checkout, never in a linked worktree; two open plans never share a worktree.
// The summary still groups the plans by repo.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { activePlans, isOrchestrationPath, queueProblems, queueSummary, readIndex } from "../src/core/queue/lib";

const TMP = mkdtempSync(join(tmpdir(), "one-index-"));
const HOME = join(TMP, "home");
const MAIN = join(HOME, ".omp/agent/INDEX.md");
const BLOCKERS = join(HOME, ".omp/agent/blockers");
const REPO = join(HOME, "projects/toy");
const PLANS = join(REPO, "docs/plans");
const WT = join(HOME, "Work/toy-wt");
const SHARED = join(HOME, "Work/toy-shared");

const GIT_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): void {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
}

function plan(name: string, body: string): string {
	const file = join(PLANS, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
	return file;
}

function openPlan(worktree = "-", status: "open" | "complete" = "open"): string {
	return `# Plan

Worktree: ${worktree}
Branch: -

## Goal
- one index

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`src/core/queue/lib.ts\`

## Progress
Status: ${status}
`;
}

// Main checkout with one linked worktree; plans go wherever each test writes them.
mkdirSync(BLOCKERS, { recursive: true });
writeFileSync(join(BLOCKERS, "no-push"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "no-push"), 0o755);
mkdirSync(PLANS, { recursive: true });
git(REPO, "init", "-q", "-b", "main");
writeFileSync(join(REPO, "README.md"), "toy\n");
git(REPO, "add", "README.md");
git(REPO, "commit", "-q", "-m", "init");
git(REPO, "worktree", "add", "-q", "-b", "wt-branch", WT);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function setIndex(...plans: string[]): void {
	mkdirSync(dirname(MAIN), { recursive: true });
	writeFileSync(MAIN, plans.map(p => `- \`${p}\``).join("\n") + "\n");
}

test("readIndex returns the plan files the main index lists (markup and duplicates tolerated)", () => {
	const a = plan("20261024_1400_a.md", openPlan());
	setIndex(a, a, "~/notes/elsewhere.md");
	expect(readIndex(MAIN)).toEqual([a, join(homedir(), "notes/elsewhere.md")]);
});

test("activePlans reads plans straight from the main index; the repo is the plan's main checkout", () => {
	const a = plan("20261024_1401_b.md", openPlan());
	setIndex(a);
	const plans = activePlans(MAIN, BLOCKERS);
	expect(plans.map(p => p.file)).toEqual([a]);
	expect(plans[0]!.repo).toBe(REPO);
});

test("queueProblems: a plan inside a linked worktree is refused, naming the worktree and the main checkout", () => {
	const inWt = plan("20261024_1402_c.md", openPlan());
	// Rewrite through the worktree checkout so the file really lives there.
	const wtPlans = join(WT, "docs/plans");
	mkdirSync(wtPlans, { recursive: true });
	const inWt2 = join(wtPlans, "20261024_1402_c.md");
	writeFileSync(inWt2, openPlan());
	rmSync(inWt);
	setIndex(inWt2);
	const probs = queueProblems(MAIN, BLOCKERS);
	const hit = probs.find(q => q.where === inWt2);
	expect(hit).toBeTruthy();
	expect(hit!.problem).toContain(WT);
	expect(hit!.problem).toContain(REPO);
});

test("queueProblems: two open plans naming one worktree are refused; open plus complete is fine", () => {
	const c = plan("20261024_1403_d.md", openPlan(SHARED));
	const d = plan("20261024_1404_e.md", openPlan(SHARED));
	setIndex(c, d);
	let probs = queueProblems(MAIN, BLOCKERS);
	const dup = probs.find(q => q.where === SHARED);
	expect(dup).toBeTruthy();
	expect(dup!.problem).toContain(c);
	expect(dup!.problem).toContain(d);
	writeFileSync(d, openPlan(SHARED, "complete"));
	probs = queueProblems(MAIN, BLOCKERS);
	expect(probs.find(q => q.where === SHARED)).toBeUndefined();
});

test("queueSummary lists the plans flat in index order with a rank per line", () => {
	const a = plan("20261024_1405_f.md", openPlan());
	setIndex(a);
	const s = queueSummary(MAIN);
	expect(s).toContain(`  1. ${a} [`);
	expect(s).not.toMatch(/^- /m);
});

test("isOrchestrationPath: the main index and its listed plans are orchestration files; other files are not", () => {
	const a = plan("20261024_1406_g.md", openPlan());
	setIndex(a);
	process.env.QUEUE_INDEX = MAIN;
	try {
		const plans = activePlans(MAIN, BLOCKERS);
		expect(isOrchestrationPath(MAIN, plans)).toBe(true);
		expect(isOrchestrationPath(a, plans)).toBe(true);
		expect(isOrchestrationPath(join(REPO, "src/x.ts"), plans)).toBe(false);
	} finally {
		delete process.env.QUEUE_INDEX;
	}
});

// P4 (I-20261025-208): the index may not rank a plan above an open plan it waits on.
function waitingPlan(title: string, waitsOn?: string): string {
	return `# ${title}

Worktree: -
Branch: -

## Goal
- dependency order

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`src/core/queue/lib.ts\`

## Progress
Status: open
${waitsOn ? `- Waits on: ${waitsOn}\n` : ""}`;
}

test("dependency order: a plan above the open plan it waits on is one problem naming both ranks", () => {
	const b = plan("20261025_2336_b.md", waitingPlan("Plan B"));
	const a = plan("20261025_2335_a.md", waitingPlan("Plan A", b));
	setIndex(a, b);
	const probs = queueProblems(MAIN, BLOCKERS).filter(q => q.problem.includes("waits on"));
	expect(probs).toHaveLength(1);
	expect(probs[0]!.where).toBe(a);
	expect(probs[0]!.problem).toContain("#1 Plan A waits on #2 Plan B");
	expect(probs[0]!.problem).toContain('move #2 up first or remove the "Waits on" line');
});

test("dependency order: the waits-on plan sitting below its target is no problem", () => {
	const b = plan("20261025_2337_b.md", waitingPlan("Plan B"));
	const a = plan("20261025_2338_a.md", waitingPlan("Plan A", b));
	setIndex(b, a);
	expect(queueProblems(MAIN, BLOCKERS).filter(q => q.problem.includes("waits on"))).toEqual([]);
});

test("dependency order: a waits-on target missing from the index is no problem", () => {
	const ghost = plan("20261025_2339_ghost.md", waitingPlan("Plan Ghost"));
	const a = plan("20261025_2340_a.md", waitingPlan("Plan A", ghost));
	setIndex(a);
	expect(queueProblems(MAIN, BLOCKERS).filter(q => q.problem.includes("waits on"))).toEqual([]);
});

test("queueSummary flags an open plan waiting on an open plan with waits on #N, in any order", () => {
	const b = plan("20261025_2341_b.md", waitingPlan("Plan B"));
	const a = plan("20261025_2342_a.md", waitingPlan("Plan A", b));
	setIndex(a, b);
	const s = queueSummary(MAIN);
	expect(s).toContain(`  1. ${a} [open, waits on #2]`);
	expect(s).toContain(`  2. ${b} [open]`);
	setIndex(b, a);
	expect(queueSummary(MAIN)).toContain(`  2. ${a} [open, waits on #1]`);
});
