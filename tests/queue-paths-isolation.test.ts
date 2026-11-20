// Isolation regression tests (plan 20261120_1415_remove_queue_env_globals):
// (a) Two distinct Config / QueuePaths sandboxes evaluated interleaved in the same process never
//     interfere with each other across queue helpers, guard checks, unlock state, and edit windows.
// (b) Calling queue, guard, and autonomy helpers never mutates process.env with QUEUE_* keys.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, reset as resetAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { configFile, loadConfig, reloadingConfig, type Config } from "../src/core/config.ts";
import { chatTier, currentTier } from "../src/core/autonomy.ts";
import { checkInject, checkStop, checkTool, readWindow, writeWindow } from "../src/core/guards.ts";
import {
	activePlans,
	chatUnlock,
	protectedHit,
	protectedPaths,
	queueProblems,
	queueSummary,
	unlocked,
} from "../src/core/queue/lib.ts";

const REPO = dirname(dirname(import.meta.path));
const CLI = join(REPO, "src/cli/main.ts");
const TMP = mkdtempSync(join(tmpdir(), "queue-paths-isolation-"));

afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
});

interface Sandbox {
	cfg: Config;
	repo: string;
	plan: string;
}

/** Creates an isolated sandbox with its own home, agent dir, index, blockers, state, and plan. */
function makeSandbox(label: string, planTitle: string): Sandbox {
	const home = join(TMP, `home-${label}`);
	const agent = join(home, ".omp/agent");
	const state = join(home, ".local/state/queue");
	const repo = join(home, `projects/repo-${label}`);
	const plan = join(repo, `docs/plans/20261020_0100_${label}.md`);
	for (const d of [
		join(home, ".config/neurastream"),
		join(agent, "blockers"),
		join(agent, "notes"),
		state,
		join(repo, ".git"),
		join(repo, "docs/plans"),
		join(repo, "src"),
	]) {
		mkdirSync(d, { recursive: true });
	}
	writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(agent, "blockers/ok"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(agent, "blockers/ok"), 0o755);
	writeFileSync(join(agent, "notes/subagents.md"), `## Allowed\n\n- \`worker-${label}\`\n`);
	writeFileSync(join(agent, "CANCELLED.md"), "");
	writeFileSync(
		plan,
		`# ${planTitle}

Worktree: -
Branch: feat/${label}

## Goal
- Isolated goal for ${label}.

## Forbidden
- Never skip tests.

## Blockers
- ok

## Phases
- [ ] P1 do ${label} — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started ${label}.
`,
	);
	writeFileSync(join(agent, "INDEX.md"), `${plan}\n`);
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  work_roots: ["${repo}"]
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "notes/subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(home, "guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
guards:
  chat_unlock: true
review:
  agents: []
  plan: false
`,
	);
	const cfg = loadConfig({ home, env: {} });
	return { cfg, repo, plan };
}

/** Snapshots all QUEUE_* keys currently in process.env. */
function queueEnvSnapshot(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")).sort(([a], [b]) => a.localeCompare(b)));
}

test("two distinct QueuePaths configs do not interfere when evaluated interleaved in one process", () => {
	const a = makeSandbox("alpha", "Alpha Plan");
	const b = makeSandbox("beta", "Beta Plan");

	// Queue index and summaries stay strictly isolated per config.
	expect(activePlans(a.cfg.paths).map(p => p.file)).toEqual([a.plan]);
	expect(activePlans(b.cfg.paths).map(p => p.file)).toEqual([b.plan]);
	expect(queueProblems(a.cfg.paths)).toEqual([]);
	expect(queueProblems(b.cfg.paths)).toEqual([]);
	expect(queueSummary(a.cfg.paths)).toContain(a.plan);
	expect(queueSummary(a.cfg.paths)).not.toContain(b.plan);
	expect(queueSummary(b.cfg.paths)).toContain(b.plan);
	expect(queueSummary(b.cfg.paths)).not.toContain(a.plan);

	// Unlock state in A does not unlock B.
	expect(chatUnlock("unlock 10", a.cfg, "interactive").applied).toBe(true);
	expect(unlocked(a.cfg.paths)).toBe(true);
	expect(unlocked(b.cfg.paths)).toBe(false);

	// Protected paths are derived per QueuePaths, so A's index is protected in A and not in B.
	expect(protectedPaths(a.cfg.paths)).toContain(a.cfg.paths.queue_index);
	expect(protectedHit([a.cfg.paths.queue_index], a.cfg.paths)).toBe(a.cfg.paths.queue_index);
	expect(protectedHit([a.cfg.paths.queue_index], b.cfg.paths)).toBeNull();
	expect(protectedHit([b.cfg.paths.queue_index], b.cfg.paths)).toBe(b.cfg.paths.queue_index);

	// Edit windows and autonomy tiers remain isolated per queue_state.
	writeWindow({ used: ["edit:a.ts"], windowStart: Date.now(), mainCalls: 4 }, a.cfg.paths);
	writeWindow({ used: [], windowStart: Date.now(), mainCalls: 1 }, b.cfg.paths);
	expect(readWindow(a.cfg.paths).mainCalls).toBe(4);
	expect(readWindow(b.cfg.paths).mainCalls).toBe(1);

	expect(chatTier("tier full", a.cfg, "interactive").applied).toBe(true);
	expect(currentTier(a.cfg)).toBe("full");
	expect(currentTier(b.cfg)).toBe("opinionated");

	// Guard checks (checkInject, checkTool, checkStop) reflect only their own config's queue.
	const injA = checkInject({ agent: "main", inject: "status" }, a.cfg);
	const injB = checkInject({ agent: "main", inject: "status" }, b.cfg);
	expect(injA.inject).toContain(a.plan);
	expect(injA.inject).not.toContain(b.plan);
	expect(injB.inject).toContain(b.plan);
	expect(injB.inject).not.toContain(a.plan);

	// A is unlocked so writing A's index is allowed; B is locked so writing B's index is refused.
	const writeA = checkTool(
		{ tool: "write", input: { path: a.cfg.paths.queue_index, content: "" }, cwd: a.repo, agent: "main", agentId: "main", calls: 0, paths: [], writes: [], command: "" },
		a.cfg,
	);
	const writeB = checkTool(
		{ tool: "write", input: { path: b.cfg.paths.queue_index, content: "" }, cwd: b.repo, agent: "main", agentId: "main", calls: 0, paths: [], writes: [], command: "" },
		b.cfg,
	);
	expect(writeA.allow).toBe(true);
	expect(writeB.allow).toBe(false);

	// Emptying B's index allows B to stop while A still blocks on A's open plan.
	writeFileSync(b.cfg.paths.queue_index, "");
	expect(checkStop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }, a.cfg).allow).toBe(false);
	expect(checkStop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }, b.cfg).allow).toBe(true);
});

test("calling queue, guard, and autonomy helpers never mutates process.env with QUEUE_* keys", () => {
	const before = queueEnvSnapshot();
	const s = makeSandbox("envcheck", "Env Check Plan");

	activePlans(s.cfg.paths);
	queueProblems(s.cfg.paths);
	queueSummary(s.cfg.paths);
	protectedPaths(s.cfg.paths);
	protectedHit([s.cfg.paths.queue_index], s.cfg.paths);
	chatUnlock("unlock 5", s.cfg, "interactive");
	unlocked(s.cfg.paths);
	chatTier("tier strict", s.cfg, "interactive");
	currentTier(s.cfg);
	checkInject({ agent: "main", inject: "hello" }, s.cfg);
	checkTool(
		{ tool: "read", input: { path: join(s.repo, "src/a.ts") }, cwd: s.repo, agent: "main", agentId: "main", calls: 0, paths: [], writes: [], command: "" },
		s.cfg,
	);
	checkStop({ agent: "main", callsSinceStop: 1, idleStops: 0, ledgerText: "" }, s.cfg);

	expect(queueEnvSnapshot()).toEqual(before);
});

test("reloadingConfig + createOmpAdapter picks up updated paths.queue_index and paths.queue_state on the next guarded event", () => {
	const home = join(TMP, "home-hotreload");
	const agent = join(home, ".omp/agent");
	const repo = join(home, "projects/repo-hr");
	const plan1 = join(repo, "docs/plans/20261020_0100_one.md");
	const plan2 = join(repo, "docs/plans/20261020_0200_two.md");
	const index1 = join(home, "custom-a/INDEX.md");
	const index2 = join(home, "custom-b/INDEX.md");
	const state1 = join(home, "custom-a/state");
	const state2 = join(home, "custom-b/state");
	for (const d of [
		join(home, ".config/neurastream"),
		join(agent, "blockers"),
		join(agent, "notes"),
		join(repo, ".git"),
		join(repo, "docs/plans"),
		join(repo, "src"),
		dirname(index1),
		dirname(index2),
		state1,
		state2,
	]) {
		mkdirSync(d, { recursive: true });
	}
	writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(agent, "blockers/ok"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(agent, "blockers/ok"), 0o755);
	writeFileSync(join(agent, "notes/subagents.md"), "## Allowed\n\n- `worker`\n");
	writeFileSync(join(agent, "CANCELLED.md"), "");
	const body = (title: string) =>
		`# ${title}\n\nWorktree: -\nBranch: -\n\n## Goal\n- ${title}\n\n## Forbidden\n- Never push.\n\n## Blockers\n- ok\n\n## Phases\n- [ ] P1 x — verify: \`true\`\n\n## Done check\n\`true\`\n\n## Progress\nStatus: open\n`;
	writeFileSync(plan1, body("HotReload One"));
	writeFileSync(plan2, body("HotReload Two"));
	writeFileSync(index1, `${plan1}\n`);
	writeFileSync(index2, `${plan2}\n`);

	const cfgPath = configFile(home);
	const writeCfg = (index: string, state: string, mtimeSec: number): void => {
		writeFileSync(
			cfgPath,
			`paths:
  home: "${home}"
  work_roots: ["${repo}"]
  agent_dir: "${agent}"
  queue_index: "${index}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "notes/subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(home, "guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
rollover:
  enabled: false
review:
  agents: []
  plan: false
`,
		);
		utimesSync(cfgPath, mtimeSec, mtimeSec);
	};

	writeCfg(index1, state1, 1_800_000_000);
	const initial = loadConfig({ home, env: {} });
	const current = reloadingConfig(initial, cfgPath, () => loadConfig({ home, env: {} }), () => {});

	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const host: ExtensionHost = {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb as (e: unknown, ctx: unknown) => unknown]);
		},
		registerCommand() {},
		sendUserMessage() {},
		sendMessage() {},
	};
	createOmpAdapter(host, initial, current);
	const ctx = { agent: { kind: "main", id: "main" }, cwd: repo };
	const fire = (event: string, payload: unknown): unknown[] =>
		(handlers.get(event) ?? []).map(cb => cb(payload, ctx)).filter(r => r !== undefined);

	// Before reload: before_agent_start injects index1's plan and writes owner-messages into state1.
	const beforeRes = JSON.stringify(fire("before_agent_start", { prompt: "check queue before reload" }));
	expect(beforeRes).toContain(plan1);
	expect(beforeRes).not.toContain(plan2);
	expect(existsSync(join(state1, "owner-messages.jsonl"))).toBe(true);
	expect(existsSync(join(state2, "owner-messages.jsonl"))).toBe(false);

	// Hot-reload config.yml to point at index2 and state2.
	writeCfg(index2, state2, 1_800_000_100);

	// Next guarded event immediately sees index2 and writes state into state2.
	const afterRes = JSON.stringify(fire("before_agent_start", { prompt: "check queue after reload" }));
	expect(afterRes).toContain(plan2);
	expect(afterRes).not.toContain(plan1);
	expect(existsSync(join(state2, "owner-messages.jsonl"))).toBe(true);

	// tool_call also uses the reloaded queue_state for Main's edit window.
	fire("tool_call", { toolName: "read", input: { path: join(repo, "src/a.ts") }, toolCallId: "t1" });
	expect(readWindow({ queue_state: state2 }).mainCalls).toBeGreaterThan(0);
	resetAdapter();
});

