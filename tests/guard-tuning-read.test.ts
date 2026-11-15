// Guard tuning read red tests (plan 20261110_1746_rule_tuning, P8b): with tuning.guards off a
// refusal is unchanged; with it on, a refusal whose rule id is at tell is allowed with its reason,
// at off is allowed silently, and pinned, unset, or corrupt stays blocked.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkTool } from "../src/core/guards.ts";
import { writeLevels, type RuleLevels } from "../src/core/rule-levels.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const REPO = dirname(dirname(import.meta.path));
// Scratch sits beside the worktree, never under the system temp dir.
const ROOT = join(dirname(REPO), "guard-tuning-read-scratch");
const HOME = join(ROOT, "home");
let cfg: Config;
let on: Config;

beforeAll(() => {
	mkdirSync(HOME, { recursive: true });
	cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	on = { ...cfg, tuning: { ...cfg.tuning, guards: true } };
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

// A main write to a plan by a relative path: refused under tool.relative-plan, a non-pinned id.
function relativePlanWrite(): ToolEvent {
	return {
		tool: "write",
		input: { path: "docs/plans/20261110_1746_scratch.md", content: "" },
		cwd: HOME,
		agent: "main",
		agentId: "MAIN",
		calls: 0,
		paths: [],
		writes: [],
		command: "",
		runningJobs: 0,
	};
}

// A protected guard file write: refused under tool.protected, which is pinned.
function protectedWrite(): ToolEvent {
	const path = cfg.paths.unlock;
	return { ...relativePlanWrite(), input: { path, content: "" }, cwd: HOME, paths: [path], writes: [path] };
}

function levelsWith(rules: RuleLevels["rules"]): void {
	writeLevels(cfg, { rules });
}

const RELATIVE = "tool.relative-plan";
const entry = (level: "block" | "tell" | "off") => ({ level, date: "2026-11-10" });

test("tuning.guards is off by default, and a refusal is unchanged even when its id is at tell", () => {
	expect(cfg.tuning.guards).toBe(false);
	levelsWith({ [RELATIVE]: entry("tell") });
	const d = checkTool(relativePlanWrite(), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason.endsWith(` [rule ${RELATIVE}]`)).toBe(true);
});

test("tuning.guards on, id at tell: allowed, and the refusal reason is kept", () => {
	levelsWith({ [RELATIVE]: entry("tell") });
	const d = checkTool(relativePlanWrite(), on);
	expect(d.allow).toBe(true);
	expect(d.reason).toContain("use the absolute plan path");
});

test("tuning.guards on, id at off: allowed with an empty reason", () => {
	levelsWith({ [RELATIVE]: entry("off") });
	const d = checkTool(relativePlanWrite(), on);
	expect(d.allow).toBe(true);
	expect(d.reason).toBe("");
});

test("tuning.guards on, id unset: still blocked", () => {
	levelsWith({});
	const d = checkTool(relativePlanWrite(), on);
	expect(d.allow).toBe(false);
});

test("tuning.guards on, pinned id at tell: still blocked", () => {
	levelsWith({ "tool.protected": entry("tell") });
	const d = checkTool(protectedWrite(), on);
	expect(d.allow).toBe(false);
});

test("tuning.guards on, corrupt levels file: every id blocks", () => {
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	writeFileSync(join(cfg.paths.queue_state, "rule-levels.json"), "{ not json");
	const d = checkTool(relativePlanWrite(), on);
	expect(d.allow).toBe(false);
});
