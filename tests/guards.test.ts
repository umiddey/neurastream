// Guard parity: for a toy plan in a sandbox HOME the ported guards refuse what the original
// extensions refuse (denied command, denied path, non-Progress plan edit, spawn outside the
// allow-list, 6th counted change in the window) plus the allowed counterparts. The originals run
// from /tmp/neurastream-originals under their own env overrides (tests-only, as they document);
// the port runs through `neurastream guard <event> --json`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { helpText } from "../src/cli/dispatch.ts";
import { CANCEL_TODO } from "../src/core/guards.ts";
import { touchedPaths } from "../src/core/queue/lib.ts";

const REPO = dirname(dirname(import.meta.path));
const ORIG = "/tmp/neurastream-originals";
const ORIG_EXT = join(ORIG, "extensions");
const ORIG_BLOCKERS = join(ORIG, "blockers");
const HOME = "/tmp/neurastream-home-guard";
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const PLAN = join(TOY, "docs/plans/20261019_toy.md");
const STATE = join(HOME, ".local/state/queue");
const SUBAGENTS = join(AGENT, "notes/subagents.md");
const UNLOCK = join(AGENT, ".guard-unlock");

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
	for (const d of [join(TOY, "docs/plans"), join(TOY, "src"), join(TOY, "secret"), join(AGENT, "blockers"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN, TOY_PLAN);
	writeFileSync(join(TOY, "INDEX.md"), "docs/plans/20261019_toy.md\n");
	writeFileSync(join(AGENT, "INDEX.md"), `${TOY}\n`);
	// Original allowedAgents only accepts "- `name`" lines (queue/lib.ts match on backticks).
	writeFileSync(SUBAGENTS, "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	for (const b of ["deny-command", "deny-path", "deny-text", "no-push"]) {
		// the wrapper's relative import must survive the copy: point it at the package (same
		// technique as the P4 goldens' rewrite())
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
  free_prefixes: ["${join(HOME, "Work/gf-testbed/")}", "${join(HOME, "Work/archive/")}", "${join(HOME, "Work/heavy-run.sh")}"]
`,
	);
	spawnSync("git", ["init", "-q"], { cwd: TOY });
}

// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
function envWithoutQueue(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
}

function envFor(): NodeJS.ProcessEnv {
	return {
		...envWithoutQueue(),
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

// The parity oracle is the frozen snapshot of the owner's extension and blocker
// scripts in tests/fixtures/originals/agent. Mirror it to /tmp/neurastream-originals
// (the tests never run the fixture in place) and always remove the mirror
// afterwards: the tests leave no /tmp/neurastream-* state behind.
function seedOriginals(): void {
	rmSync(ORIG, { recursive: true, force: true });
	mkdirSync(ORIG, { recursive: true });
	for (const name of ["extensions", "queue", "blockers"]) cpSync(join(REPO, "tests/fixtures/originals/agent", name), join(ORIG, name), { recursive: true });
}

beforeAll(seedOriginals);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(ORIG, { recursive: true, force: true });
});

function guardCli(event: string, payload: unknown): { code: number; d: Decision } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	if (!r.stdout.trim()) throw new Error(`guard ${event} printed nothing: ${r.stderr}`);
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) as Decision };
}

function origRun(body: string, blockers = ORIG_BLOCKERS): unknown {
	const lines = [
		`process.env.HOME = ${JSON.stringify(HOME)}`,
		`process.env.QUEUE_INDEX = ${JSON.stringify(join(AGENT, "INDEX.md"))}`,
		`process.env.QUEUE_BLOCKERS = ${JSON.stringify(blockers)}`,
		`process.env.QUEUE_STATE = ${JSON.stringify(STATE)}`,
		`process.env.QUEUE_SUBAGENTS = ${JSON.stringify(SUBAGENTS)}`,
		`process.env.QUEUE_CANCELLED = ${JSON.stringify(join(AGENT, "CANCELLED.md"))}`,
		`process.env.MAIN_GUARD_ROOTS = ${JSON.stringify(join(HOME, "projects"))}`,
		`process.env.MAIN_GUARD_LOG = ${JSON.stringify(join(HOME, "main-guard.log"))}`,
		`process.env.PLAN_GUARD_LOG = ${JSON.stringify(join(HOME, "plan-guard.log"))}`,
	];
	const script = `${lines.join("\n")}\n${body}\n`;
	// HOME goes through the child's environment: the originals build paths from os.homedir().
	const r = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: "/tmp", env: { ...process.env, HOME } });
	if (r.status !== 0) throw new Error(`original run failed: ${r.stderr}`);
	const out = r.stdout.trim().split("\n").pop() ?? "null";
	return JSON.parse(out);
}

// The originals only see this sandbox through the env lines inside origRun's child process (their
// paths are import-time constants), so each original scenario is a `bun -e` script that imports
// the extension at runtime — a genuinely runtime-selected module, not a hidden static dependency.

const MAIN_CTX = { agent: { kind: "main" }, cwd: TOY };

function toolEvent(tool: string, input: Record<string, unknown>, agent: "main" | "sub", calls = 0) {
	return { tool, input, cwd: TOY, agent, agentId: agent === "main" ? "main" : "w1", calls, paths: [], writes: [], command: String(input.command ?? "") };
}

test("help names the guard command", () => {
	expect(helpText()).toContain("guard <event>");
});

test("denied command: same refusal as the original blocker run, clean command allowed", () => {
	fresh();
	const bad = "bun test --grep thing test.skip";
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "plan-guard.ts"))});
const out = [];
out.push(mod.checkCall("bash", { command: ${JSON.stringify(bad)} }, ${JSON.stringify(TOY)}, "sub", 0, undefined));
out.push(mod.checkCall("bash", { command: "bun test --grep thing" }, ${JSON.stringify(TOY)}, "sub", 0, undefined));
console.log(JSON.stringify(out));
`) as [string, null];
	const refused = guardCli("pre-tool", toolEvent("bash", { command: bad }, "sub"));
	expect(refused.code).toBe(2);
	expect(refused.d.allow).toBe(false);
	expect(refused.d.reason).toBe(`plan-guard: ${orig[0]}`);
	expect(orig[0]).toContain("deny-command: command matches forbidden pattern /test\\.skip/");
	const allowed = guardCli("pre-tool", toolEvent("bash", { command: "bun test --grep thing" }, "sub"));
	expect(allowed.code).toBe(0);
	expect(allowed.d).toEqual({ allow: true, reason: "" });
});

