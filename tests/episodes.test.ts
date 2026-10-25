import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { buildEpisodes } from "../src/core/episodes.ts";
import { runLabels } from "../src/cli/labels.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(id: string, status: Run["status"] = "done"): Run {
	return { id, kind: "sub", model: "test-model", calls: 1, tokens: 2, cacheRead: 0, cost: 0, inputTokens: 1, prefillTokens: 1, status, statusDetail: status === "died" ? "DIED" : "done", startedAt: 100, lastWriteAt: 200, endedAt: 200, messages: [], scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: status === "done", scoreEnd: "done" };
}

function source(...rows: Run[]): RunSource {
	return { listRuns: since => rows.filter(row => (row.startedAt ?? 0) >= since), mainSession: () => null };
}

test("joins accept events with run data and the matching spawn brief", () => {
	const result = buildEpisodes(source(run("AgentA")), [{ type: "accept", agent: "AgentA", plan: "plan.md", phase: "P1", repo: "/repo", commits: ["abc"], ts: 150, rework: false }], [{ agent: "AgentA", brief: "build feature", ts: 90 }], 0);
	expect(result).toEqual([{ id: "AgentA:plan.md:P1", agent: "AgentA", model: "test-model", plan: "plan.md", phase: "P1", repo: "/repo", commits: ["abc"], runId: "AgentA", briefRef: "90:AgentA", acceptedAt: 150, rework: false }]);
});

test("DIED runs without accept become commitless episodes", () => {
	const result = buildEpisodes(source(run("AgentDead", "died")), [], [], 0);
	expect(result).toHaveLength(1);
	expect(result[0]?.commits).toEqual([]);
	expect(result[0]?.acceptedAt).toBeNull();
});

test("over-budget runs without accept become commitless episodes", () => {
	const overBudget = { ...run("AgentOver"), statusDetail: "RUNNING OVER-BUDGET(101>100 calls)" };
	const result = buildEpisodes(source(overBudget), [], [], 0);
	expect(result).toHaveLength(1);
	expect(result[0]?.commits).toEqual([]);
});

test("since cutoff excludes older runs", () => {
	const result = buildEpisodes(source(run("AgentOld")), [{ type: "accept", agent: "AgentOld", ts: 50 }], [], 101);
	expect(result).toEqual([]);
});

test("labels episodes --json emits the expected output shape", () => {
	const home = mkdtempSync(join(tmpdir(), "ns-episodes-"));
	dirs.push(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), `paths:\n  home: "${home}"\n`);
	const previousLog = console.log;
	const lines: string[] = [];
	try {
		console.log = (line?: unknown) => lines.push(String(line ?? ""));
		const status = runLabels(["episodes", "--since", "30d", "--json"], { home });
		expect(status).toBe(0);
		expect(JSON.parse(lines[0] ?? "null")).toEqual([]);
	} finally {
		console.log = previousLog;
	}
});
