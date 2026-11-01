// `neurastream watch on|off` (plan 20261027_1430 P4): installs or removes the watcher's timer —
// a systemd user timer on Linux, a LaunchAgent on macOS — through the same Runner seam as
// `pages on|off` (src/core/pages-setup.ts). The service manager is probed first: a failed probe
// writes nothing. The period is watch.interval_min. Core stays free of service-manager calls
// (watch.ts only reports the unit files); this file is the CLI side that writes them.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.ts";
import { systemRunner, type Runner, type Setup } from "../core/pages-setup.ts";
import { watchUnitPaths } from "../core/watch.ts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "../../templates");

/** launchctl: the macOS counterpart of systemRunner. */
export const launchRunner: Runner = args => {
	const r = spawnSync("launchctl", args, { encoding: "utf8" });
	return { status: r.status, stderr: r.stderr ?? "" };
};

export interface WatchSetup extends Setup {
	/** Defaults to process.platform; tests inject it to pick the unit set. */
	platform?: NodeJS.Platform;
}

export function watchOn(opts: WatchSetup = {}): number {
	const home = opts.home ?? homedir(), platform = opts.platform ?? process.platform;
	const runner = opts.runner ?? (platform === "darwin" ? launchRunner : systemRunner);
	const probe = runner(platform === "darwin" ? ["list"] : ["--user", "show-environment"]);
	if (probe.status !== 0) { console.error(probe.stderr); return 1; }
	const cfg = loadConfig({ home });
	const paths = watchUnitPaths(home, platform);
	// Templates in the same order as watchUnitPaths returns their targets.
	const templates = platform === "darwin" ? ["launchd/neurastream-watch.plist"] : ["systemd/neurastream-watch.service", "systemd/neurastream-watch.timer"];
	paths.forEach((path, i) => {
		const text = readFileSync(join(TEMPLATES, templates[i]!), "utf8")
			.replaceAll("__INTERVAL_MIN__", String(cfg.watch.interval_min))
			.replaceAll("__INTERVAL_SEC__", String(cfg.watch.interval_min * 60))
			.replaceAll("__HOME__", home);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	});
	if (platform === "darwin") {
		// Unloading first makes a re-run with a new interval take effect; "not loaded yet" is fine.
		runner(["unload", "-w", paths[0]!]);
		const r = runner(["load", "-w", paths[0]!]);
		if (r.status !== 0) { console.error(r.stderr); return 1; }
	} else {
		for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", "neurastream-watch.timer"]]) {
			const r = runner(args);
			if (r.status !== 0) { console.error(r.stderr); return 1; }
		}
	}
	console.log(`watch: on, every ${cfg.watch.interval_min} min`);
	return 0;
}

export function watchOff(opts: WatchSetup = {}): number {
	const home = opts.home ?? homedir(), platform = opts.platform ?? process.platform;
	const runner = opts.runner ?? (platform === "darwin" ? launchRunner : systemRunner);
	const paths = watchUnitPaths(home, platform);
	const stop = runner(platform === "darwin" ? ["unload", "-w", paths[0]!] : ["--user", "disable", "--now", "neurastream-watch.timer"]);
	if (stop.status !== 0) { console.error(stop.stderr); return 1; }
	for (const path of paths) rmSync(path, { force: true });
	if (platform !== "darwin") {
		const reload = runner(["--user", "daemon-reload"]);
		if (reload.status !== 0) { console.error(reload.stderr); return 1; }
	}
	console.log("watch: off");
	return 0;
}
