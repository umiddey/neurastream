// One plan = one worktree (plan 20261024_1400_one_index P2): after a successful close the plan's
// worktree is removed with a plain `git worktree remove` — never --force, never a main checkout —
// and a dirty or unmerged worktree is kept with the reason printed. Branches leave only via a safe
// `git branch -d`: git refuses, the branch stays.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
const ROOT = join(tmpdir(), "neurastream-home-qclose-worktree");
const PLAN = "20261024_1500_wt.md";
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7).replace("-", "");

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("QUEUE_"))),
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
	return `${r.stdout}${r.stderr}`.trim();
}

function commit(cwd: string, file: string, body: string, msg: string): void {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), body);
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", msg);
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
`;
}

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
	};
}

function runClose(home: string, file: string, binDir = "") {
	const env = { ...envFor(home), ...(binDir ? { PATH: `${binDir}:${process.env.PATH}` } : {}) };
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "queue-close", file], { env, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function planText(status: "complete" | "cancelled", branch: string, worktree: string): string {
	return `# Worktree probe

Worktree: ${worktree}
Branch: ${branch}

## Goal
- one plan, one worktree

## Forbidden
- none

## Blockers
- no-push

## Phases
- [x] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`src/core/queue-close.ts\`

## Progress
Status: ${status}
${status === "cancelled" ? 'Cancelled by owner: 2026-10-24 "stop this one"\n' : ""}
- done.
`;
}

// Chain: repo R -> middle C -> upstream U. F is the plan's branch, merged into U's main only when
// `landed`; R's origin (C) stays stale, so git's own -d check cannot see the landing.
function chain(dir: string, landed: boolean): string {
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
	writeFileSync(join(R, "docs/plans", PLAN), planText("complete", "F", "-"));
	git(R, "add", join("docs/plans", PLAN));
	git(R, "commit", "-q", "-m", "plan");
	if (landed) {
		git(U, "fetch", "-q", R, "F");
		git(U, "merge", "-q", "--no-ff", "-m", "merge F", "FETCH_HEAD");
	}
	return R;
}

function fresh(name: string): string {
	const dir = join(ROOT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

function indexHome(home: string, plan: string): void {
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${plan}\n`);
}

test("a clean owned worktree on a merged branch is removed after the close", () => {
	const dir = fresh("removed");
	const home = makeHome(dir);
	const R = chain(dir, true);
	const W = join(dir, "wt-f");
	git(R, "worktree", "add", "-q", W, "F");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`queue-close: worktree ${W} removed`);
	expect(existsSync(W)).toBe(false);
	expect(git(R, "worktree", "list", "--porcelain")).not.toContain(W);
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(true);
	expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8")).not.toContain(PLAN);
	// git's -d cannot see the landing on the stale upstream, so the branch stays
	expect(r.stdout).toContain("queue-close: branch F kept");
	expect(git(R, "rev-parse", "--verify", "-q", "refs/heads/F").length).toBe(40);
});

test("a dirty owned worktree is kept with the reason and the close still succeeds", () => {
	const dir = fresh("dirty");
	const home = makeHome(dir);
	const R = chain(dir, true);
	const W = join(dir, "wt-f");
	git(R, "worktree", "add", "-q", W, "F");
	writeFileSync(join(W, "scratch.txt"), "unfinished\n");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`queue-close: worktree ${W} kept: it has uncommitted changes`);
	expect(existsSync(join(W, "scratch.txt"))).toBe(true);
	expect(git(R, "worktree", "list", "--porcelain")).toContain(W);
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(true);
	expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8")).not.toContain(PLAN);
});

test("a worktree git cannot remove is kept, not force-deleted, and docker is never called", () => {
	const dir = fresh("broken");
	const home = makeHome(dir);
	const R = chain(dir, true);
	const W = join(dir, "wt-f");
	git(R, "worktree", "add", "-q", W, "F");
	rmSync(join(W, ".git")); // git can no longer remove this worktree
	const bin = join(home, "stub-bin");
	mkdirSync(bin, { recursive: true });
	const log = join(home, "docker.log");
	writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
	chmodSync(join(bin, "docker"), 0o755);
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN), bin);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`queue-close: worktree ${W} kept`);
	expect(existsSync(W)).toBe(true);
	expect(existsSync(log)).toBe(false);
	expect(existsSync(join(R, "docs/plans/archive", MONTH, PLAN))).toBe(true);
});

test("a cancelled plan's worktree is never the repo's main checkout", () => {
	const dir = fresh("main-checkout");
	const home = makeHome(dir);
	const R = chain(dir, false);
	writeFileSync(join(R, "docs/plans", PLAN), planText("cancelled", "chore/other", R));
	git(R, "add", join("docs/plans", PLAN));
	git(R, "commit", "-q", "-m", "cancel");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`queue-close: worktree ${R} kept`);
	expect(r.stdout).toContain("main checkout");
	expect(existsSync(join(R, "base.txt"))).toBe(true);
	expect(git(R, "worktree", "list", "--porcelain")).toContain(R);
});

test("a cancelled plan's clean worktree on an unmerged branch is kept, branch included", () => {
	const dir = fresh("unmerged");
	const home = makeHome(dir);
	const R = chain(dir, false);
	const W = join(dir, "wt-f");
	git(R, "worktree", "add", "-q", W, "F");
	writeFileSync(join(R, "docs/plans", PLAN), planText("cancelled", "F", W));
	git(R, "add", join("docs/plans", PLAN));
	git(R, "commit", "-q", "-m", "cancel");
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(0);
	expect(r.stdout).toContain(`queue-close: worktree ${W} kept: branch F is not merged`);
	expect(existsSync(W)).toBe(true);
	expect(git(R, "rev-parse", "--verify", "-q", "refs/heads/F").length).toBe(40);
});

test("the done-check scratch worktree leaves without force; a scratch the check dirtied stays", () => {
	const dir = fresh("scratch");
	const home = makeHome(dir);
	const R = chain(dir, true);
	// The plan's worktree is gone, so the done check runs in a temporary detached worktree on the
	// base; its script dirties that scratch, which must then be kept, not force-removed.
	const plan = planText("complete", "F", join(dir, "gone")).replace(
		"## Done check\n`true`",
		"## Done check\n`echo x > made-by-check.txt && test -f base.txt`",
	);
	writeFileSync(join(R, "docs/plans", PLAN), plan);
	indexHome(home, join(R, "docs/plans", PLAN));
	const r = runClose(home, join(R, "docs/plans", PLAN));
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("temporary worktree");
	expect(r.stdout).toContain("queue-close: CLOSED");
	const state = join(home, ".local/state/queue");
	const scratches = existsSync(state) ? readdirSync(state).filter(n => n.startsWith("done-base-")) : [];
	expect(scratches.length).toBeGreaterThan(0);
	expect(git(R, "worktree", "list", "--porcelain")).not.toContain("done-base-");
});
