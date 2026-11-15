// Guard rule ids red tests (plan 20261110_1746_rule_tuning, P8a): every refusal ends with its rule
// id, its BLOCK log line names the id, parseBlocks reads it back, and the block-then-bypass finding
// keeps it. The six owner-pinned ids are the block-only set in rule-levels.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolEvent, TraceEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkTool } from "../src/core/guards.ts";
import { blockThenBypass } from "../src/core/incident-detectors.ts";
import { parseBlocks } from "../src/core/metrics.ts";
import { PINNED } from "../src/core/rule-levels.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const REPO = dirname(dirname(import.meta.path));
// Scratch sits beside the worktree, never under the system temp dir.
const ROOT = join(dirname(REPO), "rule-ids-scratch");
const HOME = join(ROOT, "home");
let cfg: Config;

beforeAll(() => {
	mkdirSync(HOME, { recursive: true });
	cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

function protectedWrite(): ToolEvent {
	const path = cfg.paths.unlock;
	return {
		tool: "write",
		input: { path, content: "" },
		cwd: HOME,
		agent: "main",
		agentId: "MAIN",
		calls: 0,
		paths: [],
		writes: [path],
		command: "",
		runningJobs: 0,
	};
}

test("the six owner-pinned guard ids are in the block-only set", () => {
	expect([...PINNED]).toEqual(
		expect.arrayContaining([
			"main.push-merge",
			"tool.review-lock",
			"tool.ui-start",
			"tool.claim-force",
			"tool.notify-secret",
			"tool.protected",
		]),
	);
});

test("a protected-file refusal ends with its rule id, and its BLOCK line names the id", () => {
	const d = checkTool(protectedWrite(), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason.endsWith(" [rule tool.protected]")).toBe(true);
	const lines = readFileSync(cfg.paths.plan_guard_log, "utf8").trim().split("\n");
	expect(lines.at(-1)!.endsWith(" rule=tool.protected")).toBe(true);
});

test("parseBlocks reads the rule id back; a line without one has no rule", () => {
	const text =
		"2026-11-10T10:00:00Z BLOCK main tool=write protected: x rule=tool.protected\n" +
		"2026-11-10T10:01:00Z BLOCK main tool=bash shell write to plan y\n";
	const [withId, withoutId] = parseBlocks(text);
	expect(withId!.rule).toBe("tool.protected");
	expect(withoutId!.rule).toBeUndefined();
});

test("the block-then-bypass finding keeps the refused rule id", () => {
	const events: TraceEvent[] = [
		{ kind: "toolCall", ts: 1000, runId: "MAIN", tool: "bash", args: { command: "cp secret.env out" }, callId: "c1" },
		{
			kind: "toolResult",
			ts: 1001,
			runId: "MAIN",
			tool: "bash",
			callId: "c1",
			isError: true,
			text: "plan-guard: x is a protected guard file. [rule tool.protected]",
		},
		{ kind: "toolCall", ts: 1060, runId: "MAIN", tool: "bash", args: { command: "cp secret.env out" }, callId: "c2" },
		{ kind: "toolResult", ts: 1061, runId: "MAIN", tool: "bash", callId: "c2", isError: false, text: "ok" },
	];
	const found = blockThenBypass(events, 600, 0.6);
	expect(found).toHaveLength(1);
	expect(found[0]!.rule).toBe("tool.protected");
});