test("denied path: same refusal as the original, other writes allowed", () => {
	fresh();
	const bad = join(TOY, "secret/x.md");
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "plan-guard.ts"))});
const out = [];
out.push(mod.checkCall("write", { path: ${JSON.stringify(bad)}, content: "x" }, ${JSON.stringify(TOY)}, "sub", 0, undefined));
out.push(mod.checkCall("write", { path: ${JSON.stringify(join(TOY, "src/ok.ts"))}, content: "x" }, ${JSON.stringify(TOY)}, "sub", 0, undefined));
console.log(JSON.stringify(out));
`) as [string, null];
	const refused = guardCli("pre-tool", toolEvent("write", { path: bad, content: "x" }, "sub"));
	expect(refused.code).toBe(2);
	expect(refused.d.reason).toBe(`plan-guard: ${orig[0]}`);
	expect(orig[0]).toContain("is forbidden by the plan (deny-path secret/**)");
	expect(guardCli("pre-tool", toolEvent("write", { path: join(TOY, "src/ok.ts"), content: "x" }, "sub")).code).toBe(0);
});

test("non-Progress plan edit: refused with the original restore text, Progress-only edit and Main allowed", () => {
	fresh();
	const before = TOY_PLAN;
	const statusFlip = before.replace("Status: open", "Status: complete");
	const goalHack = before.replace("- Guard parity toy for the ported guards.", "- Hijacked goal.");
	const orig = origRun(`
