import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { agentScore } from "../src/core/agent-score.ts";
import { nowSec } from "../src/core/clock.ts";
import { ConfigError, loadConfig, type Config } from "../src/core/config.ts";
import { appendLabel } from "../src/core/labels.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "ns-agent-score-"));
	dirs.push(dir);
	return dir;
}

function cfgOf(yaml = ""): Config {
	const home = sandbox();
	if (yaml !== "") {
		mkdirSync(join(home, ".config/neurastream"), { recursive: true });
		writeFileSync(join(home, ".config/neurastream/config.yml"), yaml);
	}
	return loadConfig({ home, env: {} });
}

function accept(cfg: Config, agent: string, weight = 4): void {
	mkdirSync(cfg.paths.score_state, { recursive: true });
	writeFileSync(join(cfg.paths.score_state, "events.jsonl"), `${JSON.stringify({
		type: "accept", agent, plan: "plan.md", phase: "P2", weight, ts: nowSec(), model: "worker-model", rework: false,
	})}\n`);
}

function goodThen(cfg: Config, party: "plan" | "implementer" | "both" | "test" | "none", extra: { party: "plan" | "implementer" | "both" | "test" | "none" }[] = []): void {
	const episode = "WorkerA:plan.md:P2";
	appendLabel(cfg.paths.score_state, { ts: 1, episode, label: "good", reason: "accepted", party: "none", evidence: "accept" });
	appendLabel(cfg.paths.score_state, { ts: 2, episode, label: "bad", reason: "flipped", party, evidence: "blame", found_by: "fixsha" });
	extra.forEach((line, i) => {
		appendLabel(cfg.paths.score_state, { ts: 3 + i, episode, label: "bad", reason: "later", party: line.party, evidence: "later", found_by: "fixsha" });
	});
}

function board(cfg: Config, source: RunSource = { listRuns: () => [], mainSession: () => null }): string {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		expect(agentScore(["board", "--days", "7"], cfg, source)).toBe(0);
		return out;
	} finally {
		spy.mockRestore();
	}
}

function netOf(text: string, model: string): number | null {
	const line = text.split("\n").find(l => l.includes(`| ${model} |`));
	if (!line) return null;
	return Number(line.split("|").map(s => s.trim())[7]);
}

test("an empty ledger leaves accept points unchanged", () => {
	const cfg = cfgOf();
	accept(cfg, "WorkerA");
	const text = board(cfg);
	expect(netOf(text, "worker-model")).toBe(4);
	expect(netOf(text, "MAIN")).toBeNull();
});

test("a good label that never flipped does not lose accept points", () => {
	const cfg = cfgOf();
	accept(cfg, "WorkerA");
	appendLabel(cfg.paths.score_state, { ts: 1, episode: "WorkerA:plan.md:P2", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	expect(netOf(board(cfg), "worker-model")).toBe(4);
});

test("a bad label with no earlier good is not a flip", () => {
	const cfg = cfgOf();
	accept(cfg, "WorkerA");
	appendLabel(cfg.paths.score_state, { ts: 1, episode: "WorkerA:plan.md:P2", label: "bad", reason: "rework", party: "implementer", evidence: "rework" });
	expect(netOf(board(cfg), "worker-model")).toBe(4);
});

test("flip_weight 1 loses all accept points and 0.5 halves the loss", () => {
	const full = cfgOf();
	accept(full, "WorkerA");
	goodThen(full, "implementer");
	expect(netOf(board(full), "worker-model")).toBe(0);
	expect(netOf(board(full), "MAIN")).toBeNull();

	const half = cfgOf("labels:\n  flip_weight: 0.5\n");
	accept(half, "WorkerA");
	goodThen(half, "implementer");
	expect(netOf(board(half), "worker-model")).toBe(2);
});

test("a plan-party flip counts against MAIN and the episode still loses its points", () => {
	const cfg = cfgOf();
	accept(cfg, "WorkerA");
	goodThen(cfg, "plan", [{ party: "test" }]);
	const text = board(cfg);
	expect(netOf(text, "worker-model")).toBe(0);
	expect(netOf(text, "MAIN")).toBe(-4);
});

test("both counts against MAIN; an assign to implementer does not", () => {
	const both = cfgOf();
	accept(both, "WorkerA");
	goodThen(both, "both");
	expect(netOf(board(both), "MAIN")).toBe(-4);

	const assigned = cfgOf();
	accept(assigned, "WorkerA");
	goodThen(assigned, "plan", [{ party: "test" }, { party: "implementer" }]);
	const text = board(assigned);
	expect(netOf(text, "worker-model")).toBe(0);
	expect(netOf(text, "MAIN")).toBeNull();
});

test("labels.flip_weight must be >= 0 and <= 1 and defaults to 1", () => {
	expect(cfgOf().labels.flip_weight).toBe(1);
	expect(() => cfgOf("labels:\n  flip_weight: 1.5\n")).toThrow(/labels\.flip_weight must be >= 0 and <= 1/);
	expect(() => cfgOf("labels:\n  flip_weight: -0.1\n")).toThrow(ConfigError);
});

function sub(id: string, model: string): Run {
	const ts = nowSec();
	return {
		id, kind: "sub", model, calls: 1, tokens: 1, cacheRead: 0, cost: 1, inputTokens: 1, prefillTokens: 1,
		status: "done", statusDetail: "done", startedAt: ts - 100, lastWriteAt: ts - 50, endedAt: ts - 50, messages: [],
		scoreModel: model, scoreCost: 1, scoreHours: 1, scoreRunning: false, scoreSurvived: true, scoreEnd: "done",
	};
}

test("gate sees the lost points: a flipped worker ranks below an unflipped one", () => {
	const cfg = cfgOf();
	mkdirSync(cfg.paths.score_state, { recursive: true });
	const ts = nowSec();
	writeFileSync(join(cfg.paths.score_state, "events.jsonl"), [
		{ type: "accept", agent: "WorkerA", plan: "plan.md", phase: "P2", weight: 4, ts, rework: false },
		{ type: "accept", agent: "WorkerB", plan: "plan.md", phase: "P2", weight: 4, ts, rework: false },
	].map(e => JSON.stringify(e)).join("\n") + "\n");
	appendLabel(cfg.paths.score_state, { ts: 1, episode: "WorkerA:plan.md:P2", label: "good", reason: "accepted", party: "none", evidence: "accept" });
	appendLabel(cfg.paths.score_state, { ts: 2, episode: "WorkerA:plan.md:P2", label: "bad", reason: "flipped", party: "implementer", evidence: "blame", found_by: "fixsha" });
	const source: RunSource = { listRuns: () => [sub("WorkerA", "model-a"), sub("WorkerB", "model-b")], mainSession: () => null };
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		expect(agentScore(["gate", "WorkerA"], cfg, source)).toBe(0);
	} finally {
		spy.mockRestore();
	}
	expect(out).toContain("WARN gate:");
	expect(out).toContain("model-b");
});
