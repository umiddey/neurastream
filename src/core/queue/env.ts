import type { Config } from "../config.ts";
import { refreshQueuePaths } from "./lib.ts";

/** Map merged config into the env vars the queue library reads (same as live setup). */
export function applyQueueEnv(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
	env.QUEUE_AGENT = cfg.paths.agent_dir;
	env.QUEUE_INDEX = cfg.paths.queue_index;
	env.QUEUE_BLOCKERS = cfg.paths.blockers;
	env.QUEUE_STATE = cfg.paths.queue_state;
	env.QUEUE_SUBAGENTS = cfg.paths.subagents;
	env.QUEUE_CANCELLED = cfg.paths.cancelled;
	env.QUEUE_UNLOCK = cfg.paths.unlock;
	refreshQueuePaths();
}
