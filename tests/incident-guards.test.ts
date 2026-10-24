// Incident enforcement (P2): open incidents reach Main's prompt, refuse spawns and bypass
// launches unless the plan cites `INCIDENT <id>`, refuse the stop regardless of live subagents,
// and `agent-ledger --cap --incident <id>` no longer fails on OVER-BUDGET. Everything runs
// in-process against a sandbox HOME (applyQueueEnv points the queue library at it; the caller's
// QUEUE_* and NEURASTREAM_NOW are restored afterAll).

import { afterAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InjectEvent, Run, RunSource, SpawnEvent, StopEvent, ToolEvent } from "../src/core/adapter.ts";
import { agentLedger } from "../src/core/agent-ledger.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkInject, checkSpawn, checkStop, checkTool } from "../src/core/guards.ts";
import { addIncident, dismissIncident, planIncident } from "../src/core/incidents.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-incident-guards-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const NOW = 1760000000;
const INCIDENTS = join(STATE, "incidents.jsonl");

const TOY_PLAN = join(TOY, "docs/plans/20261020_toy.md");
const FIX = join(TOY, "docs/plans/20261020_fix.md");
const FIX2 = join(TOY, "docs/plans/20261020_fix2.md");
const FIX3 = join(TOY, "docs/plans/20261020_fix3.md");
const EMPTY_INDEX = join(AGENT, "EMPTY-INDEX.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(NOW);

function planText(citation = ""): string {
	return `# Toy fix

Worktree: -
Branch: feat/toy

## Goal
- Fix the incident. ${citation}

## Forbidden
- Never skip tests.

## Blockers
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.
`;
}

const baseCfg: Config = (() => {
	for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(TOY, "docs/plans"), join(TOY, "src"), join(HOME, ".config/neurastream"), STATE, join(HOME, ".local/bin")])
		mkdirSync(d, { recursive: true });
	for (const f of [TOY_PLAN, FIX, FIX2, FIX3]) writeFileSync(f, planText());
	writeFileSync(join(AGENT, "INDEX.md"), `${TOY_PLAN}\n${FIX}\n${FIX2}\n${FIX3}\n`);
	writeFileSync(EMPTY_INDEX, "");
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	// The blocker script's relative import must survive the copy (tests-only rewrite, as in guards.test.ts).
	const noPush = join(AGENT, "blockers/no-push");
	writeFileSync(noPush, readBlocker());
	chmodSync(noPush, 0o755);
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
	return loadConfig({ home: HOME, env: {} });
})();

function readBlocker(): string {
	// The blocker script's relative import must survive the copy (tests-only rewrite, as in guards.test.ts).
	const repo = dirname(dirname(import.meta.path));
	return readFileSync(join(repo, "blockers/no-push"), "utf8").replace("../src/core/blockers.ts", join(repo, "src/core/blockers.ts"));
}

applyQueueEnv(baseCfg);
const cfg = baseCfg;
// agentLedger runs queue-check for the priority check: a stub that reports one priority id.
const queueCheck = join(HOME, ".local/bin/queue-check");
writeFileSync(queueCheck, "#!/bin/sh\necho P77\nexit 0\n");
chmodSync(queueCheck, 0o755);

// A queue with no open plans: only the incident rule decides the stop there.
const stopCfg: Config = { ...baseCfg, paths: { ...baseCfg.paths, queue_index: EMPTY_INDEX } };

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

function taskInput(brief: string): Record<string, unknown> {
	return { tasks: [{ name: "w", agent: "toy-worker", task: brief, context: "" }] };
}

function toolEvent(input: Record<string, unknown>, tool = "task"): ToolEvent {
	return { tool, input, cwd: TOY, agent: "main", agentId: "m0", calls: 0, paths: [], writes: [], command: "" };
}

function stop(callsSinceStop: number, idleStops: number, ledgerText: string): StopEvent {
	return { agent: "main", callsSinceStop, idleStops, ledgerText };
}

