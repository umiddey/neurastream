// queue-trim <plan> [--keep N]: keep the newest Progress entries of an indexed plan and move the
// older ones to its archive. The adapter runs the same trim after Main ticks a phase.

import { existsSync } from "node:fs";
import path from "node:path";
import { rekeySpawnFile } from "./guards.ts";
import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import * as q from "./queue/lib.ts";

const USAGE = "usage: queue-trim <plan file> [--keep N]";

export function queueTrim(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	if (args[0] === "--help" || args[0] === "-h") {
		console.log(USAGE);
		return 0;
	}
	const hasKeep = args.includes("--keep");
	const rest = args.filter((a, i) => a !== "--keep" && args[i - 1] !== "--keep");
	const planArg = rest[0];
	if (!planArg) {
		console.error(USAGE);
		return 2;
	}
	const keepArg = hasKeep ? args[args.indexOf("--keep") + 1] : undefined;
	const keep = hasKeep ? Number(keepArg) : cfg.queue.progress_keep;
	if (!Number.isInteger(keep) || keep < 0) {
		console.error(`queue-trim: --keep takes a whole number, got ${keepArg ?? "nothing"}`);
		return 2;
	}
	const file = path.resolve(planArg);
	if (!existsSync(file) || !q.planAt(file, q.activePlans())) {
		console.error(`queue-trim: ${file} is not an indexed plan`);
		return 2;
	}
	const t = q.trimPlanProgress(file, keep);
	if (!t) {
		console.log(`queue-trim: ${file} has no more than ${keep} Progress entries; nothing moved`);
		return 0;
	}
	rekeySpawnFile(file, t.before, t.after);
	console.log(`queue-trim: moved ${t.count} older Progress entries of ${file} to ${t.archive}`);
	return 0;
}
