// P4 (plan 20261027_1430): `neurastream watch on|off` writes the watcher's timer units into a
// temp HOME with the configured interval substituted, and removes them again. The service
// manager is a fake runner that records every call; a failed probe writes nothing. No real
// home, systemd or launchd is touched.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchOff, watchOn } from "../src/cli/watch-setup.ts";
import type { Runner, RunnerResult } from "../src/core/pages-setup.ts";
import { watchUnitPaths } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempHome(label: string, intervalMin: number): string {
	const home = mkdtempSync(join(tmpdir(), `watchsetup-${label}-`));
	DIRS.push(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), `watch:\n  interval_min: ${intervalMin}\n`);
	return home;
}

/** A runner that answers every call with the given status and records the argv it was given. */
function fakeRunner(status: number): { runner: Runner; calls: string[][] } {
	const calls: string[][] = [];
	const runner: Runner = (args): RunnerResult => {
		calls.push(args);
		return { status, stderr: status === 0 ? "" : "no user bus" };
	};
	return { runner, calls };
}

test("on writes the systemd service and timer with the interval substituted, then enables the timer", () => {
	const home = tempHome("linux-on", 7);
	const { runner, calls } = fakeRunner(0);
	expect(watchOn({ home, runner, platform: "linux" })).toBe(0);
	const [service, timer] = watchUnitPaths(home, "linux");
	expect(existsSync(service!)).toBe(true);
	expect(readFileSync(timer!, "utf8")).toContain("OnUnitActiveSec=7min");
	expect(readFileSync(timer!, "utf8")).not.toContain("__INTERVAL");
	expect(readFileSync(service!, "utf8")).toContain("ExecStart=%h/.bun/bin/neurastream watch");
	expect(calls.at(-1)).toEqual(["--user", "enable", "--now", "neurastream-watch.timer"]);
});

test("on on macOS writes the LaunchAgent with StartInterval in seconds and loads it", () => {
	const home = tempHome("darwin-on", 7);
	const { runner, calls } = fakeRunner(0);
	expect(watchOn({ home, runner, platform: "darwin" })).toBe(0);
	const [plist] = watchUnitPaths(home, "darwin");
	const text = readFileSync(plist!, "utf8");
	expect(text).toContain("<integer>420</integer>");
	expect(text).toContain(`${home}/.bun/bin/neurastream`);
	expect(text).not.toContain("__HOME__");
	expect(calls).toEqual([["list"], ["unload", "-w", plist!], ["load", "-w", plist!]]);
});

test("a failed probe returns 1 and writes nothing", () => {
	const home = tempHome("probe-fail", 15);
	const { runner, calls } = fakeRunner(1);
	expect(watchOn({ home, runner, platform: "linux" })).toBe(1);
	for (const p of watchUnitPaths(home, "linux")) expect(existsSync(p)).toBe(false);
	expect(calls).toHaveLength(1);
});

test("off removes both unit files and disables the timer", () => {
	const home = tempHome("linux-off", 15);
	expect(watchOn({ home, runner: fakeRunner(0).runner, platform: "linux" })).toBe(0);
	const { runner, calls } = fakeRunner(0);
	expect(watchOff({ home, runner, platform: "linux" })).toBe(0);
	for (const p of watchUnitPaths(home, "linux")) expect(existsSync(p)).toBe(false);
	expect(calls[0]).toEqual(["--user", "disable", "--now", "neurastream-watch.timer"]);
});

test("off on macOS unloads and removes the LaunchAgent", () => {
	const home = tempHome("darwin-off", 15);
	expect(watchOn({ home, runner: fakeRunner(0).runner, platform: "darwin" })).toBe(0);
	const [plist] = watchUnitPaths(home, "darwin");
	const { runner, calls } = fakeRunner(0);
	expect(watchOff({ home, runner, platform: "darwin" })).toBe(0);
	expect(existsSync(plist!)).toBe(false);
	expect(calls).toEqual([["unload", "-w", plist!]]);
});
