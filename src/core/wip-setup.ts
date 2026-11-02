// `neurastream wip on|off` (plan 20261027_1130 P6): installs the hourly snapshot timer and, when a
// backup repo is configured, the daily backup timer; off removes both. Same Runner seam as
// watch/pages, so tests record argv and never run systemctl or launchctl: the service manager is
// probed FIRST and a failed check writes nothing. Existing unit files are rewritten, never treated
// as "already present" — the hand-made units that failed unnoticed since 2026-10-21 are exactly
// what this replaces.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEdited, setConfigKeys } from "./config-edit.ts";
import { configFile, loadConfig, type Config } from "./config.ts";
import { systemRunner, type Runner } from "./pages-setup.ts";
import { cmd } from "./proc.ts";
import { readWipLast, type WipLast } from "./wip-fail.ts";
import { backupVisibility, type Visibility } from "./wip-private.ts";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "../../templates");

/** launchctl: the macOS counterpart of systemRunner. */
const launchctlRunner: Runner = args => {
	const r = spawnSync("launchctl", args, { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** The unit files of one job: the service and its timer (.service + .timer), or the agent plist. */
export interface WipUnits {
	snapshot: string[];
	backup: string[];
}

export function wipUnitPaths(home: string, platform: NodeJS.Platform = process.platform): WipUnits {
	if (platform === "darwin") {
		const dir = join(home, "Library/LaunchAgents");
		return { snapshot: [join(dir, "com.neurastream.wip-snapshot.plist")], backup: [join(dir, "com.neurastream.wip-backup.plist")] };
	}
	const dir = join(home, ".config/systemd/user");
	return {
		snapshot: [join(dir, "neurastream-wip-snapshot.service"), join(dir, "neurastream-wip-snapshot.timer")],
		backup: [join(dir, "neurastream-wip-backup.service"), join(dir, "neurastream-wip-backup.timer")],
	};
}

/** The templates in wipUnitPaths order, relative to templates/. */
function wipTemplates(platform: NodeJS.Platform): WipUnits {
	if (platform === "darwin") return { snapshot: ["launchd/neurastream-wip-snapshot.plist"], backup: ["launchd/neurastream-wip-backup.plist"] };
	return {
		snapshot: ["systemd/neurastream-wip-snapshot.service", "systemd/neurastream-wip-snapshot.timer"],
		backup: ["systemd/neurastream-wip-backup.service", "systemd/neurastream-wip-backup.timer"],
	};
}

/** Which wip units are installed here, and how the last runs ended: the doctor line. */
export interface WipHealth {
	installed: boolean;
	backupInstalled: boolean;
	last: WipLast;
}

export function wipHealth(cfg: Config, platform: NodeJS.Platform = process.platform): WipHealth {
	const paths = wipUnitPaths(cfg.paths.home, platform);
	return {
		installed: paths.snapshot.every(p => existsSync(p)),
		backupInstalled: paths.backup.every(p => existsSync(p)),
		last: readWipLast(cfg),
	};
}

export interface WipSetupOptions {
	/** HOME the units, the config and wip-last.json resolve against. Default: the real home. */
	home?: string;
	/** Defaults to process.platform; tests inject it to pick the unit set. */
	platform?: NodeJS.Platform;
	/** Command runner. Default: systemRunner (Linux) or launchctl. */
	runner?: Runner;
	/** The private-repo check; default runs `gh`/`glab`/wip.private_check for real. */
	visibility?: (url: string) => Visibility;
	print?: (line: string) => void;
	error?: (line: string) => void;
}

export function wipOn(opts: WipSetupOptions & { backupUrl?: string | null } = {}): number {
	const home = opts.home ?? homedir();
	const platform = opts.platform ?? process.platform;
	const runner = opts.runner ?? (platform === "darwin" ? launchctlRunner : systemRunner);
	const print = opts.print ?? console.log;
	const error = opts.error ?? console.error;
	const fail = (line: string): number => {
		error(`neurastream wip: ${line}`);
		return 1;
	};
	// Checks first (same shape as uiOn): the manager answers, roots exist, and a backup repo is
	// private with the secret gate answering. A failed check writes nothing.
	const probe = runner(platform === "darwin" ? ["list"] : ["--user", "show-environment"]);
	if (probe.status !== 0) return fail(`the service manager does not answer${probe.stderr.trim() ? `: ${probe.stderr.trim()}` : ""} — nothing was written`);
	let cfg: Config;
	try {
		cfg = loadConfig({ home });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	if (cfg.wip.roots.length === 0) return fail("wip.roots is empty — add a folder first (`neurastream wip add <path>`), then run this again");
	const url = (opts.backupUrl ?? cfg.wip.backup_url).trim();
	if (url !== "") {
		const state = (opts.visibility ?? ((u: string) => backupVisibility(u, cmd, cfg.wip.private_check)))(url);
		if (state !== "private") {
			const why = `${url} is ${state}`;
			return fail(`${why} — the backup timer only runs to a repo confirmed private; nothing was written`);
		}
		const gate = cfg.wip.secret_gate;
		let executable = true;
		try {
			accessSync(gate, constants.X_OK);
		} catch {
			executable = false;
		}
		if (!executable) return fail(`${gate} is missing — the backup refuses to upload without the secret gate; nothing was written`);
		const scan = cmd([gate, "scan"]);
		if (scan.code !== 0 && scan.code !== 1) {
			return fail(`${gate} scan exited ${scan.code}${scan.stderr.trim() ? `: ${scan.stderr.trim().split("\n")[0]}` : ""} — nothing was written`);
		}
	}
	// Write the units, then enable them. Always a write: an old hand-made unit would otherwise stay.
	const paths = wipUnitPaths(home, platform);
	const templates = wipTemplates(platform);
	const write = (targets: string[], sources: string[]): void => {
		targets.forEach((file, i) => {
			const text = readFileSync(join(TEMPLATES, sources[i]!), "utf8").replaceAll("__HOME__", home);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text);
		});
	};
	write(paths.snapshot, templates.snapshot);
	if (url !== "") write(paths.backup, templates.backup);
	const failed = (what: string, stderr: string): number =>
		fail(`${what} failed${stderr.trim() ? `: ${stderr.trim()}` : ""} — the unit files are written; fix this and run the command again`);
	if (platform === "darwin") {
		for (const file of [...paths.snapshot, ...(url === "" ? [] : paths.backup)]) {
			runner(["unload", "-w", file]); // not loaded yet is fine
			const r = runner(["load", "-w", file]);
			if (r.status !== 0) return failed("launchctl", r.stderr);
		}
	} else {
		const reload = runner(["--user", "daemon-reload"]);
		if (reload.status !== 0) return failed("systemctl", reload.stderr);
		for (const timer of [paths.snapshot[1]!, ...(url === "" ? [] : [paths.backup[1]!])]) {
			const r = runner(["--user", "enable", "--now", basename(timer)]);
			if (r.status !== 0) return failed("systemctl", r.stderr);
		}
	}
	// The config records the URL only once the timers are live (a failed enable leaves it alone).
	if (opts.backupUrl && opts.backupUrl !== cfg.wip.backup_url) {
		const file = configFile(home);
		const edited = setConfigKeys(existsSync(file) ? readFileSync(file, "utf8") : null, { "wip.backup_url": opts.backupUrl });
		if (!checkEdited(edited, home, error)) return 1;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, edited);
	}
	const line = url === "" ? "wip: on — snapshot hourly; no backup repo set (neurastream wip on --backup-url <url>)" : `wip: on — snapshot hourly, backup daily 23:30 to ${url}`;
	print(line);
	return 0;
}

export function wipOff(opts: WipSetupOptions = {}): number {
	const home = opts.home ?? homedir();
	const platform = opts.platform ?? process.platform;
	const runner = opts.runner ?? (platform === "darwin" ? launchctlRunner : systemRunner);
	const print = opts.print ?? console.log;
	const error = opts.error ?? console.error;
	const paths = wipUnitPaths(home, platform);
	const failed = (what: string, stderr: string): number => {
		error(`neurastream wip: ${what} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
		return 1;
	};
	if (platform === "darwin") {
		for (const file of [...paths.snapshot, ...paths.backup]) {
			if (!existsSync(file)) continue;
			const r = runner(["unload", "-w", file]);
			if (r.status !== 0) return failed("launchctl", r.stderr);
		}
	} else {
		for (const timer of [paths.snapshot[1]!, paths.backup[1]!]) {
			if (!existsSync(timer)) continue;
			const r = runner(["--user", "disable", "--now", basename(timer)]);
			if (r.status !== 0) return failed("systemctl", r.stderr);
		}
	}
	for (const file of [...paths.snapshot, ...paths.backup]) rmSync(file, { force: true });
	if (platform !== "darwin") {
		const reload = runner(["--user", "daemon-reload"]);
		if (reload.status !== 0) return failed("systemctl", reload.stderr);
	}
	print("wip: off");
	return 0;
}
