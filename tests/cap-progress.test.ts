import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTool } from "../src/core/guards.ts";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { activePlans, planAt, refreshQueuePaths, touchedPaths, writeTargets } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const originalQueueEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QUEUE_")));
afterAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("QUEUE_")) delete process.env[key];
  Object.assign(process.env, originalQueueEnv);
  refreshQueuePaths();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("at call cap, own indexed plan edits and selected reads are allowed, other plans/files refused", () => {
  const root = mkdtempSync(join(tmpdir(), "neurastream-cap-progress-")); roots.push(root);
  const state = join(root, "state"), agent = join(root, "agent"), repo = join(root, "repo");
  const plans = join(repo, "docs/plans");
  mkdirSync(plans, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(state, { recursive: true });
  mkdirSync(join(agent, "blockers"), { recursive: true });
  writeFileSync(join(agent, "blockers/no-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/code.ts"), "export const x = 1;\n");
  writeFileSync(join(state, "main-reads.json"), JSON.stringify({ [join(repo, "src/code.ts")]: new Date().toISOString() }));
  const plan = join(plans, "20261024_2155_owner_notify_discord_slack.md");
  const otherPlan = join(plans, "other.md");
  const text = (name: string) => `# ${name}\n\nWorktree: ${repo}\nBranch: fix/test\n\n## Goal\n- Test.\n\n## Forbidden\n- None.\n\n## Blockers\n- no-push\n\n## Phases\n- [ ] P1 test — verify: \`true\`\n\n## Done check\n\`true\`\n\n## Code read by Main\n- \`${join(repo, "src/code.ts")}\`\n\n## Progress\nStatus: open\n- Started.\n`;
  writeFileSync(plan, text("Own")); writeFileSync(otherPlan, text("Other"));
  writeFileSync(join(agent, "INDEX.md"), `${plan}\n`);
  const configFile = join(root, ".config/neurastream/config.yml");
  mkdirSync(join(root, ".config/neurastream"), { recursive: true });
  writeFileSync(configFile, `paths:\n  home: "${root}"\n  agent_dir: "${agent}"\n  queue_index: "${join(agent, "INDEX.md")}"\n  blockers: "${join(agent, "blockers")}"\n  queue_state: "${state}"\n  subagents: "${join(agent, "subagents.md")}"\n  cancelled: "${join(agent, "CANCELLED.md")}"\n  unlock: "${join(agent, ".guard-unlock")}"\n  guard_log: "${join(root, "guard.log")}"\n  plan_guard_log: "${join(root, "plan-guard.log")}"\n`);
  writeFileSync(join(agent, "CANCELLED.md"), "");
  writeFileSync(join(agent, "subagents.md"), "## Allowed\n- `task`\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QUEUE_")));
  Object.assign(env, { HOME: root });
  const cfg = loadConfig({ home: root, env });
  applyQueueEnv(cfg);
  const event = (tool: string, input: Record<string, unknown>, calls = 100) => ({ tool, input, cwd: repo, agent: "sub" as const, agentId: "worker", calls, paths: [], writes: [], command: String(input?.command ?? "") });
  const editHashline = { path: plan, input: `[${plan}#AB12]\nPUT >40:\n+- recorded progress\n` };
  const editStructuredNotify = {
    i: "Writing final progress bullet to plan",
    path: plan,
    old_string: "- Started.",
    new_string: "- 2026-10-24 owner-notify: P1-P4 done.",
  };
  const editStructuredUnlock = {
    i: "Correcting progress bullet with final verified state",
    path: plan,
    old_string: "- Started.",
    new_string: "- 2026-10-25 NsChatUnlockGlm RESUME POINT",
  };
  const writePlan = { path: plan, content: text("Own updated") };

  const ownReadNoSelector = { path: plan };
  const ownReadSelector = { path: `${plan}:44+10` };
  const ownReadRawSelector = { path: `${plan}:raw:44+10` };

  expect(activePlans().map(p => p.file)).toContain(plan);
  expect(touchedPaths("edit", editHashline, repo)).toContain(plan);
  expect(writeTargets("edit", editHashline, repo)).toContain(plan);
  expect(writeTargets("edit", editStructuredNotify, repo)).toContain(plan);
  expect(planAt(plan, activePlans())).not.toBeNull();

  // Allowed at cap: own plan edits (hashline, structured, write)
  expect(checkTool(event("edit", editHashline), cfg)).toEqual({ allow: true, reason: "" });
  expect(checkTool(event("edit", editStructuredNotify, 100), cfg)).toEqual({ allow: true, reason: "" });
  expect(checkTool(event("edit", editStructuredNotify, 101), cfg)).toEqual({ allow: true, reason: "" });
  expect(checkTool(event("edit", editStructuredUnlock, 102), cfg)).toEqual({ allow: true, reason: "" });
  expect(checkTool(event("write", writePlan, 100), cfg)).toEqual({ allow: true, reason: "" });

  // Allowed at cap: own plan reads (no selector, :44+10, :raw:44+10)
  expect(checkTool(event("read", ownReadNoSelector), cfg).allow).toBe(true);
  expect(checkTool(event("read", ownReadSelector), cfg).allow).toBe(true);
  expect(checkTool(event("read", ownReadRawSelector, 110), cfg).allow).toBe(true);

  // Still refused at cap: other plan
  expect(checkTool(event("read", { path: otherPlan }), cfg).allow).toBe(false);
  expect(checkTool(event("read", { path: `${otherPlan}:44+10` }), cfg).allow).toBe(false);
  expect(checkTool(event("read", { path: `${otherPlan}:raw:44+10` }), cfg).allow).toBe(false);
  expect(checkTool(event("edit", { input: `[${otherPlan}#AB12]\nPUT >40:\n+- changed\n` }), cfg).allow).toBe(false);
  expect(checkTool(event("edit", { path: otherPlan, old_string: "a", new_string: "b" }), cfg).allow).toBe(false);
  expect(checkTool(event("write", { path: otherPlan, content: "hacked" }), cfg).allow).toBe(false);

  // Still refused at cap: other files
  const codeFile = join(repo, "src/code.ts");
  expect(checkTool(event("read", { path: codeFile }), cfg).allow).toBe(false);
  expect(checkTool(event("read", { path: `${codeFile}:44+10` }), cfg).allow).toBe(false);
  expect(checkTool(event("read", { path: `${codeFile}:raw:44+10` }), cfg).allow).toBe(false);
  expect(checkTool(event("edit", { input: `[${codeFile}#AB12]\nPUT >40:\n+- changed\n` }), cfg).allow).toBe(false);
  expect(checkTool(event("edit", { path: codeFile, old_string: "a", new_string: "b" }), cfg).allow).toBe(false);
  expect(checkTool(event("write", { path: codeFile, content: "alert()" }), cfg).allow).toBe(false);
});
