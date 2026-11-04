import type { Run, RunSource } from "./adapter.ts";
import type { SpawnBrief } from "./trace-briefs.ts";

export interface Episode {
	id: string;
	agent: string;
	model: string;
	plan: string;
	phase: string;
	repo: string;
	commits: string[];
	runId: string;
	briefRef: string | null;
	acceptedAt: number | null;
	rework: boolean;
}

export type EpisodeScoreEvent = Record<string, unknown>;

function failedRun(run: Run): boolean {
	return run.status === "died" || /OVER-BUDGET\(/i.test(run.statusDetail);
}

export function buildEpisodes(runs: RunSource, events: EpisodeScoreEvent[], briefs: SpawnBrief[], since: number): Episode[] {
	const listed = runs.listRuns(since).filter(run => run.kind === "sub");
	const output: Episode[] = [];
	for (const run of listed) {
		const runEvents = events.filter(event => event.agent === run.id && ["accept", "validate", "diagnose", "penalty"].includes(String(event.type)));
		const acceptance = runEvents.find(event => event.type === "accept" || event.type === "validate");
		if (runEvents.length === 0 && !failedRun(run)) continue;
		const score = acceptance ?? runEvents[0];
		const brief = briefs.reduce<SpawnBrief | undefined>((best, candidate) => {
			if (candidate.agent !== run.id || (candidate.ts !== null && run.startedAt !== null && candidate.ts > run.startedAt)) return best;
			if (!best || (candidate.ts !== null && (best.ts === null || candidate.ts > best.ts))) return candidate;
			return best;
		}, undefined);
		output.push({
			id: `${run.id}:${String(score?.plan ?? "")}:${String(score?.phase ?? "")}`,
			agent: run.id,
			model: run.model,
			plan: String(score?.plan ?? ""),
			phase: String(score?.phase ?? ""),
			repo: String(score?.repo ?? ""),
			commits: Array.isArray(acceptance?.commits) ? acceptance.commits.map(String) : [],
			runId: run.id,
			briefRef: brief ? `${brief.ts ?? ""}:${brief.agent}` : null,
			acceptedAt: typeof acceptance?.ts === "number" ? acceptance.ts : null,
			rework: acceptance?.rework === true,
		});
	}
	return output;
}


