import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { wipRepos } from "../src/core/wip-roots.ts";
import { wipSnapshot } from "../src/core/wip-snapshot.ts";
import { wipBackup } from "../src/core/wip-backup.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function gitAt(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

// The wip-roots.test.ts snapshot sandbox shape: temp home, wip-check on PATH, roots = <home>/Work.
function snapSandbox(name: string) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), name)));
	DIRS.push(base);
	const home = join(base, "home");
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".local/bin/wip-check"), "#!/bin/sh\necho ok\n");
	chmodSync(join(home, ".local/bin/wip-check"), 0o755);
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [join(home, "Work")];
	cfg.wip.status_log = join(home, "Work/WIP-STATUS.md");
	cfg.paths.alert_state = join(home, "alerts");
	const origHome = process.env.HOME;
	const origPath = process.env.PATH;
	process.env.HOME = home;
	process.env.PATH = `${join(home, ".local/bin")}:${origPath ?? ""}`;
	return {
		home,
		cfg,
		restore: () => {
			process.env.HOME = origHome;
			process.env.PATH = origPath;
		},
	};
}

// Case 3 (dead worktree dir): `.git` is a file naming a gitdir that is gone — no repo exists to
// save, so the dir must be absent from wipRepos; a valid gitfile worktree beside it stays listed.
test("a dead gitfile dir is absent from wipRepos; a valid gitfile worktree beside it is still present", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "wip-deadgit-")));
	DIRS.push(base);
	const home = join(base, "home");
	const root = join(home, "Work");
	const real = join(root, "real");
	const wt = join(root, "wt");
	const dead = join(root, "dead");
	mkdirSync(real, { recursive: true });

	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [root];

	gitAt(base, ["init", "-q", "-b", "main", real]);
	gitAt(real, ["config", "user.email", "t@example.com"]);
	gitAt(real, ["config", "user.name", "t"]);
	writeFileSync(join(real, "a.txt"), "one\n");
	gitAt(real, ["add", "a.txt"]);
	gitAt(real, ["commit", "-q", "-m", "init"]);
	gitAt(real, ["worktree", "add", "-q", wt]);
	mkdirSync(dead, { recursive: true });
	writeFileSync(join(dead, ".git"), `gitdir: ${join(base, "gone", ".git", "worktrees", "dead")}\n`);

	expect(wipRepos(cfg)).toEqual([real, wt]);
});

// Case 1 (unborn HEAD): nothing to save yet — skipped silently, not "Needed a single revision".
test("an unborn-HEAD repo: snapshot exits 0 with no FAILED line and the uncommitted file stays", () => {
	const { home, cfg, restore } = snapSandbox("wip-unborn-");
	const repo = join(home, "Work", "unborn");
	mkdirSync(repo, { recursive: true });
	try {
		gitAt(repo, ["init", "-q", "-b", "main"]);
		gitAt(repo, ["config", "user.email", "t@example.com"]);
		gitAt(repo, ["config", "user.name", "t"]);
		writeFileSync(join(repo, "wip.md"), "draft\n"); // uncommitted, no commit to hang a save on

		expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
		const log = readFileSync(cfg.wip.status_log, "utf8");
		expect(log).not.toContain("FAILED");
		expect(log).toContain("0 new, 0 unchanged since last, 0 failed");
		expect(existsSync(join(repo, "wip.md"))).toBe(true);
	} finally {
		restore();
	}
});

// Case 2 (bare main repo): its worktree-list block carries `bare`; snapshot must skip the block
// ("this operation must be run in a work tree") and still save the linked worktree's dirty change.
test("a bare repo with a worktree: snapshot exits 0, saves the worktree change, no FAILED line for the bare path", () => {
	const { home, cfg, restore } = snapSandbox("wip-bare-");
	const bare = join(home, "Work", "gate.git");
	const wt = join(home, "Work", "wt-main");
	try {
		gitAt(home, ["init", "-q", "--bare", bare]);
		gitAt(bare, ["config", "user.email", "t@example.com"]);
		gitAt(bare, ["config", "user.name", "t"]);
		const tree = gitAt(bare, ["hash-object", "-w", "-t", "tree", "--stdin"]).trim();
		const c = gitAt(bare, ["commit-tree", tree, "-m", "init"]).trim();
		gitAt(bare, ["update-ref", "refs/heads/main", c]);
		gitAt(bare, ["worktree", "add", "-q", wt, "main"]);
		writeFileSync(join(wt, "b.txt"), "dirty\n");

		expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
		const log = readFileSync(cfg.wip.status_log, "utf8");
		expect(log).not.toContain("FAILED");
		expect(log).not.toContain(bare);
		const refs = gitAt(wt, ["for-each-ref", "--format=%(refname)", "refs/wip/Work_wt-main/"]).split("\n").filter(Boolean);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatch(/^refs\/wip\/Work_wt-main\/\d{8}-\d{4}$/);
		expect(gitAt(wt, ["show", `${refs[0]}:b.txt`])).toBe("dirty\n");
	} finally {
		restore();
	}
});

// Case 4 (backup): branch `ops/x` beside a file `ops/x` — `rev-list --count ops/x --not --remotes`
// is "ambiguous argument"; naming the full ref and ending in `--` counts the branch and pushes it.
test("a branch named like a path with an unpushed commit: backup exits 0 and the commit reaches the target as <rkey>/ops/x", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "wip-branchpath-")));
	DIRS.push(base);
	const home = join(base, "home");
	const repo = join(home, "Work", "demo");
	const remote = join(base, "backup.git");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".local/bin/git-secret-gate"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(home, ".local/bin/git-secret-gate"), 0o755);
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [join(home, "Work")];
	cfg.wip.backup_url = remote;
	cfg.wip.backup_log = join(home, "Work/WIP-BACKUP.md");
	cfg.wip.secret_gate = join(home, ".local/bin/git-secret-gate");
	cfg.paths.alert_state = join(home, "alerts");
	cfg.paths.queue_state = join(home, "queue");

	const origHome = process.env.HOME;
	process.env.HOME = home;
	try {
		gitAt(base, ["init", "-q", "--bare", remote]);
		gitAt(repo, ["init", "-q", "-b", "main"]);
		gitAt(repo, ["config", "user.email", "t@example.com"]);
		gitAt(repo, ["config", "user.name", "t"]);
		writeFileSync(join(repo, "a.txt"), "one\n");
		gitAt(repo, ["add", "a.txt"]);
		gitAt(repo, ["commit", "-q", "-m", "init"]);
		gitAt(repo, ["checkout", "-q", "-b", "ops/x"]);
		mkdirSync(join(repo, "ops"), { recursive: true });
		writeFileSync(join(repo, "ops", "x"), "branch work\n");
		gitAt(repo, ["add", "ops/x"]);
		gitAt(repo, ["commit", "-q", "-m", "branch commit"]);

		expect(wipBackup([], cfg, () => "private")).toBe(0);

		const local = gitAt(repo, ["rev-parse", "refs/heads/ops/x"]).trim();
		expect(gitAt(remote, ["rev-parse", "refs/heads/Work_demo/ops/x"]).trim()).toBe(local);
		const log = readFileSync(cfg.wip.backup_log, "utf8");
		expect(log).toContain("repos failed: 0");
	} finally {
		process.env.HOME = origHome;
	}
});
