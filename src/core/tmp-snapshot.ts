import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../templates/tmp-snapshot.sh");

export function tmpSnapshot(_args: string[], cfg: Config): number {
	const r = spawnSync("bash", [SCRIPT], {
		env: {
			...process.env,
			SNAP_DEST: cfg.snapshot.tmp_dest,
			SNAP_GIT_REPO: cfg.snapshot.git_repo,
			SNAP_GIT_BACKUP: cfg.snapshot.git_backup,
			SNAP_LOCK: cfg.paths.snapshot_lock,
			SNAP_EXCLUDES: cfg.snapshot.excludes.join(" "),
		},
		encoding: "utf8",
	});
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.stderr) process.stderr.write(r.stderr);
	return r.status ?? 0;
}
