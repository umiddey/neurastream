// Guard parity: for a toy plan in a sandbox HOME the ported guards refuse what the original
// extensions refuse (denied command, denied path, non-Progress plan edit, spawn outside the
// allow-list, 6th counted change in the window) plus the allowed counterparts. The originals run
// from /tmp/neurastream-originals under their own env overrides (tests-only, as they document);
// the port runs through `neurastream guard <event> --json`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { helpText } from "../src/cli/dispatch.ts";
import type { ToolEvent } from "../src/core/adapter.ts";
import { CANCEL_TODO, MAIN_PLAN_FILE, planGate, reviewHash } from "../src/core/guards.ts";
import { autoClose } from "../src/adapters/omp/index.ts";
import { lastCloseResult, touchedPaths } from "../src/core/queue/lib.ts";
import { loadConfig } from "../src/core/config.ts";
import { recordPagePlan } from "../src/core/plan-approval.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

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
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
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
review:
  agents: []
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

function waitFor(see: () => boolean, ms: number): boolean {
	const end = Date.now() + ms;
	while (!see() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
	return see();
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

function toolEvent(tool: string, input: Record<string, unknown>, agent: "main" | "sub", calls = 0) {
	return { tool, input, cwd: TOY, agent, agentId: agent === "main" ? "main" : "w1", calls, paths: [], writes: [], command: String(input.command ?? "") };
}

test("help names the guard command", () => {
	expect(helpText()).toContain("guard <event>");
});

test("denied command: a mutating bash matching a deny-command blocker is refused; read-only shell is allowed (P5c)", () => {
	fresh();
	// P5c: a read-only shell call skips the blockers, so the pattern match alone no longer refuses it.
	const allowed = guardCli("pre-tool", toolEvent("bash", { command: "bun test --grep thing test.skip" }, "sub"));
	expect(allowed.code).toBe(0);
	expect(allowed.d).toEqual({ allow: true, reason: "" });
	// A mutating command still meets the blocker, and the refusal names the pattern.
	const refused = guardCli("pre-tool", toolEvent("bash", { command: "touch test.skip" }, "sub"));
	expect(refused.code).toBe(2);
	expect(refused.d.allow).toBe(false);
	expect(refused.d.reason).toContain("deny-command: command matches forbidden pattern /test\\.skip/");
});

test("denied path: a write under a deny-path glob is refused; other writes allowed", () => {
	fresh();
	const bad = join(TOY, "secret/x.md");
	const refused = guardCli("pre-tool", toolEvent("write", { path: bad, content: "x" }, "sub"));
	expect(refused.code).toBe(2);
	expect(refused.d.allow).toBe(false);
	expect(refused.d.reason).toContain(`${bad} is forbidden by the plan (deny-path secret/**)`);
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
	expect(refused.d.reason).toBe(orig[0].replace('"WAITING on owner:", "Cancelled by owner:"', '"WAITING on owner:", "Waits on:", "Cancelled by owner:"'));
	expect(refused.d.restore).toEqual({ path: PLAN, text: before });
	const hacked = guardCli("plan-edit", { path: PLAN, before, after: goalHack, agent: "sub" });
	expect(hacked.code).toBe(2);
	expect(hacked.d.restore?.text).toBe(before);
	// Since 2026-10-24 a new Progress entry must carry a Findings line (a port-only rule; the
	// original has no such check): the plain entry is refused, the dated one passes.
	const plainEntry = guardCli("plan-edit", { path: PLAN, before, after: before.replace("- Started the toy work.", "- Started the toy work.\n- Did the thing."), agent: "sub" });
	expect(plainEntry.code).toBe(2);
	expect(plainEntry.d.restore).toEqual({ path: PLAN, text: before });
	const progressOnly = guardCli("plan-edit", { path: PLAN, before, after: before.replace("- Started the toy work.", "- Started the toy work.\n- Did the thing. Findings: none."), agent: "sub" });
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

test("spawn gates: an unknown subagent is refused; a valid spawn records and then demands new progress", () => {
	fresh();
	const brief = `Work ${PLAN} P1 now.`;
	const ghost = guardCli("spawn", { agent: "ghost", invocationKind: "task", brief });
	expect(ghost.code).toBe(2);
	expect(ghost.d.allow).toBe(false);
	expect(ghost.d.reason).toContain("ghost");
	const first = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief });
	expect(first.code).toBe(0);
	expect(readFileSync(join(STATE, "spawns.json"), "utf8")).toContain("20261019_toy.md");
	const second = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief });
	expect(second.code).toBe(2);
	expect(second.d.reason).toContain('no new "## Progress" entry');
	writeFileSync(PLAN, TOY_PLAN.replace("- Started the toy work.", "- Started the toy work.\n- Ran once."));
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief }).code).toBe(0);
	writeFileSync(PLAN, TOY_PLAN.replace("Status: open\n", "Status: open\nWAITING on owner: feedback\n"));
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief }).d.reason).toContain('parked "WAITING on owner"');
});

