// `labels update` and `labels export --good` (plan 20261024_1915 P5 + P5b). update runs the P2
// labeller and the P3 whytrail import over the episodes since the ledger's watermark line, rescans
// good episodes for flips (a later revert, a penalty) and opens one `work-turned-bad` incident
// per flip; export lists the good set. The watermark, the idempotency and the incident dedup all
// live in the ledger, so a quiet second run appends nothing.

import type { Run, TraceSource } from "./adapter.ts";
import type { Config } from "./config.ts";
import type { Episode, EpisodeScoreEvent } from "./episodes.ts";
import { addIncident } from "./incidents.ts";
import { importWhytrailLabels } from "./label-import.ts";
import type { EpisodeLabel, LabelParty } from "./labels.ts";
import { appendWatermark, appendLabel, flipAccepted, flippedEpisodes, labelAndAppend, labelEpisodes, readWatermark, readLabels } from "./labels.ts";
import { efficiencyRules, runEfficiency } from "./trace-efficiency.ts";

export interface LabelUpdateDeps {
	/** Episodes whose runs started after the cutoff (the CLI's buildEpisodes window). */
	episodesFor: (cutoff: number) => Episode[];
	events: EpisodeScoreEvent[];
	runs: Run[];
}

export interface LabelFlip {
	episode: string;
	party: LabelParty;
	/** The commit that turned the work bad — the revert sha, or the labeller's reason when no sha exists. */
	fixSha: string;
}

export interface UpdateResult {
	/** P2 label lines appended for episodes new since the watermark. */
	labels: EpisodeLabel[];
	/** P3 whytrail lines appended for those episodes. */
	imported: EpisodeLabel[];
	/** Good episodes this run turned bad, one incident each. */
	flips: LabelFlip[];
	/** Why the P3 import did not run to completion; the update itself still lands. */
	importError?: string;
}

/**
 * One update pass. New episodes (runs after the watermark) get their first P2/P3 lines; every
 * rebuildable good episode is recomputed and flipped when the labeller now calls it bad. The
 * watermark advances only when something was appended, so a run with nothing new appends nothing.
 */
export function updateLabels(cfg: Config, repo: string, deps: LabelUpdateDeps, now: number): UpdateResult {
	const state = cfg.paths.score_state;
	const windowStart = now - cfg.labels.episode_days * 86400;
	const cutoff = readWatermark(state) ?? windowStart;
	const fresh = deps.episodesFor(cutoff);
	const labels = labelAndAppend(state, fresh, deps.events, deps.runs, now);
	let imported: EpisodeLabel[] = [];
	let importError: string | undefined;
	if (fresh.length > 0) {
		try {
			imported = importWhytrailLabels(repo, state, fresh, now);
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
		}
	}
	// Flip scan (P5b): the ledger's latest labels against a fresh labeller pass over the window.
	const latest = new Map(readLabels(state).map(l => [l.episode, l]));
	const windowed = deps.episodesFor(windowStart);
	const computed = labelEpisodes(windowed, deps.events, deps.runs, now);
	const flips: LabelFlip[] = [];
	windowed.forEach((episode, i) => {
		const c = computed[i]!;
		if (latest.get(episode.id)?.label !== "good" || c.label !== "bad") return;
		const fixSha = c.found_by ?? c.reason;
		let party: LabelParty;
		if (episode.acceptedAt !== null) {
			party = flipAccepted(cfg, episode, fixSha, now).party;
		} else {
			// Good without an accept (a whytrail import) takes no P4 party/test pair: one plain flip line.
			appendLabel(state, { ts: now, episode: episode.id, label: "bad", reason: `flipped by ${fixSha}`, party: "none", evidence: c.evidence, found_by: fixSha });
			party = "none";
		}
		addIncident(cfg, {
			source: "traces",
			kind: "work-turned-bad",
			summary: `work-turned-bad: agent ${episode.agent} plan ${episode.plan} phase ${episode.phase} fix ${fixSha} party ${party}`,
			evidence: c.evidence,
			fingerprint: `work-turned-bad:${episode.id}:${fixSha}`,
		}, now);
		flips.push({ episode: episode.id, party, fixSha });
	});
	if (labels.length + imported.length + flips.length > 0) appendWatermark(state, now);
	return { labels, imported, flips, importError };
}

export interface GoodRow {
	runId: string;
	briefRef: string | null;
	commits: string[];
	/** Ordinals among the run's tool calls that traces 05 (trace-efficiency) marks wasted. */
	wasted: number[];
}

/** The good set: latest label good, older than the min age, never flipped. */
export function goodSet(cfg: Config, episodes: Episode[], traceSrc: TraceSource | null, now: number, minAgeDays: number): GoodRow[] {
	const state = cfg.paths.score_state;
	const latest = new Map(readLabels(state).map(l => [l.episode, l]));
	const flipped = new Set(flippedEpisodes(state).map(f => f.episode));
	const oldest = now - minAgeDays * 86400;
	const out: GoodRow[] = [];
	for (const e of episodes) {
		if (latest.get(e.id)?.label !== "good") continue;
		if (flipped.has(e.id)) continue;
		if (e.acceptedAt === null || e.acceptedAt > oldest) continue;
		const wasted = traceSrc ? runEfficiency(traceSrc.events(e.runId), efficiencyRules(cfg)).steps.map(s => s.index) : [];
		out.push({ runId: e.runId, briefRef: e.briefRef, commits: e.commits, wasted });
	}
	return out;
}
