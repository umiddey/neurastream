import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { keyOf } from "../src/core/wip-roots.ts";
import { pruneWip } from "../src/core/wip-snapshot.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY_MS = 86_400_000;

function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

/** A repo with one commit, a wip root that contains it, and the ref helpers prune works on. */
function sandbox(name: string) {
	const base = mkdtempSync(join(tmpdir(), name));
	DIRS.push(base);
	const home = join(base, "home");
	const root = join(home, "Work");
	const repo = join(root, "demo");
	mkdirSync(repo, { recursive: true });
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.paths.alert_state = join(home, "alerts");
	git(["init", "-q", "-b", "main"], repo);
	git(["config", "user.email", "t@example.com"], repo);
	git(["config", "user.name", "t"], repo);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(["add", "a.txt"], repo);
	git(["commit", "-m", "init"], repo);
	return { cfg, repo };
}

/** A save stamp `daysAgo` days back at `hour`: the same shape wip-snapshot writes. */
function stamp(daysAgo: number, hour: number): string {
	const today = Date.UTC(
		Number(strftime(nowSec(), "%Y")),
		Number(strftime(nowSec(), "%m")) - 1,
		Number(strftime(nowSec(), "%d")),
	);
	return `${strftime((today - daysAgo * DAY_MS) / 1000, "%Y%m%d")}-${String(hour).padStart(2, "0")}00`;
}

function refsOf(repo: string, prefix: string): string[] {
	return git(["for-each-ref", "--format=%(refname)", prefix], repo).split("\n").filter(Boolean);
}

test("prune keeps the newest 48 saves plus one per older day, and never the newest", () => {
	const { cfg, repo } = sandbox("wip-prune-");
	const key = keyOf(repo, cfg.paths.home);
	// 100 hourly saves over 5 days: 20 per day
	for (let daysAgo = 4; daysAgo >= 0; daysAgo--) {
		for (let hour = 0; hour < 20; hour++) {
			git(["update-ref", `refs/wip/${key}/${stamp(daysAgo, hour)}`, "HEAD"], repo);
		}
	}

	pruneWip(cfg);

	const left = refsOf(repo, `refs/wip/${key}/`);
	// 48 newest + the newest save of the two days the hourly window does not reach
	expect(left).toHaveLength(50);
	expect(left).toContain(`refs/wip/${key}/${stamp(0, 19)}`); // newest of all
	expect(left).toContain(`refs/wip/${key}/${stamp(2, 12)}`); // the hourly window's oldest survivor
	expect(left).toContain(`refs/wip/${key}/${stamp(3, 19)}`); // daily representative, day -3
	expect(left).toContain(`refs/wip/${key}/${stamp(4, 19)}`); // daily representative, day -4
	expect(left).not.toContain(`refs/wip/${key}/${stamp(2, 0)}`); // past the hourly window, not that day's newest
	expect(left).not.toContain(`refs/wip/${key}/${stamp(4, 18)}`); // older than its day's representative
});

test("prune keeps a vanished worktree's saves for keep_days, then deletes them", () => {
	const { cfg, repo } = sandbox("wip-prune-gone-");
	const recent = stamp(3, 9);
	const stale = stamp(20, 9);
	git(["update-ref", `refs/wip/Work_gone/${recent}`, "HEAD"], repo);
	git(["update-ref", `refs/wip/Work_stale/${stale}`, "HEAD"], repo);

	pruneWip(cfg);

	expect(refsOf(repo, "refs/wip/Work_gone/")).toEqual([`refs/wip/Work_gone/${recent}`]);
	expect(refsOf(repo, "refs/wip/Work_stale/")).toEqual([]);
	// a live worktree's only save is its newest: never deleted
	expect(refsOf(repo, "refs/wip/Work_demo/")).toEqual([]);
});
