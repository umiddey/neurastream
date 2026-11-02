import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { wipBackup } from "../src/core/wip-backup.ts";
import { backupVisibility } from "../src/core/wip-private.ts";

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

		expect(wipBackup([], cfg, () => "private")).toBe(0);

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

// P2: a corrupt repo is recorded, never fatal — the healthy repo is still pushed, and the log and
// wip-last.json name the failure.
test("a corrupt repo is recorded and backup still pushes the healthy repo", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-backup-isolation-"));
	DIRS.push(base);
	const home = join(base, "home");
	const root = join(home, "Work");
	const bad = join(root, "bad");
	const repo = join(root, "good");
	const remote = join(base, "backup.git");
	mkdirSync(bad, { recursive: true });
	writeFileSync(join(bad, ".git"), "junk\n");

	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".local/bin/git-secret-gate"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(home, ".local/bin/git-secret-gate"), 0o755);

	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.backup_url = remote;
	cfg.wip.backup_log = join(root, "WIP-BACKUP.md");
	cfg.wip.secret_gate = join(home, ".local/bin/git-secret-gate");
	cfg.paths.alert_state = join(home, "alerts");

	const origHome = process.env.HOME;
	process.env.HOME = home;
	try {
		git(["init", "-q", "--bare", remote], base);
		mkdirSync(repo, { recursive: true });
		git(["init", "-q", "-b", "main"], repo);
		git(["config", "user.email", "t@example.com"], repo);
		git(["config", "user.name", "t"], repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(["add", "a.txt"], repo);
		git(["commit", "-m", "init"], repo);
		git(["update-ref", "refs/wip/Work_good/20261102-1200", "HEAD"], repo);

		expect(wipBackup([], cfg, () => "private")).toBe(1);

		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"], remote).split("\n").filter(Boolean)).toEqual([
			"refs/heads/wip/Work_good",
		]);
		const log = readFileSync(cfg.wip.backup_log, "utf8");
		expect(log).toContain("repos failed: 1");
		expect(log).toContain(`FAILED: ${bad}: git rev-parse --git-common-dir: fatal: invalid gitfile format: ${join(bad, ".git")}`);

		const last = JSON.parse(readFileSync(join(cfg.paths.alert_state, "wip-last.json"), "utf8")).backup as {
			kind: string;
			ok: boolean;
			failed: string[];
			refused: string | null;
		};
		expect(last.kind).toBe("backup");
		expect(last.ok).toBe(false);
		expect(last.refused).toBeNull();
		expect(last.failed).toHaveLength(1);
	} finally {
		process.env.HOME = origHome;
	}
});

// A temp home with one repo under Work and a local bare backup target: no network, no real home.
function target(name: string): { cfg: Config; repo: string; remote: string } {
	const base = mkdtempSync(join(tmpdir(), name));
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
	cfg.paths.alert_state = join(home, "alerts");
	cfg.paths.queue_state = join(home, "queue");
	git(["init", "-q", "--bare", remote], base);
	git(["init", "-q", "-b", "main"], repo);
	git(["config", "user.email", "t@example.com"], repo);
	git(["config", "user.name", "t"], repo);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(["add", "a.txt"], repo);
	git(["commit", "-m", "init"], repo);
	git(["update-ref", "refs/wip/Work_demo/20261102-1200", "HEAD"], repo);
	return { cfg, repo, remote };
}

function ghAnswer(out: string, code = 0) {
	return backupVisibility("git@github.com:o/r.git", () => ({ code, stdout: out, stderr: "" }));
}

function probeRun(code: number, out: string) {
	return () => ({ code, stdout: out, stderr: "" });
}

// P3: only the exact answer "private" marks a target safe to push to. The URL is parsed first, so a
// hostile or malformed one never reaches a command.
test("backupVisibility parses the URL first and asks gh for a github repo", () => {
	const calls: string[][] = [];
	const run = (argv: string[]) => {
		calls.push(argv);
		return { code: 0, stdout: "private\n", stderr: "" };
	};
	expect(backupVisibility("git@github.com:owner/repo.git", run)).toBe("private");
	expect(calls).toEqual([["gh", "api", "repos/owner/repo", "--jq", ".visibility"]]);
	calls.length = 0;
	expect(backupVisibility("https://github.com/owner/repo", run)).toBe("private");
	expect(calls).toEqual([["gh", "api", "repos/owner/repo", "--jq", ".visibility"]]);
	calls.length = 0;
	for (const bad of [
		"https://github.com/owner/../repo",
		"https://github.com/owner/repo?x=1",
		"https://github.com/owner/repo#frag",
		"https://github.com/owner/re%70o",
		"https://github.com/owner//repo",
		"https://github.com/owner/",
		"https://github.com/",
		"not a url",
		"",
	]) {
		expect(backupVisibility(bad, run)).toBe("unknown");
	}
	expect(calls).toEqual([]);
});

