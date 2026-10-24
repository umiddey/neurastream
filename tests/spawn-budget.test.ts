// Per-spawn call budget: a `Call budget: <N>` line in a task brief (the task's own text, or the
// shared context of the same `task` tool call) gives that run a hard stop at N and a warning band
// of the same width as the global one (sub_max_calls - sub_warn_calls), floored at 1. The task
// must carry a name (the budget is keyed by it, the way plan-guard logs `BLOCK sub:<name>`) and N
// must be inside [10, guards.sub_max_calls_cap]; a task without the line keeps the global 90/100.
// Guard behaviour runs through `neurastream guard <event> --json` in a sandbox HOME (the
// tests/guards.test.ts harness); the ledger half uses the omp session parser and Run rows (the
// tests/ledger-*.ts harness).

import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { agentLedger } from "../src/core/agent-ledger.ts";
import { loadConfig } from "../src/core/config.ts";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";

const REPO = dirname(dirname(import.meta.path));
const HOME = "/tmp/neurastream-home-budget";
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const PLAN = join(TOY, "docs/plans/20261019_toy.md");
const STATE = join(HOME, ".local/state/queue");
const SUBAGENTS = join(AGENT, "notes/subagents.md");
const UNLOCK = join(AGENT, ".guard-unlock");
// A file no plan covers: every read of it counts against the budget and no blocker script runs.
const COUNTED = join(HOME, "counted.txt");
const BUDGETS = join(STATE, "spawn-budgets.json");

interface Decision {
	allow: boolean;
	reason: string;
	inject?: string;
	restore?: { path: string; text: string | null };
	state?: { callsSinceStop: number; idleStops: number };
}

const TOY_PLAN = `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Guard parity toy for the ported guards.

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

- Started the toy work.
`;

