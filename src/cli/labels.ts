import { join } from "node:path";
import { readEvents } from "../core/agent-score.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { nowSec } from "../core/clock.ts";
import { buildEpisodes, type Episode } from "../core/episodes.ts";
import { importWhytrailLabels } from "../core/label-import.ts";
import { assignLabel } from "../core/labels.ts";
import { defaultRunSource } from "../adapters/omp/sessions.ts";
import { ompTraceRuns, spawnBriefsIn } from "../adapters/omp/traces.ts";

const USAGE = "usage: neurastream labels episodes [--since 30d] [--json]\n       neurastream labels import --repo <dir> [--since 30d] [--json]\n       neurastream labels assign <episode> --party plan|implementer|both --why <text>";
const SINCE = /^(\d+)([dhm])$/;

function gatherEpisodes(cfg: Config, cutoff: number): Episode[] {
	const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
	const briefs = ompTraceRuns(root)
		.filter(run => run.mtimeSec >= cutoff)
		.flatMap(run => spawnBriefsIn(run.file, run.runId));
	return buildEpisodes(defaultRunSource(cfg), readEvents(cfg), briefs, cutoff);
}

export function runLabels(args: string[], opts: { home?: string } = {}): number {
	if (args[0] !== "episodes" && args[0] !== "import" && args[0] !== "assign") {
		console.error(USAGE);
		return 2;
	}
	try {
		const cfg = loadConfig(opts.home === undefined ? undefined : { home: opts.home });
		if (args[0] === "assign") return runAssign(args.slice(1), cfg);
		let windowSec = cfg.labels.episode_days * 86400;
		let json = false;
		let repo: string | undefined;
		for (let i = 1; i < args.length; i++) {
			const arg = args[i]!;
			if (arg === "--json") json = true;
			else if (arg === "--repo" && args[0] === "import") repo = args[++i];
			else if (arg === "--since") {
				const match = SINCE.exec(args[++i] ?? "");
				if (!match) { console.error(USAGE); return 2; }
				windowSec = Number(match[1]) * (match[2] === "d" ? 86400 : match[2] === "h" ? 3600 : 60);
			} else { console.error(USAGE); return 2; }
		}
		const ts = nowSec();
		const cutoff = ts - windowSec;
		if (args[0] === "import") {
			if (repo === undefined) { console.error(USAGE); return 2; }
			const appended = importWhytrailLabels(repo, cfg.paths.score_state, gatherEpisodes(cfg, cutoff), ts);
			if (json) console.log(JSON.stringify(appended, null, 2));
			else console.log(`imported ${appended.length} label line(s) from whytrail`);
			return 0;
		}
		const episodes = gatherEpisodes(cfg, cutoff);
		if (json) console.log(JSON.stringify(episodes, null, 2));
		else if (episodes.length === 0) console.log("no episodes in the window");
		else for (const episode of episodes) console.log(`${episode.id} ${episode.agent} ${episode.model} ${episode.plan} ${episode.phase} ${episode.commits.join(",")}`);
		return 0;
	} catch (error) {
		console.error(error instanceof ConfigError ? error.message : String(error));
		return 1;
	}
}

function runAssign(args: string[], cfg: Config): number {
	const episode = args[0];
	if (!episode || episode.startsWith("-")) { console.error(USAGE); return 2; }
	let party: string | undefined;
	let why: string | undefined;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--party") party = args[++i];
		else if (arg === "--why") why = args[++i];
		else { console.error(USAGE); return 2; }
	}
	if ((party !== "plan" && party !== "implementer" && party !== "both") || !why) { console.error(USAGE); return 2; }
	const line = assignLabel(cfg.paths.score_state, episode, party, why, nowSec());
	console.log(`${line.episode} ${line.label} ${line.party}`);
	return 0;
}