test("sandbox E2E: non-default queue_index and queue_state work across spawned CLI children without touching default state dir", () => {
	const home = join(TMP, "home-e2e");
	const customRoot = join(TMP, "custom-nondefault-queue");
	const customIndex = join(customRoot, "my-index/INDEX.md");
	const customState = join(customRoot, "my-state");
	const customAgent = join(customRoot, "my-agent");
	const repo = join(home, "projects/e2e-repo");
	const plan = join(repo, "docs/plans/20261020_0300_cancelme.md");
	const defaultStateDir = join(home, ".local/state/queue");

	for (const d of [
		join(home, ".config/neurastream"),
		join(customAgent, "blockers"),
		join(customAgent, "notes"),
		dirname(customIndex),
		customState,
		join(repo, "docs/plans"),
		join(repo, "src"),
	]) {
		mkdirSync(d, { recursive: true });
	}
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
	writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(customAgent, "blockers/ok"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(customAgent, "blockers/ok"), 0o755);
	writeFileSync(join(customAgent, "notes/subagents.md"), "## Allowed\n\n- `worker`\n");
	writeFileSync(join(customAgent, "CANCELLED.md"), "");
	writeFileSync(
		plan,
		`# Cancel E2E Plan

Worktree: -
Branch: -

## Goal
- Cancel this plan through the CLI.

## Forbidden
- Never push.

## Blockers
- ok

## Phases
- [ ] P1 do it — verify: \`true\`

## Done check
\`true\`

## Progress
Status: open
`,
	);
	spawnSync("git", ["add", "."], { cwd: repo });
	spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
	writeFileSync(customIndex, `${plan}\n`);

	writeFileSync(
		configFile(home),
		`paths:
  home: "${home}"
  work_roots: ["${repo}"]
  agent_dir: "${customAgent}"
  queue_index: "${customIndex}"
  blockers: "${join(customAgent, "blockers")}"
  queue_state: "${customState}"
  subagents: "${join(customAgent, "notes/subagents.md")}"
  cancelled: "${join(customAgent, "CANCELLED.md")}"
  unlock: "${join(customAgent, ".guard-unlock")}"
  guard_log: "${join(customRoot, "guard.log")}"
  plan_guard_log: "${join(customRoot, "plan-guard.log")}"
review:
  agents: []
  plan: false
`,
	);

	// Clean child env: HOME points to sandbox, zero QUEUE_* overrides so config.yml is the sole source.
	const cleanEnv: NodeJS.ProcessEnv = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))),
		HOME: home,
	};

	// 1) `neurastream guard inject --json` reads customIndex and writes owner-messages into customState.
	const guardRes = spawnSync("bun", [CLI, "guard", "inject", "--json"], {
		input: JSON.stringify({ agent: "main", inject: "stop the cancelme plan" }),
		encoding: "utf8",
		env: cleanEnv,
		cwd: repo,
	});
	expect(guardRes.status).toBe(0);
	const guardDecision = JSON.parse(guardRes.stdout.trim().split("\n").pop() ?? "{}") as { inject?: string };
	expect(guardDecision.inject ?? "").toContain(plan);
	expect(existsSync(join(customState, "owner-messages.jsonl"))).toBe(true);
	expect(existsSync(defaultStateDir)).toBe(false);

	// 2) `neurastream queue-cancel` cancels the plan and spawns `queue-close` child against customIndex/customState.
	const cancelRes = spawnSync("bun", [CLI, "queue-cancel", plan, "owner said cancel this e2e plan"], {
		encoding: "utf8",
		env: cleanEnv,
		cwd: repo,
	});
	expect(cancelRes.status).toBe(0);
	expect(existsSync(plan)).toBe(false);
	expect(readFileSync(customIndex, "utf8").trim()).toBe("");
	expect(existsSync(defaultStateDir)).toBe(false);
}, 30_000);
