import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Episode } from "./episodes.ts";
import { appendLabel, type EpisodeLabel } from "./labels.ts";

export type PlanLabelFlag = "bad" | "good" | "open";

/** One `whytrail labels --json` row (whytrail lineage.ts PlanLabel). */
export interface PlanLabel {
	plan: string;
	label: PlanLabelFlag;
	by?: string;
	goal?: string;
}

/** whytrail names plans by basename without .md; episode.plan holds the full accept --plan path. */
export function planKey(plan: string): string {
	return basename(plan).replace(/\.md$/, "");
}

/** The cards.jsonl whytrail `labels` rewrites, resolved exactly like whytrail's repoContext (whytrail git.ts:45-51): the absolute git common dir with one trailing /.git (then one /) stripped. */
function cardsPathFor(repo: string): string {
	const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	return join(common.replace(/\/\.git$/, "").replace(/\/$/, ""), ".whytrail", "cards.jsonl");
}

export interface ImportOpts {
	/** PATH for the whytrail lookup; defaults to the process PATH (tests pin a stub dir). */
	path?: string;
}

/**
 * Run `whytrail labels --json --repo <repo>` and append one ledger line per matching episode.
 * The call is a pure read in effect: the child gets no provider key and an empty temp HOME (so
 * whytrail classifies nothing), and the cards.jsonl whytrail always rewrites is snapshotted and
 * restored in a finally that wraps the whole call — a write-then-throw restores too, and a file
 * absent before stays absent after. Plans labelled open (or unmatched by any episode) append
 * nothing: unknown is thrown away, not guessed.
 */
export function importWhytrailLabels(repo: string, scoreState: string, episodes: Episode[], ts: number, opts: ImportOpts = {}): EpisodeLabel[] {
	const cards = cardsPathFor(repo);
	const snapshot = existsSync(cards) ? readFileSync(cards) : null;
	const home = mkdtempSync(join(tmpdir(), "whytrail-home-"));
	const env = { ...process.env };
	delete env.OPENROUTER_API_KEY;
	env.HOME = home;
	if (opts.path !== undefined) env.PATH = opts.path;
	try {
		let out: string;
		try {
			out = execFileSync("whytrail", ["labels", "--json", "--repo", repo], {
				cwd: repo,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`whytrail labels failed for ${repo}: ${detail}`, { cause: error });
		}
		const rows = JSON.parse(out) as PlanLabel[];
		const byPlan = new Map<string, Episode[]>();
		for (const episode of episodes) {
			const key = planKey(episode.plan);
			const same = byPlan.get(key);
			if (same) same.push(episode);
			else byPlan.set(key, [episode]);
		}
		const appended: EpisodeLabel[] = [];
		for (const row of rows) {
			// open (and anything else) is no line; every appended row is party "none" — real parties are P4.
			if ((row.label !== "bad" && row.label !== "good") || !row.plan) continue;
			const targets = byPlan.get(planKey(row.plan));
			if (!targets) continue;
			for (const episode of targets) {
				const label: EpisodeLabel = {
					ts,
					episode: episode.id,
					label: row.label,
					reason: row.goal !== undefined && row.goal.trim() !== "" ? row.goal : `whytrail plan ${row.plan}: ${row.label}`,
					party: "none",
					evidence: `whytrail labels: plan ${row.plan} ${row.label}`,
				};
				if (row.by) label.found_by = row.by;
				appendLabel(scoreState, label);
				appended.push(label);
			}
		}
		return appended;
	} finally {
		if (snapshot === null) rmSync(cards, { force: true });
		else writeFileSync(cards, snapshot);
		rmSync(home, { recursive: true, force: true });
	}
}
