import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../templates/resource-alerts.sh");

export function resourceAlerts(_args: string[], cfg: Config): number {
	const r = spawnSync("bash", [SCRIPT], {
		env: {
			...process.env,
			ALERT_STATE: cfg.paths.alert_state,
			THRESH_TEMP: String(cfg.alerts.temp_c),
			THRESH_MEM: String(cfg.alerts.mem_psi),
			THRESH_IO: String(cfg.alerts.io_psi),
			COOLDOWN: String(cfg.alerts.cooldown_sec),
		},
		encoding: "utf8",
	});
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.stderr) process.stderr.write(r.stderr);
	return r.status ?? 0;
}
