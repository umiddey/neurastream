// The Findings line in a plan's "## Progress": every new entry a subagent writes must carry one
// ("Findings: none", or one item per finding with file:line evidence, items separated by ";");
// plan-guard refuses and restores an edit whose new entry has none (src/core/guards.ts
// checkPlanEdit). Main's own Progress entries are unaffected.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit } from "../src/core/guards.ts";

const ROOT = "/tmp/neurastream-home-findings/guards";
const HOME = join(ROOT, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const PLAN = join(TOY, "docs/plans/20261024_toy.md");
const OLD = "- 2026-10-24 15:00 (w0): started. Findings: none.";

const BEFORE = `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Findings-line guard toy.

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Code read by Main
- \`src/a.ts\`

## Progress
Status: open

${OLD}
`;

let cfg: Config;

function fresh(): void {
	rmSync(ROOT, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN, BEFORE);
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
	cfg = loadConfig({ home: HOME, env: {} });
}

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function edit(findings: string): string {
	return BEFORE.replace(OLD, `${OLD}\n- 2026-10-24 15:40 (w1): did the thing.${findings}`);
}

test("a new Progress entry without a Findings line is refused and restored", () => {
	fresh();
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after: edit(""), agent: "sub" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.restore).toEqual({ path: PLAN, text: BEFORE });
	expect(d.reason).toContain("Findings:");
});

test("Findings: none is allowed", () => {
	fresh();
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after: edit(" Findings: none."), agent: "sub" }, cfg);
	expect(d.allow).toBe(true);
});

test("a Findings item list with file:line evidence is allowed, also on a continuation line", () => {
	fresh();
	const after = BEFORE.replace(
		OLD,
		`${OLD}\n- 2026-10-24 15:40 (w1): worked the mock check.\n  Findings: src/core/guards.ts:613 skips the mock for an undeclared kind.`,
	);
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "sub" }, cfg);
	expect(d.allow).toBe(true);
});

test("rewriting an existing entry still needs a Findings line", () => {
	fresh();
	const after = BEFORE.replace(OLD, "- 2026-10-24 15:05 (w0): started differently.");
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "sub" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.restore).toEqual({ path: PLAN, text: BEFORE });
});

test("a bare Findings: with nothing after it is not a Findings line", () => {
	fresh();
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after: edit(" Findings:"), agent: "sub" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.restore).toEqual({ path: PLAN, text: BEFORE });
});

test("Main's own Progress entries need no Findings line", () => {
	fresh();
	const after = BEFORE.replace(OLD, `${OLD}\n- 2026-10-24 15:40 (Main): noted for the review.`);
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "main" }, cfg);
	expect(d.allow).toBe(true);
});
