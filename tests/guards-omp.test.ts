// Guard parity through the omp adapter: for a toy plan in a sandbox HOME the adapter's event
// handlers (the same hooks the original extensions used) refuse what the ported guards refuse —
// denied command, denied path, non-Progress plan edit, spawn outside the allow-list, 6th counted
// change in the window — plus the allowed counterparts, and the refusal texts match
// `neurastream guard <event> --json` (which tests/guards.test.ts already pins to the originals).
// Each scenario runs in a `bun -e` child with HOME pointing at the sandbox, the way the harness
// would load the extension: the import inside the child script is deliberately runtime-selected
// because the adapter must load with the sandbox HOME already set.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CANCEL_TODO } from "../src/core/guards.ts";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(import.meta.path));
const ADAPTER = join(REPO, "src/adapters/omp/index.ts");
const HOME = "/tmp/neurastream-home-omp";
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const PLAN = join(TOY, "docs/plans/20261019_toy.md");
const STATE = join(HOME, ".local/state/queue");
const SUBAGENTS = join(AGENT, "notes/subagents.md");
const UNLOCK = join(AGENT, ".guard-unlock");
const LEDGER_OUT = join(HOME, "ledger-out.txt");
const CLOSE_CAPTURE = join(HOME, "close-capture.txt");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

interface Decision {
	allow: boolean;
	reason: string;
	inject?: string;
	restore?: { path: string; text: string };
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
	for (const d of [
		join(TOY, "docs/plans"),
		join(TOY, "src"),
		join(TOY, "secret"),
		join(AGENT, "blockers"),
		join(AGENT, "notes"),
		join(HOME, ".config/neurastream"),
		STATE,
	])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN, TOY_PLAN);
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
	writeFileSync(SUBAGENTS, "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(LEDGER_OUT, "");
	for (const b of ["deny-command", "deny-path", "deny-text", "no-push"]) {
		const text = readFileSync(join(REPO, "blockers", b), "utf8").replace(
			"../src/core/blockers.ts",
			join(REPO, "src/core/blockers.ts"),
		);
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
  free_prefixes: ["${join(HOME, "Work/gf-testbed/")}", "${join(HOME, "Work/archive/")}", "${join(HOME, "Work/heavy-run.sh")}"]
  ledger_command: "cat ${LEDGER_OUT}"
queue:
  auto_close_min: 15
`,
	);
	spawnSync("git", ["init", "-q"], { cwd: TOY });
}

// Inherited QUEUE_* (left by an in-process adapter in another test file) would override the
// sandbox config.yml in the child: env beats config.
function envFor(): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	return { ...env, HOME, QUEUE_CLOSE_BIN: join(HOME, "close-stub") };
}

// Result readers: handler returns are untyped at the boundary (fake host in the child), so the
// assertions read them through checked access instead of shape assertions.
function reasonOf(x: unknown): string {
	if (x && typeof x === "object" && "reason" in x) {
		const value: unknown = x.reason;
		return typeof value === "string" ? value : "";
	}
	return "";
}

function isBlocked(x: unknown): boolean {
	if (x && typeof x === "object" && "block" in x) {
		const value: unknown = x.block;
		return value === true;
	}
	return false;
}

function fieldOf(x: unknown, key: string): unknown {
	if (!x || typeof x !== "object" || !(key in x)) return undefined;
	return (x as Record<string, unknown>)[key];
}

// Runs one scenario in a child whose HOME is the sandbox: the extension registers on a fake
// host, the body drives handlers, the last stdout line comes back as JSON.
function adapterRun(body: string, env: NodeJS.ProcessEnv = envFor()): unknown[] {
	const r = spawnSync("bun", ["-e", body], { encoding: "utf8", cwd: "/tmp", env, timeout: 60000 });
	if (r.status !== 0) throw new Error(`adapter run failed: ${r.stderr}`);
	const out = r.stdout.trim().split("\n").pop() ?? "null";
	// Allowed handlers return undefined; JSON.stringify turned those slots into null.
	const parsed: unknown = JSON.parse(out, (_k, v) => (v === null ? undefined : v));
	if (!Array.isArray(parsed)) throw new Error(`adapter scenario printed ${typeof parsed}, not an array`);
	return parsed;
}

const REGISTER = `
const h = {};
const mod = await import(${JSON.stringify(ADAPTER)});
mod.default({ on: (ev, cb) => { h[ev] = cb; }, registerCommand: () => {}, sendUserMessage: () => {} });
`;
const MAIN_CTX = JSON.stringify({ agent: { kind: "main", id: "main" }, cwd: TOY });
const SUB_CTX = JSON.stringify({ agent: { kind: "sub", id: "w1" }, cwd: TOY });

function guardCli(event: string, payload: unknown): { code: number; d: Decision } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	if (!r.stdout.trim()) throw new Error(`guard ${event} printed nothing: ${r.stderr}`);
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) as Decision };
}

function toolEvent(tool: string, input: Record<string, unknown>, agent: "main" | "sub", calls = 0) {
	return {
		tool,
		input,
		cwd: TOY,
		agent,
		agentId: agent === "main" ? "main" : "w1",
		calls,
		paths: [],
		writes: [],
		command: String(input.command ?? ""),
	};
}

test("denied command: adapter tool_call refuses a sub like the guard CLI; clean command passes", () => {
	fresh();
	const bad = "bun test --grep thing test.skip";
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["tool_call"]({ toolName: "bash", input: { command: ${JSON.stringify(bad)} }, toolCallId: "t1" }, ${SUB_CTX}));
out.push(await h["tool_call"]({ toolName: "bash", input: { command: "bun test --grep thing" }, toolCallId: "t2" }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`);
	const cli = guardCli("pre-tool", toolEvent("bash", { command: bad }, "sub"));
	expect(isBlocked(out[0])).toBe(true);
	expect(reasonOf(out[0])).toBe(cli.d.reason);
	expect(cli.d.reason).toContain("deny-command: command matches forbidden pattern /test\\.skip/");
	expect(out[1]).toBeUndefined();
});