test("backupVisibility counts only private; internal, public, errors and bad JSON are not", () => {
	expect(ghAnswer("public\n")).toBe("public");
	expect(ghAnswer("internal\n")).toBe("internal");
	expect(ghAnswer("Private\n")).toBe("unknown");
	expect(ghAnswer("")).toBe("unknown");
	expect(ghAnswer("private\n", 1)).toBe("unknown");

	const calls: string[][] = [];
	expect(
		backupVisibility("git@gitlab.com:group/sub/repo.git", (argv) => {
			calls.push(argv);
			return { code: 0, stdout: JSON.stringify({ visibility: "private" }), stderr: "" };
		}),
	).toBe("private");
	expect(calls).toEqual([["glab", "api", "projects/group%2Fsub%2Frepo"]]);
	expect(backupVisibility("git@gitlab.com:group/repo.git", () => ({ code: 0, stdout: "not json", stderr: "" }))).toBe("unknown");

	// an unknown host is settled by wip.private_check: exit 0 and exactly "private"; empty setting is unknown
	expect(backupVisibility("git@git.example.com:o/r.git", probeRun(0, "private\n"))).toBe("unknown");
	expect(backupVisibility("git@git.example.com:o/r.git", probeRun(0, "private\n"), "check --probe")).toBe("private");
	expect(backupVisibility("git@git.example.com:o/r.git", probeRun(0, "yes\n"), "check")).toBe("unknown");
	expect(backupVisibility("git@git.example.com:o/r.git", probeRun(1, "private\n"), "check")).toBe("unknown");
	// a local path is not a remote URL: fail closed, never guess
	expect(backupVisibility("/tmp/backup.git", probeRun(0, "private\n"), "check")).toBe("unknown");
});

// P3: the check runs first, so a public or internal target pushes nothing and says why.
test("wip-backup refuses a target that is not verifiably private", () => {
	const { cfg, remote } = target("wip-backup-refuse-");
	const run = (visibility: "private" | "public" | "internal" | "unknown") => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		};
		try {
			return { code: wipBackup([], cfg, () => visibility), logs: logs.join("\n") };
		} finally {
			console.log = orig;
		}
	};

	const refused = run("public");
	expect(refused.code).toBe(1);
	expect(refused.logs).toContain(`Backup stopped: ${remote} is public. Make it private; nothing was uploaded.`);
	const last = JSON.parse(readFileSync(join(cfg.paths.alert_state, "wip-last.json"), "utf8")).backup as {
		ok: boolean;
		refused: string | null;
		failed: string[];
	};
	expect(last.ok).toBe(false);
	expect(last.refused).toBe(`${remote} is public`);
	expect(last.failed).toEqual([]);

	// internal is not private either, and repeating the state updates one incident instead of adding one
	expect(run("internal").logs).toContain(`Backup stopped: ${remote} is internal.`);
	expect(run("internal").code).toBe(1);
	const incidents = readFileSync(join(cfg.paths.queue_state, "incidents.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { kind: string; count: number; fingerprint: string });
	expect(incidents).toHaveLength(1);
	expect(incidents[0]).toMatchObject({ kind: "wip-backup-refused", count: 3, fingerprint: `wip-backup-refused:${remote}` });

	// nothing was ever pushed
	expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/"], remote).trim()).toBe("");
});

