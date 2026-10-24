import type { Config } from "./config.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, queueProblems, queueSummary } from "./queue/lib.ts";

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
	return queueProblems().length ? 1 : 0;
}
