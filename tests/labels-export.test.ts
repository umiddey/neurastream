// `labels export --good` (plan 20261024_1915 P5): episodes whose latest label is good, older
// than the min age, never flipped; each row carries runId, brief ref, commits and the trace
// step indexes traces 05 (trace-efficiency) marks as wasted.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent, TraceSource } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Episode } from "../src/core/episodes.ts";
import { appendLabel, flippedEpisodes } from "../src/core/labels.ts";
import { goodSet } from "../src/core/label-update.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function homeCfg(): { home: string; cfg: Config } {
	const home = mkdtempSync(join(tmpdir(), "ns-labels-export-"));
	dirs.push(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), `paths:\n  home: "${home}"\n`);
	return { home, cfg: loadConfig({ home, env: {} }) };
}

function episode(id: string, acceptedAt: number, overrides: Partial<Episode> = {}): Episode {
	return { id, agent: id.split(":")[0]!, model: "model", plan: id.split(":")[1]!, phase: id.split(":")[2]!, repo: "", commits: [`c-${id}`], runId: id.split(":")[0]!, briefRef: `brief:${id}`, acceptedAt, rework: false, ...overrides };
}

const NOW = 1_700_000_000;
const DAY = 86400;

function call(runId: string, callId: string): TraceEvent {
	return { kind: "toolCall", ts: NOW, runId, tool: "read", args: { file_path: "a.ts" }, callId };
}

function result(runId: string, callId: string): TraceEvent {
	return { kind: "toolResult", ts: NOW, runId, callId, text: "ok" };
}

/** Three identical reads: repeat_read_min 3 marks the third call (index 2) wasted. */
const traceSrc: TraceSource = {
	events: runId => (runId === "old" ? [call(runId, "c1"), call(runId, "c2"), call(runId, "c3"), result(runId, "c3")] : []),
};

function seedLedger(cfg: Config): void {
	const state = cfg.paths.score_state;
	// old: good, 20 days old — in
	appendLabel(state, { ts: NOW - 20 * DAY, episode: "old:plan:P1", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	// young: good but accepted 1 day ago — out by min age
	appendLabel(state, { ts: NOW - 1 * DAY, episode: "young:plan:P2", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	// flipped: good once, later bad — out by never-flipped
	appendLabel(state, { ts: NOW - 20 * DAY, episode: "flip:plan:P3", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	appendLabel(state, { ts: NOW - 5 * DAY, episode: "flip:plan:P3", label: "bad", reason: "reverted", party: "implementer", evidence: "revert" });
	// unlabelled episode — out (latest label is nothing)
}

const EPISODES = [episode("old:plan:P1", NOW - 20 * DAY), episode("young:plan:P2", NOW - 1 * DAY), episode("flip:plan:P3", NOW - 20 * DAY), episode("ghost:plan:P4", NOW - 20 * DAY)];

test("export keeps good, old enough, never-flipped episodes", () => {
	const { cfg } = homeCfg();
	seedLedger(cfg);
	const rows = goodSet(cfg, EPISODES, traceSrc, NOW, 14);
	expect(rows.map(r => r.runId)).toEqual(["old"]);
	expect(rows[0]).toEqual({ runId: "old", briefRef: "brief:old:plan:P1", commits: ["c-old:plan:P1"], wasted: [2] });
});

test("export flips check reads the ledger, not a recompute", () => {
	const { cfg } = homeCfg();
	seedLedger(cfg);
	expect(flippedEpisodes(cfg.paths.score_state).map(f => f.episode)).toEqual(["flip:plan:P3"]);
});

test("export min age 0 keeps the young episode too", () => {
	const { cfg } = homeCfg();
	seedLedger(cfg);
	const rows = goodSet(cfg, EPISODES, traceSrc, NOW, 0);
	expect(rows.map(r => r.runId)).toEqual(["old", "young"]);
	expect(rows[1]!.wasted).toEqual([]); // no trace events for young: no wasted steps
});

test("export with an unknown run emits no wasted steps and keeps the row", () => {
	const { cfg } = homeCfg();
	appendLabel(cfg.paths.score_state, { ts: NOW - 20 * DAY, episode: "solo:plan:P9", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	const rows = goodSet(cfg, [episode("solo:plan:P9", NOW - 20 * DAY)], { events: () => [] }, NOW, 14);
	expect(rows).toEqual([{ runId: "solo", briefRef: "brief:solo:plan:P9", commits: ["c-solo:plan:P9"], wasted: [] }]);
});
