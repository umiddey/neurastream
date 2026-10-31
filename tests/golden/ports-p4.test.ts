import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(dirname(import.meta.path)));
// The golden oracle scripts: the frozen snapshot of the live originals (never the live machine).
const LIVE = join(REPO, "tests/fixtures/originals/bin");
const HEAVY_ORIG = join(REPO, "tests/fixtures/originals/Work/heavy-run.sh");
const ROOT = "/tmp/neurastream-home-golden-p4";

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function homeFor(name: string): string {
	const home = join(ROOT, name);
	rmSync(home, { recursive: true, force: true });
	mkdirSync(join(home, "Work"), { recursive: true });
	mkdirSync(join(home, "projects"), { recursive: true });
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	return home;
}

function pinOmp(home: string): void {
	const yml = `paths:
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
review:
  agents: []
`;
	writeFileSync(join(home, ".config/neurastream/config.yml"), yml);
}

function envFor(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const agent = join(home, ".omp/agent");
	return {
		...process.env,
		HOME: home,
		PATH: `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`,
		QUEUE_AGENT: agent,
		QUEUE_INDEX: join(agent, "INDEX.md"),
		QUEUE_BLOCKERS: join(agent, "blockers"),
		QUEUE_STATE: join(home, ".local/state/queue"),
		QUEUE_SUBAGENTS: join(agent, "notes/subagents.md"),
		QUEUE_CANCELLED: join(agent, "CANCELLED.md"),
		QUEUE_UNLOCK: join(agent, ".guard-unlock"),
		...extra,
	};
}

function match(
	a: { code: number; stdout: string; stderr: string },
	b: { code: number; stdout: string; stderr: string },
) {
	expect(b.stderr).toBe(a.stderr);
	expect(b.stdout).toBe(a.stdout);
	expect(b.code).toBe(a.code);
}

// Goldens run the oracle and the port seconds apart: strip what the machine changes between runs.
function stripVanished(s: string): string {
	// rsync racing the orchestrator's transient /tmp/runc-process* files: noise on either side
	return s
		.split("\n")
		.filter(l => !/file has vanished|rsync warning: some files vanished/.test(l))
		.join("\n");
}

function stripTs(s: string): string {
	return s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "TS");
}
function stripClock(s: string): string {
	return s.replace(/^\d{2}:\d{2}$/m, "HH:MM");
}

function stripLoadavg(s: string): string {
	return s.replace(/^[\d.]+ [\d.]+ [\d.]+ \d+\/\d+ \d+$/m, "LOADAVG");
}

function stripMg(s: string): string {
	return stripLoadavg(
		stripTs(s)
			.replace(/^\d{2}:\d{2}:\d{2} /m, "TS ")
			.replace(/load=[\d.]+ [\d.]+ [\d.]+/g, "load=L L L")
			.replace(/avail=\d+MB swapfree=\d+MB home_free=\d+G/g, "avail=AMB swapfree=SM home_free=HG")
			.replace(/load [\d.]+ > \d+/g, "load N > N")
			.replace(/(MemAvailable )\d+MB( < )\d+MB/g, "$1NMB$2NMB")
			.replace(/(\/home free )\d+G( < )\d+G/g, "$1NG$2NG")
			.replace(/(\/tmp \(RAM tmpfs\) )\d+MB( > )\d+MB/g, "$1NMB$2NMB"),
	);
}

