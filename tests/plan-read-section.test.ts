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

// P1: the same file read in either checkout counts — the plan's Worktree and the main checkout
// hold one file under two roots, so a read at either root covers the listed or cited path.
const WT_TMP = mkdtempSync(join(tmpdir(), "plan-read-twin-"));
const TWIN_REPO = join(WT_TMP, "repo");
const TWIN_WT = join(WT_TMP, "wt");
const TWIN_PLAN = join(TWIN_REPO, "docs/plans/20261025_1200_twin.md");
const TWIN_SRC_IN_REPO = join(TWIN_REPO, "src/a.ts");
const TWIN_SRC_IN_WT = join(TWIN_WT, "src/a.ts");
mkdirSync(join(TWIN_REPO, "src"), { recursive: true });
mkdirSync(join(TWIN_REPO, "docs/plans"), { recursive: true });
mkdirSync(join(TWIN_WT, "src"), { recursive: true });
writeFileSync(TWIN_SRC_IN_REPO, "export const v = 1;\n");
writeFileSync(TWIN_SRC_IN_WT, "export const v = 1;\n");

function twinPlan(worktree: string, listed: string, citation = ""): string {
	return `# Twin plan

Worktree: ${worktree}
Branch: feat/twin

## Goal
- Twin-root toy.${citation}

## Forbidden
- Nothing else.

## Blockers
- ok.sh

## Phases
- [ ] P1 the thing; verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`${listed}\`

## Progress
Status: open
`;
}

test("a file Main read only in the main checkout covers its Worktree copy (listed relative path resolves to the Worktree)", () => {
	readLogWith({ [TWIN_SRC_IN_REPO]: new Date().toISOString() });
	const before = twinPlan(TWIN_WT, "src/a.ts").replace("- Twin-root toy.", "- before.");
	const after = twinPlan(TWIN_WT, "src/a.ts").replace("- Twin-root toy.", "- after.");
	expect(checkPlanEdit({ path: TWIN_PLAN, before, after, agent: "main" }, GUARD_CFG).allow).toBe(true);
});

test("a file Main read only in the Worktree covers the main-checkout path listed by its absolute spelling", () => {
	readLogWith({ [TWIN_SRC_IN_WT]: new Date().toISOString() });
	const before = twinPlan(TWIN_WT, TWIN_SRC_IN_REPO).replace("- Twin-root toy.", "- before.");
	const after = twinPlan(TWIN_WT, TWIN_SRC_IN_REPO).replace("- Twin-root toy.", "- after.");
	expect(checkPlanEdit({ path: TWIN_PLAN, before, after, agent: "main" }, GUARD_CFG).allow).toBe(true);
});

test("a citation of the Worktree copy is covered when the main-checkout twin is the listed (and read) one", () => {
	readLogWith({ [TWIN_SRC_IN_REPO]: new Date().toISOString() });
	const before = twinPlan(TWIN_WT, TWIN_SRC_IN_REPO, " See src/a.ts:3.").replace("- Twin-root toy.", "- before.");
	const after = twinPlan(TWIN_WT, TWIN_SRC_IN_REPO, " See src/a.ts:3.").replace("- Twin-root toy.", "- after.");
	expect(checkPlanEdit({ path: TWIN_PLAN, before, after, agent: "main" }, GUARD_CFG).allow).toBe(true);
});

test("a file Main read in neither checkout is still refused with the was-not-read message", () => {
	readLogWith({});
	// A clean before: the read list (and its problem) is new in this edit, so the refusal is Main's doing.
	const before = twinPlan(TWIN_WT, "src/a.ts").replace("\n## Code read by Main\n- `src/a.ts`\n", "\n");
	const after = twinPlan(TWIN_WT, "src/a.ts");
	const d = checkPlanEdit({ path: TWIN_PLAN, before, after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("src/a.ts was not read by Main within");
});

// P2 (plan 20261029_1530): a plan kept in docs/plans/<subdir>/ resolves its repo as the text before
// /docs/plans/ — dirname³ would give <repo>/docs, so the twin read in the main checkout would miss.
const SUB_TMP = mkdtempSync(join(tmpdir(), "plan-read-twin-sub-"));
const SUB_REPO = join(SUB_TMP, "repo");
const SUB_WT = join(SUB_TMP, "wt");
const SUB_PLAN = join(SUB_REPO, "docs/plans/immediate/20261029_1545_twin.md");
mkdirSync(join(SUB_REPO, "docs/plans/immediate"), { recursive: true });
mkdirSync(join(SUB_REPO, "src"), { recursive: true });
mkdirSync(join(SUB_WT, "src"), { recursive: true });
writeFileSync(join(SUB_REPO, "src/a.ts"), "export const v = 1;\n");
writeFileSync(join(SUB_WT, "src/a.ts"), "export const v = 1;\n");

test("a subdir plan's listed path resolves against its repo, not <repo>/docs (the main-checkout twin read covers)", () => {
	readLogWith({ [join(SUB_REPO, "src/a.ts")]: new Date().toISOString() });
	// A clean before: the read list is new in this edit, so a wrong-root miss would be refused.
	const before = twinPlan(SUB_WT, "src/a.ts").replace("\n## Code read by Main\n- `src/a.ts`\n", "\n");
	const after = twinPlan(SUB_WT, "src/a.ts");
	expect(checkPlanEdit({ path: SUB_PLAN, before, after, agent: "main" }, GUARD_CFG).allow).toBe(true);
});

// P2: a cited file Main did read lands in the list instead of the refusal.
test("a cited file Main has read is auto-listed: allowed, the rewrite text gains the entry, the note names it", () => {
	readLogWith({ [LISTED]: HOURS_30_AGO, [NEW_CITE]: new Date().toISOString() });
	const before = guardPlan("[ ]", "- Reads show X.", PROGRESS);
	const after = guardPlan("[ ]", "- Reads show X. See src/y.ts:3.", PROGRESS);
	const d = checkPlanEdit({ path: PLAN_FILE, before, after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(true);
	expect(d.rewrite).toEqual({ path: PLAN_FILE, text: expect.stringContaining("- `src/y.ts`") });
	expect(d.note).toBe(`plan-guard: added 1 file(s) to "## Code read by Main": src/y.ts`);
});

test("a never-read citation is still refused, never auto-listed", () => {
	readLogWith({ [LISTED]: new Date().toISOString() });
	const before = guardPlan("[ ]", "- Reads show X.", PROGRESS);
	const after = guardPlan("[ ]", "- Reads show X. See src/y.ts:3.", PROGRESS);
	const d = checkPlanEdit({ path: PLAN_FILE, before, after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("src/y.ts is cited but not listed");
	expect(d.rewrite).toBeUndefined();
});

test("a plan with no read section gains one before Progress when its citation was read", () => {
	readLogWith({ [NEW_CITE]: new Date().toISOString() });
	const before = guardPlan("[ ]", "- Reads show X.", PROGRESS).replace("\n## Code read by Main\n- `src/a.ts`\n", "\n");
	const after = guardPlan("[ ]", "- Reads show X. See src/y.ts:3.", PROGRESS).replace("\n## Code read by Main\n- `src/a.ts`\n", "\n");
	const d = checkPlanEdit({ path: PLAN_FILE, before, after, agent: "main" }, GUARD_CFG);
	expect(d.allow).toBe(true);
	const text = d.rewrite?.text ?? "";
	expect(text.indexOf("## Code read by Main")).toBeGreaterThanOrEqual(0);
	expect(text.indexOf("## Code read by Main")).toBeLessThan(text.indexOf("## Progress"));
	expect(text).toContain("- `src/y.ts`");
});
