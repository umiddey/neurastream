// P6 (plan 20261027_1130): `wip on|off` installs or removes the snapshot and backup timers.
// The service manager and the private-repo check are injected, so these tests never run systemctl,
// launchctl, gh or glab: they assert the argv sequence and the files. Nothing here touches a real
// ~/.config/systemd/user.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, loadConfig, type Config } from "../src/core/config.ts";
import { wipHealth, wipOff, wipOn, wipUnitPaths } from "../src/core/wip-setup.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

/** A temp HOME with one wip root in its config; the real HOME is never read or written. */
function sandbox(): { home: string; root: string } {
	const base = mkdtempSync(join(tmpdir(), "wip-setup-"));
	DIRS.push(base);
	const home = join(base, "home");
	const root = join(home, "Work/demo");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(configFile(home), `wip:\n  roots:\n    - ${root}\n`);
	return { home, root };
}

function cfgOf(home: string): Config {
	return loadConfig({ home, env: {} });
}

/** The real gate's shape: `scan <repo> <rev>` — fewer than 2 args after scan prints usage and
 * exits 2; a repo arg that is not a directory, or a rev that does not resolve, exits 2; a clean
 * repo exits 0. */
const REAL_GATE = `#!/bin/sh
if [ "$#" -lt 3 ] || [ "$1" != "scan" ]; then
	echo "usage: scan <repo> <rev>..." >&2
	exit 2
fi
[ -d "$2" ] || exit 2
git -C "$2" rev-parse --verify -q "$3" || exit 2
exit 0
`;

/** A gate that answers like the real one on a clean repo: exit 0. */
function fakeGate(home: string): string {
	const cfg = cfgOf(home);
	mkdirSync(join(cfg.wip.secret_gate, ".."), { recursive: true });
	writeFileSync(cfg.wip.secret_gate, REAL_GATE);
	chmodSync(cfg.wip.secret_gate, 0o755);
	return cfg.wip.secret_gate;
}

function recorder(status = 0): { calls: string[][]; runner: (args: string[]) => { status: number; stdout: string; stderr: string } } {
	const calls: string[][] = [];
	return {
		calls,
		runner: (args: string[]) => {
			calls.push(args);
			return { status, stdout: "", stderr: status === 0 ? "" : "manager says no" };
		},
	};
}

test("linux: on installs the hourly snapshot timer and nothing else", () => {
	const { home } = sandbox();
	const r = recorder();
	const lines: string[] = [];
	const code = wipOn({ home, platform: "linux", runner: r.runner, print: l => lines.push(l), error: () => {} });
	expect(code).toBe(0);
	const paths = wipUnitPaths(home, "linux");
	expect(existsSync(paths.snapshot[0]!)).toBe(true);
	expect(existsSync(paths.snapshot[1]!)).toBe(true);
	expect(existsSync(paths.backup[1]!)).toBe(false);
	expect(readFileSync(paths.snapshot[1]!, "utf8")).toContain("OnUnitActiveSec=1h");
	expect(r.calls).toContainEqual(["--user", "daemon-reload"]);
	expect(r.calls).toContainEqual(["--user", "enable", "--now", "neurastream-wip-snapshot.timer"]);
	expect(r.calls).not.toContainEqual(["--user", "enable", "--now", "neurastream-wip-backup.timer"]);
	expect(lines[0]).toContain("snapshot hourly");
});

test("linux: on with a private backup URL installs both timers and records the URL", () => {
	const { home } = sandbox();
	fakeGate(home);
	const r = recorder();
	const url = "git@github.com:owner/repo.git";
	const code = wipOn({ home, platform: "linux", runner: r.runner, visibility: () => "private", backupUrl: url, print: () => {}, error: () => {} });
	expect(code).toBe(0);
	const paths = wipUnitPaths(home, "linux");
	expect(existsSync(paths.backup[0]!)).toBe(true);
	expect(existsSync(paths.backup[1]!)).toBe(true);
	expect(r.calls).toContainEqual(["--user", "enable", "--now", "neurastream-wip-backup.timer"]);
	expect(readFileSync(configFile(home), "utf8")).toContain(url);
});

test("linux: a public backup URL is refused and nothing is written", () => {
	const { home } = sandbox();
	fakeGate(home);
	const r = recorder();
	const code = wipOn({ home, platform: "linux", runner: r.runner, visibility: () => "public", backupUrl: "git@github.com:owner/repo.git", print: () => {}, error: () => {} });
	expect(code).toBe(1);
	const paths = wipUnitPaths(home, "linux");
	expect(existsSync(paths.snapshot[0]!)).toBe(false);
	expect(existsSync(paths.backup[1]!)).toBe(false);
	expect(r.calls.some(c => c.includes("enable"))).toBe(false);
});

