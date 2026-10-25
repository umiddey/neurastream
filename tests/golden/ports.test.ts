import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(dirname(import.meta.path)));
// The golden oracle scripts: the frozen snapshot of the live originals (never the live machine).
const LIVE = join(REPO, "tests/fixtures/originals/bin");
const ROOT = "/tmp/neurastream-home-golden";

// The oracles are frozen pre-scrub scripts: they hardcode the old ~/Work layout and the
// original backup remote. This sandbox config pins the same values so the port's effective
// paths equal the oracle's. The shipped template defaults stay scrubbed
// (tests/no-personal-markers.test.ts guards that); this file only aligns the comparison.
const LEGACY_CONFIG = `paths:
  work_roots: ["~/Work"]
  heavy_lock: "~/Work/.heavy-run.lock"
  heavy_owner: "~/Work/.heavy-run.owner"
  heavy_log: "~/Work/.heavy-run.log"
  heavy_idle_state: "~/Work/.heavy-run.idle-state"
wip:
  backup_url: "git@github.com:umiddey/wip-backup-clean.git"
  backup_log: "~/Work/WIP-BACKUP.md"
  status_log: "~/Work/WIP-STATUS.md"
`;

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function now(): string {
	return String(Date.now() / 1000);
}

function rewrite(name: string, dest: string, home: string, extra: [string, string][] = []): void {
	let text = readFileSync(join(LIVE, name), "utf8");
	const reps: [string, string][] = [
		["/home/ukd/.local/bin/git-secret-gate", join(home, ".local/bin/git-secret-gate")],
		["/home/ukd/Work/gf-testbed/pm-batch-logs/backend-last.log", join(home, "Work/gf-testbed/pm-batch-logs/backend-last.log")],
		["/home/ukd/Work/WIP-BACKUP.md", join(home, "Work/WIP-BACKUP.md")],
		["/home/ukd/Work/WIP-STATUS.md", join(home, "Work/WIP-STATUS.md")],
		["/home/ukd/Work", join(home, "Work")],
		["/home/ukd/projects", join(home, "projects")],
		["/home/ukd/", `${home}/`],
		["/home/ukd", home],
		...extra,
	];
	for (const [from, to] of reps) text = text.split(from).join(to);
	writeFileSync(dest, text);
	chmodSync(dest, 0o755);
}

function runPy(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
	const wrapper = `
import os, runpy, sys, time
fixed = float(os.environ["NEURASTREAM_NOW"])
time.time = lambda: fixed
_lt = time.localtime
time.localtime = lambda t=None: _lt(fixed if t is None else t)
_sf = time.strftime
def _strftime(fmt, t=None):
    return _sf(fmt, time.localtime() if t is None else t)
time.strftime = _strftime
sys.argv = ${JSON.stringify(["oracle", ...args])}
runpy.run_path(${JSON.stringify(script)}, run_name="__main__")
`;
	const r = spawnSync("python3", ["-c", wrapper], { env, cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runPort(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), cmd, ...args], { env, cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function homeFor(name: string): string {
	const home = join(ROOT, name);
	rmSync(home, { recursive: true, force: true });
	mkdirSync(join(home, "Work"), { recursive: true });
	mkdirSync(join(home, "projects"), { recursive: true });
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	return home;
}

function envFor(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), LEGACY_CONFIG);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		NEURASTREAM_NOW: now(),
		PATH: `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`,
		...extra,
	};
	delete env.WIP_LIMIT;
	delete env.WIP_DAYS;
	delete env.WIP_BACKUP_MAX_REPO_MB;
	delete env.WIP_SNAPSHOT_MAX_MB;
	return env;
}

function match(py: { code: number; stdout: string; stderr: string }, port: { code: number; stdout: string; stderr: string }) {
	expect(port.stderr).toBe(py.stderr);
	expect(port.stdout).toBe(py.stdout);
	expect(port.code).toBe(py.code);
}


