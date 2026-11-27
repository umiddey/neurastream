// Main's limit wake (plan 20261127_1005 P2): when a counted Main call cap or edit window resets
// while plans are still open, the adapter sends Main ONE continuation at the reset, instead of
// leaving it parked until the owner speaks. The tick is a snapshot taken at arm time: it never
// re-reads the window, because the terminal hand-back zeroes mainCalls after session_stop.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLimitWake } from "../src/adapters/omp/limit-wake.ts";
import type { ExtensionHost, HostCtx } from "../src/adapters/omp/types.ts";
import { type Config, loadConfig } from "../src/core/config.ts";
import { mainCallsResetMs, readWindow, writeWindow } from "../src/core/guards.ts";

const roots: string[] = [];
const originalQueueEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QUEUE_")));
afterAll(() => {
	for (const key of Object.keys(process.env)) if (key.startsWith("QUEUE_")) delete process.env[key];
	Object.assign(process.env, originalQueueEnv);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0); // ms, as Date.now() reads it
const S = T0 / 1000; // mainCallsStart is unix seconds
const WINDOW_MS = 15 * 60_000;
const WAKE = "main-guard: the call/edit limit has reset — continue the queue where you stopped.";

let now = T0;
let nowSpy: { mockRestore(): void };
let root: string;
let agent: string;
let repo: string;
let plan: string;
let cfg: Config;
let installs = 0;
let tick: (() => void) | null = null;
const sent: string[] = [];

const pi = { sendUserMessage: (m: string) => void sent.push(m) } as unknown as ExtensionHost;
const ctx = {
	setInterval: (fn: () => void) => {
		installs++;
		tick = fn;
		const handle = setInterval(() => {}, 1 << 30); // a real handle, so clearInterval has something to clear
		handle.unref();
		return handle;
	},
} as unknown as HostCtx;
const fire = (): void => tick?.();

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-limit-wake-"));
	roots.push(root);
	agent = join(root, "agent");
	repo = join(root, "repo");
	const state = join(root, "state");
	for (const d of [agent, state, repo, join(root, ".config/neurastream")]) mkdirSync(d, { recursive: true });
	plan = join(repo, "plan.md");
	writeFileSync(
		plan,
		`# Open\n\nWorktree: ${repo}\nBranch: fix/test\n\n## Goal\n- Test.\n\n## Forbidden\n- None.\n\n## Blockers\n- no-push\n\n## Phases\n- [ ] P1 test — verify: \`true\`\n\n## Done check\n\`true\`\n\n## Progress\nStatus: open\n- Started.\n`,
	);
	writeFileSync(join(agent, "INDEX.md"), `${plan}\n`);
	writeFileSync(join(agent, "CANCELLED.md"), "");
	writeFileSync(join(agent, "subagents.md"), "## Allowed\n- `task`\n");
	writeFileSync(
		join(root, ".config/neurastream/config.yml"),
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
guards:
  main_warn_calls: 2
  main_max_calls: 3
  main_edit_limit: 5
  main_window_min: 15
`,
	);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QUEUE_")));
	Object.assign(env, { HOME: root });
	cfg = loadConfig({ home: root, env });
	writeWindow({ used: [], windowStart: 0, mainCalls: 0 }, cfg.paths);
	now = T0;
	installs = 0;
	tick = null;
	sent.length = 0;
	nowSpy = spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => nowSpy.mockRestore());

test("calls spent: one continuation at the reset, none before, none after", () => {
	writeWindow({ used: [], windowStart: 0, mainCalls: 3, mainCallsStart: S }, cfg.paths);
	const wake = createLimitWake(pi, () => cfg);
	wake.arm(ctx);
	expect(installs).toBe(1);
	now = (S + 1) * 1000;
	fire();
	expect(sent).toEqual([]);
	now = (S + 900) * 1000;
	fire();
	expect(sent).toEqual([WAKE]);
	fire();
	expect(sent).toEqual([WAKE]);
});

test("units: the calls reset is a unix-seconds stamp read back in ms", () => {
	writeWindow({ used: [], windowStart: 0, mainCalls: 3, mainCallsStart: S }, cfg.paths);
	expect(mainCallsResetMs(readWindow(cfg.paths))).toBe((S + 900) * 1000);
});

test("edits spent: the continuation lands when the edit window ends", () => {
	writeWindow({ used: ["a", "b", "c", "d", "e"], windowStart: T0, mainCalls: 0 }, cfg.paths);
	const wake = createLimitWake(pi, () => cfg);
	wake.arm(ctx);
	expect(installs).toBe(1);
	now = T0 + WINDOW_MS - 1;
	fire();
	expect(sent).toEqual([]);
	now = T0 + WINDOW_MS;
	fire();
	expect(sent).toEqual([WAKE]);
});

test("nothing pending: arm installs no tick", () => {
	writeWindow({ used: [], windowStart: 0, mainCalls: 1, mainCallsStart: S }, cfg.paths);
	createLimitWake(pi, () => cfg).arm(ctx);
	expect(installs).toBe(0);
});

test("empty queue: arm installs no tick, and a queue emptied before the reset sends nothing", () => {
	writeWindow({ used: [], windowStart: 0, mainCalls: 3, mainCallsStart: S }, cfg.paths);
	writeFileSync(join(agent, "INDEX.md"), "");
	createLimitWake(pi, () => cfg).arm(ctx);
	expect(installs).toBe(0);

	writeFileSync(join(agent, "INDEX.md"), `${plan}\n`);
	const wake = createLimitWake(pi, () => cfg);
	wake.arm(ctx);
	expect(installs).toBe(1);
	writeFileSync(join(agent, "INDEX.md"), "");
	now = (S + 900) * 1000;
	fire();
	expect(sent).toEqual([]);
});

test("owner prompt cancels: a fire after cancel sends nothing", () => {
	writeWindow({ used: [], windowStart: 0, mainCalls: 3, mainCallsStart: S }, cfg.paths);
	const wake = createLimitWake(pi, () => cfg);
	wake.arm(ctx);
	wake.cancel();
	now = (S + 900) * 1000;
	fire();
	expect(sent).toEqual([]);
});
