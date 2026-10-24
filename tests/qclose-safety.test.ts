import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// The checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(import.meta.path));
// realpath: macOS /tmp is a symlink to /private/tmp, and git reports worktrees by real path.
const ROOT = join(realpathSync("/tmp"), "neurastream-home-qclose-safety");
const PLAN = "20261018_0900_qclose_probe.md";
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7).replace("-", "");

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

// Git runs without any inherited GIT_* state; identity is fixed so commits are reproducible.
const GIT_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
	return r.stdout.trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
	return spawnSync("git", args, { cwd, env: GIT_ENV }).status === 0;
}

function commit(cwd: string, file: string, body: string, msg: string): void {
	writeFileSync(join(cwd, file), body);
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", msg);
}

function fresh(name: string): string {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function configYml(home: string): string {
	return `paths:
  home: "${home}"
  work_roots:
    - "${join(home, "Work")}"
    - "${join(home, "projects")}"
  agent_dir: "${join(home, ".omp/agent")}"
  queue_index: "${join(home, ".omp/agent/INDEX.md")}"
  blockers: "${join(home, ".omp/agent/blockers")}"
  queue_state: "${join(home, ".local/state/queue")}"
  subagents: "${join(home, ".omp/agent/notes/subagents.md")}"
  cancelled: "${join(home, ".omp/agent/CANCELLED.md")}"
  unlock: "${join(home, ".omp/agent/.guard-unlock")}"
  heavy_lock: "${join(home, "Work/.heavy-run.lock")}"
  heavy_owner: "${join(home, "Work/.heavy-run.owner")}"
  heavy_log: "${join(home, "Work/.heavy-run.log")}"
  heavy_idle_state: "${join(home, "Work/.heavy-run.idle-state")}"
  alert_state: "${join(home, ".cache/resource-alerts")}"
  snapshot_lock: "${join(home, ".cache/tmp-snapshot.lock")}"
brief:
  heavy_path: "${join(home, "Work/heavy-run.sh")}"
machine:
  disk_path: "/home"
priority:
  sleep_sec: 1
snapshot:
  tmp_dest: "${join(home, "Work/tmp-snapshot")}"
  git_repo: "${join(home, "Work/gateforge")}"
  git_backup: "${join(home, "Work/gf-backups/latest")}"
`;
}

// A sandbox HOME with the queue index, the blockers the plan names, and the config the CLI reads.
function makeHome(dir: string): string {
	const home = join(dir, "home");
	const agent = join(home, ".omp/agent");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(join(agent, "blockers"), { recursive: true });
	for (const f of ["no-push", "_blocker.py"]) {
		copyFileSync(join(REPO, "tests/fixtures/originals/agent/blockers", f), join(agent, "blockers", f));
		chmodSync(join(agent, "blockers", f), 0o755);
	}
	writeFileSync(join(home, ".config/neurastream/config.yml"), configYml(home));
	return home;
}

function envFor(home: string): NodeJS.ProcessEnv {
	const agent = join(home, ".omp/agent");
	return {
		...GIT_ENV,
		HOME: home,
		QUEUE_AGENT: agent,
		QUEUE_INDEX: join(agent, "INDEX.md"),
		QUEUE_BLOCKERS: join(agent, "blockers"),
		QUEUE_STATE: join(home, ".local/state/queue"),
		QUEUE_SUBAGENTS: join(agent, "notes/subagents.md"),
		QUEUE_CANCELLED: join(agent, "CANCELLED.md"),
		QUEUE_UNLOCK: join(agent, ".guard-unlock"),
	};
}

function runClose(home: string, file: string, binDir = "") {
	const env = { ...envFor(home), ...(binDir ? { PATH: `${binDir}:${process.env.PATH}` } : {}) };
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "queue-close", file], { env, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function planText(status: "open" | "complete", branch: string, worktree: string, done: string): string {
	return `# Probe plan
Worktree: ${worktree}
Branch: ${branch}

## Goal
- probe

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`${done}\`

## Progress
Status: ${status}

## Background
note
`;
}

// Chain: repo R -> middle C -> upstream U. C's HEAD is a feature branch and its local main is stale,
// so R's origin/HEAD (cloned from C) points at that feature branch, not at the upstream default.
// Plan's branch F is merged into U's main only when `landed` is true.
function chain(dir: string, landed: boolean, worktree = "-", done = "true"): string {
	const U = join(dir, "upstream");
	const C = join(dir, "middle");
	const R = join(dir, "repo");
	mkdirSync(U, { recursive: true });
	git(U, "init", "-q", "-b", "main");
	commit(U, "base.txt", "base\n", "base");
	git(dir, "clone", "-q", U, C);
	git(C, "checkout", "-q", "-b", "chore/other");
	git(dir, "clone", "-q", C, R);
	git(R, "checkout", "-q", "-b", "F", "origin/main");
	commit(R, "F.txt", "feature\n", "feature F");
	git(R, "checkout", "-q", "chore/other");
	mkdirSync(join(R, "docs/plans"), { recursive: true });
	writeFileSync(join(R, "docs/plans", PLAN), planText("complete", "F", worktree, done));
	git(R, "add", join("docs/plans", PLAN));
	git(R, "commit", "-q", "-m", "plan");
	if (landed) {
		git(U, "fetch", "-q", R, "F");
		git(U, "merge", "-q", "--no-ff", "-m", "merge F", "FETCH_HEAD");
	}
	return R;
}

function indexHome(home: string, plan: string): void {
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${plan}\n`);
}

test("P1: base follows a local origin chain to the upstream default branch (merged)", () => {
	const dir = fresh("p1-merged");
	const home = makeHome(dir);
	const R = chain(dir, true);
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.stderr + r.stdout).not.toContain("AWAITING");
	expect(r.stdout).toContain("queue-close: branch F kept");
	expect(r.stdout).toContain("queue-close: CLOSED");
	expect(r.code).toBe(0);
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(true);
	// git's -d cannot see the landing on the stale upstream, so the branch stays.
	expect(gitOk(R, "rev-parse", "--verify", "-q", "refs/heads/F")).toBe(true);
});

test("P1: base follows a local origin chain; unmerged branch stays AWAITING merge", () => {
	const dir = fresh("p1-awaiting");
	const home = makeHome(dir);
	const R = chain(dir, false);
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.stderr).toContain("AWAITING merge");
	expect(r.code).toBe(4);
	expect(existsSync(join(R, "docs/plans", PLAN))).toBe(true);
	expect(gitOk(R, "rev-parse", "--verify", "-q", "refs/heads/F")).toBe(true);
});

test("P2: a plan worktree on another branch is kept intact; the plan is still archived", () => {
	const dir = fresh("p2-kept");
	const home = makeHome(dir);
	const W = join(dir, "wt-g");
	const R = chain(dir, true, W);
	git(R, "worktree", "add", "-q", "-b", "G", W, "origin/main");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.stdout).toContain(`queue-close: worktree ${W} kept: it is on G`);
	expect(r.stdout).toContain("queue-close: branch F kept");
	expect(r.stdout).toContain("queue-close: CLOSED");
	expect(r.code).toBe(0);
	expect(existsSync(join(W, ".git"))).toBe(true);
	expect(git(W, "rev-parse", "--abbrev-ref", "HEAD")).toBe("G");
	expect(git(R, "worktree", "list", "--porcelain")).toContain(W);
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(true);
});

test("P2: a worktree git cannot remove is kept; no docker, no force, branch included", () => {
	const dir = fresh("p2-leftover");
	const home = makeHome(dir);
	const W = join(dir, "wt-f");
	const R = chain(dir, true, W);
	git(R, "worktree", "add", "-q", W, "F");
	rmSync(join(W, ".git")); // git can no longer remove this worktree
	const bin = join(home, "stub-bin");
	mkdirSync(bin, { recursive: true });
	const log = join(home, "docker.log");
	writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
	chmodSync(join(bin, "docker"), 0o755);
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN), bin);
	expect(r.stderr).toBe("");
	expect(r.stdout).toContain(`queue-close: worktree ${W} kept`);
	expect(r.stdout).toContain("queue-close: branch F kept");
	expect(r.code).toBe(0);
	expect(existsSync(log)).toBe(false);
	expect(existsSync(W)).toBe(true);
	expect(git(R, "worktree", "list", "--porcelain")).toContain(W);
	expect(gitOk(R, "rev-parse", "--verify", "-q", "refs/heads/F")).toBe(true);
});

test("P3: a missing plan worktree is checked on the upstream base; the file is there, so CLOSED", () => {
	const dir = fresh("p3-present");
	const home = makeHome(dir);
	// F.txt lands on upstream main only; R's checkout (chore/other) does not have it.
	const R = chain(dir, true, join(dir, "gone"), "test -f F.txt");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.stdout).toContain("temporary worktree");
	expect(r.stdout).toContain("queue-close: CLOSED");
	expect(r.code).toBe(0);
	expect(git(R, "worktree", "list", "--porcelain")).not.toContain("done-base-");
});

test("P3: a missing plan worktree is checked on the upstream base; the file is absent, so the plan reopens", () => {
	const dir = fresh("p3-absent");
	const home = makeHome(dir);
	const R = chain(dir, true, join(dir, "gone"), "test -f NOT_ON_MAIN.txt");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("plan reopened (Status: open)");
	expect(readFileSync(join(R, "docs/plans", PLAN), "utf8")).toContain("Status: open");
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(false);
});