const fs = await import("node:fs");
const mod = await import(${JSON.stringify(join(ORIG_EXT, "plan-guard.ts"))});
fs.writeFileSync(${JSON.stringify(PLAN)}, ${JSON.stringify(statusFlip)});
const out = [];
out.push(mod.verifyPlanEdits(new Map([[${JSON.stringify(PLAN)}, ${JSON.stringify(before)}]])));
out.push(fs.readFileSync(${JSON.stringify(PLAN)}, "utf8") === ${JSON.stringify(before)});
console.log(JSON.stringify(out));
`) as [string, boolean];
	expect(orig[1]).toBe(true); // the original restored the file itself
	const refused = guardCli("plan-edit", { path: PLAN, before, after: statusFlip, agent: "sub" });
	expect(refused.code).toBe(2);
	expect(refused.d.reason).toBe(orig[0]);
	expect(refused.d.restore).toEqual({ path: PLAN, text: before });
	const hacked = guardCli("plan-edit", { path: PLAN, before, after: goalHack, agent: "sub" });
	expect(hacked.code).toBe(2);
	expect(hacked.d.restore?.text).toBe(before);
	const progressOnly = guardCli("plan-edit", { path: PLAN, before, after: before.replace("- Started the toy work.", "- Started the toy work.\n- Did the thing."), agent: "sub" });
	expect(progressOnly.code).toBe(0);
	expect(guardCli("plan-edit", { path: PLAN, before, after: statusFlip, agent: "main" }).code).toBe(0);
});

// P2: Main may author plan text only when a "## Code read by Main" section lists read files.
function cite(p: string): string {
	return "- `" + p + ":1`";
}
function mainBody(section: string | null, extra = ""): string {
	const head = section === null ? "" : "## Code read by Main\n" + section + "\n\n";
	return TOY_PLAN.replace("## Progress", "## Background\n- Reads show X." + extra + "\n\n" + head + "## Progress");
}
function readLog(entries: Record<string, string>): void {
	writeFileSync(join(STATE, "main-reads.json"), JSON.stringify(entries));
}

test("Main plan text without a Code read by Main section is refused and restored", () => {
	fresh();
	const d = guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after: mainBody(null), agent: "main" });
	expect(d.code).toBe(2);
	expect(d.d.reason).toContain("## Code read by Main");
	expect(d.d.restore).toEqual({ path: PLAN, text: TOY_PLAN });
});

test("Main cannot rewrite a plan through the shell (that route skips the plan-text checks); edit/write still go through", () => {
	fresh();
	for (const command of [`cat > ${PLAN} <<'EOF'\nrewritten\nEOF`, `echo rewritten > ${PLAN}`, `sed -i s/open/complete/ ${PLAN}`]) {
		const d = guardCli("pre-tool", toolEvent("bash", { command }, "main"));
		expect(d.code).toBe(2);
		expect(d.d.reason).toContain("is a plan file");
	}
	expect(guardCli("pre-tool", toolEvent("bash", { command: `cat ${PLAN}` }, "main")).code).toBe(0);
	expect(guardCli("pre-tool", toolEvent("write", { path: PLAN, content: "x" }, "main")).code).toBe(0);
	const archived = join(TOY, "docs/plans/archive/202610/old.md");
	expect(guardCli("pre-tool", toolEvent("bash", { command: `echo x > ${archived}` }, "main")).code).toBe(0);
});

test("a new plan file written by Main without the section is deleted on refusal", () => {
	fresh();
	const d = guardCli("plan-edit", { path: PLAN, before: null, after: mainBody(null), agent: "main" });
	expect(d.code).toBe(2);
	expect(d.d.restore).toEqual({ path: PLAN, text: null });
});

test("a listed path missing from the read log is refused, and the refusal names it", () => {
	fresh();
	const src = join(TOY, "src/read.ts");
	writeFileSync(src, "export const a = 1;\n");
	readLog({});
	const d = guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after: mainBody(cite(src)), agent: "main" });
	expect(d.code).toBe(2);
	expect(d.d.reason).toContain(src);
});

test("a read older than plan_read_max_hours (24 h) does not count", () => {
	fresh();
	const src = join(TOY, "src/read.ts");
	writeFileSync(src, "export const a = 1;\n");
	readLog({ [src]: new Date(Date.now() - 48 * 3600_000).toISOString() });
	const d = guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after: mainBody(cite(src)), agent: "main" });
	expect(d.code).toBe(2);
	expect(d.d.reason).toContain(src);
});

test("a cited path outside docs/plans that the section does not list is refused", () => {
	fresh();
	const src = join(TOY, "src/read.ts");
	const extra = join(TOY, "src/extra.ts");
	writeFileSync(src, "export const a = 1;\n");
	writeFileSync(extra, "export const b = 2;\n");
	readLog({ [src]: new Date().toISOString() });
	const d = guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after: mainBody(cite(src), " See " + extra + ":2."), agent: "main" });
	expect(d.code).toBe(2);
	expect(d.d.reason).toContain(extra);
});

test("Main plan text is allowed once every listed path was read in time", () => {
	fresh();
	const src = join(TOY, "src/read.ts");
	writeFileSync(src, "export const a = 1;\n");
	readLog({ [src]: new Date().toISOString() });
	expect(guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after: mainBody(cite(src)), agent: "main" }).code).toBe(0);
});

test("a Main Progress-only edit needs no Code read by Main section", () => {
	fresh();
	const after = TOY_PLAN.replace("- Started the toy work.", "- Started the toy work.\n- Main note.");
	expect(guardCli("plan-edit", { path: PLAN, before: TOY_PLAN, after, agent: "main" }).code).toBe(0);
});

test("spawn gates: same refusals as the original task-tool gate; a valid spawn records and then demands new progress", () => {
	fresh();
	const brief = `Work ${PLAN} P1 now.`;
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "main-guard.ts"))});
const h = {};
mod.default({ on: (ev, cb) => { h[ev] = cb; } });
const out = [];
out.push(await h["tool_call"]({ toolName: "task", input: { tasks: [{ agent: "ghost", name: "ghost", task: ${JSON.stringify(PLAN)} }] } }, ${JSON.stringify(MAIN_CTX)}));
out.push(await h["tool_call"]({ toolName: "task", input: { tasks: [{ agent: "toy-worker", task: ${JSON.stringify(PLAN)} }] } }, ${JSON.stringify(MAIN_CTX)}));
out.push(await h["tool_call"]({ toolName: "task", input: { tasks: [{ agent: "toy-worker", task: ${JSON.stringify(PLAN)} }] } }, ${JSON.stringify(MAIN_CTX)}));
console.log(JSON.stringify(out));
`) as unknown[];
	const ghostOrig = (orig[0] as { reason: string }).reason; // original refusal object
	const againOrig = (orig[2] as { reason: string }).reason;
	fresh();
	const ghost = guardCli("spawn", { agent: "ghost", invocationKind: "task", brief });
	expect(ghost.code).toBe(2);
	expect(ghost.d.reason).toBe(ghostOrig);
	const first = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief });
	expect(first.code).toBe(0);
	expect(readFileSync(join(STATE, "spawns.json"), "utf8")).toContain("20261019_toy.md");
	const second = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief });
	expect(second.code).toBe(2);
	expect(second.d.reason).toBe(againOrig);
	expect(againOrig).toContain('no new "## Progress" entry');
	writeFileSync(PLAN, TOY_PLAN.replace("- Started the toy work.", "- Started the toy work.\n- Ran once."));
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief }).code).toBe(0);
	writeFileSync(PLAN, TOY_PLAN.replace("Status: open\n", "Status: open\nWAITING on owner: feedback\n"));
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief }).d.reason).toContain('parked "WAITING on owner"');
});

