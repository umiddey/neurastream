import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Run } from "./adapter.ts";
import type { Episode, EpisodeScoreEvent } from "./episodes.ts";

export type WorkLabel = "good" | "bad" | "unknown";
export type LabelParty = "plan" | "implementer" | "both" | "test" | "none";

export interface EpisodeLabel {
	ts: number;
	episode: string;
	label: WorkLabel;
	reason: string;
	party: LabelParty;
	evidence: string;
	found_by?: string;
}

export function labelEpisodes(episodes: Episode[], events: EpisodeScoreEvent[], runs: Run[], ts: number): EpisodeLabel[] {
	const byRun = new Map(runs.map(run => [run.id, run]));
	return episodes.map(episode => {
		const relevant = events.filter(event => event.agent === episode.agent && (event.plan === undefined || event.plan === episode.plan) && (event.phase === undefined || event.phase === episode.phase));
		const acceptance = relevant.find(event => event.type === "accept" || event.type === "validate");
		const penalty = relevant.find(event => event.type === "penalty");
		if (penalty) return { ts, episode: episode.id, label: "bad", reason: "penalty", party: "none", evidence: `penalty event: ${String(penalty.kind ?? penalty.note ?? "recorded")}` };
		const reverted = revertedCommit(episode);
		if (reverted) return { ts, episode: episode.id, label: "bad", reason: "episode commit later reverted", party: "none", evidence: `revert commit ${reverted.revert} reverts ${reverted.commit}`, found_by: reverted.revert };
		if (acceptance && episode.rework) return { ts, episode: episode.id, label: "bad", reason: "accepted with rework", party: "implementer", evidence: `accept event for ${episode.agent} recorded rework` };
		if (acceptance) return { ts, episode: episode.id, label: "good", reason: "accepted without rework", party: "none", evidence: `accept event for ${episode.agent} without rework` };
		const run = byRun.get(episode.runId);
		if (run?.status === "died") return { ts, episode: episode.id, label: "bad", reason: "run died without accept", party: "implementer", evidence: `run status: ${run.statusDetail}` };
		if (run && /OVER-BUDGET\(/i.test(run.statusDetail)) return { ts, episode: episode.id, label: "bad", reason: "run over budget without accept", party: "implementer", evidence: `run status: ${run.statusDetail}` };
		return { ts, episode: episode.id, label: "unknown", reason: "no recorded outcome", party: "none", evidence: "no qualifying score event, failed run, or revert found" };
	});
}
function revertedCommit(episode: Episode): { commit: string; revert: string } | null {
	if (!episode.repo || episode.commits.length === 0) return null;
	try {
		const log = execFileSync("git", ["-C", episode.repo, "log", "--all", "--format=%H%x00%B%x00"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const rows = log.split("\0");
		for (let i = 0; i + 1 < rows.length; i += 2) {
			const sha = rows[i]!;
			const message = rows[i + 1]!;
			for (const commit of episode.commits) if (message.includes(`This reverts commit ${commit}.`)) return { commit, revert: sha };
		}
	} catch { /* An unavailable/non-git repository provides no revert evidence. */ }
	return null;
}

export function labelLedgerPath(scoreState: string): string {
	return join(scoreState, "labels.jsonl");
}

export function appendLabel(scoreState: string, label: EpisodeLabel): void {
	mkdirSync(scoreState, { recursive: true });
	appendFileSync(labelLedgerPath(scoreState), `${JSON.stringify(label)}\n`);
}


export function labelAndAppend(scoreState: string, episodes: Episode[], events: EpisodeScoreEvent[], runs: Run[], ts: number): EpisodeLabel[] {
	const labels = labelEpisodes(episodes, events, runs, ts);
	for (const label of labels) appendLabel(scoreState, label);
	return labels;
}
export function readLabels(scoreState: string): EpisodeLabel[] {
	const path = labelLedgerPath(scoreState);
	if (!existsSync(path)) return [];
	const latest = new Map<string, EpisodeLabel>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const label = JSON.parse(line) as EpisodeLabel;
		latest.set(label.episode, label);
	}
	return [...latest.values()];
}