function fresh(): void {
	rmSync(HOME, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(TOY, "src"), join(AGENT, "blockers"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN, TOY_PLAN);
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
	writeFileSync(SUBAGENTS, "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	// The toy plan's blockers must exist and be executable (plan validation checks them); the
	// wrapper's relative import must survive the copy, as in tests/guards.test.ts.
	for (const b of ["deny-command", "deny-path", "deny-text", "no-push"]) {
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
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${SUBAGENTS}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${UNLOCK}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
guards:
  free_prefixes: ["${join(HOME, "Work/heavy-run.sh")}"]
`,
	);
	spawnSync("git", ["init", "-q"], { cwd: TOY });
}

// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
function envFor(): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))),
		HOME,
		QUEUE_AGENT: AGENT,
		QUEUE_INDEX: join(AGENT, "INDEX.md"),
		QUEUE_BLOCKERS: join(AGENT, "blockers"),
		QUEUE_STATE: STATE,
		QUEUE_SUBAGENTS: SUBAGENTS,
		QUEUE_CANCELLED: join(AGENT, "CANCELLED.md"),
		QUEUE_UNLOCK: UNLOCK,
	};
}

function guardCli(event: string, payload: unknown): { code: number; d: Decision } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	if (!r.stdout.trim()) throw new Error(`guard ${event} printed nothing: ${r.stderr}`);
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) as Decision };
}

function toolEvent(tool: string, input: Record<string, unknown>, agent: "main" | "sub", agentId: string, calls = 0) {
	return { tool, input, cwd: TOY, agent, agentId, calls, paths: [], writes: [], command: String(input.command ?? "") };
}

const ALLOW: Decision = { allow: true, reason: "" };
const brief = (budget: string): string => `Work ${PLAN} P1 now.\nCall budget: ${budget}`;

/** Main's `task` tool call with one named task plus a shared context. */
function spawn(name: string | null, task: string, context = ""): { code: number; d: Decision } {
	const t: Record<string, unknown> = { agent: "toy-worker", task };
	if (name !== null) t.name = name;
	return guardCli("pre-tool", toolEvent("task", { tasks: [t], context }, "main", "main"));
}

/** Main's `task` tool call with several tasks (their own lines win over the context's). */
function spawnTasks(tasks: Record<string, unknown>[], context: string): { code: number; d: Decision } {
	return guardCli("pre-tool", toolEvent("task", { tasks, context }, "main", "main"));
}

/** A subagent tool call after `calls` counted calls, reading a file no plan covers. */
function sub(agentId: string, calls: number, tool = "read", input: Record<string, unknown> = { path: COUNTED }): { code: number; d: Decision } {
	return guardCli("pre-tool", toolEvent(tool, input, "sub", agentId, calls));
}

function budgets(): Record<string, number> {
	return JSON.parse(readFileSync(BUDGETS, "utf8")) as Record<string, number>;
}

// --- (g) ledger harness: the omp session parser plus Run rows, as in tests/ledger-*.test.ts ---

const TMPG = mkdtempSync(join(tmpdir(), "spawn-budget-ledger-"));
// Inherited QUEUE_* (the caller's live session) beats the sandbox config in loadConfig below;
// save and delete them before it runs; afterAll restores them.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const cfgG = loadConfig({ home: join(TMPG, "home") });
const SESSIONS = join(TMPG, "sessions");
const PROJECT = join(SESSIONS, "-projects"); // listRuns finds session files one level down only
mkdirSync(PROJECT, { recursive: true });
mkdirSync(cfgG.paths.queue_state, { recursive: true });
writeFileSync(join(cfgG.paths.queue_state, "spawn-budgets.json"), JSON.stringify({ BudgetedX: 50 }));

// nowSec() reads NEURASTREAM_NOW, so the ledger's idle math is exact.
const NOW = 1760000000;
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(NOW);

// agentLedger runs queue-check for the priority check: an empty stub keeps it quiet.
const bin = join(TMPG, "home", ".local", "bin");
mkdirSync(bin, { recursive: true });
const queueCheck = join(bin, "queue-check");
writeFileSync(queueCheck, "#!/bin/sh\nexit 0\n");
chmodSync(queueCheck, 0o755);

const USAGE = { totalTokens: 10, input: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
const TOOL_USE = [{ type: "toolUse", id: "t1", name: "bash", input: { command: "bun test" } }];

function writeSession(name: string, calls: number): void {
	// Session lines in the shape the omp adapter parses (tests/ledger-final-text.test.ts): each
	// assistant toolUse turn with usage is one counted call.
	const lines = Array.from({ length: calls }, (_, i) => {
		const ts = `2026-10-22T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
		const message = { role: "assistant", stopReason: "toolUse", content: TOOL_USE, usage: { ...USAGE } };
		return JSON.stringify({ type: "message", timestamp: ts, message });
	});
	writeFileSync(join(PROJECT, name), `${lines.join("\n")}\n`);
}

function runById(id: string): Run | undefined {
	return ompRunSource(SESSIONS, cfgG).listRuns(0).find((r) => r.id === id);
}

function ledgerRow(id: string, statusDetail: string): Run {
	const lastWriteAt = NOW - 60;
	return {
		id,
		kind: "sub",
		model: "zai/glm-5",
		calls: 3,
		tokens: 1000,
		cacheRead: 0,
		cost: 0.1,
		inputTokens: 0,
		status: "running",
		statusDetail,
		startedAt: lastWriteAt - 600,
		lastWriteAt,
		endedAt: null,
		messages: [],
		scoreModel: "zai/glm-5",
		scoreCost: 0.1,
		scoreHours: 0.2,
		scoreRunning: true,
		scoreSurvived: false,
		scoreEnd: "running",
	};
}

const source = (rows: Run[]): RunSource => ({ listRuns: () => rows, mainSession: () => null });

// agentLedger writes its report to stdout; capture it.
function ledger(args: string[], rows: Run[]): { code: number; out: string } {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		const code = agentLedger(args, cfgG, source(rows));
		return { code, out };
	} finally {
		spy.mockRestore();
	}
}

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMPG, { recursive: true, force: true });
	rmSync(HOME, { recursive: true, force: true });
});

// (a) a Main task call whose brief has `Call budget: 50` and name X is allowed and records 50 for X.
test("a named task with Call budget: 50 is allowed and records 50 for its name", () => {
	fresh();
	const r = spawn("X", brief("50"));
	expect(r.code).toBe(0);
	expect(r.d).toEqual(ALLOW);
	expect(budgets()).toEqual({ X: 50 });
});

// (b) sub X is denied at call 50 (only plan Progress reads/edits pass) and warned at call 40
// (the global gap is sub_max_calls - sub_warn_calls = 10).
test("budgeted sub X: warning band opens at call 40, denial at 50, Progress work still passes", () => {
	fresh();
	expect(spawn("X", brief("50")).code).toBe(0);
	expect(sub("X", 20).d).toEqual(ALLOW); // before the band: no inject
	expect(sub("X", 38).d.inject).toBeUndefined();
	const warn = sub("X", 39); // call 40: the band opens
	expect(warn.code).toBe(0);
	expect(warn.d.allow).toBe(true);
	expect(String(warn.d.inject)).toContain("call 40/50");
	expect(String(warn.d.inject)).toContain("at 50");
	expect(String(sub("X", 48).d.inject)).toContain("call 49/50");
	expect(sub("X", 49).d.inject).toBeUndefined(); // call 50: past the warn band, not denied yet
	const spent = sub("X", 50);
	expect(spent.code).toBe(2);
	expect(spent.d.allow).toBe(false);
	expect(spent.d.reason).toContain("call budget spent (50/50)");
	// Only plan Progress reads and edits pass at the limit. The omp edit tool names its target as
	// a `[path#id]` marker inside `input.input` (queue/lib.ts writeTargets), not a `path` key.
	const editBody = `[${PLAN}#d1ff]\n- Started the toy work.\n+ Started the toy work.\n- wrote progress. Findings: none.`;
	expect(sub("X", 50, "edit", { input: editBody }).code).toBe(0);
	expect(sub("X", 50, "read", { path: join(TOY, "src/a.ts") }).code).toBe(2);
});