// P4: a brief names an unticked phase of the plan it runs on, and never asks for research for a plan.
test("spawn brief must name an unticked phase of the plan", () => {
	fresh();
	writeFileSync(PLAN, TOY_PLAN.replace("- [ ] P1 do the thing — verify: \`test -f src/a.ts\`", "- [x] P1 do the thing — verify: \`test -f src/a.ts\`\n- [ ] P2 do the next thing — verify: \`test -f src/a.ts\`"));
	const onlyTicked = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P1 now.` });
	expect(onlyTicked.code).toBe(2);
	expect(onlyTicked.d.reason).toContain("must name an unticked phase");
	expect(onlyTicked.d.reason).toContain("P2");
	const noPhase = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} now.` });
	expect(noPhase.code).toBe(2);
	expect(noPhase.d.reason).toContain("must name an unticked phase");
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P2 now.` }).code).toBe(0);
});

test("spawn brief that asks for research for a plan to be written is refused, quoting the owner rule", () => {
	fresh();
	for (const ask of ["Research the code under src/", "Investigate src/a.ts", "Find where src/a.ts is used", "Map the code under src/", "Read the code for src/a.ts"]) {
		const d = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `${ask} so Main can write the plan. ${PLAN} P1.` });
		expect(d.code).toBe(2);
		expect(d.d.reason).toContain("never ever ever write a plan when another agent is doing the research or reading for you");
	}
	// the same words without the plan are not a plan-research ask
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Investigate src/a.ts, then do ${PLAN} P1.` }).code).toBe(0);
});