// P4: a brief names an unticked phase of the plan it runs on, and never asks for research for a plan.
test("spawn brief must name an unticked phase of the plan", () => {
	fresh();
	writeFileSync(PLAN, TOY_PLAN.replace("- [ ] P1 do the thing — verify: `test -f src/a.ts`", "- [x] P1 do the thing — verify: `test -f src/a.ts`\n- [ ] P2 do the next thing — verify: `test -f src/a.ts`"));
	const onlyTicked = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P1 now.` });
	expect(onlyTicked.code).toBe(2);
	expect(onlyTicked.d.reason).toContain("must name an unticked phase");
	expect(onlyTicked.d.reason).toContain("P2");
	const noPhase = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} now.` });
	expect(noPhase.code).toBe(2);
	expect(noPhase.d.reason).toContain("must name an unticked phase");
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P2 now.` }).code).toBe(0);
});

test("spawn brief may name a lettered sub-phase (P4a) of the plan", () => {
	fresh();
	writeFileSync(PLAN, TOY_PLAN.replace("- [ ] P1 do the thing — verify: `test -f src/a.ts`", "- [x] P1 do the thing — verify: `test -f src/a.ts`\n- [ ] P2a do the next thing — verify: `test -f src/a.ts`\n- [ ] P2b then this — verify: `test -f src/a.ts`"));
	const onlyTicked = guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P1 now.` });
	expect(onlyTicked.code).toBe(2);
	expect(onlyTicked.d.reason).toContain("P2a, P2b");
	expect(guardCli("spawn", { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} P2a now.` }).code).toBe(0);
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

test("6th counted change in the window is blocked; .md writes stay free; an owner message resets", () => {
	fresh();
	const aTs = join(TOY, "src/a.ts");
	const noteMd = join(TOY, "docs/note.md");
	const writeMain = (path: string, content: string) =>
		guardCli("pre-tool", toolEvent("write", { path, content }, "main"));
	const results = Array.from({ length: 6 }, (_, i) => writeMain(aTs, `v${i}`));
	expect(results.slice(0, 5).map(r => r.code)).toEqual([0, 0, 0, 0, 0]);
	expect(results[2]!.d.inject).toContain("2 project-file change(s) left in this 15-minute window");
	expect(results[4]!.d.inject).toContain("0 project-file change(s) left in this 15-minute window");
	expect(results[5]!.code).toBe(2);
	expect(results[5]!.d.allow).toBe(false);
	expect(results[5]!.d.reason).toContain("Main already changed project files 5 times in this 15-minute window");
	expect(results[5]!.d.reason).toContain(join(AGENT, "INDEX.md"));
	expect(writeMain(noteMd, "x").code).toBe(0); // .md never counts
	expect(guardCli("inject", { prompt: "continue", agent: "main" }).code).toBe(0);
	expect(writeMain(aTs, "after reset").code).toBe(0); // owner message reset the window
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

// I-20261027-158/160: an agent copied the read tool's stand-in for a hidden value into
// templates/config.yml and the shipped template stopped loading. The text is built here rather
// than written out, so this test file itself stays writable under the rule it tests.
test("redaction placeholder: copying the read tool's stand-in into a file is refused; its producer and tests may hold one", () => {
	fresh();
	const mark = "[" + "REDACTED:" + "known-value]";
	const shipped = join(TOY, "templates/config.yml");
	const refusal = "plan-guard: this is the read tool's redaction placeholder, not the real value; re-read the file raw or keep the original line";
	const edit = guardCli("pre-tool", toolEvent("edit", { path: shipped, old_string: "a: 1", new_string: `a: ${mark}` }, "sub"));
	expect(edit.code).toBe(2);
	expect(edit.d.allow).toBe(false);
	expect(edit.d.reason).toBe(refusal);
	for (const call of [
		toolEvent("write", { path: shipped, content: `a: ${mark}\n` }, "sub"),
		toolEvent("ast_edit", { path: shipped, instructions: `set a to ${mark}` }, "sub"),
	]) {
		expect(guardCli("pre-tool", call).d.reason).toBe(refusal);
	}
	// Removing one (the replaced text only) is the fix, not a copy.
	expect(guardCli("pre-tool", toolEvent("edit", { path: shipped, old_string: mark, new_string: "a: 1" }, "sub")).code).toBe(0);
	expect(guardCli("pre-tool", toolEvent("edit", { path: join(TOY, "src/core/secret-redact.ts"), old_string: "x", new_string: mark }, "sub")).code).toBe(0);
	expect(guardCli("pre-tool", toolEvent("write", { path: join(TOY, "tests/secret-redact-proxy.test.ts"), content: mark }, "sub")).code).toBe(0);
	expect(guardCli("pre-tool", toolEvent("write", { path: join(TOY, "tests/guards.test.ts"), content: mark }, "sub")).code).toBe(2);
});

test("subagent shell: a commit that names a queue-close path is allowed; a shell that runs the tool is refused", () => {
	fresh();
	expect(guardCli("pre-tool", toolEvent("bash", { command: "git commit -m x -- src/core/queue-close.ts" }, "sub")).code).toBe(0);
	for (const command of ["queue-close plan.md", 'queue-cancel p "a b c"', "cd r && neurastream queue-close p", "bun run queue-cancel p", 'bash -c "queue-close p"', "sh -c 'cd r; ~/.local/bin/queue-cancel p'", "x=$(queue-close p)", "echo `queue-cancel p`"]) {
		expect(guardCli("pre-tool", toolEvent("bash", { command }, "sub")).code).toBe(2);
	}
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

// The rollover note turn runs with nobody typing, so Main itself writes <state>/rollover/<id>.md.
// Only those notes (directly in that folder, .md) are open to Main; relaunch.json, other state
// files and subagents stay protected.
test("rollover notes: Main may write <state>/rollover/<id>.md, the rest of the state dir stays protected", () => {
	fresh();
	const note = join(STATE, "rollover", "sess-1.md");
	expect(guardCli("pre-tool", toolEvent("write", { path: note, content: "x" }, "main")).code).toBe(0);
	const relaunch = guardCli("pre-tool", toolEvent("write", { path: join(STATE, "rollover", "relaunch.json"), content: "{}" }, "main"));
	expect(relaunch.code).toBe(2);
	expect(relaunch.d.reason).toContain("is a protected guard file");
	const other = guardCli("pre-tool", toolEvent("write", { path: join(STATE, "other.md"), content: "x" }, "main"));
	expect(other.code).toBe(2);
	expect(other.d.reason).toContain("is a protected guard file");
	const nested = guardCli("pre-tool", toolEvent("write", { path: join(STATE, "rollover", "sub", "x.md"), content: "x" }, "main"));
	expect(nested.code).toBe(2);
	expect(nested.d.reason).toContain("is a protected guard file");
	const sub = guardCli("pre-tool", toolEvent("write", { path: note, content: "x" }, "sub"));
	expect(sub.code).toBe(2);
	expect(sub.d.reason).toContain("is a protected guard file");
});

test("bypass launch: a main bash that skips the queue is refused with the plan gate", () => {
	fresh();
	const refused = guardCli("pre-tool", toolEvent("bash", { command: "opencode run fix things" }, "main"));
	expect(refused.code).toBe(2);
	expect(refused.d.allow).toBe(false);
	expect(refused.d.reason).toContain("an implementer needs an open plan");
	expect(refused.d.reason).toContain(join(AGENT, "INDEX.md"));
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

// 20261031_2320 P2: the landed lock had no idle-stop valve — 0.2.60 froze Main's chat input on
// plans whose auto-close kept failing. Like the incident block above it, empty stops now count
// toward cfg.guards.idle_stops; a stop with tool calls in between resets the count and re-locks.
test("stop valve: the landed lock lets Main out after idle_stops empty stops; a stop with calls resets it", () => {
	fresh();
	const cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	// Branchless, every phase ticked, done check fails: the auto-close records a failed close, so
	// the landed lock (not the open-queue valve) is what holds the stop.
	writeFileSync(PLAN, [
		"# Stuck valve",
		"",
		"## Goal",
		"- hold the stop until the landed-lock valve opens.",
		"",
		"## Forbidden",
		"- never skip tests.",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		"- [x] P1 do the thing — verify: `true`",
		"",
		"## Done check",
		"`exit 1`",
		"",
		"## Progress",
		"Status: open",
		"- landed; the auto-close keeps failing on the done check.",
		"",
	].join("\n"));
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
	const stub = join(HOME, "close-stub");
	writeFileSync(stub, `#!/bin/sh\nexec bun ${join(REPO, "bin", "queue-close")} "$@"\n`);
	chmodSync(stub, 0o755);
	const closeBin = process.env.QUEUE_CLOSE_BIN;
	process.env.QUEUE_CLOSE_BIN = stub;
	try {
		autoClose(cfg);
		expect(waitFor(() => lastCloseResult(PLAN) !== null, 20_000)).toBe(true);
		const stop = (calls: number, idle: number) => guardCli("stop", { agent: "main", callsSinceStop: calls, idleStops: idle, ledgerText: "" });
		const first = stop(0, 0);
		expect(first.code).toBe(2);
		expect(first.d.reason).toContain("landed but its auto-close failed");
		expect(first.d.state).toEqual({ callsSinceStop: 0, idleStops: 1 });
		expect(first.d.reason).toContain("2 idle stop attempts left");
		const second = stop(0, 1);
		expect(second.code).toBe(2);
		expect(second.d.reason).toContain("1 idle stop attempt left");
		const third = stop(0, 2);
		expect(third.code).toBe(0);
		// a stop with tool calls in between resets the streak and blocks again
		const busy = stop(5, 0);
		expect(busy.code).toBe(2);
		expect(busy.d.reason).toContain("3 idle stop attempts left");
		expect(busy.d.state).toEqual({ callsSinceStop: 0, idleStops: 0 });
	} finally {
		if (closeBin === undefined) delete process.env.QUEUE_CLOSE_BIN;
		else process.env.QUEUE_CLOSE_BIN = closeBin;
	}
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

describe("foreign deny-path (20261028_1228 P6, I-20261028-111)", () => {
	// The incident's shape: the plan covers the repo (its base path is in call.paths), but the
	// command also names a path outside it that matches the plan's deny-path glob. The adapter
	// sends agent "sub" and the task name as agentId, which is what staffing.json holds.
	const STAGED = join(HOME, ".local/bin/staged-heavy-run");
	const CMD = `ln -s ${join(TOY, "node_modules")} node_modules && cp ${join(TOY, "src/a.ts")} ${STAGED}`;
	const PLAN_WITH_BIN = TOY_PLAN.replace("- deny-path secret/**", `- deny-path secret/** ${join(HOME, ".local/bin")}/**`);

	function sub(): ToolEvent {
		return { tool: "bash", input: { command: CMD }, cwd: TOY, agent: "sub", agentId: "toy-worker", calls: 0, paths: [], writes: [], command: CMD };
	}

	test("an agent staffed on another plan may run a command whose other targets this plan does not cover", () => {
		fresh();
		writeFileSync(PLAN, PLAN_WITH_BIN);
		writeFileSync(join(STATE, "staffing.json"), JSON.stringify({ [join(TOY, "docs/plans/20261019_other.md")]: ["toy-worker"] }));
		expect(guardCli("pre-tool", sub()).code).toBe(0);
	});

	test("the plan's own agent is still refused by the same command", () => {
		fresh();
		writeFileSync(PLAN, PLAN_WITH_BIN);
		writeFileSync(join(STATE, "staffing.json"), JSON.stringify({ [PLAN]: ["toy-worker"] }));
		const d = guardCli("pre-tool", sub());
		expect(d.code).toBe(2);
		expect(d.d.reason).toContain(`deny-path ${join(HOME, ".local/bin")}/**`);
	});
});

// P1 (plan 20261029_1530): which files count as live plans — plans kept one level under
// docs/plans/ (immediate/) match at any depth; docs/plans/archive/ never does.
test("MAIN_PLAN_FILE matches plans under docs/plans subdirs but never archive", () => {
	expect(MAIN_PLAN_FILE.test("/r/docs/plans/20261029_1200_x.md")).toBe(true);
	expect(MAIN_PLAN_FILE.test("/r/docs/plans/immediate/20261029_1200_x.md")).toBe(true);
	expect(MAIN_PLAN_FILE.test("/r/docs/plans/immediate/deeper/20261029_1200_x.md")).toBe(true);
	expect(MAIN_PLAN_FILE.test("/r/docs/plans/archive/202610/20261029_1200_x.md")).toBe(false);
	expect(MAIN_PLAN_FILE.test("/r/docs/plans/archive/20261029_1200_x.md")).toBe(false);
});

// --- Hard approval gate (plan 20261029_1455 P3): approval.since sets which plans need a page and a record ---
describe("plan approval hard gate (planGate, 20261029_1455 P3)", () => {
	const home = mkdtempSync(join(tmpdir(), "guards-approval-"));
	const plan = join(home, "projects/toy/docs/plans/20261030_0900_late.md");
	const index = join(home, "INDEX.md");
	const state = join(home, "state");
	const pages = join(home, "pages");
	const blockers = join(home, "blockers");
	const cancelled = join(home, "CANCELLED.md");
	const saved = { ...process.env };
	const body = "# Toy plan\n\nWorktree: -\nBranch: feat/toy\n\n## Goal\n- Toy.\n\n## Forbidden\n- Never skip tests.\n\n## Blockers\n- toy-blocker\n\n## Code read by Main\n- src/a.ts\n\n## Phases\n- [ ] P1 do the thing — verify: `test -f src/a.ts`\n\n## Done check\n`test -f src/a.ts`\n\n## Progress\nStatus: open\n\n- Started.\n";

	beforeAll(() => {
		for (const d of [dirname(plan), state, pages, blockers]) mkdirSync(d, { recursive: true });
		writeFileSync(plan, body);
		writeFileSync(index, `${plan}\n`);
		writeFileSync(cancelled, "");
		writeFileSync(join(blockers, "toy-blocker"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(blockers, "toy-blocker"), 0o755);
	});
	afterAll(() => {
		rmSync(home, { recursive: true, force: true });
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	});
	// planGate under a sandbox config: the one indexed plan, a page dir inside the sandbox.
	const gate = (since: string): [string | null, string[]] => {
		const cfg = loadConfig({ file: join(home, "missing.yml"), home, env: {} });
		cfg.review.agents = [];
		cfg.paths.queue_index = index;
		cfg.paths.queue_state = state;
		cfg.paths.blockers = blockers;
		cfg.paths.cancelled = cancelled;
		cfg.pages.dir = pages;
		cfg.approval.since = since;
		applyQueueEnv(cfg);
		return planGate(`Plan: ${plan}\nP1 do the thing.`, "toy-worker", cfg);
	};
	test("after approval.since a plan with no page is refused; with since empty or a later since it passes", () => {
		expect(gate("20261029_1455")[0]).toContain(`neurastream pages publish <page.html> --plan ${plan}`);
		expect(gate("")).toEqual([null, [plan]]);
		expect(gate("20261031_0000")).toEqual([null, [plan]]);
	});
	test("after approval.since a page without a record is refused, and a matching record passes", () => {
		recordPagePlan(pages, "toy.html", { plan, missing: [], thin: [] });
		expect(gate("20261029_1455")[0]).toContain("has no approval record");
		writeFileSync(join(state, "plan-approvals.json"), JSON.stringify({ approvals: { [plan]: { hash: reviewHash(body), at: 1, via: "page", page: "toy.html" } } }));
		expect(gate("20261029_1455")).toEqual([null, [plan]]);
	});
});

