// P3 (plan 20261025_1700): the owner's pick order is ENFORCED, not prose. config ledger.prefer
// names agents in order (empty = off); the spawn gates refuse a later agent while an earlier one
// is free and under its provider cap, unless the brief carries "Pick note: <why>"; a brief that
// claims a provider shown free is rate-limited is refused (who is limited comes from live data);
// agent-score gate ranks inside prefer and never recommends a later paid agent while an earlier
// one is free. Owner 2026-10-27: "you are using paid haiku over free glm … this is the 5th time".

import { afterAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { agentScore } from "../src/core/agent-score.ts";
import { nowSec } from "../src/core/clock.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkSpawn, preferProblem, providerClaimProblem, spawnProblem } from "../src/core/guards.ts";
import { recordOut } from "../src/core/provider-state.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "pstate-enforce-"));
// Inherited QUEUE_* (the caller's live session) beats the sandbox config; save, delete, restore.
// No test here may touch the live state dir (INCIDENT I-20261027-129).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

const PINS: [string, string][] = [
	["glm", "zai/glm-5.3-flash"],
	["deepseek", "deepseek/deepseek-chat"],
	["haiku", "anthropic/claude-haiku-5-5"],
];

function sandbox(prefer: boolean): Config {
	const home = join(TMP, `home-${prefer ? "prefer" : "plain"}`);
	const agentDir = join(home, ".omp/agent");
	const state = join(home, ".local/state/queue");
	for (const d of [join(home, ".config/neurastream"), join(agentDir, "agents"), agentDir, state]) mkdirSync(d, { recursive: true });
	writeFileSync(join(agentDir, "notes/subagents.md"), "## Allowed\n\n- `glm`\n- `deepseek`\n- `haiku`\n- `toy-worker`\n");
	writeFileSync(join(agentDir, "INDEX.md"), "");
	for (const [name, model] of PINS) writeFileSync(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\nmodel: ${model}\n---\n\nBody.\n`);
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  work_roots: ["${home}/projects"]
  agent_dir: "${agentDir}"
  queue_index: "${join(agentDir, "INDEX.md")}"
  blockers: "${join(agentDir, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agentDir, "notes/subagents.md")}"
  cancelled: "${join(agentDir, "CANCELLED.md")}"
  unlock: "${join(agentDir, ".guard-unlock")}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
adapter:
  name: omp
  pins: "${join(agentDir, "agents")}"
${prefer ? 'ledger:\n  prefer:\n    - glm\n    - deepseek\n    - haiku\n' : ""}`,
	);
	return loadConfig({ home, env: {} });
}

const cfg = sandbox(true);
const cfgPlain = sandbox(false);
applyQueueEnv(cfg);

// --- the spawn gates (pure rules, exported for both call sites) ---

test("preferProblem refuses a lower pick while ANY higher one is free; Pick note, cap and out allow", () => {
	// glm (prefer #1, provider zai) is free: haiku may not spawn without a Pick note.
	const why = preferProblem("haiku", "Work the queue.", [], cfg);
	expect(why).toContain("glm is ahead of haiku in ledger.prefer and free");
	expect(why).toContain('Pick note: <why>');
	expect(preferProblem("haiku", "Work the queue.\nPick note: glm is saturated with the terms batch.", [], cfg)).toBeNull();
	// glm at its provider cap (2 running) no longer blocks — but deepseek (free, prefer #2) does.
	expect(preferProblem("haiku", "Work the queue.", ["CpTermsGlm", "CpWatcherGlm"], cfg)).toContain("deepseek is ahead of haiku in ledger.prefer and free");
	// glm and deepseek both out: the later agent may go.
	recordOut(cfg, "zai", nowSec() + 3600, "rate-limit");
	expect(preferProblem("deepseek", "Work the queue.", [], cfg)).toBeNull(); // glm (its only higher) is out
	recordOut(cfg, "deepseek", nowSec() + 3600, "rate-limit");
	expect(preferProblem("haiku", "Work the queue.", [], cfg)).toBeNull();
	// Empty prefer = off; an agent prefer does not name is not ordered against anyone; the first pick is never refused by the order.
	expect(preferProblem("haiku", "Work the queue.", [], cfgPlain)).toBeNull();
	expect(preferProblem("toy-worker", "Work the queue.", [], cfg)).toBeNull();
	expect(preferProblem("glm", "Work the queue.", [], cfg)).toBeNull();
});

test("providerClaimProblem refuses a brief that claims a provider shown free is rate-limited; true and past-tense claims pass", () => {
	recordOut(cfg, "zai", nowSec() - 60, "quota-reset"); // newest record wins: zai free again
	const why = providerClaimProblem("zai is rate-limited until 18:56, so pace the calls.", cfg);
	expect(why).toContain("zai is free per the recorded provider state");
	// The same claim through the pin's agent name (the incident's wording) is refused too.
	expect(providerClaimProblem("glm is rate-limited, so use haiku for the batch.", cfg)).toContain("glm (provider zai) is free per the recorded provider state");
	// A statement about a PAST limit does not match: the claim must say "is …".
	expect(providerClaimProblem("last night's 429 on zai showed the Shanghai-zone reset.", cfg)).toBeNull();
	// openrouter has no record at all, so providerStatus does not list it and its claim passes here.
	expect(providerClaimProblem("openrouter is rate-limited until tomorrow.", cfg)).toBeNull();
});

test("the live task-tool path refuses a haiku batch while glm is free, and allows it with a Pick note", () => {
	const files: string[] = [];
	const budgets: Record<string, number | null> = {};
	const staffing: Record<string, string[]> = {};
	const denied = spawnProblem(
		{ tasks: [{ name: "w", agent: "haiku", task: "x", context: "" }], context: "" },
		cfg,
		files,
		budgets,
		staffing,
		[],
	);
	expect(denied).toContain("glm is ahead of haiku in ledger.prefer and free");
	const allowed = spawnProblem(
		{ tasks: [{ name: "w", agent: "haiku", task: "x", context: "Pick note: glm holds the only terms slot." }], context: "" },
		cfg,
		files,
		budgets,
		staffing,
		[],
	);
	expect(allowed).toBeNull();
});

test("checkSpawn denies the haiku spawn without a Pick note and allows it with one (the owner's 5th-time case)", () => {
	const d = checkSpawn({ agent: "haiku", invocationKind: "task", brief: "Work the queue.", runningJobs: [] }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("glm is ahead of haiku in ledger.prefer and free");
	const ok = checkSpawn({ agent: "haiku", invocationKind: "task", brief: "Work the queue.\nPick note: glm is out of slots.", runningJobs: [] }, cfg);
	expect(ok.allow).toBe(true);
	// Empty prefer = no change from the old gate.
	expect(checkSpawn({ agent: "haiku", invocationKind: "task", brief: "Work the queue.", runningJobs: [] }, cfgPlain).allow).toBe(true);
});

// --- agent-score gate ranks inside prefer ---

const NOW = nowSec();

function run(id: string, model: string, cost: number): Run {
	return {
		id,
		kind: "sub",
		model,
		calls: 3,
		tokens: 1000,
		cacheRead: 0,
		cost,
		inputTokens: 0,
		prefillTokens: 0,
		status: "running",
		statusDetail: "RUNNING",
		startedAt: NOW - 600,
		lastWriteAt: NOW - 60,
		endedAt: null,
		messages: [],
		scoreModel: model,
		scoreCost: cost,
		scoreHours: 0.2,
		scoreRunning: false,
		scoreSurvived: true,
		scoreEnd: "done",
	};
}

const source: RunSource = {
	listRuns: () => [run("glm", "zai/glm-5.3-flash", 1), run("haiku", "anthropic/claude-haiku-5-5", 0.5)],
	mainSession: () => null,
};

function accept(agent: string): void {
	mkdirSync(cfg.paths.score_state, { recursive: true });
	appendFileSync(join(cfg.paths.score_state, "events.jsonl"), `${JSON.stringify({ type: "accept", agent, weight: 2, ts: NOW })}\n`);
}

function gate(args: string[], config: Config): string {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		const code = agentScore(["gate", ...args], config, source);
		expect(code).toBe(0);
		return out;
	} finally {
		spy.mockRestore();
	}
}

test("gate: haiku has the higher score but glm is first in prefer and free, so the gate names glm (fail-before case)", () => {
	accept("glm");
	accept("haiku");
	const out = gate(["haiku"], cfg);
	expect(out).toContain("gate: glm is first in prefer and free → use it");
	expect(out).not.toContain("WARN gate");
});

test("gate names the highest free prefer agent, blesses haiku once glm and deepseek are out, keeps score verdicts when prefer is empty", () => {
	// glm out, deepseek free: the later paid agent is never recommended.
	recordOut(cfg, "zai", nowSec() + 3600, "rate-limit");
	expect(gate(["haiku"], cfg)).toContain("gate: deepseek is higher in prefer and free → use it");
	// deepseek out too: haiku is the first free prefer agent.
	recordOut(cfg, "deepseek", nowSec() + 3600, "rate-limit");
	expect(gate(["haiku"], cfg)).toContain("gate: anthropic/claude-haiku-5-5 is free and no higher prefer agent is free");
	// Empty prefer: the old score-only verdicts, byte for byte.
	expect(gate(["haiku"], cfgPlain)).toContain("gate: anthropic/claude-haiku-5-5 ranks #1");
	expect(gate(["glm"], cfgPlain)).toContain("WARN gate: zai/glm-5.3-flash ranks #2; better-ranked: anthropic/claude-haiku-5-5.");
});