test("6th counted change in the window: same block as the original; .md writes stay free; an owner message resets", () => {
	fresh();
	const aTs = join(TOY, "src/a.ts");
	const noteMd = join(TOY, "docs/note.md");
	const origScript = `
const mod = await import(${JSON.stringify(join(ORIG_EXT, "main-guard.ts"))});
const h = {};
mod.default({ on: (ev, cb) => { h[ev] = cb; } });
const ctx = ${JSON.stringify(MAIN_CTX)};
const w = (p, c) => ({ toolName: "write", input: { path: p, content: c } });
const out = [];
for (let i = 0; i < 6; i++) out.push(await h["tool_call"](w(${JSON.stringify(aTs)}, "v" + i), ctx));
out.push(await h["tool_call"](w(${JSON.stringify(noteMd)}, "x"), ctx));
await h["before_agent_start"]({ prompt: "continue" }, ctx);
out.push(await h["tool_call"](w(${JSON.stringify(aTs)}, "after reset"), ctx));
console.log(JSON.stringify(out));
`;
	const orig = origRun(origScript) as unknown[];
	fresh();
	const writeMain = (path: string, content: string) =>
		guardCli("pre-tool", toolEvent("write", { path, content }, "main"));
	const results = Array.from({ length: 6 }, (_, i) => writeMain(aTs, `v${i}`));
	expect(results.slice(0, 5).map(r => r.code)).toEqual([0, 0, 0, 0, 0]);
	const warnOf = (x: unknown) => (x as { additionalContext?: string }).additionalContext;
	expect(results[2]!.d.inject).toBe(warnOf(orig[2]));
	expect(results[4]!.d.inject).toBe(warnOf(orig[4]));
	expect(results[5]!.code).toBe(2);
	expect(results[5]!.d.reason).toBe((orig[5] as { reason: string }).reason);
	expect(results[5]!.d.reason).toContain("Main already changed project files 5 times in this 15-minute window");
	expect(writeMain(noteMd, "x").code).toBe(0); // .md never counts
	expect(guardCli("inject", { prompt: "continue", agent: "main" }).code).toBe(0);
	expect(writeMain(aTs, "after reset").code).toBe(0); // owner message reset the window
	expect(orig[6]).toBeNull();
	expect(orig[7]).toBeNull();
});