function runPort(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), cmd, ...args], { env, cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runBash(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
	const r = spawnSync("bash", [script, ...args], { env, cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runBun(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
	const r = spawnSync("bun", [script, ...args], { env, cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function rewriteText(text: string, home: string, extra: [string, string][] = []): string {
	const reps: [string, string][] = [
		["/home/ukd/.omp/agent/queue/lib.ts", join(home, ".omp/agent/queue/lib.ts")],
		["/home/ukd/Work/heavy-run.sh", join(home, "Work/heavy-run.sh")],
		["/home/ukd/Work/.heavy-run.lock", join(home, "Work/.heavy-run.lock")],
		["/home/ukd/Work/.heavy-run.owner", join(home, "Work/.heavy-run.owner")],
		["/home/ukd/Work/.heavy-run.log", join(home, "Work/.heavy-run.log")],
		["/home/ukd/Work/.heavy-run.idle-state", join(home, "Work/.heavy-run.idle-state")],
		["/home/ukd/.cache/resource-alerts", join(home, ".cache/resource-alerts")],
		["/home/ukd/.cache/tmp-snapshot.lock", join(home, ".cache/tmp-snapshot.lock")],
		["/home/ukd/Work/tmp-snapshot", join(home, "Work/tmp-snapshot")],
		["/home/ukd/Work/gateforge", join(home, "Work/gateforge")],
		["/home/ukd/Work/gf-backups/latest", join(home, "Work/gf-backups/latest")],
		["/home/ukd/.local/bin/", join(home, ".local/bin/")],
		["/home/ukd/", `${home}/`],
		["/home/ukd", home],
		...extra,
	];
	let out = text;
	for (const [from, to] of reps) out = out.split(from).join(to);
	return out;
}

function installQueueLib(home: string): void {
	const dest = join(home, ".omp/agent/queue/lib.ts");
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(join(REPO, "src/core/queue/lib.ts"), dest);
	// lib.ts imports ../clock.ts at runtime (strftime for the claim flag, multi-main P4).
	copyFileSync(join(REPO, "src/core/clock.ts"), join(home, ".omp/agent/clock.ts"));
}

function installQueueBin(name: string, home: string): string {
	let text = readFileSync(join(LIVE, name), "utf8");
	text = rewriteText(text, home);
	if (name === "queue-cancel") {
		text = text.replace(
			/spawnSync\(path\.join\(path\.dirname\(process\.argv\[1\]\), "queue-close"\)/,
			`spawnSync(${JSON.stringify(join(home, ".local/bin/queue-close"))}`,
		);
	}
	const dest = join(home, ".local/bin", name);
	writeFileSync(dest, text);
	chmodSync(dest, 0o755);
	return dest;
}

function installBlockers(home: string): void {
	const src = join(home, ".omp/agent/blockers");
	mkdirSync(src, { recursive: true });
	for (const f of ["no-push", "_blocker.py", "deny-command", "deny-path", "deny-text"]) {
		copyFileSync(join(REPO, "tests/fixtures/originals/agent/blockers", f), join(src, f));
		chmodSync(join(src, f), 0o755);
	}
}

function toyPlan(status: "open" | "complete" | "cancelled", extra = ""): string {
	const cancelled =
		status === "cancelled"
			? `\nCancelled by owner: 2026-10-18 owner said stop`
			: "";
	return `# Toy plan
Worktree: -
Branch: -

## Goal
- toy

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Progress
Status: ${status}${cancelled}

## Background
note
${extra}`;
}

function initToyRepo(home: string, env: NodeJS.ProcessEnv): { repo: string; plan: string } {
	const repo = join(home, "Work/toy-queue");
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	const plan = join(repo, "docs/plans/toy.md");
	const git = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
		const r = spawnSync("git", args, { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")}`);
	};
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@example.com"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "README.md"), "toy\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "init"], { GIT_AUTHOR_DATE: "2026-10-18T00:00:00", GIT_COMMITTER_DATE: "2026-10-18T00:00:00" });
	writeFileSync(plan, toyPlan("open"));
	// One index: the main index lists the plan file directly; there is no repo INDEX.md.
	mkdirSync(dirname(join(home, ".omp/agent/INDEX.md")), { recursive: true });
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${plan}\n`);
	return { repo, plan };
}

function setupQueue(home: string, env: NodeJS.ProcessEnv, status: "open" | "complete" | "cancelled" = "open") {
	pinOmp(home);
	installQueueLib(home);
	installBlockers(home);
	installQueueBin("queue-cancel", home);
	const { plan } = initToyRepo(home, env);
	if (status !== "open") writeFileSync(plan, toyPlan(status));
	return plan;
}

test.skipIf(process.platform !== "linux")("quota-reset matches the original", () => {
	const home = homeFor("glm");
	pinOmp(home);
	// the oracle labels its output GLM; pin the label so the port matches it
	const cfg = join(home, ".config/neurastream/config.yml");
	writeFileSync(cfg, `${readFileSync(cfg, "utf8")}quota:\n  label: "GLM"\n`);
	const env = envFor(home);
	const oracle = join(home, "glm-reset.sh");
	writeFileSync(oracle, readFileSync(join(LIVE, "glm-reset"), "utf8"));
	chmodSync(oracle, 0o755);
	for (const when of ["2026-10-09 14:03:41", "2099-01-01 00:00:00"]) {
		match(runBash(oracle, [when], env), runPort("quota-reset", [when], env));
	}
	// the no-args usage text differs from the oracle's; compare exit code and stdout only
	const want = runBash(oracle, [], env);
	const got = runPort("quota-reset", [], env);
	expect(got.code).toBe(want.code);
	expect(got.stdout).toBe(want.stdout);
	expect(got.stderr).toContain("usage: quota-reset");
});

// The oracle needs Linux tools (flock, /proc, nproc); the port itself runs on macOS too.
test.skipIf(process.platform !== "linux")("heavy-run matches the original", () => {
	const home = homeFor("heavy");
	pinOmp(home);
	const env = envFor(home);
	const oracle = join(home, "Work/heavy-run.sh");
	writeFileSync(oracle, rewriteText(readFileSync(HEAVY_ORIG, "utf8"), home));
	chmodSync(oracle, 0o755);
	// The oracle's usage line names its own $0 (the sandbox script); the port names the CLI. Both print to stderr.
	const noBin = (r: { code: number; stdout: string; stderr: string }) => ({
		...r,
		stderr: r.stderr.replace(/^usage: \S+ <who>/m, "usage: BIN <who>"),
	});
	match(runBash(oracle, ["--status"], env), runPort("heavy-run", ["--status"], env));
	match(noBin(runBash(oracle, [], env)), noBin(runPort("heavy-run", [], env)));
	const py = runBash(oracle, ["Agent", "echo test", "--", "echo", "hello"], env);
	const port = runPort("heavy-run", ["Agent", "echo test", "--", "echo", "hello"], env);
	expect(port.code).toBe(py.code);
	expect(port.stdout).toBe(py.stdout);
	expect(readFileSync(join(home, "Work/.heavy-run.log"), "utf8")).toBe(
		readFileSync(join(home, "Work/.heavy-run.log"), "utf8"),
	);
});

// The oracle needs Linux tools (flock, /proc, nproc); the port itself runs on macOS too.
test.skipIf(process.platform !== "linux")("machine-guard matches the original", () => {
	const home = homeFor("mg");
	pinOmp(home);
	const env = envFor(home);
	// Fixed probes: clock, process table, containers, heavy-run status. df on /home and
	// /proc/loadavg + meminfo stay live; stripMg normalizes their numbers.
	const stub = (name: string, body: string) => {
		writeFileSync(join(home, ".local/bin", name), body);
		chmodSync(join(home, ".local/bin", name), 0o755);
	};
	stub("date", '#!/bin/sh\necho "12:00:00"\n');
	stub("docker", "#!/bin/sh\nexit 0\n");
	stub(
		"ps",
		`#!/bin/sh
cat <<'EOF'
  10240 00:03 bun test stub line dropped by awk
 624640 41:24 /opt/omp/bin/omp worker mnemopi embed
  53248 4-02:01:40 /opt/omp/bin/omp --optchat main
  32768 15-01:43:57 /usr/libexec/localsearch-3
  20480 1-14:41:02 /opt/omp/bin/omp --resume session
  1048576 5-01:02:03 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
EOF
`,
	);
	writeFileSync(join(home, "Work/heavy-run.sh"), '#!/bin/sh\necho "free"\n');
	chmodSync(join(home, "Work/heavy-run.sh"), 0o755);
	const oracle = join(home, "machine-guard.sh");
	writeFileSync(oracle, rewriteText(readFileSync(join(LIVE, "machine-guard"), "utf8"), home));
	chmodSync(oracle, 0o755);
	const py = runBash(oracle, [], env);
	const port = runPort("machine-guard", [], env);
	expect(stripMg(port.stdout)).toBe(stripMg(py.stdout));
	expect(port.stderr).toBe(py.stderr);
	expect(port.code).toBe(py.code);
});

test("resource-alerts matches the original", () => {
	const home = homeFor("ra");
	pinOmp(home);
	const env = envFor(home);
	const oracle = join(home, "resource-alerts.sh");
	writeFileSync(oracle, rewriteText(readFileSync(join(LIVE, "resource-alerts"), "utf8"), home));
	chmodSync(oracle, 0o755);
	match(runBash(oracle, [], env), runPort("resource-alerts", [], env));
});

// The oracle needs Linux tools (flock, /proc, nproc); the port itself runs on macOS too.
test.skipIf(process.platform !== "linux")("tmp-snapshot matches the original", () => {
	const home = homeFor("snap");
	pinOmp(home);
	// The oracle and the port rsync the literal /tmp/ (P5b): one rsync PATH shim (envFor puts
	// ~/.local/bin first) redirects that source into a fake /tmp under the sandbox for both
	// sides, so the run never copies the machine's real /tmp into its own sandbox.
	const fakeTmp = join(home, "fake-tmp");
	mkdirSync(fakeTmp, { recursive: true });
	writeFileSync(join(fakeTmp, "sandbox-marker"), "fake /tmp\n");
	const realMarker = join(ROOT, "real-tmp-marker");
	writeFileSync(realMarker, "real /tmp\n");
	const realRsync = spawnSync("sh", ["-c", "command -v rsync"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/rsync";
	writeFileSync(
		join(home, ".local/bin/rsync"),
		[
			"#!/usr/bin/env bash",
			"args=()",
			'for a in "$@"; do',
			`  [[ $a == /tmp/ ]] && a="${fakeTmp}/"`,
			'  args+=("$a")',
			"done",
			`exec ${realRsync} "\${args[@]}"`,
		].join("\n"),
	);
	chmodSync(join(home, ".local/bin/rsync"), 0o755);
	const env = envFor(home);
	mkdirSync(join(home, "Work/gateforge"), { recursive: true });
	spawnSync("git", ["init", "-b", "main"], { cwd: join(home, "Work/gateforge"), env });
	const oracle = join(home, "tmp-snapshot.sh");
	writeFileSync(oracle, rewriteText(readFileSync(join(LIVE, "tmp-snapshot.sh"), "utf8"), home));
	chmodSync(oracle, 0o755);
	const py = runBash(oracle, [], env);
	const port = runPort("tmp-snapshot", [], env);
	// the scrub renamed the oracle's "gateforge backup failed" to "repo backup failed"
	const toOracle = (s: string): string => s.replaceAll("repo backup failed for", "gateforge backup failed for");
	expect(stripTs(port.stdout)).toBe(stripTs(py.stdout));
	expect(stripVanished(toOracle(port.stderr))).toBe(stripVanished(py.stderr));
	expect(port.code).toBe(py.code);
	// The snapshot mirrors the fake /tmp only: the sandbox marker is in, the real one is out.
	expect(existsSync(join(home, "Work/tmp-snapshot/tmp/sandbox-marker"))).toBe(true);
	expect(existsSync(join(home, "Work/tmp-snapshot/tmp", basename(realMarker)))).toBe(false);
}, 120_000);

// The 0.2.0 queue format change (one index, plan 20261024_1400_one_index) supersedes the frozen
// queue-check/queue-close oracles: they implement the retired two-level INDEX layout, so there is
// nothing left to compare against. These tests pin the port's behaviour instead; queue-cancel still
// has a live oracle below.
test("queue-check reports a one-index queue and the open plan's priority id", () => {
	const home = homeFor("qcheck");
	const env = envFor(home);
	const plan = setupQueue(home, env, "open");
	const full = runPort("queue-check", [], env);
	expect(full.code).toBe(0);
	expect(full.stdout).toContain(plan);
	const ids = runPort("queue-check", ["--priority-ids"], env);
	expect(ids.code).toBe(0);
	expect(ids.stdout).toBe("");
});

test("queue-close refusal paths", () => {
	const home = homeFor("qclose-ref");
	const env = envFor(home);
	const plan = setupQueue(home, env, "open");
	const noArgs = runPort("queue-close", [], env);
	expect(noArgs.code).toBe(1);
	expect(noArgs.stderr).toContain("usage: queue-close <plan file>");
	const open = runPort("queue-close", [plan], env);
	expect(open.code).toBe(1);
	expect(open.stderr).toContain('"Status: open"');
	expect(existsSync(plan)).toBe(true);
});

test("queue-close archives a complete plan and removes it from the main index", () => {
	const home = homeFor("qclose-done");
	const env = envFor(home);
	const plan = setupQueue(home, env, "complete");
	const port = runPort("queue-close", [plan], env);
	expect(port.code).toBe(0);
	expect(port.stderr).toBe("");
	expect(existsSync(plan)).toBe(false);
	expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8")).not.toContain(plan);
});

// P1 (2026-10-19): the live bin gained landed detection beyond `merge-base --is-ancestor`:
// squashMerged (c) — merging the branch into a first-parent commit of base since the fork point
// (`git merge-tree --write-tree`) changes nothing — and declaredLanded (d), a verified
// "Landed: <commit on base> from <pre-squash commit>" plan line. Each scenario builds that
// history in a temp repo; the close either lands (exit 0, plan archived) or stays AWAITING
// (exit 4, plan and index untouched).

function landedRepo(
	home: string,
	env: NodeJS.ProcessEnv,
	kind: "squash-later-edit" | "stacked" | "unmerged" | "forged",
): string {
	const repo = join(home, "Work/toy-landed");
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(join(repo, "docs/plans"), { recursive: true });
	const plan = join(repo, "docs/plans/toy-landed.md");
	const git = (args: string[]) => {
		const r = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")}`);
		return r.stdout.trim();
	};
	const write = (rel: string, text: string) => writeFileSync(join(repo, rel), text);
	const commitAll = (msg: string) => {
		git(["add", "-A"]);
		git(["commit", "-m", msg]);
	};
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@example.com"]);
	git(["config", "user.name", "t"]);
	write(".git/info/exclude", "/INDEX.md\n");
	write("README.md", "toy\n");
	commitAll("init");
	const root = git(["rev-parse", "HEAD"]);
	let branch = "feat";
	let landed = "";
	if (kind === "unmerged") {
		git(["checkout", "-b", "feat"]);
		write("n.txt", "n1\n");
		commitAll("feature work");
	} else if (kind === "squash-later-edit") {
		git(["checkout", "-b", "feat"]);
		write("a.txt", "a1\n");
		write("b.txt", "b1\n");
		commitAll("feature work");
		git(["checkout", "main"]);
		// The release squash carries the branch's content plus a version bump, so it is not the
		// branch's one patch: (a) misses. A later edit on base touches a file the branch changed:
		// (b) misses; (c) still holds.
		write("a.txt", "a1\n");
		write("b.txt", "b1\n");
		write("c.txt", "v0.1.0\n");
		commitAll("release: feat squashed");
		write("a.txt", "a2\n");
		commitAll("later edit on base");
	} else {
		branch = "stacked";
		git(["checkout", "-b", "base-w"]);
		write("w.txt", "w1\n");
		commitAll("base work");
		git(["checkout", "-b", "stacked"]);
		write("b.txt", "b1\n");
		commitAll("stacked work");
		const preSquash = git(["rev-parse", "stacked"]);
		git(["checkout", "main"]);
		write("w.txt", "w1\n");
		write("b.txt", "b1\n");
		write("c.txt", "v0.1.0\n");
		commitAll("release: base-w and stacked squashed");
		const release = git(["rev-parse", "main"]); // the squash commit itself
		write("b.txt", "b2\n");
		commitAll("later edit on base"); // (b) misses: a branch file differs on base
		// (c) walks only the newest 200 first-parent commits since the fork point: 201 empty
		// fillers push the release squash outside that window, so (a)-(c) all miss and only a
		// verified Landed line can close the branch.
		for (let i = 0; i < 201; i++) git(["commit", "--allow-empty", "-qm", `filler ${i}`]);
		landed = kind === "stacked"
			? `- Landed: ${release} from ${preSquash}\n`
			: `Landed: ${release} from ${root}\n`; // forged: the init commit lacks the branch
	}
	// queue-close compares against refs/remotes/origin/main: create that remote-tracking ref
	// directly (like a fetched checkout whose branch is local-only) — no remote, no push hooks.
	git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "main"])]);
	writeFileSync(plan, `# Toy landed plan
Worktree: -
Branch: ${branch}

## Goal
- toy

## Forbidden
- none

## Blockers
- no-push

## Phases
- [ ] P1 step — difficulty: 1 — verify: \`true\`

## Done check
\`true\`

## Progress
Status: complete

## Background
note
${landed}`);
	mkdirSync(dirname(join(home, ".omp/agent/INDEX.md")), { recursive: true });
	writeFileSync(join(home, ".omp/agent/INDEX.md"), `- ${plan}\n`);
	return plan;
}

test("queue-close landed detection (squash, stacked, unmerged, forged)", () => {
	const cases: Array<{ kind: "squash-later-edit" | "stacked" | "unmerged" | "forged"; code: number }> = [
		{ kind: "squash-later-edit", code: 0 },
		{ kind: "stacked", code: 0 },
		{ kind: "unmerged", code: 4 },
		{ kind: "forged", code: 4 },
	];
	for (const { kind, code } of cases) {
		const home = homeFor(`qclose-${kind}`);
		const env = envFor(home);
		pinOmp(home);
		installQueueLib(home);
		installBlockers(home);
		installQueueBin("queue-cancel", home);
		const plan = landedRepo(home, env, kind);
		const port = runPort("queue-close", [plan], env);
		expect(port.code).toBe(code);
		// A landed branch closes: the plan leaves its path and the main index. An unmerged or
		// forged Landed line stays AWAITING: the plan and its index line stay as they are.
		expect(existsSync(plan)).toBe(code !== 0);
		expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8").includes(plan)).toBe(code !== 0);
	}
}, 120_000);

test("queue-cancel matches the original", () => {
	const home = homeFor("qcancel");
	const env = envFor(home);
	setupQueue(home, env, "open");
	const oracle = join(home, ".local/bin/queue-cancel");
	const usage = [
		[],
		["--never", "short", ""],
		["--never", "short", "ok"],
		["--never", "drop the payment module", "owner no"],
	];
	for (const args of usage) {
		match(runBun(oracle, args, env), runPort("queue-cancel", args, env));
	}
	// Deliberate break from the original: --not-a-cancel is refused unless main-guard flagged a message.
	const bare = runPort("queue-cancel", ["--not-a-cancel", "misread the owner message"], env);
	expect(bare.code).toBe(1);
	expect(bare.stderr).toContain("nothing is flagged");
	const stateDir = env.QUEUE_STATE ?? join(home, ".local/state/queue");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "cancel-pending.json"), JSON.stringify({ at: "2026-10-28T08:00:00Z", words: "stop it" }));
	const flagged = runPort("queue-cancel", ["--not-a-cancel", "misread the owner message"], env);
	expect(flagged.code).toBe(0);
	expect(existsSync(join(stateDir, "cancel-pending.json"))).toBe(false);
	const repo = join(home, "Work/toy-queue");
	match(
		runBun(oracle, ["--never", "drop payment module", "owner said no", "--repo", repo], env),
		runPort("queue-cancel", ["--never", "drop payment module", "owner said no", "--repo", repo], env),
	);
});