test("linux: a secret gate that exits 2 on a clean repo is refused and nothing is written", () => {
	const { home } = sandbox();
	const cfg = cfgOf(home);
	mkdirSync(join(cfg.wip.secret_gate, ".."), { recursive: true });
	writeFileSync(cfg.wip.secret_gate, "#!/bin/sh\nexit 2\n");
	chmodSync(cfg.wip.secret_gate, 0o755);
	const r = recorder();
	const code = wipOn({ home, platform: "linux", runner: r.runner, visibility: () => "private", backupUrl: "git@github.com:owner/repo.git", print: () => {}, error: () => {} });
	expect(code).toBe(1);
	const paths = wipUnitPaths(home, "linux");
	expect(existsSync(paths.snapshot[0]!)).toBe(false);
	expect(existsSync(paths.backup[1]!)).toBe(false);
	expect(r.calls.some(c => c.includes("enable"))).toBe(false);
});

test("linux: a missing secret gate is refused and nothing is written", () => {
	const { home } = sandbox();
	const r = recorder();
	const code = wipOn({ home, platform: "linux", runner: r.runner, visibility: () => "private", backupUrl: "git@github.com:owner/repo.git", print: () => {}, error: () => {} });
	expect(code).toBe(1);
	expect(existsSync(wipUnitPaths(home, "linux").snapshot[0]!)).toBe(false);
	expect(r.calls.some(c => c.includes("enable"))).toBe(false);
});

test("linux: a stale installed unit is replaced, not skipped as present", () => {
	const { home } = sandbox();
	const paths = wipUnitPaths(home, "linux");
	mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
	for (const file of paths.snapshot) writeFileSync(file, "[Service]\nExecStart=/old/broken/wip-snapshot\n");
	const r = recorder();
	expect(wipOn({ home, platform: "linux", runner: r.runner, print: () => {}, error: () => {} })).toBe(0);
	expect(readFileSync(paths.snapshot[0]!, "utf8")).toContain("ExecStart=%h/.bun/bin/neurastream wip-snapshot --quiet");
	expect(r.calls).toContainEqual(["--user", "enable", "--now", "neurastream-wip-snapshot.timer"]);
});

test("linux: off disables the installed timers and removes the files", () => {
	const { home } = sandbox();
	const paths = wipUnitPaths(home, "linux");
	expect(wipOn({ home, platform: "linux", runner: recorder().runner, print: () => {}, error: () => {} })).toBe(0);
	const r = recorder();
	expect(wipOff({ home, platform: "linux", runner: r.runner, print: () => {}, error: () => {} })).toBe(0);
	expect(r.calls).toContainEqual(["--user", "disable", "--now", "neurastream-wip-snapshot.timer"]);
	for (const file of [...paths.snapshot, ...paths.backup]) expect(existsSync(file)).toBe(false);
});

test("macOS: on writes and loads the agents", () => {
	const { home } = sandbox();
	const r = recorder();
	expect(wipOn({ home, platform: "darwin", runner: r.runner, print: () => {}, error: () => {} })).toBe(0);
	const paths = wipUnitPaths(home, "darwin");
	expect(readFileSync(paths.snapshot[0]!, "utf8")).toContain(`${home}/.bun/bin/neurastream`);
	expect(existsSync(paths.backup[0]!)).toBe(false);
	expect(r.calls).toContainEqual(["load", "-w", paths.snapshot[0]!]);
	expect(r.calls.some(c => c.includes("enable"))).toBe(false);
});

test("macOS: off unloads and removes the agents", () => {
	const { home } = sandbox();
	const paths = wipUnitPaths(home, "darwin");
	expect(wipOn({ home, platform: "darwin", runner: recorder().runner, print: () => {}, error: () => {} })).toBe(0);
	const r = recorder();
	expect(wipOff({ home, platform: "darwin", runner: r.runner, print: () => {}, error: () => {} })).toBe(0);
	expect(r.calls).toContainEqual(["unload", "-w", paths.snapshot[0]!]);
	expect(existsSync(paths.snapshot[0]!)).toBe(false);
});

test("a service manager that does not answer writes nothing", () => {
	const { home } = sandbox();
	const r = recorder(1);
	expect(wipOn({ home, platform: "linux", runner: r.runner, print: () => {}, error: () => {} })).toBe(1);
	expect(existsSync(wipUnitPaths(home, "linux").snapshot[0]!)).toBe(false);
	expect(r.calls).toHaveLength(1);
});

test("wipHealth reports which units exist and how the last runs ended", () => {
	const { home } = sandbox();
	const cfg = cfgOf(home);
	expect(wipHealth(cfg, "linux").installed).toBe(false);
	expect(wipOn({ home, platform: "linux", runner: recorder().runner, print: () => {}, error: () => {} })).toBe(0);
	const health = wipHealth(cfg, "linux");
	expect(health.installed).toBe(true);
	expect(health.backupInstalled).toBe(false);
	mkdirSync(cfg.paths.alert_state, { recursive: true });
	writeFileSync(join(cfg.paths.alert_state, "wip-last.json"), JSON.stringify({ snapshot: { kind: "snapshot", at: 1, ok: false, failed: ["x"], refused: null } }));
	expect(wipHealth(cfg, "linux").last.snapshot?.failed).toEqual(["x"]);
});
