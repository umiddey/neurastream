import type { Config } from "./config.ts";
import { fileClaimStore } from "./claims.ts";
import { nowSec } from "./clock.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { activePlans, allowedAgents, holdWarnings, queueProblems, queueSummary, reviewAgentsProblem } from "./queue/lib.ts";
import { mrSweep } from "./mr-sweep.ts";
import { recheckHolds, staleHoldLines } from "./waiting-check.ts";

// One index (20261024_1400_one_index): the main index lists plan files directly, so there are no
// repo INDEX.md files to git-check and no work_roots scan; the queue problems carry the
// worktree-placement and one-plan-one-worktree rules instead.
export function queueCheck(args: string[], cfg: Config): number {
	applyQueueEnv(cfg);
	if (args.includes("--priority-ids")) {
		for (const p of activePlans()) if (p.priorityId && !p.waiting && p.status === "open") console.log(p.priorityId);
		return 0;
	}
	const claims = fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min);
	const plans = activePlans();
	const holds = recheckHolds(cfg, plans);
	console.log(queueSummary(undefined, cfg.review.agents, claims, Infinity));
	for (const line of staleHoldLines(holds, plans)) console.log(line);
	// main-start prints the sweep itself and passes this so the child bin does not print it twice.
	let fail = queueProblems(undefined, undefined, cfg.review.agents).length > 0;
	// P4d (plan 20261028_1600): a review spawn needs a review.agents entry that Main may spawn.
	const review = reviewAgentsProblem(cfg, allowedAgents(cfg.paths.subagents));
	if (review.problem) {
		console.log(`review gate: ${review.problem}`);
		fail = true;
	}
	for (const w of review.warnings) console.log(`warning: ${w}`);
	// P4 (plan 20261027_0915): a hold dated DONE_CLAIM_SINCE or later without its own check warns; the exit code stays.
	for (const w of holdWarnings(plans)) console.log(`warning: ${w}`);
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
