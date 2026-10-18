import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Config } from "./config.ts";

export function priorityWatch(_args: string[], cfg: Config): number {
	const ledger = join(cfg.paths.home, ".local/bin", "agent-ledger");
	const sleepSec = cfg.priority.sleep_sec;
	for (;;) {
		const first = spawnSync("bash", ["-c", `${ledger} --cap 2>/dev/null | grep -q "^PRIORITY IDLE"`], { encoding: "utf8" });
		if (first.status === 0) {
			spawnSync("sleep", [String(sleepSec)]);
			const out = spawnSync("bash", ["-c", `${ledger} --cap 2>/dev/null | grep "^PRIORITY IDLE"`], { encoding: "utf8" });
			const line = (out.stdout ?? "").trim();
			if (line) {
				const t = spawnSync("date", ["+%H:%M"], { encoding: "utf8" });
				console.log((t.stdout ?? "").trim());
				console.log(line);
				return 0;
			}
		}
		spawnSync("sleep", [String(sleepSec)]);
	}
}