test("oc-run matches the original", () => {
	const home = homeFor("oc");
	const env = envFor(home);
	const oracle = join(LIVE, "oc-run");
	const cwd = home;
	match(runPy(oracle, [], env, cwd), runPort("oc-run", [], env, cwd));
	match(runPy(oracle, ["AgentA", "--"], env, cwd), runPort("oc-run", ["AgentA", "--"], env, cwd));
	const args = ["AgentA", "--", "PLAN=demo", "echo", "hello"];
	const py = runPy(oracle, args, env, cwd);
	const portHome = homeFor("oc-port");
	const portEnv = { ...env, HOME: portHome, NEURASTREAM_NOW: env.NEURASTREAM_NOW };
	const port = runPort("oc-run", args, portEnv, cwd);
	expect(port.code).toBe(py.code);
	expect(port.stdout).toBe(py.stdout);
	const pyLog = readFileSync(join(home, ".local/state/agent-score/oc-runs.jsonl"), "utf8");
	const portLog = readFileSync(join(portHome, ".local/state/agent-score/oc-runs.jsonl"), "utf8");
	expect(portLog).toBe(pyLog);
});

test("wip-check matches the original", () => {
	const home = homeFor("wip");
	const env = envFor(home);
	const repo = join(home, "Work/demo");
	mkdirSync(repo, { recursive: true });
	spawnSync("git", ["init", "-b", "main"], { cwd: repo });
	spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
	spawnSync("git", ["config", "user.name", "t"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "a\n");
	spawnSync("git", ["add", "a.txt"], { cwd: repo });
	spawnSync("git", ["commit", "-m", "init"], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: "2026-10-18T00:00:00", GIT_COMMITTER_DATE: "2026-10-18T00:00:00" } });
	writeFileSync(join(repo, "a.txt"), "b\n");
	// A linked worktree next to its repo: git prints its common dir as an absolute path.
	spawnSync("git", ["worktree", "add", "-q", "-b", "wt", join(home, "Work/demo-wt")], { cwd: repo });
	const oracle = join(home, "wip-check.py");
	rewrite("wip-check", oracle, home);
	match(runPy(oracle, [], env), runPort("wip-check", [], env));
	match(runPy(oracle, ["--limit", "0"], env), runPort("wip-check", ["--limit", "0"], env));
	match(runPy(oracle, ["--all"], { ...env, WIP_DAYS: "1" }), runPort("wip-check", ["--all"], { ...env, WIP_DAYS: "1" }));
});

function touch(path: string, sec: number): void {
	utimesSync(path, sec, sec);
}