// (c) a sub with no recorded budget still stops at sub_max_calls (global 90/100 unchanged).
test("a sub without a recorded budget keeps the global warn 90 / stop 100", () => {
	fresh();
	expect(sub("NB", 20).d).toEqual(ALLOW);
	expect(sub("NB", 89).d.inject).toContain("call 90/100");
	expect(sub("NB", 99).d.inject).toBeUndefined();
	const spent = sub("NB", 100);
	expect(spent.code).toBe(2);
	expect(spent.d.reason).toContain("call budget spent (100/100)");
});

// (d) `Call budget: 5` and `Call budget: 500` (cap 200) are refused at spawn with the allowed range.
test("budgets outside [10, cap 200] are refused at spawn and nothing is recorded", () => {
	fresh();
	const low = spawn("LOW", brief("5"));
	expect(low.code).toBe(2);
	expect(low.d.allow).toBe(false);
	expect(low.d.reason).toContain("10");
	const high = spawn("HIGH", brief("500"));
	expect(high.code).toBe(2);
	expect(high.d.allow).toBe(false);
	expect(high.d.reason).toContain("200");
	expect(existsSync(BUDGETS)).toBe(false);
});

// (e) a budget without a task name is refused.
test("a Call budget line without a task name is refused at spawn", () => {
	fresh();
	const r = spawn(null, brief("50"));
	expect(r.code).toBe(2);
	expect(r.d.allow).toBe(false);
	expect(r.d.reason).toContain("name");
	expect(existsSync(BUDGETS)).toBe(false);
});

// (f) a budget in the shared context applies to every task of the call; a task's own line wins.
test("a context budget applies to every task of the call; the task's own line wins", () => {
	fresh();
	const r = spawnTasks(
		[
			{ agent: "toy-worker", name: "CTXA", task: `Work ${PLAN} P1 now.` },
			{ agent: "toy-worker", name: "CTXB", task: `Work ${PLAN} P1 now.\nCall budget: 20` },
		],
		`Shared rules.\nCall budget: 30`,
	);
	expect(r.code).toBe(0);
	expect(r.d).toEqual(ALLOW);
	expect(budgets()).toEqual({ CTXA: 30, CTXB: 20 });
});

// (g) the ledger's OVER-BUDGET check uses X's budget, keyed by the task name.
test("the ledger flags a budgeted sub over its own budget and leaves one under it running", () => {
	writeSession("BudgetedX.jsonl", 60); // 60 calls, budget 50
	writeSession("BudgetedOk.jsonl", 45); // 45 calls, budget 50
	writeSession("Unbudgeted.jsonl", 101); // no budget: the global 100 still applies
	const over = runById("BudgetedX");
	expect(over).toBeDefined();
	expect(over!.status).toBe("running");
	expect(over!.statusDetail).toContain("OVER-BUDGET(60>50 calls)");
	const ok = runById("BudgetedOk");
	expect(ok).toBeDefined();
	expect(ok!.status).toBe("running");
	expect(ok!.statusDetail).not.toContain("OVER-BUDGET");
	expect(runById("Unbudgeted")!.statusDetail).toContain("OVER-BUDGET(101>100 calls)");
});

test("agent-ledger --cap reports budgeted runs past their own budget; the global-only line stays the original's", () => {
	const r = ledger(["--cap"], [
		ledgerRow("BudgetedX", "RUNNING OVER-BUDGET(60>50 calls)"),
		ledgerRow("Wide", "RUNNING OVER-BUDGET(120>100 calls)"),
	]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("BudgetedX (past 50 calls)");
	expect(r.out).toContain("Wide (past 100 calls)");
	const global = ledger(["--cap"], [ledgerRow("BudgetHog", "RUNNING OVER-BUDGET(101>100 calls)")]);
	expect(global.code).toBe(1);
	expect(global.out).toContain("BudgetHog past 100 calls: stop them");
});