test("checkInject lists each open incident for Main with the two ways to clear it", () => {
	const { incident } = addIncident(cfg, { source: "main", kind: "ledger-bug", summary: "ledger says RUNNING for a finished agent" }, NOW);
	const d = checkInject({ inject: "hello", agent: "main" }, cfg);
	expect(d.allow).toBe(true);
	expect(d.inject).toContain(`INCIDENT ${incident.id} [main/ledger-bug]: ledger says RUNNING for a finished agent`);
	expect(d.inject).toContain(`neurastream incident plan ${incident.id} <plan.md>`);
	expect(d.inject).toContain(`neurastream incident dismiss ${incident.id} --why "<text>"`);
	const sub = checkInject({ inject: "hello", agent: "sub" }, cfg);
	expect(sub.inject ?? "").not.toContain("INCIDENT ");
	// a recorded plan clears the prompt line
	writeFileSync(FIX, planText(`Fixes INCIDENT ${incident.id}`));
	expect(planIncident(cfg, incident.id, FIX)).toBe(null);
	const after = checkInject({ inject: "hello", agent: "main" }, cfg);
	expect(after.inject).not.toContain(`INCIDENT ${incident.id} `);
});

test("a task spawn is refused until its plan cites the incident; once planned, unrelated spawns go through", () => {
	const { incident } = addIncident(cfg, { source: "realtime", kind: "ledger-bug", summary: "second toy" }, NOW);
	const toyBrief = `Work ${TOY_PLAN} on P1`;
	const refused = checkTool(toolEvent(taskInput(toyBrief)), cfg);
	expect(refused.allow).toBe(false);
	expect(refused.reason).toContain(incident.id);
	expect(refused.reason).toContain("incident plan");
	const fixBrief = `Work ${FIX} on P1`;
	// fix work goes through: the named plan cites the open incident
	writeFileSync(FIX, planText(`Fixes INCIDENT ${incident.id}`));
	const fixSpawn = checkTool(toolEvent(taskInput(fixBrief)), cfg);
	// Matching the whole decision keeps the refusal reason visible when this fails.
	expect(fixSpawn).toMatchObject({ allow: true });
	expect(planIncident(cfg, incident.id, FIX)).toBe(null);
	expect(checkTool(toolEvent(taskInput(toyBrief)), cfg).allow).toBe(true);
});

test("a bypass launch follows the same rule as the task gate", () => {
	const { incident } = addIncident(cfg, { source: "daily", kind: "m2", summary: "third toy" }, NOW);
	const cmd = (plan: string) => `opencode run P1 ${plan}`;
	// FIX2 is uncited and never spawned on, so planGate passes and the refusal provably comes
	// from the incident gate (TOY_PLAN's progress hash was spent by the task-gate test above).
	const blocked = checkTool(toolEvent({ command: cmd(FIX2) }, "bash"), cfg);
	expect(blocked.allow).toBe(false);
	expect(blocked.reason).toContain(incident.id);
	writeFileSync(FIX2, planText(`Fixes INCIDENT ${incident.id}`));
	expect(checkTool(toolEvent({ command: cmd(FIX2) }, "bash"), cfg)).toMatchObject({ allow: true });
	// leave nothing open for the tests below
	expect(planIncident(cfg, incident.id, FIX2)).toBe(null);
});

test("the spawn event gate refuses open-incident work like the task gate", () => {
	const { incident } = addIncident(cfg, { source: "weekly", kind: "m5", summary: "fourth toy" }, NOW);
	// Same trick as the bypass test: FIX3 is uncited and never spawned on, so planGate passes
	// and the incident gate is what refuses.
	const refused = checkSpawn({ agent: "toy-worker", invocationKind: "task", brief: `Work ${FIX3} on P1` }, cfg);
	expect(refused.allow).toBe(false);
	expect(refused.reason).toContain(incident.id);
	writeFileSync(FIX3, planText(`Fixes INCIDENT ${incident.id}`));
	expect(checkSpawn({ agent: "toy-worker", invocationKind: "task", brief: `Work ${FIX3} on P1` }, cfg)).toMatchObject({ allow: true });
	// leave nothing open for the stop tests below
	expect(planIncident(cfg, incident.id, FIX3)).toBe(null);
});

