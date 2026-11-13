import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { type Config, loadConfig } from "../src/core/config.ts";
import { type RoutedTeam, type SpawnIdent, teamCapProblem } from "../src/core/guards.ts";
import { teamDir } from "../src/core/team-client.ts";
import { teamConfigError } from "../src/core/team-labels.ts";

type TeamCfg = Config["teams"][number];

const TMP = mkdtempSync(join(tmpdir(), "team-rules-guard-"));
const T0 = 1_700_000_000 + 12 * 3600;
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(T0);

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	rmSync(TMP, { recursive: true, force: true });
});

/** Epoch seconds of the local midnight that starts `sec`'s day: the cap's day boundary. */
function midnightOf(sec: number): number {
	const d = new Date(sec * 1000);
	d.setHours(0, 0, 0, 0);
	return d.getTime() / 1000;
}
const MID = midnightOf(T0);

const base = loadConfig({ home: join(TMP, "home"), env: {} });

function teamOf(name: string, max?: number): TeamCfg {
	return {
		name,
		server: "http://127.0.0.1:9",
		repos: ["gitlab.com/acme/*"],
		...(max === undefined ? {} : { max_share: max }),
	};
}

function cfgWith(teams: TeamCfg[]): Config {
	return { ...base, paths: { ...base.paths, queue_state: join(TMP, "state") }, teams };
}

/** The team at `i`; a missing index is a test bug, not a silent undefined. */
function teamAt(c: Config, i: number): TeamCfg {
	const t = c.teams[i];
	if (!t) throw new Error(`no team ${i}`);
	return t;
}

/** Writes a team's spawns.jsonl rows: one agent per row, as the spawn gate records them. */
function writeSpawns(c: Config, teamIndex: number, rows: { agentId: string; at: number }[]): void {
	const dir = teamDir(c, teamAt(c, teamIndex));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "spawns.jsonl"), rows.map((r) => `${JSON.stringify({ planId: "p1", ...r })}\n`).join(""));
}

/** A run source over fixed [agentId, calls] rows; `since` values are recorded in `seen`. */
function runsOf(rows: [string, number][], seen: number[] = []): RunSource {
	return {
		listRuns(since: number): Run[] {
			seen.push(since);
			return rows.map(([id, calls]) => ({ id, calls }) as Run);
		},
		mainSession: () => null,
	};
}

function routed(c: Config, teamIndex = 0): RoutedTeam {
	return { team: teamAt(c, teamIndex), file: join(TMP, "plan.md") };
}

function spawnOf(runs: RunSource | undefined, agentIds: string[] = ["ada"]): SpawnIdent {
	return { agentIds, unnamed: false, runs };
}

/** The refusal `teams[0].max_share` gets for a bad value, or null when the config is valid. */
function maxShareError(max: unknown): string | null {
	return teamConfigError([{ name: "acme", server: "http://x", repos: ["gitlab.com/acme/*"], max_share: max }]);
}

test("team cap: under max_share allows the spawn", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	writeSpawns(c, 0, [{ agentId: "ada", at: T0 }]);
	// ada 2 of 10 calls today: 0.2 is under the 0.5 cap.
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 2], ["bob", 8]])), c)).toBeNull();
});

test("team cap: reaching max_share refuses, and the boundary counts", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	writeSpawns(c, 0, [{ agentId: "ada", at: T0 }]);
	const over = teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 6], ["bob", 4]])), c);
	expect(over).toBe("team acme cap reached: 6 of 10 calls today (max_share 0.5); team plans wait until local midnight");
	// Exactly at the cap is at the cap: refused.
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 5], ["bob", 5]])), c)).toContain("cap reached: 5 of 10");
});

test("team cap: no calls today allows (denominator 0)", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	writeSpawns(c, 0, [{ agentId: "ada", at: T0 }]);
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([])), c)).toBeNull();
});

test("team cap: a capped team with no run source refuses rather than guessing", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	expect(teamCapProblem([routed(c)], spawnOf(undefined), c)).toBe(
		"team acme sets max_share: the cap cannot be computed without a run source",
	);
});

test("team cap: an uncapped team ignores the run source and never refuses", () => {
	const c = cfgWith([teamOf("acme")]);
	expect(teamCapProblem([routed(c)], spawnOf(undefined), c)).toBeNull();
});

test("team cap: only rows since local midnight count against the cap", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	// Yesterday's spawn of ada does not count; today's does.
	writeSpawns(c, 0, [{ agentId: "ada", at: MID - 60 }]);
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 9], ["bob", 1]])), c)).toBeNull();
	writeSpawns(c, 0, [{ agentId: "ada", at: MID + 60 }]);
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 9], ["bob", 1]])), c)).toContain("cap reached: 9 of 10");
});

test("team cap: one spawn reads the run source once, however many capped teams it touches", () => {
	const c = cfgWith([teamOf("acme", 0.9), teamOf("beta", 0.9)]);
	writeSpawns(c, 0, [{ agentId: "ada", at: T0 }]);
	writeSpawns(c, 1, [{ agentId: "ada", at: T0 }]);
	const seen: number[] = [];
	expect(teamCapProblem([routed(c, 0), routed(c, 1)], spawnOf(runsOf([["ada", 1], ["bob", 9]], seen)), c)).toBeNull();
	expect(seen).toEqual([MID]);
});

test("team cap: a team's rows do not count against another team's cap", () => {
	const c = cfgWith([teamOf("acme", 0.5), teamOf("beta", 0.5)]);
	writeSpawns(c, 0, [{ agentId: "ada", at: T0 }]);
	writeSpawns(c, 1, [{ agentId: "bob", at: T0 }]);
	// ada used 6 of 10 calls on acme, so acme refuses. bob used 4 of 10 on beta: under 0.5, allowed.
	expect(teamCapProblem([routed(c, 1)], spawnOf(runsOf([["ada", 6], ["bob", 4]]), ["bob"]), c)).toBeNull();
	expect(teamCapProblem([routed(c, 0)], spawnOf(runsOf([["ada", 6], ["bob", 4]])), c)).toContain("team acme cap reached");
});

test("team max_share: must be a number above 0 and at most 1", () => {
	const bad = "teams[0].max_share must be a number above 0 and at most 1";
	expect(maxShareError(0)).toBe(bad);
	expect(maxShareError(1.5)).toBe(bad);
	expect(maxShareError("half")).toBe(bad);
	expect(maxShareError(1)).toBeNull();
	expect(maxShareError(0.25)).toBeNull();
	expect(maxShareError(undefined)).toBeNull();
});

test("spawns.jsonl: a corrupt row counts for nothing and does not hide the rows after it", () => {
	const c = cfgWith([teamOf("acme", 0.5)]);
	const dir = teamDir(c, teamAt(c, 0));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "spawns.jsonl"), `{not json\n${JSON.stringify({ planId: "p1", agentId: "ada", at: T0 })}\n`);
	expect(teamCapProblem([routed(c)], spawnOf(runsOf([["ada", 6], ["bob", 4]])), c)).toContain("cap reached: 6 of 10");
});
