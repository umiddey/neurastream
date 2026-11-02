import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { wipSnapshot } from "../src/core/wip-snapshot.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

function sandbox(name: string) {
	const base = mkdtempSync(join(tmpdir(), name));
	DIRS.push(base);
	const home = join(base, "home");
	const root = join(home, "Work");
	mkdirSync(root, { recursive: true });
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.status_log = join(root, "WIP-STATUS.md");
	cfg.paths.alert_state = join(home, "alerts");
	return { root, cfg };
}

/** A repo with one commit and one unsaved tracked edit: the minimal thing a snapshot saves. */
function dirtyRepo(path: string): void {
	mkdirSync(path, { recursive: true });
	git(["init", "-q", "-b", "main"], path);
	git(["config", "user.email", "t@example.com"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "a.txt"), "one\n");
	git(["add", "a.txt"], path);
	git(["commit", "-m", "init"], path);
	writeFileSync(join(path, "a.txt"), "two\n");
}

function wipLast(cfg: Config): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cfg.paths.alert_state, "wip-last.json"), "utf8")) as Record<string, unknown>;
}

// P2: one broken repo never kills the run. A `.git` replaced by a junk file makes every git call
// in that repo fail; the healthy worktree next to it is still saved and the failure is recorded.
test("a corrupt repo is recorded and the run still saves a healthy worktree", () => {
	const { root, cfg } = sandbox("wip-isolation-");
	const bad = join(root, "bad");
	const good = join(root, "good");
	mkdirSync(bad, { recursive: true });
	writeFileSync(join(bad, ".git"), "junk\n");
	dirtyRepo(good);

	expect(wipSnapshot(["--quiet"], cfg)).toBe(1);

	// the healthy worktree was still saved, and left untouched
	const refs = git(["for-each-ref", "--format=%(refname)", "refs/wip/Work_good/"], good).split("\n").filter(Boolean);
	expect(refs).toHaveLength(1);
	expect(git(["status", "--porcelain"], good)).toBe(" M a.txt\n");

	// the corrupt repo's failure is one line, in the log and in the state file
	const failure = `FAILED: ${bad}: git rev-parse --git-common-dir: fatal: invalid gitfile format: ${join(bad, ".git")}`;
	const log = readFileSync(cfg.wip.status_log, "utf8");
	expect(log).toContain(failure);
	expect(log).toContain("Snapshot: 1 new, 0 unchanged since last, 1 failed.");

	const last = wipLast(cfg);
	expect(Object.keys(last).toSorted()).toEqual(["at", "failed", "kind", "ok", "refused"]);
	expect(last.kind).toBe("snapshot");
	expect(last.ok).toBe(false);
	expect(last.refused).toBeNull();
	expect(typeof last.at).toBe("number");
	expect(last.failed).toEqual([failure]);
});

test("a healthy run writes ok:true with no failures and exits 0", () => {
	const { root, cfg } = sandbox("wip-healthy-");
	dirtyRepo(join(root, "good"));

	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);

	expect(readFileSync(cfg.wip.status_log, "utf8")).toContain("Snapshot: 1 new, 0 unchanged since last, 0 failed.");
	expect(wipLast(cfg)).toMatchObject({ kind: "snapshot", ok: true, failed: [], refused: null });
});

test("an empty wip.roots writes a refused state and still exits 0", () => {
	const { cfg } = sandbox("wip-refused-");
	cfg.wip.roots = [];

	expect(wipSnapshot(["--quiet"], cfg)).toBe(0);

	expect(wipLast(cfg)).toMatchObject({ kind: "snapshot", ok: false, failed: [], refused: "no wip.roots set" });
});
