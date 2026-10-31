// Findings stay notes (plan 20261031_1207 P2): no finding item of an allowed subagent plan edit
// becomes an incident — the entry's `Findings:` value is text the plan-guard only checks for
// presence ("none" or items; src/core/guards.ts checkPlanEdit restores an entry without it).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit } from "../src/core/guards.ts";
import { openIncidents } from "../src/core/incidents.ts";

const ROOT = "/tmp/neurastream-home-findings/incidents";
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

function entry(body: string): string {
	return BEFORE.replace(OLD, `${OLD}\n${body}`);
}

test("an allowed edit's finding items stay notes: no incidents", () => {
	fresh();
	const after = entry(
		"- 2026-10-24 15:40 (w1): worked the mock check.\n  Findings: src/core/guards.ts:613 skips the mock for an undeclared kind; tests/progress-trim.test.ts:10 drops continuation lines.",
	);
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "sub" }, cfg);
	expect(d.allow).toBe(true);
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("Findings: none records nothing", () => {
	fresh();
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after: entry("- 2026-10-24 15:40 (w1): did the thing. Findings: none."), agent: "sub" }, cfg);
	expect(d.allow).toBe(true);
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("only the entry's last Findings: counts; a quoted one mid-text is resume text", () => {
	fresh();
	const after = entry(
		'- 2026-10-25 08:40 (sub): resume: check the final text "…commit follows.\\n\\nFindings: none" (if false, print char codes); then commit.\n  Findings: src/a.ts:1 one; src/b.ts:2 two',
	);
	expect(checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "sub" }, cfg).allow).toBe(true);
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("a refused edit records no incidents", () => {
	fresh();
	expect(checkPlanEdit({ path: PLAN, before: BEFORE, after: entry("- 2026-10-24 15:40 (w1): did the thing."), agent: "sub" }, cfg).allow).toBe(false);
	expect(openIncidents(cfg)).toHaveLength(0);
});
