// `labels update` (plan 20261024_1915 P5 + P5b): P2+P3 over the episodes since the cursor
// (a cursor line in the same ledger), idempotent on a quiet second run; a flip to bad opens
// one `work-turned-bad` incident and a second update adds none.

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Episode, EpisodeScoreEvent } from "../src/core/episodes.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { labelLedgerPath, readLabels } from "../src/core/labels.ts";
import { updateLabels, type LabelUpdateDeps } from "../src/core/label-update.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "ns-labels-update-"));
	dirs.push(dir);
	return dir;
}

function homeCfg(): { home: string; cfg: Config } {
	const home = sandbox();
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), `paths:\n  home: "${home}"\n`);
	return { home, cfg: loadConfig({ home, env: {} }) };
}

function episode(overrides: Partial<Episode> = {}): Episode {
	return { id: "agent:plan:P2", agent: "agent", model: "model", plan: "plan", phase: "P2", repo: "", commits: [], runId: "agent", briefRef: null, acceptedAt: 10, rework: false, ...overrides };
}

function run(status: Run["status"], startedAt = 50): Run {
	return { id: "agent", kind: "sub", model: "model", calls: 1, tokens: 1, cacheRead: 0, cost: 0, inputTokens: 1, prefillTokens: 1, status, statusDetail: status, startedAt, lastWriteAt: startedAt, endedAt: startedAt, messages: [], scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: true, scoreEnd: "done" };
}

function acceptEvent(repo = ""): EpisodeScoreEvent {
	return { type: "accept", agent: "agent", plan: "plan", phase: "P2", repo, commits: [], rework: false };
}

/** Episodes the builder may return, filtered exactly like buildEpisodes: only runs started after the cutoff. */
function deps(episodes: Episode[], events: EpisodeScoreEvent[], runs: Run[] = [run("done")]): LabelUpdateDeps {
	const started = new Map(runs.map(r => [r.id, r.startedAt]));
	return { episodesFor: cutoff => episodes.filter(e => (started.get(e.runId) ?? 0) > cutoff), events, runs };
}

function gitRepo(): { repo: string; sha: string; git: (...args: string[]) => void } {
	const repo = join(sandbox(), "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	return { repo, sha: "", git };
}

function linesOf(scoreState: string): Record<string, unknown>[] {
	return readFileSync(labelLedgerPath(scoreState), "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
}

function bytesOf(scoreState: string): Buffer {
	return readFileSync(labelLedgerPath(scoreState));
}

test("update appends once and not twice", () => {
	const { cfg } = homeCfg();
	const ep = episode();
	const d = deps([ep], [acceptEvent()]);
	const first = updateLabels(cfg, "", d, 100);
	expect(first.labels).toHaveLength(1);
	expect(first.labels[0]).toMatchObject({ episode: ep.id, label: "good" });
	expect(first.imported).toHaveLength(0);
	// no whytrail on PATH: the import step is skipped with a note, not a crash
	expect(first.importError).toBeDefined();
	// one cursor line marks what the run processed
	expect(linesOf(cfg.paths.score_state).filter(l => l.kind === "cursor")).toEqual([
		expect.objectContaining({ kind: "cursor", until: 100 }),
	]);
	const afterFirst = bytesOf(cfg.paths.score_state);
	const second = updateLabels(cfg, "", d, 200);
	expect(second.labels).toHaveLength(0);
	expect(second.imported).toHaveLength(0);
	expect(second.flips).toHaveLength(0);
	expect(bytesOf(cfg.paths.score_state)).toEqual(afterFirst);
	expect(readLabels(cfg.paths.score_state)).toEqual([
		expect.objectContaining({ episode: ep.id, label: "good" }),
	]);
});

test("a second run with a new episode appends only that episode", () => {
	const { cfg } = homeCfg();
	const d0 = deps([], [acceptEvent()]);
	updateLabels(cfg, "", d0, 100);
	const late = episode({ id: "late:plan:P3", runId: "late" });
	const lateRun = run("done", 150);
	lateRun.id = "late";
	const d1 = deps([late], [acceptEvent()], [run("done", 50), lateRun]);
	const second = updateLabels(cfg, "", d1, 200);
	expect(second.labels.map(l => l.episode)).toEqual([late.id]);
	expect(linesOf(cfg.paths.score_state).filter(l => l.kind === "cursor")).toEqual([
		expect.objectContaining({ kind: "cursor", until: 200 }),
	]);
});

test("one flip opens one work-turned-bad incident; a second update adds none", () => {
	const { cfg } = homeCfg();
	const { repo, git } = gitRepo();
	mkdirSync(dirname(join(repo, "src/a.ts")), { recursive: true });
	writeFileSync(join(repo, "src/a.ts"), "work\n");
	git("add", "-A");
	git("commit", "-qm", "episode work");
	const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const ep = episode({ repo, commits: [sha] });
	const d = deps([ep], [acceptEvent(repo)], [run("done", 50)]);
	updateLabels(cfg, repo, d, 100);

	writeFileSync(join(repo, "src/a.ts"), "reverted\n");
	git("commit", "-qam", `Revert "episode work"\n\nThis reverts commit ${sha}.`);
	const fixSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const before = bytesOf(cfg.paths.score_state);
	const second = updateLabels(cfg, repo, d, 200);
	expect(second.flips).toEqual([{ episode: ep.id, party: expect.any(String), fixSha }]);
	// the flip lines are appended, nothing rewritten
	expect(bytesOf(cfg.paths.score_state).subarray(0, before.length)).toEqual(before);
	expect(readLabels(cfg.paths.score_state).find(l => l.episode === ep.id)?.label).toBe("bad");
	const incidents = openIncidents(cfg).filter(i => i.kind === "work-turned-bad");
	expect(incidents).toHaveLength(1);
	expect(incidents[0]!.fingerprint).toBe(`work-turned-bad:${ep.id}:${fixSha}`);
	expect(incidents[0]!.summary).toContain(`agent agent`);
	expect(incidents[0]!.summary).toContain(`plan plan`);
	expect(incidents[0]!.summary).toContain(`phase P2`);
	expect(incidents[0]!.summary).toContain(`fix ${fixSha}`);
	// a second update re-detects nothing: no new lines, no second incident
	const afterFlip = bytesOf(cfg.paths.score_state);
	const third = updateLabels(cfg, repo, d, 300);
	expect(third.flips).toHaveLength(0);
	expect(openIncidents(cfg).filter(i => i.kind === "work-turned-bad")).toHaveLength(1);
	expect(bytesOf(cfg.paths.score_state)).toEqual(afterFlip);
});