test("denied path: adapter refuses the sub write, other writes pass", () => {
	fresh();
	const bad = join(TOY, "secret/x.md");
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(bad)}, content: "x" }, toolCallId: "t1" }, ${SUB_CTX}));
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(join(TOY, "src/ok.ts"))}, content: "x" }, toolCallId: "t2" }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`);
	const cli = guardCli("pre-tool", toolEvent("write", { path: bad, content: "x" }, "sub"));
	expect(isBlocked(out[0])).toBe(true);
	expect(reasonOf(out[0])).toBe(cli.d.reason);
	expect(cli.d.reason).toContain("is forbidden by the plan (deny-path secret/**)");
	expect(out[1]).toBeUndefined();
});

test("non-Progress plan edit: tool_call snapshots, tool_result refuses, restores, and reports; Progress-only edit passes", () => {
	fresh();
	const before = TOY_PLAN;
	const statusFlip = before.replace("Status: open", "Status: complete");
	const progressOnly = before.replace("- Started the toy work.", "- Started the toy work.\n- Did the thing.");
	const out = adapterRun(`${REGISTER}
const fs = await import("node:fs");
const out = [];
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(PLAN)}, content: ${JSON.stringify(statusFlip)} }, toolCallId: "t1" }, ${SUB_CTX}));
fs.writeFileSync(${JSON.stringify(PLAN)}, ${JSON.stringify(statusFlip)}); // the tool did the write
out.push(await h["tool_result"]({ toolName: "write", input: {}, toolCallId: "t1" }, ${SUB_CTX}));
out.push(fs.readFileSync(${JSON.stringify(PLAN)}, "utf8") === ${JSON.stringify(before)});
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(PLAN)}, content: ${JSON.stringify(progressOnly)} }, toolCallId: "t2" }, ${SUB_CTX}));
fs.writeFileSync(${JSON.stringify(PLAN)}, ${JSON.stringify(progressOnly)});
out.push(await h["tool_result"]({ toolName: "write", input: {}, toolCallId: "t2" }, ${SUB_CTX}));
out.push(fs.readFileSync(${JSON.stringify(PLAN)}, "utf8") === ${JSON.stringify(progressOnly)});
console.log(JSON.stringify(out));
`);
	const cli = guardCli("plan-edit", { path: PLAN, before, after: statusFlip, agent: "sub" });
	expect(out[0]).toBeUndefined(); // the write itself is allowed, only verified after
	expect(fieldOf(out[1], "isError")).toBe(true);
	const text = (fieldOf(out[1], "content") as { type: string; text: string }[] | undefined)?.[0]?.text;
	expect(text).toBe(cli.d.reason);
	expect(cli.d.restore).toEqual({ path: PLAN, text: before });
	expect(out[2]).toBe(true); // the adapter restored the file itself
	expect(out[3]).toBeUndefined();
	expect(out[4]).toBeUndefined(); // Progress-only edit passes verification
	expect(out[5]).toBe(true); // and the Progress-only content stays
});

test("spawn outside the allow-list: before_subagent_spawn refuses; listed agent via task passes; other kinds refuse", () => {
	fresh();
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["before_subagent_spawn"]({ agent: "ghost", invocationKind: "task" }, ${MAIN_CTX}));
out.push(await h["before_subagent_spawn"]({ agent: "toy-worker", invocationKind: "task" }, ${MAIN_CTX}));
out.push(await h["before_subagent_spawn"]({ agent: "toy-worker", invocationKind: "bash" }, ${MAIN_CTX}));
out.push(await h["before_subagent_spawn"]({ agent: "toy-worker", invocationKind: "task" }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`);
	expect(isBlocked(out[0])).toBe(true);
	expect(reasonOf(out[0])).toBe(`main-guard: agent "ghost" is not in "## Allowed" of ${SUBAGENTS}.`);
	expect(out[1]).toBeUndefined();
	expect(reasonOf(out[2])).toBe("main-guard: spawn implementers with the task tool (the plan gate checks its brief).");
	expect(out[3]).toBeUndefined(); // subs never go through the spawn gate
});