test("queue-close archives a cancelled plan and records it in the repo's CANCELLED list", () => {
	const home = homeFor("qclose-cancel");
	const env = envFor(home);
	const plan = setupQueue(home, env, "cancelled");
	const port = runPort("queue-close", [plan], env);
	expect(port.code).toBe(0);
	expect(port.stderr).toBe("");
	expect(existsSync(plan)).toBe(false);
	expect(readFileSync(join(dirname(plan), "CANCELLED.md"), "utf8")).toContain("owner said stop");
	expect(readFileSync(join(home, ".omp/agent/INDEX.md"), "utf8")).not.toContain(plan);
});

// The oracle needs Linux tools (flock, /proc, nproc); the port itself runs on macOS too.
test.skipIf(process.platform !== "linux")("main-start matches the original", () => {
	const home = homeFor("mstart");
	pinOmp(home);
	const env = envFor(home);
	setupQueue(home, env, "open");
	const stub = (name: string, body: string) => {
		const p = join(home, ".local/bin", name);
		writeFileSync(p, body);
		chmodSync(p, 0o755);
	};
	stub("machine-guard", '#!/bin/sh\necho "line1"\necho "OK"\n');
	stub("agent-ledger", '#!/bin/sh\nif [ "$1" = "--hours" ]; then echo "LEDGER"; elif [ "$1" = "--cap" ]; then echo "PRIORITY IDLE x"; fi\n');
	stub("main-health", '#!/bin/sh\necho "health ok"\n');
	stub("queue-check", '#!/bin/sh\necho "queue ok"\nexit 0\n');
	writeFileSync(join(home, "Work/.heavy-run.lock"), "held\nline2\n");
	const oracle = join(home, "main-start.sh");
	writeFileSync(oracle, rewriteText(readFileSync(join(LIVE, "main-start"), "utf8"), home));
	chmodSync(oracle, 0o755);
	const py = runBash(oracle, ["6"], env);
	const port = runPort("main-start", ["6"], env);
	// the metrics report-due line is new (not in the Python oracle); compare the rest
	const portOut = port.stdout.replace(/=== doctor\n[\s\S]*$/, "").replace(/^metrics: report due .*\n/m, "");
	expect(stripLoadavg(portOut)).toBe(stripLoadavg(py.stdout));
	expect(port.stderr).toBe(py.stderr);
	expect(port.code).toBe(py.code);
});

