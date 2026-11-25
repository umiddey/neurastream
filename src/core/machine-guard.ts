import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";
import { cpuCount } from "./host.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../templates/machine-guard.sh");

export interface MachineGuardOptions {
	/** Absolute path to the CLI entrypoint (`src/cli/main.ts`) invoked by `machine-guard.sh` for heavy-run status. */
	heavyMain: string;
	/** Runtime executable that runs `heavyMain` (default: `"bun"`). */
	heavyStatus?: string;
}

function envFor(cfg: Config, opts: MachineGuardOptions): NodeJS.ProcessEnv {
	const cores = cpuCount();
	const loadMax = cfg.machine.load_max > 0 ? cfg.machine.load_max : cores + cfg.machine.load_over_cores;
	return {
		...process.env,
		CORES: String(cores),
		LOAD_MAX: String(loadMax),
		AVAIL_MIN_MB: String(cfg.machine.avail_min_mb),
		DISK_MIN_GB: String(cfg.machine.disk_min_gb),
		TMP_MAX_MB: String(cfg.machine.tmp_max_mb),
		IDLE_MAX_MIN: String(cfg.machine.idle_max_min),
		IDLE_MIN_TICKS: String(cfg.machine.idle_min_ticks),
		HEAVY_LOCK: cfg.paths.heavy_lock,
		HEAVY_OWNER: cfg.paths.heavy_owner,
		HEAVY_IDLE_STATE: cfg.paths.heavy_idle_state,
		HEAVY_STATUS: opts.heavyStatus ?? "bun",
		HEAVY_MAIN: opts.heavyMain,
		DISK_PATH: cfg.machine.disk_path,
		WORK_ROOT: cfg.paths.work_roots[0] ?? join(cfg.paths.home, "Work"),
		WATCH_SEC: String(cfg.machine.watch_sec),
		WATCH_STREAK: String(cfg.machine.watch_streak),
	};
}

/**
 * Runs `templates/machine-guard.sh` with thresholds derived from config and caller-supplied heavy-run runner paths.
 *
 * Args:
 *     args (string[]): CLI arguments (`--watch` optional)
 *     cfg (Config): Loaded neurastream configuration
 *     opts (MachineGuardOptions): Required `heavyMain` CLI path and optional `heavyStatus` runtime command
 *
 * Returns:
 *     number: Exit status from `machine-guard.sh`
 */
export function machineGuard(args: string[], cfg: Config, opts: MachineGuardOptions): number {
	const r = spawnSync("bash", [SCRIPT, ...(args[0] === "--watch" ? ["--watch"] : [])], {
		env: envFor(cfg, opts),
		encoding: "utf8",
	});
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.stderr) process.stderr.write(r.stderr);
	return r.status ?? 1;
}
