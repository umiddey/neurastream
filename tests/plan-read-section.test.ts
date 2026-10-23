import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { checkPlanEdit } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { parsePlan } from "../src/core/queue/lib.ts";

// Plans stamped at or after this get the "## Code read by Main" requirement; older ones are grandfathered.
const CUTOVER = "20261021_0100";
const BLOCKERS = mkdtempSync(join(tmpdir(), "plan-read-section-"));
writeFileSync(join(BLOCKERS, "ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "ok.sh"), 0o755);

function plan(extra: string): string {
	return `# Plan

## Goal
- Do the thing.

## Forbidden
- Nothing else.

## Blockers
- ok.sh

## Phases
- [ ] P1 the thing; verify: \`true\`

## Done check
\`true\`

${extra}## Progress
Status: open
`;
}

const READ_SECTION = "## Code read by Main\n- `src/a.ts`\n\n";

function errorsFor(file: string, text: string): string[] {
	return parsePlan("/repo", join("/repo/docs/plans", file), text, BLOCKERS).errors ?? [];
}

test("a plan stamped at the cutover without the Code read by Main section is refused", () => {
	const errs = errorsFor(`${CUTOVER}_new.md`, plan(""));
	expect(errs.some(e => /Code read by Main/i.test(e))).toBe(true);
});

test("a plan stamped before the cutover without the section still parses", () => {
	const errs = errorsFor("20261019_0900_old.md", plan(""));
	expect(errs.some(e => /Code read by Main/i.test(e))).toBe(false);
	expect(errs).toEqual([]);
});

test("a plan stamped after the cutover with the section has no section error", () => {
	const errs = errorsFor("20261021_0200_new.md", plan(READ_SECTION));
	expect(errs).toEqual([]);
});

// P1: Main's plan edits are judged by what they add. A problem the plan already had is not refused again.
const QUEUE_ENV_BEFORE = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, QUEUE_ENV_BEFORE);
});
const GUARD_TMP = mkdtempSync(join(tmpdir(), "plan-read-guard-"));
const REPO = join(GUARD_TMP, "repo");
const PLAN_FILE = join(REPO, "docs/plans/20261023_1000_guard.md");
const GUARD_CFG = loadConfig({ home: join(GUARD_TMP, "home"), env: {} });
const LISTED = join(REPO, "src/a.ts");
const CITED_IN_PROGRESS = join(REPO, "src/x.ts");
const NEW_CITE = join(REPO, "src/y.ts");
mkdirSync(join(REPO, "src"), { recursive: true });
mkdirSync(join(REPO, "docs/plans"), { recursive: true });
for (const f of [LISTED, CITED_IN_PROGRESS, NEW_CITE]) writeFileSync(f, "export const v = 1;\n");

function guardPlan(phase: string, background: string, progress: string): string {
	return `# Guard plan

Worktree: -
Branch: feat/guard

## Goal
- Plan-read guard toy.

## Forbidden
- Nothing else.

## Blockers
- ok.sh

## Phases
- ${phase} P1 the thing; verify: \`true\`

## Done check
\`true\`

## Background
${background}

## Code read by Main
- \`src/a.ts\`

## Progress
Status: open
${progress}`;
}

/** Main's read log, with the sandbox queue state pointed at by applyQueueEnv. */
function readLogWith(reads: Record<string, string>): void {
	applyQueueEnv(GUARD_CFG);
	mkdirSync(GUARD_CFG.paths.queue_state, { recursive: true });
	writeFileSync(join(GUARD_CFG.paths.queue_state, "main-reads.json"), JSON.stringify(reads));
}
const HOURS_30_AGO = new Date(Date.now() - 30 * 3_600_000).toISOString();
const PROGRESS = "- Worker: checked `src/x.ts:12`.\n";

test("a Main edit that only ticks a phase is allowed although the plan already has a read problem", () => {
	readLogWith({ [LISTED]: HOURS_30_AGO });
	const before = guardPlan("[ ]", "- Reads show X.", PROGRESS);
	const after = guardPlan("[x]", "- Reads show X.", PROGRESS);
	expect(checkPlanEdit({ path: PLAN_FILE, before, after, agent: "main" }, GUARD_CFG).allow).toBe(true);
});

test("a Main edit that adds an unread citation outside Progress is refused, naming only the new problem", () => {
	readLogWith({ [LISTED]: HOURS_30_AGO });
	const before = guardPlan("[ ]", "- Reads show X.", PROGRESS);
	const after = guardPlan("[ ]", "- Reads show X. See src/y.ts:3.", PROGRESS);
	const d = checkPlanEdit({ path: PLAN_FILE, before, after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("src/y.ts");
	expect(d.reason).not.toContain("src/a.ts");
	expect(d.restore).toEqual({ path: PLAN_FILE, text: before });
});

test("a new plan (no before text) with no Main reads is refused in full", () => {
	readLogWith({});
	const after = guardPlan("[ ]", "- Reads show X.", PROGRESS);
	const d = checkPlanEdit({ path: PLAN_FILE, before: "", after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("src/a.ts");
	expect(d.restore).toEqual({ path: PLAN_FILE, text: null });
});