test("call budget: warn at 90, refusal at 100 unless reading or editing the plan", () => {
	fresh();
	const ev = (tool: string, input: Record<string, unknown>, calls: number) => guardCli("pre-tool", toolEvent(tool, input, "sub", calls));
	const warn = ev("read", { path: join(TOY, "src/a.ts") }, 89);
	expect(warn.code).toBe(0);
	expect(warn.d.inject).toBe(`plan-guard: call 90/100. Update your plan's "## Progress" now (done, verified, next); at 100 only that edit is allowed.`);
	expect(ev("read", { path: join(TOY, "src/a.ts") }, 99).d.inject).toBeUndefined();
	const spent = ev("read", { path: join(TOY, "src/a.ts") }, 100);
	expect(spent.code).toBe(2);
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "plan-guard.ts"))});
console.log(JSON.stringify(mod.checkCall("read", { path: ${JSON.stringify(join(TOY, "src/a.ts"))} }, ${JSON.stringify(TOY)}, "sub", 100, undefined)));
`) as string;
	expect(spent.d.reason).toBe(`plan-guard: ${orig}`);
	expect(ev("read", { path: PLAN }, 100).code).toBe(0);
	expect(ev("edit", { input: `[${PLAN}#abe4]\n+more progress` }, 100).code).toBe(0);
});

test("protected guard files: refused until the owner unlocks; subs never close or cancel", () => {
	fresh();
	const target = join(AGENT, "AGENTS.md");
	const refused = guardCli("pre-tool", toolEvent("write", { path: target, content: "x" }, "sub"));
	expect(refused.code).toBe(2);
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "plan-guard.ts"))});
console.log(JSON.stringify(mod.checkCall("write", { path: ${JSON.stringify(target)}, content: "x" }, ${JSON.stringify(TOY)}, "sub", 0, undefined)));
`) as string;
	expect(refused.d.reason).toBe(`plan-guard: ${orig}`);
	expect(orig).toContain("is a protected guard file");
	writeFileSync(UNLOCK, new Date().toISOString()); // owner touched the unlock file
	expect(guardCli("pre-tool", toolEvent("write", { path: target, content: "x" }, "sub")).code).toBe(0);
	const closer = guardCli("pre-tool", toolEvent("bash", { command: "bun run queue-close docs/plans/x.md" }, "sub"));
	expect(closer.code).toBe(2);
	expect(closer.d.reason).toBe(`plan-guard: queue-close and queue-cancel are Main's; report in your plan's "## Progress" instead.`);
});

// An in-process adapter in an earlier test file (createOmpAdapter -> applyQueueEnv) leaves
// QUEUE_* in this process's env; bun's file order differs per machine, so CI saw it here.
test("protected guard files: a QUEUE_* env leaked by an earlier in-process adapter does not unprotect them", () => {
	fresh();
	const leaked = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
	process.env.QUEUE_AGENT = "/nonexistent/neurastream-leaked-agent";
	process.env.QUEUE_UNLOCK = "/nonexistent/neurastream-leaked-agent/.guard-unlock";
	try {
		const refused = guardCli("pre-tool", toolEvent("write", { path: join(AGENT, "AGENTS.md"), content: "x" }, "sub"));
		expect(refused.code).toBe(2);
		expect(refused.d.reason).toContain("is a protected guard file");
	} finally {
		for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
		Object.assign(process.env, leaked);
	}
});

test("bypass launch: same plan gate as the original", () => {
	fresh();
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "main-guard.ts"))});
const h = {};
mod.default({ on: (ev, cb) => { h[ev] = cb; } });
console.log(JSON.stringify([await h["tool_call"]({ toolName: "bash", input: { command: "opencode run fix things" } }, ${JSON.stringify(MAIN_CTX)})]));
`) as unknown[];
	const refused = guardCli("pre-tool", toolEvent("bash", { command: "opencode run fix things" }, "main"));
	expect(refused.code).toBe(2);
	expect(refused.d.reason).toBe((orig[0] as { reason: string }).reason);
	expect(refused.d.reason).toContain("an implementer needs an open plan");
});

