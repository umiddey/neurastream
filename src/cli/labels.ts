import { readEvents } from "../core/agent-score.ts";
import { getAdapter } from "../adapters/index.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { nowSec } from "../core/clock.ts";
import { goodSet, updateLabels } from "../core/label-update.ts";
import { importWhytrailLabels } from "../core/label-import.ts";
import { assignLabel } from "../core/labels.ts";
import { defaultRunSource } from "../adapters/omp/sessions.ts";

const USAGE = "usage: neurastream labels episodes [--since 30d] [--json]\n       neurastream labels import --repo <dir> [--since 30d] [--json]\n       neurastream labels update --repo <dir>\n       neurastream labels export --good [--min-age-days 14] [--json]\n       neurastream labels assign <episode> --party plan|implementer|both --why <text>";
const SINCE = /^(\d+)([dhm])$/;

export function runLabels(args: string[], opts: { home?: string } = {}): number {
	if (args[0] !== "episodes" && args[0] !== "import" && args[0] !== "assign" && args[0] !== "update" && args[0] !== "export") {
		console.error(USAGE);
		return 2;
	}
	try {
		const cfg = loadConfig(opts.home === undefined ? undefined : { home: opts.home });
		if (args[0] === "assign") return runAssign(args.slice(1), cfg);
		if (args[0] === "update") return runUpdate(args.slice(1), cfg);
		if (args[0] === "export") return runExport(args.slice(1), cfg);
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
			const appended = importWhytrailLabels(repo, cfg.paths.score_state, getAdapter(cfg).episodes(cfg, cutoff), ts);
			if (json) console.log(JSON.stringify(appended, null, 2));
			else console.log(`imported ${appended.length} label line(s) from whytrail`);
			return 0;
		}
		const episodes = getAdapter(cfg).episodes(cfg, cutoff);
		if (json) console.log(JSON.stringify(episodes, null, 2));
		else if (episodes.length === 0) console.log("no episodes in the window");
		else for (const episode of episodes) console.log(`${episode.id} ${episode.agent} ${episode.model} ${episode.plan} ${episode.phase} ${episode.commits.join(",")}`);
		return 0;
	} catch (error) {
		console.error(error instanceof ConfigError ? error.message : String(error));
		return 1;
	}
}

function runUpdate(args: string[], cfg: Config): number {
	let repo: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--repo") repo = args[++i];
		else { console.error(USAGE); return 2; }
	}
	if (repo === undefined) { console.error(USAGE); return 2; }
	const a = getAdapter(cfg);
	const result = updateLabels(cfg, repo, {
		episodesFor: cutoff => a.episodes(cfg, cutoff),
		events: readEvents(cfg),
		runs: defaultRunSource(cfg).listRuns(nowSec() - cfg.labels.episode_days * 86400),
	}, nowSec());
	console.log(`labels update ${repo}: ${result.labels.length} label(s), ${result.imported.length} imported, ${result.flips.length} flip(s)`);
	if (result.importError) console.error(`labels update: whytrail import skipped: ${result.importError}`);
	for (const f of result.flips) console.log(`flipped ${f.episode} (party ${f.party}, fix ${f.fixSha})`);
	return 0;
}

function runExport(args: string[], cfg: Config): number {
	let good = false;
	let json = false;
	let minAge = 14;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--good") good = true;
		else if (arg === "--json") json = true;
		else if (arg === "--min-age-days") minAge = Number(args[++i]);
		else { console.error(USAGE); return 2; }
	}
	if (!good || !Number.isFinite(minAge) || minAge < 0) { console.error(USAGE); return 2; }
	const a = getAdapter(cfg);
	const episodes = a.episodes(cfg, nowSec() - cfg.labels.episode_days * 86400);
	const rows = goodSet(cfg, episodes, a.scoreTraces(cfg), nowSec(), minAge);
	if (json) console.log(JSON.stringify(rows, null, 2));
	else if (rows.length === 0) console.log("no good episodes past the min age");
	else for (const r of rows) console.log(`${r.runId} ${r.briefRef ?? "-"} ${r.commits.join(",") || "-"} wasted=[${r.wasted.join(",")}]`);
	return 0;
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
