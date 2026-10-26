import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, queueProblems, queueSummary } from "./queue/lib.ts";
import { mrSweep } from "./mr-sweep.ts";

// One index (20261024_1400_one_index): the main index lists plan files directly, so there are no
// repo INDEX.md files to git-check and no work_roots scan; the queue problems carry the
// worktree-placement and one-plan-one-worktree rules instead.
export function queueCheck(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	if (args.includes("--priority-ids")) {
		for (const p of activePlans()) if (p.priorityId && !p.waiting && p.status === "open") console.log(p.priorityId);
		return 0;
	}
	console.log(queueSummary());
	// main-start prints the sweep itself and passes this so the child bin does not print it twice.
	let fail = queueProblems().length > 0;
	if (!args.includes("--no-mr-sweep")) {
		try {
			const sweep = mrSweep();
			for (const line of sweep.lines) console.log(line);
			if (sweep.fail) fail = true;
		} catch {
			console.log("mr-sweep: skipped (forge unreachable)");
		}
	}
	return fail ? 1 : 0;
}
