// `neurastream pressure`: prints the machine-pressure level, the sample it came from, and the
// line Main would read for that level. Read only: it never acts on a process.

import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { nowSec } from "../core/clock.ts";
import { currentHolder, pressureLevel, pressureMessage, readPressure, type PressureSample } from "../core/pressure.ts";

/** The three lines the command prints. Amber has nothing to say, so it names that instead of a message. */
export function pressureReport(cfg: Config, sample: PressureSample, now: number): string {
	const level = pressureLevel(sample, cfg);
	let last = "none (amber: nothing to say)";
	if (level === "red") last = pressureMessage("red", sample, currentHolder(cfg, now));
	if (level === "green") last = pressureMessage("green", sample, null);
	return [`level: ${level}`, `sample: ${JSON.stringify(sample)}`, `last message: ${last}`].join("\n");
}

export function runPressure(args: string[]): number {
	if (args.length > 0) {
		console.error("usage: neurastream pressure");
		return 2;
	}
	try {
		console.log(pressureReport(loadConfig(), readPressure(), nowSec()));
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	return 0;
}
