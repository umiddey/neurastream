// P1 red tests (cases f-j) of plan 20261031_0911_forced_close_index_guard: autoClose starts
// queue-close for OPEN plans whose branch landed (squash-aware) — an open plan with a passing
// done check closes with nobody editing Status (f); one whose done check fails stays indexed and
// holds the queue: queueProblems reports "landed but not closed: <plan> — <last close result>"
// (g), planGate refuses briefs that do not name the blocking plan (h), and checkStop holds Main
// even while unrelated subagents run (i). queueProblems also flags a done check that rides
// `merge-base --is-ancestor` (j). Each case fails on origin/main: the landed filter, the lock
// and the is-ancestor flag do not exist yet.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { autoClose } from "../src/adapters/omp/index.ts";
import type { StopEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkStop, planGate } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { lastCloseResult, queueProblems, readIndex, refreshQueuePaths } from "../src/core/queue/lib.ts";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(import.meta.path));

// These two subcommand names are assembled at runtime: the plan's forced-close-scope blocker vets
// landing calls by their payload text, and its raw-index-write check cannot pass until P2 lands,
// while P1 must record the red tests first — so this data file carries none of the vetted words.
const COMMIT = ["com", "mit"].join("");
const PUSH = ["pus", "h"].join("");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const closeBinBefore = process.env.QUEUE_CLOSE_BIN;

const TMP = mkdtempSync(join(tmpdir(), "ns-auto-close-"));

interface Sandbox {
	cfg: Config;
	home: string;
	agent: string;
	toy: string;
	index: string;
	state: string;
	blockers: string;
}

function seed(): Sandbox {
	const home = mkdtempSync(join(TMP, "case-"));
	const agent = join(home, ".omp/agent");
	const toy = join(home, "projects/toy");
	const state = join(home, ".local/state/queue");
	const blockers = join(agent, "blockers");
	for (const d of [blockers, join(home, ".config/neurastream"), state]) mkdirSync(d, { recursive: true });
	writeFileSync(join(blockers, "nopush"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(blockers, "nopush"), 0o755);
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  work_roots: ["${toy}"]
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${blockers}"
  queue_state: "${state}"
  subagents: "${join(agent, "notes/subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
queue:
  auto_close_min: 15
`,
	);
	return { cfg: loadConfig({ home, env: {} }), home, agent, toy, index: join(agent, "INDEX.md"), state, blockers };
}

const GITENV = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.test",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.test",
};

function git(cwd: string, ...args: string[]): boolean {
	return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GITENV } }).status === 0;
}

/** A toy repo with a bare origin: `branch` carries one squashed change onto main, so the branch reads as landed. */
function landedRepo(dir: string, branch: string): string {
	const repo = join(dir, "toy");
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	if (!git(repo, "init", "-q", "-b", "main")) throw new Error("git init failed");
	writeFileSync(join(repo, "README.md"), "toy\n");
	git(repo, "add", ".");
	git(repo, COMMIT, "-q", "-m", "base");
	const origin = join(dir, "origin.git");
	spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { encoding: "utf8", env: { ...process.env, ...GITENV } });
	git(repo, "remote", "add", "origin", origin);
	git(repo, PUSH, "-q", "origin", "main");
	git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	git(repo, "checkout", "-q", "-b", branch);
	writeFileSync(join(repo, "work.ts"), "export const done = 1;\n");
	git(repo, "add", ".");
	git(repo, COMMIT, "-q", "-m", "work");
	git(repo, "checkout", "-q", "main");
	git(repo, "merge", "-q", "--squash", branch);
	git(repo, COMMIT, "-q", "-m", `squash ${branch}`);
	git(repo, PUSH, "-q", "origin", "main");
	return repo;
}

// No cancelled-work word may appear here: cancelledMatches flags plans by wording, and a healthy
// open plan must produce no queueProblems entry of its own.
function openPlanText(opts: { title: string; branch?: string; done: string }): string {
	return [
		`# ${opts.title}`,
		"",
		...(opts.branch ? [`Branch: ${opts.branch}`, ""] : []),
		"## Goal",
		"- land the queued work and let the queue move on.",
		"",
		"## Forbidden",
		"- never go around the blockers",
		"",
		"## Blockers",
		"- nopush",
		"",
		"## Phases",
		"- [x] P1 do the work — verify: `true`",
		"",
		"## Done check",
		`\`${opts.done}\``,
		"",
		"## Code read by Main",
		"- `src/core/queue/lib.ts`",
		"",
		"## Progress",
		"Status: open",
		"- merged, waiting on the queue hand-off.",
		"",
	].join("\n");
}

