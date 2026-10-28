// Main cannot walk away from a bug it found (plan 20261028_0900_main_findings_force_plan).
// P1: Main's own new Progress entries record their Findings items as incidents too — kind
// "main-finding", evidence = plan path + "main" — so a bug Main writes down blocks the stop
// like a subagent's (src/core/guards.ts checkMainPlan -> recordFindings).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit, checkStop } from "../src/core/guards.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const ROOT = "/tmp/neurastream-home-planfindings/p1";
const HOME = join(ROOT, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const PLAN = join(TOY, "docs/plans/20261028_toy.md");
const OLD = "- 2026-10-28 09:00 (main): started. Findings: none.";

const BEFORE = `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Findings guard toy.

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
	writeFileSync(join(AGENT, "INDEX.md"), "");
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
	applyQueueEnv(cfg);
}

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

test("Main's own Findings item becomes an open main-finding incident", () => {
	fresh();
	const after = BEFORE.replace(OLD, `${OLD}\n- 2026-10-28 09:20 (Main): looked again. Findings: bucket missing.`);
	expect(checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "main" }, cfg).allow).toBe(true);
	const open = openIncidents(cfg);
	expect(open).toHaveLength(1);
	expect(open[0]).toMatchObject({
		source: "findings",
		kind: "main-finding",
		summary: "bucket missing.",
		evidence: `${PLAN} (main)`,
		resolution: null,
	});
});

// P2: a stop reply that offers to plan instead of planning is refused (guards.plan_offer), and
// the two-empty-stops valve does not release that block; a reply without the offer stops as before.
test("a stop reply that offers to plan is refused", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "backups broken, want me to write a plan?" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("don't offer it — write the plan and index it");
});

test("two idle stops do not release the offer block", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 2, ledgerText: "", reply: "should I plan this?" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("don't offer it — write the plan and index it");
});

test("a stop reply without the offer stops as before", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "backups broken, investigating now" }, cfg);
	expect(d.allow).toBe(true);
});