// P3: wip.private_check is the real runner's answer for a host it does not know.
test("wip-backup asks wip.private_check about an unknown host before pushing", () => {
	const { cfg, remote } = target("wip-backup-check-");
	cfg.wip.backup_url = "git@git.example.com:owner/repo.git";
	cfg.wip.private_check = join(cfg.paths.home, ".local/bin/private-check");
	// the URL is the last argv; anything but exactly "private" on exit 0 is not private
	const seen = join(cfg.paths.home, "probe-args");
	writeFileSync(cfg.wip.private_check, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\necho public\n`);
	chmodSync(cfg.wip.private_check, 0o755);

	const orig = console.log;
	console.log = () => {};
	let code = 0;
	try {
		code = wipBackup([], cfg);
	} finally {
		console.log = orig;
	}
	expect(code).toBe(1);
	expect(readFileSync(seen, "utf8").trim()).toBe("git@git.example.com:owner/repo.git");
	const last = JSON.parse(readFileSync(join(cfg.paths.alert_state, "wip-last.json"), "utf8")).backup as { refused: string | null };
	expect(last.refused).toBe("git@git.example.com:owner/repo.git is unknown");
	expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/"], remote).trim()).toBe("");
});

// P8 (plan 20261027_1130): a repo with its own failing pre-push gate stays skipped - hooks are
// never bypassed by default - unless its origin is listed exactly in wip.backup_hook_off, and the
// skip line says so. The origin match is `host/owner` or `host/owner/repo`, never a substring.

// A repo with a failing pre-push hook, a GitHub origin, and one hidden save; nothing uploaded yet.
function hookSandbox(): { home: string; repo: string; remote: string; cfg: Config } {
	const base = mkdtempSync(join(tmpdir(), "wip-backup-hook-"));
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
	cfg.wip.backup_hook_off = [];
	git(["init", "-q", "--bare", remote], base);
	git(["init", "-q", "-b", "main"], repo);
	git(["config", "user.email", "t@example.com"], repo);
	git(["config", "user.name", "t"], repo);
	git(["remote", "add", "origin", "git@github.com:owner/repo.git"], repo);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(["add", "a.txt"], repo);
	git(["commit", "-m", "init"], repo);
	writeFileSync(join(repo, ".git/hooks/pre-push"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(repo, ".git/hooks/pre-push"), 0o755);
	git(["update-ref", "refs/wip/Work_demo/20261102-1200", "HEAD"], repo);
	return { home, repo, remote, cfg };
}

function withHome<T>(home: string, fn: () => T): T {
	const orig = process.env.HOME;
	process.env.HOME = home;
	try {
		return fn();
	} finally {
		process.env.HOME = orig;
	}
}

const HOOK_LINE = "Work_demo: whole repo (has a pre-push gate; not bypassed — add its origin to wip.backup_hook_off to back it up)";

test("a repo with its own pre-push gate is skipped and the line says how to opt in", () => {
	const s = hookSandbox();
	withHome(s.home, () => {
		expect(wipBackup([], s.cfg, () => "private")).toBe(0);
		expect(readFileSync(s.cfg.wip.backup_log, "utf8")).toContain(HOOK_LINE);
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], s.remote).trim()).toBe("");
		const last = JSON.parse(readFileSync(join(s.cfg.paths.alert_state, "wip-last.json"), "utf8")) as { backup: { skipped: number } };
		expect(last.backup.skipped).toBeGreaterThan(0);
	});
});

test("an origin listed in wip.backup_hook_off is backed up despite its gate", () => {
	const s = hookSandbox();
	s.cfg.wip.backup_hook_off = ["github.com/owner"];
	withHome(s.home, () => {
		expect(wipBackup([], s.cfg, () => "private")).toBe(0);
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"], s.remote).trim()).toBe("refs/heads/wip/Work_demo");
		expect(readFileSync(s.cfg.wip.backup_log, "utf8")).not.toContain("has a pre-push gate");
	});
});

test("the full host/owner/repo entry matches too", () => {
	const s = hookSandbox();
	s.cfg.wip.backup_hook_off = ["github.com/owner/repo"];
	withHome(s.home, () => {
		expect(wipBackup([], s.cfg, () => "private")).toBe(0);
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/wip/"], s.remote).trim()).toBe("refs/heads/wip/Work_demo");
	});
});

test("a substring entry never opts a repo in", () => {
	const s = hookSandbox();
	s.cfg.wip.backup_hook_off = ["git", "owner", "github.com"];
	withHome(s.home, () => {
		expect(wipBackup([], s.cfg, () => "private")).toBe(0);
		expect(readFileSync(s.cfg.wip.backup_log, "utf8")).toContain(HOOK_LINE);
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], s.remote).trim()).toBe("");
	});
});

test("an empty wip.backup_hook_off entry is a config error", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-backup-hookcfg-"));
	DIRS.push(base);
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	const file = join(home, "config.yml");
	writeFileSync(file, "wip:\n  backup_hook_off:\n    - \"\"\n");
	expect(() => loadConfig({ home, file, env: {} })).toThrow(/backup_hook_off/);
	writeFileSync(file, "wip:\n  backup_hook_off:\n    - \"   \"\n");
	expect(() => loadConfig({ home, file, env: {} })).toThrow(/backup_hook_off/);
});

test("a ref with a secret pattern is still refused", () => {
	const s = hookSandbox();
	s.cfg.wip.backup_hook_off = ["github.com/owner"];
	writeFileSync(s.cfg.wip.secret_gate, "#!/bin/sh\nexit 1\n");
	chmodSync(s.cfg.wip.secret_gate, 0o755);
	withHome(s.home, () => {
		expect(wipBackup([], s.cfg, () => "private")).toBe(0);
		expect(readFileSync(s.cfg.wip.backup_log, "utf8")).toContain("(secret pattern in unpushed commits)");
		expect(git(["for-each-ref", "--format=%(refname)", "refs/heads"], s.remote).trim()).toBe("");
	});
});
