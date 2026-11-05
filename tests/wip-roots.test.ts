import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, loadConfig } from "../src/core/config.ts";
import { keyOf, wipRepos } from "../src/core/wip-roots.ts";
import { wipSnapshot } from "../src/core/wip-snapshot.ts";
import { wipBackup } from "../src/core/wip-backup.ts";
import { runWip } from "../src/cli/wip.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("nested repo at depth 2 found", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-nested-"));
	DIRS.push(root);
	const sub = join(root, "sub");
	const repo = join(sub, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.depth = 3;

	const repos = wipRepos(cfg);
	expect(repos).toEqual([repo]);
});

test("depth limit honoured", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-depth-"));
	DIRS.push(root);
	const deepRepo = join(root, "level1", "level2", "level3", "repo");
	mkdirSync(join(deepRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];

	cfg.wip.depth = 3;
	expect(wipRepos(cfg)).toEqual([]);

	cfg.wip.depth = 4;
	expect(wipRepos(cfg)).toEqual([deepRepo]);
});

test("repo entry found when root itself has .git", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-repo-entry-"));
	DIRS.push(root);
	const repo = join(root, "my-repo");
	mkdirSync(join(repo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [repo];

	expect(wipRepos(cfg)).toEqual([repo]);
});

test("node_modules skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-nm-"));
	DIRS.push(root);
	const nmRepo = join(root, "node_modules", "some-pkg");
	mkdirSync(join(nmRepo, ".git"), { recursive: true });
	const realRepo = join(root, "src-repo");
	mkdirSync(join(realRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.depth = 3;

	expect(wipRepos(cfg)).toEqual([realRepo]);
});

test("never walks inside a found repo", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-inside-repo-"));
	DIRS.push(root);
	const outerRepo = join(root, "outer");
	mkdirSync(join(outerRepo, ".git"), { recursive: true });
	const innerRepo = join(outerRepo, "inner");
	mkdirSync(join(innerRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];

	expect(wipRepos(cfg)).toEqual([outerRepo]);
});

test("empty roots message: wip-snapshot and wip-backup exit 0 and print advice", () => {
	const home = mkdtempSync(join(tmpdir(), "wip-roots-empty-"));
	DIRS.push(home);
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	expect(cfg.wip.roots).toEqual([]);

	const linesSnap: string[] = [];
	const origLog = console.log;
	console.log = (s: string) => linesSnap.push(String(s));
	try {
		const code = wipSnapshot([], cfg);
		expect(code).toBe(0);
		expect(linesSnap).toEqual(["wip: no wip.roots set — run `neurastream wip add <path>`"]);
	} finally {
		console.log = origLog;
	}

	const linesBackup: string[] = [];
	console.log = (s: string) => linesBackup.push(String(s));
	try {
		const code = wipBackup([], cfg);
		expect(code).toBe(0);
		expect(linesBackup).toEqual(["wip: no wip.roots set — run `neurastream wip add <path>`"]);
	} finally {
		console.log = origLog;
	}
});