test("6th counted change in the window: adapter blocks like the CLI; .md stays free; owner message resets", () => {
	fresh();
	const aTs = join(TOY, "src/a.ts");
	const script = `${REGISTER}
const ctx = ${MAIN_CTX};
const w = (i, p, c) => h["tool_call"]({ toolName: "write", input: { path: p, content: c }, toolCallId: "w" + i }, ctx);
const out = [];
for (let i = 0; i < 6; i++) out.push(await w(i, ${JSON.stringify(aTs)}, "v" + i));
out.push(await w(99, ${JSON.stringify(join(TOY, "docs/note.md"))}, "x"));
out.push(await h["before_agent_start"]({ prompt: "continue" }, ctx));
out.push(await w(100, ${JSON.stringify(aTs)}, "after reset"));
console.log(JSON.stringify(out));
`;
	const out = adapterRun(script);
	// The edit window lives in the shared queue state, so the CLI comparison needs its own fresh
	// sandbox (same fixture, same texts) to produce the same 0,0,0,0,0,block sequence.
	fresh();
	const writeMain = (path: string, content: string) => guardCli("pre-tool", toolEvent("write", { path, content }, "main"));
	const results = Array.from({ length: 6 }, (_, i) => writeMain(aTs, `v${i}`));
	expect(results.slice(0, 5).map(r => r.code)).toEqual([0, 0, 0, 0, 0]);
	expect(fieldOf(out[2], "additionalContext")).toBe(results[2]!.d.inject);
	expect(fieldOf(out[4], "additionalContext")).toBe(results[4]!.d.inject);
	expect(isBlocked(out[5])).toBe(true);
	expect(reasonOf(out[5])).toBe(results[5]!.d.reason);
	expect(results[5]!.d.reason).toContain("Main already changed project files 5 times in this 15-minute window");
	expect(out[6]).toBeUndefined(); // .md never counts
	const injected = fieldOf(out[7], "message") as { customType?: unknown; display?: unknown; content?: unknown } | undefined;
	expect(injected && typeof injected === "object" ? injected.customType : undefined).toBe("main-guard.queue");
	expect(injected && typeof injected === "object" ? injected.display : undefined).toBe(false);
	expect(typeof injected?.content === "string" && injected.content.includes(join(AGENT, "INDEX.md"))).toBe(true);
	expect(out[8]).toBeUndefined(); // owner message reset the window
});

