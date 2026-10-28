// Plan review gate (plan 20261028_1600): P1 reuse lines in queue problems, P2 reviewer PASS lock.
// Everything runs in-process against temp dirs; no live state dir, no real forge.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	return parsePlan(REPO, file, planText(file), BLOCKERS, SINCE);
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

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