test("add/remove/list round-trip keeps comments", () => {
	const home = mkdtempSync(join(tmpdir(), "wip-cli-"));
	DIRS.push(home);
	const file = configFile(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });

	const original = [
		"# Header comment",
		"paths:",
		'  home: "~"',
		"# Section comment for wip",
		"wip:",
		"  roots: []   # inline comment",
		"  depth: 3",
		"# Footer comment",
		"",
	].join("\n");
	writeFileSync(file, original);

	const listOutput: string[] = [];
	const origLog = console.log;
	console.log = (s: string) => listOutput.push(String(s));
	try {
		// List initially empty
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual([]);

		// Add /path/one
		expect(runWip(["add", "/path/one"], home)).toBe(0);
		const content1 = readFileSync(file, "utf8");
		expect(content1).toContain("# Header comment");
		expect(content1).toContain("# Section comment for wip");
		expect(content1).toContain("# Footer comment");
		expect(content1).toContain('roots: ["/path/one"]');

		// List shows /path/one
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/one"]);

		// Add /path/two
		expect(runWip(["add", "/path/two"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/one", "/path/two"]);

		// Remove /path/one
		expect(runWip(["remove", "/path/one"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/two"]);

		// Remove /path/two
		expect(runWip(["remove", "/path/two"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual([]);

		// Comments survived the full round trip
		const finalContent = readFileSync(file, "utf8");
		expect(finalContent).toContain("# Header comment");
		expect(finalContent).toContain("# Section comment for wip");
		expect(finalContent).toContain("# Footer comment");
	} finally {
		console.log = origLog;
	}
});

test("keyOf resolves symlinks in home and path", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-keyof-"));
	DIRS.push(base);
	const realHome = join(base, "real-home");
	const symHome = join(base, "sym-home");
	mkdirSync(join(realHome, "Work/demo-wt"), { recursive: true });
	symlinkSync(realHome, symHome);

	const key = keyOf(join(symHome, "Work/demo-wt"), symHome);
	expect(key).toBe("Work_demo-wt");
});

test("keyOf gives a valid ref component for a worktree outside home, under a dot dir, or named .lock", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-keyref-"));
	DIRS.push(base);
	const home = join(base, "home");
	const outside = join(base, "elsewhere/neighbor-wt");
	const dotDir = join(home, ".omp/agent-wt");
	const lockName = join(home, "Work/x.lock");
	for (const d of [outside, dotDir, lockName]) mkdirSync(d, { recursive: true });

	expect(keyOf(outside, home)).toBe("elsewhere_neighbor-wt");
	for (const wt of [outside, dotDir, lockName]) {
		const ref = `refs/wip/${keyOf(wt, home)}/20261105-2302`;
		expect(spawnSync("git", ["check-ref-format", ref]).status, ref).toBe(0);
	}
});

// The retired golden "wip-snapshot matches the original" protected this: a snapshot saves the
// unsaved work as a hidden commit without touching the worktree or its index. P1 moved the repo
// walk to wip.roots, so the oracle comparison is gone; the protection stays, import-driven.
test("wip-snapshot over a wip.roots repo leaves the worktree and its index untouched and writes refs/wip/<key>/<stamp>", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-snap-guard-"));
	DIRS.push(base);
	const home = join(base, "home");
	const repo = join(home, "Work/demo");
	mkdirSync(repo, { recursive: true });
	const g = (args: string[]): string => {
		const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};

	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".local/bin/wip-check"), "#!/bin/sh\necho ok\n");
	chmodSync(join(home, ".local/bin/wip-check"), 0o755);

	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [join(home, "Work")];
	cfg.wip.status_log = join(home, "Work/WIP-STATUS.md");

	const origHome = process.env.HOME;
	const origPath = process.env.PATH;
	process.env.HOME = home;
	process.env.PATH = `${join(home, ".local/bin")}:${origPath ?? ""}`;
	try {
		g(["init", "-b", "main"]);
		g(["config", "user.email", "t@example.com"]);
		g(["config", "user.name", "t"]);
		writeFileSync(join(repo, "a.txt"), "one\n");
		g(["add", "a.txt"]);
		g(["commit", "-m", "init"]);
		writeFileSync(join(repo, "a.txt"), "two\n"); // dirty tracked change
		writeFileSync(join(repo, "note.txt"), "note\n"); // untracked, belongs in the save
		writeFileSync(join(repo, ".env"), "SECRET=1\n"); // secret-named, must NOT be saved

		const before = g(["status", "--porcelain"]);
		expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
		expect(g(["status", "--porcelain"])).toBe(before);

		const refs = g(["for-each-ref", "--format=%(refname)", "refs/wip/Work_demo/"]).split("\n").filter(Boolean);
		expect(refs).toHaveLength(1);
		const ref = refs[0]!;
		expect(ref).toMatch(/^refs\/wip\/Work_demo\/\d{8}-\d{4}$/);
		expect(g(["rev-parse", "--verify", `${ref}^{commit}`]).trim()).toMatch(/^[0-9a-f]{40,}$/);
		// hidden: the save commit is reachable from no branch
		expect(Number(g(["rev-list", "--count", `refs/heads/main..${ref}`]))).toBeGreaterThan(0);
		// it saved the unsaved work: the tracked edit and the new file, never the secret-named file
		const tree = g(["ls-tree", "-r", "--name-only", ref]);
		expect(tree).toContain("note.txt");
		expect(tree).not.toContain(".env");
		expect(g(["show", `${ref}:a.txt`])).toBe("two\n");
	} finally {
		process.env.HOME = origHome;
		process.env.PATH = origPath;
	}
});

function gitAt(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

// P8b (plan 20261027_1130): a HOME reached through a symlink must still name a worktree the same
// way for the snapshot, the backup and the restore - one key, Work_demo-wt, built from the
// realpath of home and worktree instead of string-replacing a home prefix.
test("a HOME reached through a symlink gives the worktree its plain key", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-symlink-"));
	DIRS.push(base);
	const real = join(base, "real");
	const link = join(base, "link");
	mkdirSync(real, { recursive: true });
	symlinkSync(real, link);
	const repo = join(link, "Work/demo");
	mkdirSync(repo, { recursive: true });
	const remote = join(base, "backup.git");
	gitAt(base, ["init", "-q", "--bare", remote]);
	gitAt(repo, ["init", "-q", "-b", "main"]);
	gitAt(repo, ["config", "user.email", "t@example.com"]);
	gitAt(repo, ["config", "user.name", "t"]);
	writeFileSync(join(repo, "a.txt"), "one\n");
	gitAt(repo, ["add", "a.txt"]);
	gitAt(repo, ["commit", "-q", "-m", "init"]);
	const wt = join(link, "Work/demo-wt");
	gitAt(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
	writeFileSync(join(wt, "b.txt"), "unsaved\n");
	const cfg = loadConfig({ home: link, file: join(link, "config.yml"), env: {} });
	mkdirSync(cfg.paths.alert_state, { recursive: true });
	mkdirSync(join(cfg.paths.home, ".local/state/neurastream"), { recursive: true });
	mkdirSync(join(cfg.paths.home, ".local/bin"), { recursive: true });
	writeFileSync(cfg.wip.secret_gate, "#!/bin/sh\nexit 0\n");
	chmodSync(cfg.wip.secret_gate, 0o755);
	cfg.wip.roots = [join(link, "Work")];
	cfg.wip.backup_url = remote;
	cfg.wip.backup_log = join(base, "WIP-BACKUP.md");
	const origHome = process.env.HOME;
	process.env.HOME = link;
	try {
		expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
		const keys = gitAt(repo, ["for-each-ref", "--format=%(refname)", "refs/wip"]).trim().split("\n");
		expect(keys.some(r => r.startsWith("refs/wip/Work_demo-wt/"))).toBe(true);
		expect(keys.every(r => r.startsWith("refs/wip/Work_demo-wt/"))).toBe(true);
		expect(wipBackup([], cfg, () => "private")).toBe(0);
		expect(gitAt(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/wip"]).trim()).toContain("refs/heads/wip/Work_demo-wt");
	} finally {
		process.env.HOME = origHome;
	}
});
