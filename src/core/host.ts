// Host probes that differ by OS: the load line and the CPU count. Plain TypeScript, no harness names.

import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

const PROC_LOADAVG = "/proc/loadavg";

/** The load averages as one line: the /proc/loadavg text where it exists, else the three os.loadavg() values. */
export function loadavgLine(): string {
	if (existsSync(PROC_LOADAVG)) return readFileSync(PROC_LOADAVG, "utf8").trim();
	return loadavg()
		.map((v) => v.toFixed(2))
		.join(" ");
}

/** Logical CPUs this process may use. */
export function cpuCount(): number {
	return availableParallelism();
}