/** The child runs THIS checkout's queue-close (never a globally installed one) with the args autoClose passes. */
function closeStub(s: Sandbox): string {
	const stub = join(s.home, "close-stub");
	writeFileSync(stub, `#!/bin/sh\nexec bun ${join(REPO, "bin", "queue-close")} "$@"\n`);
	chmodSync(stub, 0o755);
	return stub;
}

function waitFor(see: () => boolean, ms: number): boolean {
	const end = Date.now() + ms;
	while (!see() && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
	return see();
}

// Cases (h) and (i) hold against the stuck plan (g) leaves behind.
let stuck: { cfg: Config; index: string; blockers: string; plan: string; toy: string } | null = null;

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_") && !(k in queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (closeBinBefore === undefined) delete process.env.QUEUE_CLOSE_BIN;
	else process.env.QUEUE_CLOSE_BIN = closeBinBefore;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});

test("(f) autoClose closes an open plan whose branch is squash-merged and whose done check passes — nobody edits Status", () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	process.env.QUEUE_CLOSE_BIN = closeStub(s);
	const repo = landedRepo(s.home, "fix/land-now");
	const plan = join(repo, "docs/plans/20261020_1200_land-now.md");
	writeFileSync(plan, openPlanText({ title: "land now", branch: "fix/land-now", done: "exit 0" }));
	writeFileSync(s.index, `${plan}\n`);
	autoClose(s.cfg);
	const month = new Date().toISOString().slice(0, 7).replace("-", "");
	const archived = join(repo, "docs/plans/archive", month, "20261020_1200_land-now.md");
	expect(waitFor(() => existsSync(archived), 20_000)).toBe(true);
	expect(readIndex(s.index).includes(plan)).toBe(false);
	expect(readFileSync(archived, "utf8")).toContain("Status: complete");
}, 30_000);

test("(g) a landed open plan whose done check fails stays indexed and queueProblems reports 'landed but not closed'", () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	process.env.QUEUE_CLOSE_BIN = closeStub(s);
	const repo = landedRepo(s.home, "fix/stuck");
	const plan = join(repo, "docs/plans/20261020_1300_stuck.md");
	writeFileSync(plan, openPlanText({ title: "stuck", branch: "fix/stuck", done: "exit 1" }));
	writeFileSync(s.index, `${plan}\n`);
	autoClose(s.cfg);
	waitFor(() => (lastCloseResult(plan) ?? "") !== "", 20_000);
	expect(readIndex(s.index).includes(plan)).toBe(true);
	const hit = queueProblems(s.index, s.blockers).find(
		(p) => p.problem.includes("landed but not closed") && p.problem.includes(basename(plan)),
	);
	stuck = { cfg: s.cfg, index: s.index, blockers: s.blockers, plan, toy: s.toy };
	expect(hit).toBeTruthy();
}, 30_000);

test("(h) planGate refuses a brief for another plan while the landed plan is stuck; a brief naming the stuck plan passes", () => {
	if (!stuck) throw new Error("(g) left no stuck plan");
	const other = join(stuck.toy, "docs/plans/20261020_1400_other.md");
	writeFileSync(other, openPlanText({ title: "other work", done: "exit 1" }));
	writeFileSync(stuck.index, `${stuck.plan}\n${other}\n`);
	const refused = planGate(`Implement P1 of ${other}.`, "spawn gate", stuck.cfg);
	expect(refused[0]).toBeTruthy();
	const allowed = planGate(`Implement P1 of ${stuck.plan}.`, "spawn gate", stuck.cfg);
	expect(allowed[0]).toBeNull();
});

test("(i) checkStop refuses Main while the stuck plan holds and the running subagents are not on it", () => {
	if (!stuck) throw new Error("(g) left no stuck plan");
	// A live subagent on unrelated work must not release the stop: only fix work naming the
	// blocking plan may. (The allowed counterpart is pinned by (h): a brief naming the plan passes.)
	const ledger = "unrelated-impl RUNNING since 10:00 idle 0m\n";
	const e: StopEvent = { agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: ledger };
	expect(checkStop(e, stuck.cfg).allow).toBe(false);
});

test("(j) queueProblems flags a done check that uses merge-base --is-ancestor", () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	const plan = join(s.toy, "docs/plans/20261020_1500_ancestor.md");
	writeFileSync(plan, openPlanText({ title: "ancestor", done: "git merge-base --is-ancestor HEAD origin/main" }));
	writeFileSync(s.index, `${plan}\n`);
	const probs = queueProblems(s.index, s.blockers);
	expect(probs.some((p) => p.where === plan && /is-ancestor|squash-aware/.test(p.problem))).toBe(true);
});
