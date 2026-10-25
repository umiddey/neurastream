import { join } from "node:path";
import { readEvents } from "../core/agent-score.ts";
import { ConfigError, loadConfig } from "../core/config.ts";
import { nowSec } from "../core/clock.ts";
import { buildEpisodes } from "../core/episodes.ts";
import { defaultRunSource } from "../adapters/omp/sessions.ts";
import { ompTraceRuns, spawnBriefsIn } from "../adapters/omp/traces.ts";

const USAGE = "usage: neurastream labels episodes [--since 30d] [--json]";
const SINCE = /^(\d+)([dhm])$/;

export function runLabels(args: string[], opts: { home?: string } = {}): number {
	if (args[0] !== "episodes") {
		console.error(USAGE);
		return 2;
	}
	try {
		const cfg = loadConfig(opts.home === undefined ? undefined : { home: opts.home });
		let windowSec = cfg.labels.episode_days * 86400;
		let json = false;
		for (let i = 1; i < args.length; i++) {
			const arg = args[i]!;
			if (arg === "--json") json = true;
			else if (arg === "--since") {
				const match = SINCE.exec(args[++i] ?? "");
				if (!match) { console.error(USAGE); return 2; }
				windowSec = Number(match[1]) * (match[2] === "d" ? 86400 : match[2] === "h" ? 3600 : 60);
			} else { console.error(USAGE); return 2; }
		}
		const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
		const cutoff = nowSec() - windowSec;
		const briefs = ompTraceRuns(root)
			.filter(run => run.mtimeSec >= cutoff)
			.flatMap(run => spawnBriefsIn(run.file, run.runId));
		const episodes = buildEpisodes(defaultRunSource(cfg), readEvents(cfg), briefs, cutoff);
		if (json) console.log(JSON.stringify(episodes, null, 2));
		else if (episodes.length === 0) console.log("no episodes in the window");
		else for (const episode of episodes) console.log(`${episode.id} ${episode.agent} ${episode.model} ${episode.plan} ${episode.phase} ${episode.commits.join(",")}`);
		return 0;
	} catch (error) {
		console.error(error instanceof ConfigError ? error.message : String(error));
		return 1;
	}
}