function stub(home: string, name: string, body: string): void {
	const path = join(home, ".local/bin", name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

function writeSession(home: string, rel: string, lines: string, mtime: number): void {
	const path = join(home, ".omp/agent/sessions", rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.endsWith("\n") ? lines : `${lines}\n`);
	touch(path, mtime);
}

function initRepo(repo: string, env: NodeJS.ProcessEnv): void {
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(repo, { recursive: true });
	const git = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
		const r = spawnSync("git", args, { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
	};
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@example.com"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(["add", "a.txt"]);
	git(["commit", "-m", "init"], { GIT_AUTHOR_DATE: "2026-10-18T00:00:00", GIT_COMMITTER_DATE: "2026-10-18T00:00:00" });
}

function head(repo: string): string {
	return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

function pinBoard(home: string): void {
	const dir = join(home, ".config/neurastream");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), "paths:\n  ranking_board: ~/.omp/agent/notes/subagent-ranking.md\n");
}

test("agent-ledger matches the original", () => {
	const home = homeFor("ledger");
	const fixed = "1760000000";
	const env = envFor(home, { NEURASTREAM_NOW: fixed });
	const oracle = join(LIVE, "agent-ledger");
	stub(home, "queue-check", "#!/bin/sh\nprintf '%s\\n' PR01\n");
	const usage = (provider: string, model: string, tokens: number, cache: number, cost: number, extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			message: {
				role: "assistant",
				provider,
				model,
				usage: { totalTokens: tokens, cacheRead: cache, cost: { total: cost } },
				...extra,
			},
		});
	writeSession(home, "proj/Quiet.jsonl", JSON.stringify({ customType: "session_exit" }), 1759992000);
	writeSession(
		home,
		"proj/DiedOne.jsonl",
		usage("openai-codex", "gpt", 2_000_000, 500_000, 3.5, { errorMessage: "quota exceeded\nstill going" }),
		1759999700,
	);
	writeSession(
		home,
		"proj/2026-10-18T12-00-00-000Z_abcd.jsonl",
		`${usage("anthropic", "claude", 1000, 0, 0.5, { stopReason: "end_turn" })}\n${JSON.stringify({ customType: "session_exit" })}`,
		1759999800,
	);
	writeSession(
		home,
		"proj/sub/WorkerA.jsonl",
		`${usage("zai", "glm-4.5", 1_500_000, 500_000, 1.25, { stopReason: "toolUse" })}\n${JSON.stringify({
			customType: "tool_execution_start",
			data: { toolName: "wait", intent: "waiting on the owner to answer" },
		})}`,
		1759999900,
	);
	writeSession(home, "proj/BudgetHog.jsonl", Array.from({ length: 101 }, () => usage("anthropic", "claude", 1000, 0, 1)).join("\n"), 1759999950);
	writeSession(home, "proj/old/Ancient.jsonl", usage("zai", "old", 10, 0, 1), 1750000000);
	for (const args of [[], ["--all"], ["--hours", "1"], ["--hours", "1", "--all"]]) {
		match(runPy(oracle, args, env), runPort("agent-ledger", args, env));
	}
	for (const args of [
		["--cap", "--priority"],
		["--cap"],
		["--cap", "--provider", "zai", "--slots", "1", "--priority"],
		["--cap", "--provider", "nope", "--slots", "1"],
		["--cap", "--provider"],
	]) {
		match(runPy(oracle, args, env), runPort("agent-ledger", args, env));
	}
});

test("agent-score matches the original", () => {
	const pyHome = homeFor("score-py");
	const portHome = homeFor("score-port");
	const fixed = "1760000000";
	const pyEnv = envFor(pyHome, { NEURASTREAM_NOW: fixed, GIT_AUTHOR_DATE: "2026-10-18T00:00:00", GIT_COMMITTER_DATE: "2026-10-18T00:00:00" });
	const portEnv = envFor(portHome, { NEURASTREAM_NOW: fixed, GIT_AUTHOR_DATE: "2026-10-18T00:00:00", GIT_COMMITTER_DATE: "2026-10-18T00:00:00" });
	pinBoard(portHome);
	const oracle = join(LIVE, "agent-score");
	const plan = join(ROOT, "score-plan.md");
	const evidence = join(ROOT, "score-evidence.txt");
	writeFileSync(plan, "- [ ] P2 port the commands difficulty: 2\n- [ ] P9 loose\n");
	writeFileSync(evidence, "boom\n");
	const session = [
		JSON.stringify({ message: { role: "user", content: "check WorkerA please" } }),
		JSON.stringify({
			message: {
				role: "assistant",
				usage: { cost: { total: 2 } },
				content: [{ type: "text", text: "ok" }],
			},
		}),
	].join("\n");
	const worker = JSON.stringify({
		message: {
			role: "assistant",
			provider: "zai",
			model: "glm",
			usage: { totalTokens: 10, cacheRead: 0, cost: { total: 1.5 } },
			stopReason: "end_turn",
			content: [{ type: "text", text: "done" }],
		},
	});
	for (const home of [pyHome, portHome]) {
		mkdirSync(join(home, ".omp/agent/notes"), { recursive: true });
		writeSession(home, "proj/2026-10-18T00-00-00-000Z_main.jsonl", session, 1759999900);
		writeSession(home, "proj/sub/WorkerA.jsonl", worker, 1759999950);
	}
	const repo = join(ROOT, "score-git");
	initRepo(repo, pyEnv);
	const sha1 = head(repo);
	writeFileSync(join(repo, "a.txt"), "b\n");
	const committed = spawnSync("git", ["add", "a.txt"], { cwd: repo, env: pyEnv });
	if (committed.status !== 0) throw new Error("git add failed");
	const second = spawnSync("git", ["commit", "-m", "second"], {
		cwd: repo,
		env: { ...pyEnv, GIT_AUTHOR_DATE: "2026-10-18T01:00:00", GIT_COMMITTER_DATE: "2026-10-18T01:00:00" },
	});
	if (second.status !== 0) throw new Error(second.stderr?.toString() || "git commit failed");
	const sha2 = head(repo);
	const cases: string[][] = [
		[],
		["--help"],
		["diagnose", "WorkerA", "--plan", plan, "--phase", "P2", "--evidence", evidence],
		["diagnose", "WorkerA", "--plan", plan, "--phase", "P2", "--evidence", evidence, "--weight", "8"],
		["penalty", "WorkerA", "--kind", "false-claim", "--note", "lied"],
		["penalty", "WorkerA", "--kind", "nope", "--note", "x"],
		["board", "--days", "3"],
		["gate", "WorkerA"],
		["gate", "Nobody"],
		["accept", "AgentX", "--plan", plan, "--phase", "P2", "--commits", "deadbeef", "--repo", repo, "--branch", "main"],
		["base", sha1, "--repo", repo, "--branch", "main"],
		["check", "--repo", repo, "--branch", "main"],
		["accept", "AgentX", "--plan", plan, "--phase", "P2", "--commits", sha2, "--repo", repo, "--branch", "main", "--note", "landed"],
		["check", "--repo", repo, "--branch", "main"],
		["exempt", sha1, "--note", "main own", "--repo", repo],
		["nope"],
	];
	// The port is ahead of the frozen oracle by the specced `validate` feature: `--help` carries a
	// validate entry and the board column is `Accepted (diag/val)` with cell `N (d/v)` (oracle:
	// `Accepted (diag)`, cell `N (d)`). Fold the port side back so every other number and line still
	// compares exactly.
	const toOracle = (s: string): string =>
		s.split("\n")
			.filter(l => !l.startsWith("  agent-score validate") && !l.startsWith("        validation phase with proof"))
			.join("\n")
			.replaceAll("Accepted (diag/val)", "Accepted (diag)")
			.replace(/\((\d+)\/(\d+)\)/g, "($1)")
			// the scrub dropped the default-branch wording from the accept line
			.replace("(required; there is no default branch)", "(branch)")
			// traces_02 P4 added the `unreported-finding` penalty kind (score.penalties); the oracle lists three
			.replace("|unreported-finding", "");
	for (const args of cases) {
		const py = runPy(oracle, args, pyEnv, pyHome);
		// The live help string hardcodes this machine. The package ships ~/Work/pm-counts and no owner date (P9 scrub).
		const stdout = py.stdout.replaceAll("/home/ukd/Work/pm-counts", "~/Work/pm-counts").replace("(default pm/pr01-counts in ~/Work/pm-counts)", "(branch)").replace(" (owner 2026-10-16, AGENTS.md line 16)", "");
		const stderr = py.stderr.replaceAll("/home/ukd/Work/pm-counts", "~/Work/pm-counts");
		const port = runPort("agent-score", args, portEnv, portHome);
		match({ ...py, stdout, stderr }, { code: port.code, stdout: toOracle(port.stdout), stderr: toOracle(port.stderr) });
	}
	expect(readFileSync(join(portHome, ".local/state/agent-score/events.jsonl"), "utf8")).toBe(
		readFileSync(join(pyHome, ".local/state/agent-score/events.jsonl"), "utf8"),
	);
	expect(toOracle(readFileSync(join(portHome, ".omp/agent/notes/subagent-ranking.md"), "utf8"))).toBe(
		readFileSync(join(pyHome, ".omp/agent/notes/subagent-ranking.md"), "utf8"),
	);
});

test("wip-snapshot matches the original", () => {
	const home = homeFor("snap");
	const fixed = "1760000000";
	const env = envFor(home, {
		NEURASTREAM_NOW: fixed,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
		GIT_AUTHOR_DATE: "2026-10-18T00:00:00",
		GIT_COMMITTER_DATE: "2026-10-18T00:00:00",
	});
	stub(home, "wip-check", "#!/bin/sh\nprintf '%s\\n' 'UNLANDED branches (commits on no remote): 0  limit 6' 'DIRTY worktrees (uncommitted tracked changes): 1'\n");
	const repo = join(home, "Work/demo");
	initRepo(repo, env);
	writeFileSync(join(repo, "a.txt"), "b\n");
	writeFileSync(join(repo, "note.txt"), "note\n");
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	const oracle = join(home, "wip-snapshot.py");
	rewrite("wip-snapshot", oracle, home);
	const status = join(home, "Work/WIP-STATUS.md");
	const drop = () => rmSync(join(repo, ".git/refs/wip"), { recursive: true, force: true });
	drop();
	const py = runPy(oracle, [], env, home);
	const pyStatus = readFileSync(status, "utf8");
	const pyRefs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/wip"], { encoding: "utf8" }).stdout;
	drop();
	const port = runPort("wip-snapshot", [], env, home);
	match(py, port);
	expect(readFileSync(status, "utf8")).toBe(pyStatus);
	expect(spawnSync("git", ["-C", repo, "for-each-ref", "refs/wip"], { encoding: "utf8" }).stdout).toBe(pyRefs);
	drop();
	match(runPy(oracle, ["--quiet"], env, home), runPort("wip-snapshot", ["--quiet"], env, home));
});

test("wip-backup matches the original", () => {
	const home = homeFor("backup");
	const fixed = "1760000000";
	const env = envFor(home, { NEURASTREAM_NOW: fixed, GATE_RC: "0" });
	stub(home, "git-secret-gate", "#!/bin/sh\nexit \"${GATE_RC:-0}\"\n");
	const repo = join(home, "Work/demo");
	initRepo(repo, env);
	const oracle = join(home, "wip-backup.py");
	rewrite("wip-backup", oracle, home);
	match(runPy(oracle, ["--dry-run"], env, home), runPort("wip-backup", ["--dry-run"], env, home));
	match(runPy(oracle, ["--dry-run", "--quiet"], env, home), runPort("wip-backup", ["--dry-run", "--quiet"], env, home));
	const hooks = spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).stdout.trim();
	const pre = join(repo, hooks, "pre-push");
	mkdirSync(dirname(pre), { recursive: true });
	writeFileSync(pre, "#!/bin/sh\nexit 0\n");
	chmodSync(pre, 0o755);
	match(runPy(oracle, ["--dry-run"], env, home), runPort("wip-backup", ["--dry-run"], env, home));
	rmSync(pre);
	match(
		runPy(oracle, ["--dry-run"], { ...env, WIP_BACKUP_MAX_REPO_MB: "0" }, home),
		runPort("wip-backup", ["--dry-run"], { ...env, WIP_BACKUP_MAX_REPO_MB: "0" }, home),
	);
	match(
		runPy(oracle, ["--dry-run"], { ...env, GATE_RC: "1" }, home),
		runPort("wip-backup", ["--dry-run"], { ...env, GATE_RC: "1" }, home),
	);
});

