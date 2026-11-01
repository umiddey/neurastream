// Guard diet red tests (plan 20261031_1207, P1 + the P5/P5b/P5c red tests): every test pins the
// loosened rule and fails on origin/main 0.2.57. P2 makes findings-notes non-incidents (a, b),
// P3 narrows the cancel flag to owner words (c), P4 makes one spawn deny list every problem (f),
// P5 allows read-only shell for review spawns and the stop at the call cap (d, e), P5b caps the
// queue summary at 10 plans, P5c skips blockers for reads and names the hit paths (blocker tests).

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InjectEvent, SpawnEvent, ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec } from "../src/core/clock.ts";
import { addIncident, openIncidents } from "../src/core/incidents.ts";
import { approvalProblem, recordPagePlan } from "../src/core/plan-approval.ts";
import { checkInject, checkPlanEdit, checkSpawn, checkStop, checkTool, writeWindow } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { cancelPending, queueSummary } from "../src/core/queue/lib.ts";

const REPO = dirname(dirname(import.meta.path));
const ROOT = "/tmp/neurastream-home-guard-diet";
const HOME = join(ROOT, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const INDEX = join(AGENT, "INDEX.md");
const PAGES = join(HOME, "pages");
const PLAN = join(TOY, "docs/plans/20261019_toy.md");
const BLOCK_PLAN = join(TOY, "docs/plans/20261019_toyblock.md");
const OLD = "- 2026-10-31 11:00 (w0): started. Findings: none.";

const TOY_PLAN = `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Guard diet toy for the loosened guards.

## Forbidden
- Never skip tests.

## Blockers
- deny-command test\\.skip
- deny-path secret/**
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

${OLD}
`;

const BEFORE = TOY_PLAN;

const SPAWN_BRIEF = `Work the toy plan.

Plan: ${PLAN}
Run its P1 phase now.

## Acceptance
- the toy phase is done

## Forbidden
- Never push.

Stop and report within 20 tool calls.
`;

const LINT_DIRTY_BRIEF = `Work the toy plan.

Plan: ${PLAN}
Get its current phase done.

## Acceptance
- the toy phase is done
`;

const blockerPlan = (blockers: string): string => `# Toy blocker plan

Worktree: -
Branch: feat/toyb

## Goal
- Blocker skip toy.

## Forbidden
- Never skip tests.

## Blockers
${blockers}

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started the toy blocker work.
`;

let cfg: Config;

function fresh(): void {
	rmSync(ROOT, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(TOY, "src"), join(AGENT, "blockers"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE, PAGES])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN, TOY_PLAN);
	writeFileSync(INDEX, `${PLAN}\n`);
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	for (const b of ["deny-command", "deny-path", "deny-text", "no-push"]) {
		// the wrapper's relative import must survive the copy: point it at this checkout
		const text = readFileSync(join(REPO, "blockers", b), "utf8").replace("../src/core/blockers.ts", join(REPO, "src/core/blockers.ts"));
		writeFileSync(join(AGENT, "blockers", b), text);
		chmodSync(join(AGENT, "blockers", b), 0o755);
	}
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${INDEX}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
brief:
  path_prefixes: ["${HOME}/"]
review:
  agents: []
  plan: false
`,
	);
	cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	spawnSync("git", ["init", "-q"], { cwd: TOY });
}

function toolEvent(tool: string, input: Record<string, unknown>, agentId = "w1"): ToolEvent {
	return { tool, input, cwd: TOY, agent: "sub", agentId, calls: 0, paths: [], writes: [], command: String(input.command ?? "") };
}

/** A review spawn's shell call under the sandbox guard (five call sites share the lockstep setup). */
function reviewShell(command: string) {
	return checkTool(toolEvent("bash", { command }, "rev-1"), cfg);
}

// fresh() points QUEUE_* env at the sandbox per test; restore the caller's at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

// (a) plan 20261031_1207 P1a + P2: a "Findings: x; y" progress entry stays a note — no incident.
test("a Findings: x; y progress entry records no incident", () => {
	fresh();
	const entry = "- 2026-10-31 12:00 (w1): worked.\n  Findings: x; y";
	const after = BEFORE.replace(OLD, `${OLD}\n${entry}`);
	const d = checkPlanEdit({ path: PLAN, before: BEFORE, after, agent: "sub" }, cfg);
	expect(d.allow).toBe(true);
	expect(d.restore).toBeUndefined();
	expect(openIncidents(cfg)).toHaveLength(0);
});

// (b) P1b + P2: open incidents from "findings"/"traces" refuse neither spawn nor stop; "realtime" still does.
test("open findings and traces incidents refuse neither spawn nor stop; a realtime one still does", () => {
	fresh();
	const findings = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "a finding note", evidence: `${PLAN} (w1)` }).incident;
	const traces = addIncident(cfg, { source: "traces", kind: "trace", summary: "a trace note", evidence: "trace log" }).incident;
	const spawn: SpawnEvent = { agent: "toy-worker", invocationKind: "task", brief: SPAWN_BRIEF };
	const d = checkSpawn(spawn, cfg);
	expect(d.allow).toBe(true);
	expect(openIncidents(cfg).map(i => i.id)).toContain(findings.id);
	expect(openIncidents(cfg).map(i => i.id)).toContain(traces.id);
	writeFileSync(INDEX, ""); // empty queue: only the incidents could block the stop
	const s1 = checkStop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }, cfg);
	expect(s1.allow).toBe(true);
	const rt = addIncident(cfg, { source: "realtime", kind: "detector", summary: "toy detector fired", evidence: "guard log" }).incident;
	// a new Progress entry keeps planGate's no-new-entry rule out of the second spawn's way
	writeFileSync(PLAN, BEFORE.replace(OLD, `${OLD}\n- 2026-10-31 12:30 (w2): second run. Findings: none.`));
	writeFileSync(INDEX, `${PLAN}\n`); // list the plan again: only the realtime incident may block this spawn
	const d2 = checkSpawn(spawn, cfg);
	expect(d2.allow).toBe(false);
	expect(d2.reason).toContain(rt.id);
	const s2 = checkStop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }, cfg);
	expect(s2.allow).toBe(false);
	expect(s2.reason).toContain(rt.id);
});

// (c) P1c/P3: cancel wording in system notices, task results and incident lines never flags cancel;
// the owner's own words still do.
test("cancel wording in system notices, task results and incident lines does not flag cancel; owner words still do", () => {
	fresh();
	for (const inject of [
		"<system-notice>the watchdog says: stop running the backup</system-notice>",
		"<task-result>worker replied: stop running the backup</task-result>",
		"INCIDENT I-20261031-1 [realtime/detector]: stop running the backup",
	]) {
		const e: InjectEvent = { inject, agent: "main" };
		const d = checkInject(e, cfg);
		expect(d.inject).not.toContain("Flagged:");
		expect(cancelPending()).toBeNull();
	}
	const owner = checkInject({ inject: "stop running the backup", agent: "main" }, cfg);
	expect(owner.inject).toContain("Flagged:");
	expect(cancelPending()).not.toBeNull();
});

// (d) P1d/P5: a named review spawn's read-only shell call is allowed; rm, push and secret reads stay denied.
test("a named review spawn may run read-only shell; rm, push and secret reads stay denied", () => {
	fresh();
	writeFileSync(join(STATE, "review-spawns.json"), JSON.stringify({ "rev-1": { plan: PLAN, text: "", hash: "x", verdicts: 0 } }));
	expect(reviewShell("git diff origin/main..HEAD").allow).toBe(true);
	expect(reviewShell("rm x").allow).toBe(false);
	expect(reviewShell("git push origin main").allow).toBe(false);
	expect(reviewShell("cat ~/.config/gateforge/config.yml").allow).toBe(false);
	expect(reviewShell("cat .env").allow).toBe(false);
});

// (e) P1e/P5: Main's stop is allowed once the turn spent guards.main_max_calls, even with an open
// realtime incident and an open queue.
test("stop is allowed once the turn reaches guards.main_max_calls, even with an open incident", () => {
	fresh();
	addIncident(cfg, { source: "realtime", kind: "detector", summary: "toy detector fired", evidence: "guard log" });
	writeWindow({ used: [], windowStart: Date.now(), mainCalls: cfg.guards.main_max_calls, mainCallsStart: nowSec() });
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "" }, cfg);
	expect(d.allow).toBe(true);
});

// (f) P1f/P4: two spawn problems come back in one deny, both named.
test("a spawn with two problems is denied once, naming both", () => {
	fresh();
	const d = checkSpawn({ agent: "toy-worker", invocationKind: "task", brief: LINT_DIRTY_BRIEF }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("must name an unticked phase");
	expect(d.reason).toContain("call budget");
});

// P5: the approval hard gate is off while approval.since is "", even when the plan has a page.
test("approvalProblem is off when approval.since is empty, even when the plan has a page", () => {
	fresh();
	recordPagePlan(PAGES, "toy.html", { plan: PLAN, missing: [], thin: [] });
	expect(approvalProblem(TOY_PLAN, PLAN, PAGES, "")).toBeNull();
	expect(approvalProblem(TOY_PLAN, PLAN, PAGES, "20260101_0000")).toContain("no approval record");
});

// P5b: the queue summary lists the top 10 plans then one "N more" line (queue-check still lists all).
test("queue summary lists the top 10 plans then one more-line", () => {
	fresh();
	const files: string[] = [];
	for (let i = 1; i <= 12; i++) {
		const f = join(TOY, "docs/plans", `20261019_toyp${String(i).padStart(2, "0")}.md`);
		writeFileSync(f, TOY_PLAN);
		files.push(f);
	}
	writeFileSync(INDEX, `${files.join("\n")}\n`);
	const lines = queueSummary(INDEX, []).split("\n");
	const planLines = lines.filter(l => /^  \d+\. /.test(l));
	expect(planLines).toHaveLength(10);
	expect(lines.some(l => l.includes("2 more plans"))).toBe(true);
});

// P5c: a failing blocker no longer denies reads; an edit stays denied and the deny names the hit path.
test("blocker skip: a read of a covered path is allowed while its blocker fails, an edit is denied naming the path", () => {
	fresh();
	writeFileSync(join(AGENT, "blockers", "fail-blocker"), "#!/bin/sh\nexit 2\n");
	chmodSync(join(AGENT, "blockers", "fail-blocker"), 0o755);
	writeFileSync(BLOCK_PLAN, blockerPlan("- fail-blocker"));
	writeFileSync(INDEX, `${BLOCK_PLAN}\n`);
	const read = checkTool(toolEvent("read", { path: join(TOY, "src/a.ts") }), cfg);
	expect(read.allow).toBe(true);
	const edit = checkTool(
		toolEvent("edit", { path: join(TOY, "src/a.ts"), old_string: "export const a = 1;", new_string: "export const a = 2;" }),
		cfg,
	);
	expect(edit.allow).toBe(false);
	expect(edit.reason).toContain(join(TOY, "src/a.ts"));
});

// P5c: the blocker skip must not open a push hole: a sub git push under a failing no-push blocker
// stays denied, and the deny names the covered path.
test("blocker skip: a sub git push with a failing no-push blocker stays denied", () => {
	fresh();
	writeFileSync(BLOCK_PLAN, blockerPlan("- no-push"));
	writeFileSync(INDEX, `${BLOCK_PLAN}\n`);
	const d = checkTool(toolEvent("bash", { command: "git push origin main" }), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("push");
	expect(d.reason).toContain(TOY);
});
