// Main cannot walk away from a bug it found (plan 20261028_0900_main_findings_force_plan).
// P1: Main's own new Progress entries record their Findings items as incidents too — kind
// "main-finding", evidence = plan path + "main" — so a bug Main writes down blocks the stop
// like a subagent's (src/core/guards.ts checkMainPlan -> recordFindings).

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit, checkStop } from "../src/core/guards.ts";
import { addIncident, dismissIncident, openIncidents } from "../src/core/incidents.ts";
import { nowSec } from "../src/core/clock.ts";
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
	expect(d.reason).toContain("don't promise it — do it now, or write the plan and index it");
});

test("two idle stops do not release the offer block", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 2, ledgerText: "", reply: "should I plan this?" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("don't promise it — do it now, or write the plan and index it");
});

test("a stop reply without the offer stops as before", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "backups broken, investigating now" }, cfg);
	expect(d.allow).toBe(true);
});

test("a stop reply that promises instead of planning is refused", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "I'll file it as an incident." }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("don't promise it — do it now, or write the plan and index it");
});

test("a stop reply that promises mid-sentence is refused", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "Done. I will check CI later." }, cfg);
	expect(d.allow).toBe(false);
});

test("a stop reply that predicts the future is not a promise", () => {
	fresh();
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "CI will finish in 5 min" }, cfg);
	expect(d.allow).toBe(true);
});

// P3: a finding incident (agent-finding / main-finding) is dismissed only with the owner's own
// words — --owner "<quote>", a substring of an owner message the inject hook saw in the last
// 24 h (<queue_state>/owner-messages.jsonl); other kinds keep --why only.
test("a main-finding refuses --why alone and dismisses with a real owner quote", () => {
	fresh();
	const after = BEFORE.replace(OLD, `${OLD}\n- 2026-10-28 09:20 (Main): looked again. Findings: bucket missing.`);
	checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "main" }, cfg);
	const inc = openIncidents(cfg)[0]!;
	expect(dismissIncident(cfg, inc.id, "not a bug")).toContain("refused");
	writeFileSync(
		join(STATE, "owner-messages.jsonl"),
		`${JSON.stringify({ at: nowSec(), text: "I want you proactively writing bugs; bucket missing is exactly the kind of thing to plan" })}\n`,
	);
	expect(dismissIncident(cfg, inc.id, "not a bug", "proactively writing bugs; bucket missing")).toBe(null);
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("an owner quote the inject hook never saw refuses; other kinds keep --why only", () => {
	fresh();
	const after = BEFORE.replace(OLD, `${OLD}\n- 2026-10-28 09:20 (Main): looked again. Findings: bucket missing.`);
	checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "main" }, cfg);
	const inc = openIncidents(cfg)[0]!;
	writeFileSync(
		join(STATE, "owner-messages.jsonl"),
		`${JSON.stringify({ at: nowSec(), text: "the backup plan is parked, keep going" })}\n`,
	);
	expect(dismissIncident(cfg, inc.id, "not a bug", "words the owner never said at all")).toContain("refused");
	addIncident(cfg, { source: "main", kind: "toy", summary: "not a finding" });
	const toy = openIncidents(cfg).find(i => i.kind === "toy")!;
	expect(dismissIncident(cfg, toy.id, "not a bug")).toBe(null);
});

// P5 / I-20261028-67: the guard CLI passes a stop event's reply into StopEvent, so a harness
// without the omp plugin gets the plan-offer block through `neurastream guard stop --json` too.
const REPO = resolve(import.meta.dir, "..");

function guardCli(event: string, payload: unknown): { code: number; d: { allow: boolean; reason: string } } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: {
			...process.env,
			HOME,
			QUEUE_AGENT: AGENT,
			QUEUE_INDEX: join(AGENT, "INDEX.md"),
			QUEUE_BLOCKERS: join(AGENT, "blockers"),
			QUEUE_STATE: STATE,
			QUEUE_SUBAGENTS: join(AGENT, "notes/subagents.md"),
			QUEUE_CANCELLED: join(AGENT, "CANCELLED.md"),
			QUEUE_UNLOCK: join(AGENT, ".guard-unlock"),
		},
	});
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) };
}

test("guard stop --json refuses a reply that offers to plan", () => {
	fresh();
	const r = guardCli("stop", { agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "backups broken, want me to write a plan?" });
	expect(r.code).toBe(2);
	expect(r.d.allow).toBe(false);
	expect(r.d.reason).toContain("don't promise it — do it now, or write the plan and index it");
});

test("guard stop --json allows a reply without the offer", () => {
	fresh();
	const r = guardCli("stop", { agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "", reply: "backups broken, investigating now" });
	expect(r.code).toBe(0);
	expect(r.d.allow).toBe(true);
});
