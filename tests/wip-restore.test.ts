// P7 (plan 20261027_1130): `wip restore` lists a worktree's saves newest first, restores one into
// the worktree, and saves a dirty worktree first. Real git in a temp repo; no network, no HOME.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { wipRestore, wipSaves } from "../src/core/wip-restore.ts";
import { wipSnapshot } from "../src/core/wip-snapshot.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

/** A temp HOME holding one repo with a.txt committed as "one", and the config that names it. */
function sandbox(): { home: string; repo: string; cfg: Config } {
	const base = mkdtempSync(join(tmpdir(), "wip-restore-"));
	DIRS.push(base);
	const home = join(base, "home");
	const repo = join(home, "Work/demo");
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "t@example.com"]);
	git(repo, ["config", "user.name", "T"]);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "one"]);
	const cfg = loadConfig({ home, env: {} });
	// init creates the state dirs; a temp HOME must, or the snapshot cannot write its status log.
	mkdirSync(dirname(cfg.wip.status_log), { recursive: true });
	mkdirSync(cfg.paths.alert_state, { recursive: true });
	cfg.wip.roots = [repo];
	return { home, repo, cfg };
}

/** Runs fn with console.log captured, returning the exit code and what it printed. */
function capture(fn: () => number): { code: number; lines: string[] } {
	const lines: string[] = [];
	const real = console.log;
	console.log = (line: string) => lines.push(line);
	try {
		return { code: fn(), lines };
	} finally {
		console.log = real;
	}
}

/** Ages the one save by moving its ref to an older stamp, as a save from another day would be named. */
function reAge(repo: string, key: string, stamp: string): void {
	const ref = git(repo, ["for-each-ref", "--format=%(refname)", `refs/wip/${key}/`])
		.split("\n")
		.find(line => line !== "");
	if (!ref) throw new Error("reAge: no save to age");
	const sha = git(repo, ["rev-parse", ref]).trim();
	git(repo, ["update-ref", `refs/wip/${key}/${stamp}`, sha]);
	git(repo, ["update-ref", "-d", ref]);
}

test("list shows the saves newest first with their counts", () => {
	const { repo, cfg } = sandbox();
	writeFileSync(join(repo, "a.txt"), "two\n");
	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
	reAge(repo, "Work_demo", "20261101-1200");
	writeFileSync(join(repo, "b.txt"), "new\n");
	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
	const { code, lines } = capture(() => wipRestore([repo], cfg));
	expect(code).toBe(0);
	expect(lines).toHaveLength(3);
	expect(lines[0]).not.toContain("20261101-1200");
	expect(lines[0]).toContain("[main]");
	expect(lines[0]).toContain("changed paths");
	expect(lines[1]).toContain("20261101-1200");
	expect(lines[1]).toContain("1 changed paths");
	expect(lines[2]).toContain("--pick N");
}, 30_000);

test("restore brings back a deleted file and saves the dirty worktree first", () => {
	const { repo, cfg } = sandbox();
	writeFileSync(join(repo, "a.txt"), "two\n");
	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
	reAge(repo, "Work_demo", "20261101-1200");
	rmSync(join(repo, "a.txt")); // the worktree is now dirty: a deletion
	const { code, lines } = capture(() => wipRestore([repo, "--pick", "1"], cfg));
	expect(code).toBe(0);
	expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
	expect(lines[0]).toMatch(/^saved refs\/wip\/Work_demo\/\d{8}-\d{4} before restoring$/);
	expect(lines[1]).toBe(`restored refs/wip/Work_demo/20261101-1200 into ${repo}`);
	// The pre-restore save kept the deletion, so nothing is lost: two saves now, newest first.
	const after = wipSaves(repo, cfg.paths.home);
	expect(after).toHaveLength(2);
	expect(after[1]!.ref).toBe("refs/wip/Work_demo/20261101-1200");
}, 30_000);

test("a clean worktree restores without making a new save", () => {
	const { repo, cfg } = sandbox();
	writeFileSync(join(repo, "a.txt"), "two\n");
	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
	git(repo, ["checkout", "--", "."]); // back to the committed state: clean
	const before = wipSaves(repo, cfg.paths.home).length;
	const { code, lines } = capture(() => wipRestore([repo, "--pick", "1"], cfg));
	expect(code).toBe(0);
	expect(lines[0]).toContain("restored ");
	expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
	expect(wipSaves(repo, cfg.paths.home)).toHaveLength(before);
}, 30_000);

test("a pick outside the list is a usage error", () => {
	const { repo, cfg } = sandbox();
	writeFileSync(join(repo, "a.txt"), "two\n");
	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);
	expect(capture(() => wipRestore([repo, "--pick", "0"], cfg)).code).toBe(2);
	expect(capture(() => wipRestore([repo, "--pick", "9"], cfg)).code).toBe(2);
}, 30_000);