test("call budget: warn at 90, refusal at 100, all counted in adapter memory", () => {
	fresh();
	const calls = Array.from(
		{ length: 101 },
		(_, i) =>
			// A file no plan covers: the budget counts every call, but blocker scripts (one bun
			// process each) would make 100 repo reads far too slow for the test timeout.
			`out.push(await h["tool_call"]({ toolName: "read", input: { path: ${JSON.stringify(LEDGER_OUT)} }, toolCallId: "r${i}" }, ${SUB_CTX}));`,
	).join("\n");
	const out = adapterRun(`${REGISTER}
const out = [];
${calls}
console.log(JSON.stringify(out));
`);
	const warns = out.slice(0, 100).filter(x => fieldOf(x, "additionalContext") !== undefined);
	expect(warns).toHaveLength(10); // calls 90..99 warn
	expect(fieldOf(warns[0], "additionalContext")).toContain("call 90/100");
	expect(fieldOf(out[99], "additionalContext")).toBeUndefined(); // call 100: past the warn band
	const blocked = out[100]; // the 101st call: 100 counted calls are spent
	expect(isBlocked(blocked)).toBe(true);
	expect(reasonOf(blocked)).toContain("call budget spent (100/100)");
});

test("stop counters live in adapter memory: live sub allows, spin guard of three idle stops", () => {
	fresh();
	const ledger = "MAIN x RUNNING\nSUB w1 RUNNING zai/glm 3m idle 0 $0.01\n";
	const out = adapterRun(`${REGISTER}
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(LEDGER_OUT)}, ${JSON.stringify(ledger)});
const ctx = ${MAIN_CTX};
const out = [];
out.push(await h["session_stop"]({}, { agent: { kind: "sub" }, cwd: ctx.cwd })); // sub stops are free
await h["tool_call"]({ toolName: "read", input: { path: ${JSON.stringify(join(TOY, "src/a.ts"))} }, toolCallId: "m1" }, ctx);
out.push(await h["session_stop"]({}, ctx)); // live sub wakes Main: allowed
fs.writeFileSync(${JSON.stringify(LEDGER_OUT)}, "");
out.push(await h["session_stop"]({}, ctx)); // the one tool call since the last stop resets the streak
out.push(await h["session_stop"]({}, ctx)); // idle stop 1
out.push(await h["session_stop"]({}, ctx)); // idle stop 2
out.push(await h["session_stop"]({}, ctx)); // idle stop 3: let through
console.log(JSON.stringify(out));
`);
	expect(out[0]).toBeUndefined();
	expect(out[1]).toBeUndefined();
	expect(reasonOf(out[2])).toContain("keep working while the queue has items");
	expect(reasonOf(out[3])).toContain("keep working while the queue has items");
	expect(reasonOf(out[4])).toContain("keep working while the queue has items");
	expect(out[5]).toBeUndefined(); // third idle stop in a row passes
});

test("stop continuation turns keep the spin guard: the third idle stop passes despite the guard's own nudges", () => {
	fresh();
	const out = adapterRun(`${REGISTER}
const ctx = ${MAIN_CTX};
const out = [];
await h["before_agent_start"]({ prompt: "owner says hi" }, ctx);
for (let i = 0; i < 3; i++) {
	const d = await h["session_stop"]({}, ctx);
	out.push(d);
	// the harness starts the next turn from the block reason (session-stop continuation)
	if (d) await h["before_agent_start"]({ prompt: d.reason }, ctx);
}
console.log(JSON.stringify(out));
`);
	expect(reasonOf(out[0])).toContain("keep working while the queue has items");
	expect(reasonOf(out[1])).toContain("keep working while the queue has items");
	expect(out[2]).toBeUndefined();
});