test("cancel flag: owner wording blocks spawns until recorded", () => {
	fresh();
	const orig = origRun(`
const mod = await import(${JSON.stringify(join(ORIG_EXT, "main-guard.ts"))});
console.log(JSON.stringify(mod.flagCancel("please cancel that plan")));
`) as string;
	fresh();
	const injected = guardCli("inject", { prompt: "please cancel that plan", agent: "main" });
	expect(injected.code).toBe(0);
	expect(injected.d.inject?.endsWith(orig)).toBe(true);
	expect(orig).toContain('Flagged: "please cancel that plan"');
	const spawn = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN}.` });
	expect(spawn.code).toBe(2);
	expect(spawn.d.reason).toBe(`main-guard: ${CANCEL_TODO} Flagged: "please cancel that plan"`);
});

test("inject: the guard's own stop continuation keeps the idle streak (no endless re-prompt)", () => {
	fresh();
	const owner = guardCli("inject", { prompt: "continue", agent: "main" });
	expect(owner.d.state).toEqual({ callsSinceStop: 0, idleStops: 0 });
	const nudge = guardCli("inject", { prompt: "main-guard: the queue has 3 open items and no subagent is running to wake you.", agent: "main" });
	expect(nudge.code).toBe(0);
	expect(nudge.d.inject).toContain("main-guard: read");
	expect(nudge.d.state).toBeUndefined();
});

test("stop: keep working while the queue is open; live sub or idle stops allow; sub stop always allowed", () => {
	fresh();
	const stop = (p: Record<string, unknown>) => guardCli("stop", p);
	expect(stop({ agent: "sub", callsSinceStop: 0, idleStops: 0, ledgerText: "" }).code).toBe(0);
	const live = stop({ agent: "main", callsSinceStop: 5, idleStops: 0, ledgerText: "MAIN x RUNNING\nSUB w1 RUNNING zai/glm 3m idle 0 $0.01\n" });
	expect(live.code).toBe(0);
	// a stop with zero tool calls since the last one counts toward the idle streak
	const idleStop = stop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "" });
	expect(idleStop.code).toBe(2);
	expect(idleStop.d.reason).toContain("keep working while the queue has items");
	expect(idleStop.d.state).toEqual({ callsSinceStop: 0, idleStops: 1 });
	// tool calls between stops reset the streak (original rule)
	const reset = stop({ agent: "main", callsSinceStop: 5, idleStops: 2, ledgerText: "" });
	expect(reset.code).toBe(2);
	expect(reset.d.state).toEqual({ callsSinceStop: 0, idleStops: 0 });
	expect(stop({ agent: "main", callsSinceStop: 0, idleStops: 3, ledgerText: "" }).code).toBe(0);
	writeFileSync(join(AGENT, "INDEX.md"), "");
	expect(stop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }).code).toBe(0);
});

test("guard CLI surface: unknown event and bad JSON exit 2", () => {
	fresh();
	const bad = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", "nope", "--json"], { input: "{}", encoding: "utf8", env: envFor() });
	expect(bad.status).toBe(2);
	expect(bad.stderr).toContain("unknown guard event");
	const notJson = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", "pre-tool", "--json"], { input: "nope", encoding: "utf8", env: envFor() });
	expect(notJson.status).toBe(2);
});

test("touchedPaths resolves each shell word against the cd in effect at that point", () => {
	const paths = touchedPaths("bash", { command: "cd /repo && sed -n 1,5p src/x.ts" }, "/elsewhere");
	expect(paths).toContain("/repo/src/x.ts");
	expect(paths).not.toContain("/elsewhere/src/x.ts");
});

test("main reads: an allowed call logs its existing files; entries older than 7 days are dropped", () => {
	fresh();
	const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
	writeFileSync(join(STATE, "main-reads.json"), JSON.stringify({ [join(TOY, "src/old.ts")]: old }));
	expect(guardCli("pre-tool", toolEvent("bash", { command: `cd ${TOY} && sed -n 1,5p src/a.ts` }, "main")).code).toBe(0);
	const reads = JSON.parse(readFileSync(join(STATE, "main-reads.json"), "utf8")) as Record<string, string>;
	expect(Object.keys(reads)).toEqual([join(TOY, "src/a.ts")]);
	expect(Number.isNaN(Date.parse(reads[join(TOY, "src/a.ts")] ?? ""))).toBe(false);
});