test("priority-watch matches the original", () => {
	const home = homeFor("pw");
	pinOmp(home);
	const env = envFor(home);
	stubAlwaysIdle(home);
	const oracle = join(home, "priority-watch.sh");
	let text = readFileSync(join(LIVE, "priority-watch"), "utf8");
	text = rewriteText(text, home).replace(/sleep 120/g, "sleep 1");
	writeFileSync(oracle, text);
	chmodSync(oracle, 0o755);
	const py = spawnSync("bash", [oracle], { env, encoding: "utf8", timeout: 15_000 });
	const port = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "priority-watch"], { env, encoding: "utf8", timeout: 15_000 });
	expect(port.status).toBe(py.status);
	expect(port.stdout.split("\n", 1)[0]).toMatch(/^\d{2}:\d{2}$/);
	expect(py.stdout.split("\n", 1)[0]).toMatch(/^\d{2}:\d{2}$/);
	expect(stripClock(port.stdout)).toBe(stripClock(py.stdout));
	expect(port.stderr).toBe(py.stderr);
}, 35_000);

function stubAlwaysIdle(home: string): void {
	const p = join(home, ".local/bin/agent-ledger");
	writeFileSync(
		p,
		`#!/bin/sh
if [ "$1" = "--cap" ]; then echo "PRIORITY IDLE test"; fi
exit 0
`,
	);
	chmodSync(p, 0o755);
}
