import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../src/core/adapter.ts";
import type { Episode } from "../src/core/episodes.ts";
import { appendLabel, labelEpisodes, readLabels } from "../src/core/labels.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "ns-labels-"));
	dirs.push(dir);
	return dir;
}

function episode(overrides: Partial<Episode> = {}): Episode {
	return { id: "agent:plan:P2", agent: "agent", model: "model", plan: "plan", phase: "P2", repo: "", commits: [], runId: "agent", briefRef: null, acceptedAt: null, rework: false, ...overrides };
}

function run(status: Run["status"], statusDetail: string = status): Run {
	return { id: "agent", kind: "sub", model: "model", calls: 1, tokens: 1, cacheRead: 0, cost: 0, inputTokens: 1, prefillTokens: 1, status, statusDetail, startedAt: 1, lastWriteAt: 1, endedAt: 1, messages: [], scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: true, scoreEnd: "done" };
}

test("accept without rework is good", () => {
	const [label] = labelEpisodes([episode()], [{ type: "accept", agent: "agent", plan: "plan", phase: "P2", rework: false }], [run("done")], 42);
	expect(label).toMatchObject({ label: "good", reason: "accepted without rework", party: "none" });
});

test("accept with rework is bad and assigned to implementer", () => {
	const [label] = labelEpisodes([episode({ rework: true })], [{ type: "accept", agent: "agent", plan: "plan", phase: "P2", rework: true }], [run("done")], 42);
	expect(label).toMatchObject({ label: "bad", reason: "accepted with rework", party: "implementer" });
});

test("penalty is bad", () => {
	const [label] = labelEpisodes([episode()], [{ type: "penalty", agent: "agent", plan: "plan", phase: "P2", kind: "scope" }], [run("done")], 42);
	expect(label).toMatchObject({ label: "bad", reason: "penalty" });
});

test("DIED and over-budget without accept are bad", () => {
	const died = labelEpisodes([episode()], [], [run("died", "DIED")], 42)[0];
	const over = labelEpisodes([episode()], [], [run("done", "OVER-BUDGET(101>100 calls)")], 42)[0];
	expect(died).toMatchObject({ label: "bad", reason: "run died without accept" });
	expect(over).toMatchObject({ label: "bad", reason: "run over budget without accept" });
});

test("a later revert of an episode commit is bad", () => {
	const repo = join(sandbox(), "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(repo, "source.txt"), "original\n");
	git("add", "source.txt");
	git("commit", "-qm", "episode work");
	const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	writeFileSync(join(repo, "source.txt"), "reverted\n");
	git("commit", "-qam", `Revert \"episode work\"\n\nThis reverts commit ${commit}.`);
	const [label] = labelEpisodes([episode({ repo, commits: [commit] })], [], [], 42);
	expect(label).toMatchObject({ label: "bad", reason: "episode commit later reverted", found_by: expect.any(String) });
});

test("ledger writes preserve all previous bytes as an unchanged prefix and last line is effective", () => {
	const state = sandbox();
	const first = { ts: 1, episode: "e", label: "good" as const, reason: "accepted", party: "none" as const, evidence: "accept" };
	appendLabel(state, first);
	const firstBytes = readFileSync(join(state, "labels.jsonl"));
	appendLabel(state, { ...first, ts: 2, label: "bad", reason: "reverted", found_by: "fixsha" });
	const secondBytes = readFileSync(join(state, "labels.jsonl"));
	expect(secondBytes.subarray(0, firstBytes.length)).toEqual(firstBytes);
	appendLabel(state, { ...first, ts: 3, label: "unknown", reason: "relabelled" });
	const finalBytes = readFileSync(join(state, "labels.jsonl"));
	expect(finalBytes.subarray(0, secondBytes.length)).toEqual(secondBytes);
	expect(readLabels(state)).toEqual([{ ...first, ts: 3, label: "unknown", reason: "relabelled" }]);
});
