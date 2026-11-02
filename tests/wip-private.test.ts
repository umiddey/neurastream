import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { wipBackup } from "../src/core/wip-backup.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

// The retired golden "wip-backup matches the original" protected this: backup pushes the newest
// wip saves to the configured backup URL and writes the log. P1 moved the repo walk to wip.roots,
// so the oracle comparison is gone; the protection stays, import-driven.
test("wip-backup pushes refs/heads/wip/<key> to the backup URL and writes the log", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-backup-guard-"));
	DIRS.push(base);
	const home = join(base, "home");
	const repo = join(home, "Work/demo");
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

	const origHome = process.env.HOME;
	process.env.HOME = home;
	try {
		git(["init", "-q", "--bare", remote], base);
		git(["init", "-q", "-b", "main"], repo);
		git(["config", "user.email", "t@example.com"], repo);
		git(["config", "user.name", "t"], repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(["add", "a.txt"], repo);
		git(["commit", "-m", "init"], repo);
		// a save exactly as wip-snapshot leaves it: a hidden ref, nothing pushed anywhere yet
		git(["update-ref", "refs/wip/Work_demo/20261102-1200", "HEAD"], repo);

		expect(wipBackup([], cfg)).toBe(0);

		// the backup got the newest save under refs/heads/wip/<key>, same commit as the source ref
		const local = git(["rev-parse", "refs/wip/Work_demo/20261102-1200"], repo).trim();
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"], remote).split("\n").filter(Boolean)).toEqual(["refs/heads/wip/Work_demo"]);
		expect(git(["rev-parse", "refs/heads/wip/Work_demo"], remote).trim()).toBe(local);

		// the log is written and names the target and the push
		const log = readFileSync(cfg.wip.backup_log, "utf8");
		expect(log).toContain(`Target: ${remote}`);
		expect(log).toContain("- Work_demo: +refs/wip/Work_demo/20261102-1200:refs/heads/wip/Work_demo");
	} finally {
		process.env.HOME = origHome;
	}
});
