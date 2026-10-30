// Main's per-turn tool-call cap (plan 20261028_1545_main_call_budget P2): the sub call-cap's
// warn/stop shape over calls counted in the edit-window state file since the last real owner
// prompt or Main's terminal hand-back. Exempt tools never count and never refuse; tier full and
// main_max_calls 0 switch it off; the sub path keeps its own counting.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkInject, checkTool, readWindow, resetMainCalls, writeWindow } from "../src/core/guards.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const originalQueueEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QUEUE_")));
afterAll(() => {
	for (const key of Object.keys(process.env)) if (key.startsWith("QUEUE_")) delete process.env[key];
	Object.assign(process.env, originalQueueEnv);
	refreshQueuePaths();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let state: string;
let agent: string;
let repo: string;
let cfg: Config;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-main-budget-"));
	roots.push(root);
	state = join(root, "state");
	agent = join(root, "agent");
	repo = join(root, "repo");
	mkdirSync(agent, { recursive: true });
	mkdirSync(state, { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src/code.ts"), "export const a = 1;\n");
	writeFileSync(join(agent, "INDEX.md"), "");
	writeFileSync(join(agent, "CANCELLED.md"), "");
	writeFileSync(join(agent, "subagents.md"), "## Allowed\n- `task`\n");
	loadCfg("guards:\n  main_warn_calls: 2\n  main_max_calls: 3\n  main_edit_limit: 5\n  main_window_min: 15\n");
	writeWindow({ used: [], windowStart: 0, mainCalls: 0 });
});

function loadCfg(guardsYaml: string): void {
	const configFile = join(root, ".config/neurastream/config.yml");
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(
		configFile,
		`paths:
  home: "${root}"
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(root, "guard.log")}"
  plan_guard_log: "${join(root, "plan-guard.log")}"
  work_roots: ["${repo}"]
${guardsYaml}`,
	);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QUEUE_")));
	Object.assign(env, { HOME: root });
	cfg = loadConfig({ home: root, env });
	applyQueueEnv(cfg);
}

const mainEvent = (tool: string, input: Record<string, unknown> = {}) => ({
	tool,
	input,
	cwd: repo,
	agent: "main" as const,
	agentId: "main",
	calls: 0,
	paths: [],
	writes: [],
	command: String(input?.command ?? ""),
});

const subEvent = (calls: number) => ({
	tool: "read",
	input: {},
	cwd: repo,
	agent: "sub" as const,
	agentId: "w1",
	calls,
	paths: [],
	writes: [],
	command: "",
});

/** Three allowed reads put Main exactly at main_max_calls 3. */
function toCap(): void {
	for (let i = 0; i < 3; i++) expect(checkTool(mainEvent("read"), cfg).allow).toBe(true);
}

test("calls 1-3 are allowed with the warn band from main_warn_calls; the 4th is refused naming the key", () => {
	const first = checkTool(mainEvent("read"), cfg);
	expect(first.allow).toBe(true);
	expect(first.inject ?? "").not.toContain("main-guard: call");
	const second = checkTool(mainEvent("read"), cfg);
	expect(second.allow).toBe(true);
	expect(second.inject ?? "").toContain("main-guard: call 2/3");
	expect(second.inject ?? "").toContain("(guards.main_warn_calls)");
	const third = checkTool(mainEvent("read"), cfg);
	expect(third.allow).toBe(true);
	expect(third.inject ?? "").toContain("main-guard: call 3/3");
	const fourth = checkTool(mainEvent("read"), cfg);
	expect(fourth.allow).toBe(false);
	expect(fourth.reason).toContain("guards.main_max_calls");
	expect(fourth.reason).toContain("main-guard: call 3/3 since the owner's last message or your last hand-back");
	expect(fourth.reason).toContain("spawn an implementer");
	// the refused call does not count
	expect(readWindow().mainCalls).toBe(3);
});

test("an exempt tool at the cap passes and never counts", () => {
	toCap();
	const d = checkTool(mainEvent("task", { tasks: [] }), cfg);
	expect(d.allow).toBe(true);
	expect(readWindow().mainCalls).toBe(3);
});

test("a real owner prompt resets the count; a continuation prompt does not", () => {
	toCap();
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(false);
	checkInject({ inject: "what is next", agent: "main" }, cfg);
	const d = checkTool(mainEvent("read"), cfg);
	expect(d.allow).toBe(true);
	expect(readWindow().mainCalls).toBe(1);
	// two more reads reach the cap again; the next is refused
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(true);
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(true);
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(false);
	checkInject({ inject: "main-guard: keep going", agent: "main" }, cfg);
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(false);
});

test("the terminal hand-back resets the count and keeps the edit window", () => {
	toCap();
	const w = readWindow();
	writeWindow({ ...w, used: ["edit:src/code.ts"] });
	resetMainCalls();
	expect(readWindow().mainCalls).toBe(0);
	expect(readWindow().used).toEqual(["edit:src/code.ts"]);
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(true);
});

test("subagent counting is unchanged", () => {
	expect(checkTool(subEvent(0), cfg).allow).toBe(true);
	const warn = checkTool(subEvent(90), cfg);
	expect(warn.allow).toBe(true);
	expect(warn.inject ?? "").toContain("plan-guard: call 91/100");
	const spent = checkTool(subEvent(100), cfg);
	expect(spent.allow).toBe(false);
	expect(spent.reason).toContain("call budget spent (100/100)");
	// sub calls never touch Main's counter
	expect(readWindow().mainCalls).toBe(0);
});

test("main_max_calls 0 is off", () => {
	loadCfg("guards:\n  main_warn_calls: 2\n  main_max_calls: 0\n  main_edit_limit: 5\n  main_window_min: 15\n");
	for (let i = 0; i < 20; i++) {
		const d = checkTool(mainEvent("read"), cfg);
		expect(d.allow).toBe(true);
		expect(d.inject ?? "").not.toContain("main-guard: call");
	}
});

test("tier full drops the cap", () => {
	loadCfg(
		"autonomy:\n  tier: full\nguards:\n  main_warn_calls: 2\n  main_max_calls: 3\n  main_edit_limit: 5\n  main_window_min: 15\n",
	);
	for (let i = 0; i < 5; i++) {
		const d = checkTool(mainEvent("read"), cfg);
		expect(d.allow).toBe(true);
		expect(d.inject ?? "").not.toContain("main-guard: call");
	}
});

// --- adapter wiring: the omp plugin resets at Main's terminal hand-back (agent_end without willContinue)

const REPO = dirname(dirname(import.meta.path));
const ADAPTER = join(REPO, "src/adapters/omp/index.ts");
const OMP_HOME = "/tmp/neurastream-home-main-budget";

function agentEndReset(event: Record<string, unknown>, jobs: string[] = []): { mainCalls: unknown; sent: string[] } {
	// The child's import path is only known at runtime (the worktree these tests ship in), and the
	// scenario must load the adapter the way the harness does — a runtime-selected specifier, the
	// same pattern tests/guards-omp.test.ts uses.
	const body = `
const h = {}; const sent = [];
const mod = await import(${JSON.stringify(ADAPTER)});
mod.default({ on: (ev, cb) => { (h[ev] ??= []).push(cb); }, registerCommand: () => {}, sendUserMessage: (c) => { sent.push(c); } });
const fs = await import("node:fs");
const win = ${JSON.stringify(join(OMP_HOME, "state/edit-window.json"))};
fs.writeFileSync(win, JSON.stringify({ used: [], windowStart: 0, mainCalls: 5 }));
const ctx = Object.assign(${JSON.stringify({ agent: { kind: "main", id: "main" }, cwd: "/tmp" })}, { sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/s1.jsonl" }, getAsyncJobSnapshot: () => ({ running: ${JSON.stringify(jobs.map(j => ({ label: j })))} }) });
for (const cb of h["agent_end"] ?? []) await cb(${JSON.stringify(event)}, ctx);
const out = JSON.parse(fs.readFileSync(win, "utf8")); console.log(JSON.stringify(Object.assign(out, { sent })));
`;
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	Object.assign(env, { HOME: OMP_HOME, NEURASTREAM_MAIN_LAUNCHER: "1" });
	mkdirSync(join(OMP_HOME, ".config/neurastream"), { recursive: true });
	mkdirSync(join(OMP_HOME, "state"), { recursive: true });
	writeFileSync(
		join(OMP_HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${OMP_HOME}"
  agent_dir: "${join(OMP_HOME, "agent")}"
  queue_index: "${join(OMP_HOME, "agent/INDEX.md")}"
  blockers: "${join(OMP_HOME, "agent/blockers")}"
  queue_state: "${join(OMP_HOME, "state")}"
  subagents: "${join(OMP_HOME, "agent/subagents.md")}"
  cancelled: "${join(OMP_HOME, "agent/CANCELLED.md")}"
  unlock: "${join(OMP_HOME, "agent/.guard-unlock")}"
  guard_log: "${join(OMP_HOME, "guard.log")}"
  plan_guard_log: "${join(OMP_HOME, "plan-guard.log")}"
  work_roots: []
`,
	);
	const r = spawnSync("bun", ["-e", body], { encoding: "utf8", cwd: "/tmp", env, timeout: 60_000 });
	if (r.status !== 0) throw new Error(`adapter run failed: ${r.stderr}`);
	return JSON.parse(r.stdout.trim()) as { mainCalls: unknown; sent: string[] };
}

test("the adapter resets at a terminal agent_end and keeps counting across willContinue", () => {
	expect(agentEndReset({}).mainCalls).toBe(0);
	expect(agentEndReset({ willContinue: true }).mainCalls).toBe(5);
});

test("a capped count starts over 15 min after its first call, with no owner message or hand-back", () => {
	toCap();
	const start = readWindow().mainCallsStart!;
	writeWindow({ ...readWindow(), mainCallsStart: start - 14 * 60 });
	const still = checkTool(mainEvent("read"), cfg);
	expect(still.allow).toBe(false);
	expect(still.reason).toContain("starts over 1 min from now");
	writeWindow({ ...readWindow(), mainCallsStart: start - 15 * 60 });
	expect(checkTool(mainEvent("read"), cfg).allow).toBe(true);
	expect(readWindow().mainCalls).toBe(1);
});

test("a deferred hand-back (willContinue + a running job, reply ended with stop) resets the count", () => {
	expect(agentEndReset({ willContinue: true, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "handing back" }] }] }, ["bg_1"]).mainCalls).toBe(0);
});

test("a deferred hand-back that promises is steered", () => {
	const refused = agentEndReset({ willContinue: true, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I'll merge it later" }] }] }, ["bg_1"]);
	const plain = agentEndReset({ willContinue: true, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "handing back" }] }] }, ["bg_1"]);
	expect(refused.sent.some(s => typeof s === "string" && s.includes("don't promise it — do it now, or write the plan and index it"))).toBe(true);
	expect(plain.sent.some(s => typeof s === "string" && s.includes("don't promise it — do it now, or write the plan and index it"))).toBe(false);
});

afterAll(() => {
	rmSync(OMP_HOME, { recursive: true, force: true });
});
