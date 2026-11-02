import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Run } from "./adapter.ts";
import type { Config } from "./config.ts";
import type { Episode, EpisodeScoreEvent } from "./episodes.ts";
import { addIncident } from "./incidents.ts";

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

export function readLabelHistory(scoreState: string): EpisodeLabel[] {
	const path = labelLedgerPath(scoreState);
	if (!existsSync(path)) return [];
	const out: EpisodeLabel[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		out.push(JSON.parse(line) as EpisodeLabel);
	}
	return out;
}

export function readLabels(scoreState: string): EpisodeLabel[] {
	const latest = new Map<string, EpisodeLabel>();
	for (const label of readLabelHistory(scoreState)) latest.set(label.episode, label);
	return [...latest.values()];
}

/** A flip is a good line followed by a later bad line, unless a newer good line cleared it. Party is the latest non-test line of that flip: the automatic test-party line is extra history, not the attribution. */
export function flippedEpisodes(scoreState: string): { episode: string; party: LabelParty }[] {
	const state = new Map<string, { seenGood: boolean; flipped: boolean; party: LabelParty }>();
	for (const line of readLabelHistory(scoreState)) {
		const st = state.get(line.episode) ?? { seenGood: false, flipped: false, party: "none" as const };
		if (line.label === "good") {
			st.seenGood = true;
			st.flipped = false;
			st.party = "none";
		} else if (line.label === "bad" && st.seenGood) {
			st.flipped = true;
			if (line.party !== "test") st.party = line.party;
		}
		state.set(line.episode, st);
	}
	return [...state.entries()].filter(([, st]) => st.flipped).map(([episode, st]) => ({ episode, party: st.party }));
}

function gitOut(repo: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

function planNamesFile(plan: string, file: string): boolean {
	const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`(?:^|[^\\w./-])${escaped}(?:$|[^\\w./-])`).test(plan)) return true;
	const base = file.split("/").pop() ?? file;
	for (const match of plan.matchAll(/`([^`]+)`/g)) {
		const bare = match[1]!.replace(/:\d+(?::\d+)?$/, "");
		if (bare === file || bare === base || file.endsWith(`/${bare}`)) return true;
	}
	return false;
}

function blamedLines(repo: string, sha: string): { file: string; text: string }[] {
	const diff = gitOut(repo, ["show", "--format=", "--unified=0", sha]);
	if (diff === null) return [];
	const out: { file: string; text: string }[] = [];
	let file = "";
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) {
			const raw = line.slice(4);
			file = raw === "/dev/null" ? "" : raw.replace(/^b\//, "");
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!hunk || !file) continue;
		const start = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		if (count <= 0) continue;
		const blame = gitOut(repo, ["blame", "-L", `${start},${start + count - 1}`, "--line-porcelain", sha, "--", file]);
		if (blame === null) continue;
		let blamed = file;
		for (const row of blame.split("\n")) {
			if (row.startsWith("filename ")) blamed = row.slice("filename ".length);
			else if (row.startsWith("\t")) out.push({ file: blamed, text: row.slice(1) });
		}
	}
	return out;
}

/**
 * Party of the episode's own changed lines. A backticked identifier or path from the phase
 * line or Background in those lines is `plan`; a blamed file the plan never names is
 * `implementer`. Both true → `both`. Neither true is what the plan calls "unclear":
 * LabelParty has no "unclear", so it is recorded as `none`.
 */
export function blameParty(episode: Episode): LabelParty {
	if (!episode.repo || episode.commits.length === 0) return "none";
	let plan = "";
	try {
		if (episode.plan) plan = readFileSync(episode.plan, "utf8");
	} catch { /* A missing plan names nothing, so it cannot be the plan party. */ }
	const phaseRe = new RegExp(`^- \\[[ xX]\\] ${episode.phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	const lines = plan.split("\n");
	const phaseLine = lines.find(l => phaseRe.test(l)) ?? "";
	const start = lines.findIndex(l => l.trim() === "## Background");
	const body: string[] = [];
	if (start >= 0) {
		for (let i = start + 1; i < lines.length; i++) {
			if (lines[i]!.startsWith("## ")) break;
			body.push(lines[i]!);
		}
	}
	const needles = new Set<string>();
	for (const match of `${phaseLine}\n${body.join("\n")}`.matchAll(/`([^`]+)`/g)) {
		const bare = match[1]!.replace(/:\d+(?::\d+)?$/, "");
		if (/^[A-Za-z_][A-Za-z0-9_$.]*$/.test(bare) || bare.includes("/") || /\.[A-Za-z0-9]+$/.test(bare)) needles.add(bare);
	}
	let planHit = false;
	let implementerHit = false;
	for (const sha of episode.commits) {
		for (const line of blamedLines(episode.repo, sha)) {
			if ([...needles].some(n => line.text.includes(n))) planHit = true;
			if (!planNamesFile(plan, line.file)) implementerHit = true;
		}
	}
	if (planHit && implementerHit) return "both";
	if (planHit) return "plan";
	if (implementerHit) return "implementer";
	return "none";
}

function testHole(fixSha: string): string {
	return `test hole: ${fixSha} changed lines no check caught`;
}

/** Flip an accepted episode: append the blame party, then a test-party line, and open one incident. A repeat of the same fix appends nothing; the fingerprint dedupes the incident. */
export function flipAccepted(cfg: Config, episode: Episode, fixSha: string, ts: number): { party: LabelParty; appended: boolean } {
	if (episode.acceptedAt === null) return { party: "none", appended: false };
	const party = blameParty(episode);
	const already = readLabelHistory(cfg.paths.score_state).some(l => l.episode === episode.id && l.party === "test" && l.found_by === fixSha);
	if (!already) {
		appendLabel(cfg.paths.score_state, {
			ts, episode: episode.id, label: "bad", reason: `flipped by ${fixSha}`, party,
			evidence: `git blame of ${episode.commits.join(",") || "no commits"}`, found_by: fixSha,
		});
		appendLabel(cfg.paths.score_state, {
			ts, episode: episode.id, label: "bad", reason: testHole(fixSha), party: "test", evidence: testHole(fixSha), found_by: fixSha,
		});
	}
	addIncident(cfg, {
		source: "traces", kind: "test-hole", summary: testHole(fixSha), evidence: episode.id,
		fingerprint: `test-hole:${episode.id}:${fixSha}`,
	}, ts);
	return { party, appended: !already };
}

/** Main's party override. Appends; the previous label value is kept, never rewritten. */
export function assignLabel(scoreState: string, episode: string, party: "plan" | "implementer" | "both", why: string, ts: number): EpisodeLabel {
	const latest = readLabels(scoreState).find(l => l.episode === episode);
	const line: EpisodeLabel = {
		ts, episode, label: latest?.label ?? "unknown", reason: why, party, evidence: "labels assign",
	};
	appendLabel(scoreState, line);
	return line;
}