test("main-health matches the original", () => {
	const home = homeFor("health");
	const env = envFor(home, { NEURASTREAM_NOW: "1760000000" });
	stub(
		home,
		"wip-check",
		"#!/bin/sh\nprintf '%s\\n' 'UNLANDED branches (commits on no remote): 1  limit 6' 'DIRTY worktrees (uncommitted tracked changes): 2'\n",
	);
	const older = join(home, ".omp/agent/sessions/proj/2026-10-18T00-00-00-000Z_old.jsonl");
	const newer = join(home, ".omp/agent/sessions/proj/2026-10-18T01-00-00-000Z_new.jsonl");
	mkdirSync(dirname(newer), { recursive: true });
	const body = [
		JSON.stringify({ timestamp: "2026-10-18T12:00:00.000Z", message: { role: "user", content: "please fix the gate" } }),
		JSON.stringify({
			timestamp: "2026-10-18T12:00:01.000Z",
			message: { role: "assistant", usage: { input: 12000, cacheRead: 3000, cacheWrite: 0 } },
		}),
		JSON.stringify({ timestamp: "2026-10-18T12:00:02.000Z", message: { role: "user", content: "<system>ignore</system>" } }),
	].join("\n");
	writeFileSync(older, `${JSON.stringify({ message: { role: "user", content: "old" } })}\n`);
	writeFileSync(newer, `${body}\n`);
	touch(older, 1759990000);
	touch(newer, 1759999000);
	const oracle = join(LIVE, "main-health");
	match(runPy(oracle, [], env, home), runPort("main-health", [], env, home));
	match(runPy(oracle, [older], env, home), runPort("main-health", [older], env, home));
	const bloated = join(home, ".omp/agent/sessions/proj/bloated.jsonl");
	writeFileSync(
		bloated,
		`${JSON.stringify({
			timestamp: "2026-10-18T12:00:03.000Z",
			message: { role: "assistant", usage: { input: 200000, cacheRead: 0, cacheWrite: 0 } },
		})}\n${JSON.stringify({ message: { role: "user", content: `pad ${"x".repeat(200)}` } })}\n`,
	);
	match(runPy(oracle, [bloated], env, home), runPort("main-health", [bloated], env, home));
});