test("protected files and Main-only tools: adapter refuses like the CLI until the owner unlocks", () => {
	fresh();
	const target = join(AGENT, "AGENTS.md");
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(target)}, content: "x" }, toolCallId: "t1" }, ${SUB_CTX}));
out.push(await h["tool_call"]({ toolName: "bash", input: { command: "bun run queue-close docs/plans/x.md" }, toolCallId: "t2" }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`);
	const cli = guardCli("pre-tool", toolEvent("write", { path: target, content: "x" }, "sub"));
	expect(isBlocked(out[0])).toBe(true);
	expect(reasonOf(out[0])).toBe(cli.d.reason);
	expect(cli.d.reason).toContain("is a protected guard file");
	expect(reasonOf(out[1])).toBe(
		`plan-guard: queue-close and queue-cancel are Main's; report in your plan's "## Progress" instead.`,
	);
	writeFileSync(UNLOCK, new Date().toISOString());
	const after = adapterRun(`${REGISTER}
const out = [];
out.push(await h["tool_call"]({ toolName: "write", input: { path: ${JSON.stringify(target)}, content: "x" }, toolCallId: "t1" }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`);
	expect(after[0]).toBeUndefined();
});

test("cancel flag: before_agent_start flags owner wording; the task tool call refuses until recorded", () => {
	fresh();
	const brief = `Work ${PLAN}.`;
	const out = adapterRun(`${REGISTER}
const ctx = ${MAIN_CTX};
const out = [];
out.push(await h["before_agent_start"]({ prompt: "please cancel that plan" }, ctx));
// The spawn event itself passes (it carries no brief); the refusal comes at the task tool call.
out.push(await h["before_subagent_spawn"]({ agent: "toy-worker", invocationKind: "task" }, ctx));
out.push(await h["tool_call"]({ toolName: "task", input: { tasks: [{ agent: "toy-worker", task: ${JSON.stringify(brief)} }] } }, ctx));
console.log(JSON.stringify(out));
`);
	const content = fieldOf(fieldOf(out[0], "message"), "content");
	expect(content).toContain(`main-guard: ${CANCEL_TODO} Flagged: "please cancel that plan"`);
	expect(out[1]).toBeUndefined();
	expect(isBlocked(out[2])).toBe(true);
	expect(reasonOf(out[2])).toBe(`main-guard: ${CANCEL_TODO} Flagged: "please cancel that plan"`);
});

test("auto-close: session_start and a main push each start a queue-close for a complete plan", async () => {
	fresh();
	writeFileSync(PLAN, TOY_PLAN.replace("Status: open", "Status: complete"));
	const stub = join(HOME, "close-stub");
	writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(CLOSE_CAPTURE)}\n`);
	chmodSync(stub, 0o755);
	adapterRun(`${REGISTER}
const ctx = ${MAIN_CTX};
const out = [];
out.push(await h["session_start"]({}, ctx));
out.push(await h["tool_call"]({ toolName: "bash", input: { command: "echo hi" }, toolCallId: "b1" }, ctx));
out.push(await h["tool_result"]({ toolName: "bash", input: { command: "echo hi" }, toolCallId: "b1" }, ctx));
out.push(await h["tool_result"]({ toolName: "bash", input: { command: "git push origin HEAD" }, toolCallId: "b2" }, ctx));
console.log(JSON.stringify(out));
`);
	// The queue-close child is detached by design, so there is no handle to await in this
	// process: poll the capture file the stub appends to (integration against the real clock).
	const deadline = Date.now() + 15000;
	const count = () =>
		existsSync(CLOSE_CAPTURE) ? readFileSync(CLOSE_CAPTURE, "utf8").trim().split("\n").filter(Boolean).length : 0;
	while (Date.now() < deadline && count() < 2) await new Promise(r => setTimeout(r, 100));
	expect(count()).toBe(2); // session_start + the push
});

test("auto-close never re-runs the host binary: inside a harness process.execPath is the harness", async () => {
	fresh();
	writeFileSync(PLAN, TOY_PLAN.replace("Status: open", "Status: complete"));
	const hostMark = join(HOME, "host-invoked.txt");
	const host = join(HOME, "fake-host");
	writeFileSync(host, `#!/bin/sh\necho "$@" >> ${JSON.stringify(hostMark)}\n`);
	chmodSync(host, 0o755);
	const { QUEUE_CLOSE_BIN: _unset, ...env } = envFor();
	adapterRun(
		`process.execPath = ${JSON.stringify(host)};
${REGISTER}
await h["session_start"]({}, ${MAIN_CTX});
console.log("[]");
`,
		env,
	);
	const closeLines = () =>
		spawnSync("sh", ["-c", `cat ${JSON.stringify(STATE)}/close-*.log 2>/dev/null`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	// The queue-close child is detached by design (no handle to await): poll its log against the
	// real clock, like the auto-close test above.
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline && closeLines().length < 2) await Bun.sleep(100);
	expect(existsSync(hostMark)).toBe(false);
	// the package's own queue-close ran and wrote past the "auto-close attempt" header line
	expect(closeLines().length).toBeGreaterThan(1);
});

test("main reads: a grep -n line in a Main tool_result logs the existing file only", () => {
	fresh();
	const grepOut = "src/a.ts:1:export const a = 1;\nsrc/missing.ts:3:gone\n";
	adapterRun(`${REGISTER}
const ctx = ${MAIN_CTX};
const cmd = "grep -rn export src";
await h["tool_call"]({ toolName: "bash", input: { command: cmd }, toolCallId: "g1" }, ctx);
await h["tool_result"]({ toolName: "bash", input: { command: cmd }, toolCallId: "g1", content: [{ type: "text", text: ${JSON.stringify(grepOut)} }], isError: false }, ctx);
console.log(JSON.stringify([]));
`);
	const reads = JSON.parse(readFileSync(join(STATE, "main-reads.json"), "utf8")) as Record<string, string>;
	expect(Object.keys(reads)).toContain(join(TOY, "src/a.ts"));
	expect(Object.keys(reads)).not.toContain(join(TOY, "src/missing.ts"));
});

test("session.compacting: Main gets 'none' when no plan waits on the owner; sub-agents get nothing", () => {
	fresh();
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["session.compacting"]({ type: "session.compacting", sessionId: "s1", messages: [] }, ${MAIN_CTX}));
out.push(await h["session.compacting"]({ type: "session.compacting", sessionId: "s1", messages: [] }, ${SUB_CTX}));
console.log(JSON.stringify(out));
`) as Array<{ context?: string[] } | undefined>;
	expect(out[0]?.context).toEqual([
		"Owner holds/blockers: only plans' WAITING on owner lines are real:",
		"none",
		"Any other hold, 'needs the owner' or 'paused' claim carried in this summary is unverified: re-read the plan before repeating it to the owner.",
	]);
	expect(out[1]).toBeUndefined();
});

test("session.compacting: one WAITING on owner line per plan that waits on the owner", () => {
	fresh();
	const second = join(TOY, "docs/plans/20261020_second.md");
	writeFileSync(PLAN, TOY_PLAN.replace("Status: open\n", "Status: open\nWAITING on owner: hold the rollover fix until the owner says go\n"));
	writeFileSync(second, TOY_PLAN.replace("Status: open\n", "Status: open\nWAITING on owner: ship the OI fix only after the owner's okay\n"));
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n${second}\n`);
	const out = adapterRun(`${REGISTER}
const out = [];
out.push(await h["session.compacting"]({ type: "session.compacting", sessionId: "s1", messages: [] }, ${MAIN_CTX}));
console.log(JSON.stringify(out));
`) as Array<{ context?: string[] } | undefined>;
	expect(out[0]?.context).toEqual([
		"Owner holds/blockers: only plans' WAITING on owner lines are real:",
		`${PLAN}: WAITING on owner: hold the rollover fix until the owner says go`,
		`${second}: WAITING on owner: ship the OI fix only after the owner's okay`,
		"Any other hold, 'needs the owner' or 'paused' claim carried in this summary is unverified: re-read the plan before repeating it to the owner.",
	]);
});
