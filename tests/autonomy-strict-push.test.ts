// Regression (I-20261025-177 P2, I-20261025-201): in tier strict, Main's `git push` is refused
// until the owner's approve phrase (autonomy.go_phrase, default "go push"). Deliberately
// independent of src/core/autonomy.ts — the tier file is written directly — so this exact file
// also runs against the old code (origin/main 67452db), where no reader exists and the push goes
// through: the recorded fail-before.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkTool } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths, stateDirPath } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let agentDir: string;
let repo: string;
let cfg: Config;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-strict-push-"));
	roots.push(root);
	agentDir = join(root, "agent");
	repo = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "state"), { recursive: true });
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(root, ".config/neurastream/config.yml"),
		`paths:
  home: "${root}"
  agent_dir: "${agentDir}"
  queue_index: "${agentDir}/INDEX.md"
  blockers: "${agentDir}/blockers"
  queue_state: "${root}/state"
  subagents: "${agentDir}/subagents.md"
  cancelled: "${agentDir}/CANCELLED.md"
  unlock: "${agentDir}/.guard-unlock"
  guard_log: "${root}/guard.log"
  plan_guard_log: "${root}/plan-guard.log"
  work_roots: ["${repo}"]
guards:
  chat_unlock: true
`,
	);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	env.HOME = root;
	cfg = loadConfig({ home: root, env });
	applyQueueEnv(cfg);
	writeFileSync(join(stateDirPath(), "autonomy-tier"), "strict\n");
});

function mainEvent(tool: string, input: Record<string, unknown>): ToolEvent {
	return { tool, input, cwd: repo, agent: "main", agentId: "main", calls: 0, paths: [], writes: [], command: String(input?.command ?? "") };
}

test("tier strict refuses Main's git push without the approve phrase", () => {
	const d = checkTool(mainEvent("bash", { command: "git push origin feat/toy" }), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toBe('main-guard: tier strict — type "go push" to approve one push/merge');
});