test("the stop is refused while an incident is open, even with a live subagent awake", () => {
	applyQueueEnv(stopCfg);
	const { incident } = addIncident(cfg, { source: "realtime", kind: "x", summary: "stop toy" }, NOW);
	const d = checkStop(stop(0, 0, "NsA zai/glm 12 0.1 0% $0.1 10-22 23:00 RUNNING (idle 1m)"), stopCfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(incident.id);
	expect(d.state?.idleStops).toBe(1);
	// leave nothing open for the tests below
	expect(dismissIncident(cfg, incident.id, "test incident, closed to isolate the next cases")).toBe(null);
});

test("a planned, dismissed or fixed incident no longer blocks the stop", () => {
	applyQueueEnv(stopCfg);
	const a = addIncident(cfg, { source: "realtime", kind: "x", summary: "planned toy" }, NOW);
	writeFileSync(FIX, planText(`Fixes INCIDENT ${a.incident.id}`));
	expect(planIncident(cfg, a.incident.id, FIX)).toBe(null);
	expect(checkStop(stop(0, 0, ""), stopCfg).allow).toBe(true);

	const b = addIncident(cfg, { source: "realtime", kind: "x", summary: "dismissed toy" }, NOW);
	expect(dismissIncident(cfg, b.incident.id, "not a bug")).toBe(null);
	expect(checkStop(stop(0, 0, ""), stopCfg).allow).toBe(true);

	// {type:"fixed"} is what queue-close will append (P5); the fold already treats it as a resolution.
	const c = addIncident(cfg, { source: "realtime", kind: "x", summary: "fixed toy" }, NOW);
	appendFileSync(INCIDENTS, `${JSON.stringify({ type: "fixed", id: c.incident.id, plan: FIX })}\n`);
	expect(checkStop(stop(0, 0, ""), stopCfg).allow).toBe(true);
});

test("two idle stop attempts release the incident block, so a Main that cannot act is not stuck forever", () => {
	applyQueueEnv(stopCfg);
	addIncident(cfg, { source: "realtime", kind: "x", summary: "valve toy" }, NOW);
	const first = checkStop(stop(0, 0, ""), stopCfg);
	expect(first.allow).toBe(false);
	expect(first.state?.idleStops).toBe(1);
	const second = checkStop(stop(0, first.state?.idleStops ?? 0, ""), stopCfg);
	expect(second.allow).toBe(false);
	expect(second.state?.idleStops).toBe(2);
	expect(checkStop(stop(0, second.state?.idleStops ?? 0, ""), stopCfg).allow).toBe(true);
});

// --- agent-ledger --cap --incident ---

function row(id: string, statusDetail: string, lastWriteMinAgo: number): Run {
	const lastWriteAt = NOW - lastWriteMinAgo * 60;
	return {
		id,
		kind: "sub",
		model: "zai/glm-5",
		calls: 3,
		tokens: 1000,
		cacheRead: 0,
		cost: 0.1,
		inputTokens: 0,
		status: statusDetail.includes("OVER-BUDGET") ? "done" : "running",
		statusDetail,
		startedAt: lastWriteAt - 600,
		lastWriteAt,
		endedAt: null,
		messages: [],
		scoreModel: "zai/glm-5",
		scoreCost: 0.1,
		scoreHours: 0.2,
		scoreRunning: statusDetail.startsWith("RUNNING"),
		scoreSurvived: false,
		scoreEnd: "running",
	};
}

const source = (rows: Run[]): RunSource => ({ listRuns: () => rows, mainSession: () => null });

function ledger(args: string[], rows: Run[]): { code: number; out: string } {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		const code = agentLedger(args, baseCfg, source(rows));
		return { code, out };
	} finally {
		spy.mockRestore();
	}
}

test("--cap alone fails on OVER-BUDGET; with --incident it passes", () => {
	const rows = [row("ov1", "finished OVER-BUDGET(120>100)", 2), row("sub-P77", "RUNNING", 2)];
	expect(ledger(["--cap"], rows).code).toBe(1);
	const withInc = ledger(["--cap", "--incident", "I-20261022-1"], rows);
	expect(withInc.code).toBe(0);
	expect(withInc.out).toContain("OVER-BUDGET: ov1");
});

test("--incident does not weaken the provider-slot or priority checks", () => {
	const full = ledger(["--cap", "--incident", "I-20261022-1"], [row("z1", "RUNNING", 2), row("z2", "RUNNING", 2)]);
	expect(full.code).toBe(1);
	expect(full.out).toContain("FULL zai");
	const prio = ledger(["--cap", "--incident", "I-20261022-1"], [row("ov1", "finished OVER-BUDGET(120>100)", 2)]);
	expect(prio.code).toBe(1);
	expect(prio.out).toContain("PRIORITY IDLE");
});
