import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTool, readWindow, revertMainEdit, writeWindow } from "../src/core/guards.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { changesFiles, refreshQueuePaths } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const originalQueueEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QUEUE_")));
afterAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("QUEUE_")) delete process.env[key];
  Object.assign(process.env, originalQueueEnv);
  refreshQueuePaths();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let state: string;
let agent: string;
let repo: string;
let cfg: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "neurastream-edit-window-"));
  roots.push(root);
  state = join(root, "state");
  agent = join(root, "agent");
  repo = join(root, "repo");
  mkdirSync(agent, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/code.ts"), "export const a = 1;\n");
  writeFileSync(join(agent, "INDEX.md"), "");
  const configFile = join(root, ".config/neurastream/config.yml");
  mkdirSync(join(root, ".config/neurastream"), { recursive: true });
  writeFileSync(
    configFile,
    `paths:
  home: "${root}"
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(root, "guard.log")}"
  plan_guard_log: "${join(root, "plan-guard.log")}"
  work_roots: ["${repo}"]
guards:
  main_edit_limit: 5
  main_window_min: 15
`,
  );
  writeFileSync(join(agent, "CANCELLED.md"), "");
  writeFileSync(join(agent, "subagents.md"), "## Allowed\n- `task`\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QUEUE_")));
  Object.assign(env, { HOME: root });
  cfg = loadConfig({ home: root, env });
  applyQueueEnv(cfg);
  writeWindow({ used: [], windowStart: 0 });
});

const mainEvent = (tool: string, input: Record<string, unknown>) => ({
  tool,
  input,
  cwd: repo,
  agent: "main" as const,
  agentId: "main",
  calls: 0,
  paths: [],
  writes: [],
  command: String(input?.command ?? ""),
});

test("(a) a guard-denied call does not count", () => {
  // A shell write to a plan file is refused for Main by checkTool (must use edit or write tool)
  const plans = join(repo, "docs/plans");
  mkdirSync(plans, { recursive: true });
  const plan = join(plans, "20261024_0100_test.md");
  const d = checkTool(mainEvent("bash", { command: `echo 'update' > ${plan}` }), cfg);
  expect(d.allow).toBe(false);
  expect(readWindow().used.length).toBe(0);
});

test("(b) a failed edit (tool result is an error) does not count", () => {
  const target = join(repo, "src/code.ts");
  const editInput = { path: target, input: `[${target}#1234]\nPUT 1:=1:\n+broken\n` };
  const d = checkTool(mainEvent("edit", editInput), cfg);
  expect(d.allow).toBe(true);
  expect(readWindow().used.length).toBe(1);
  // Tool failed (isError: true), so adapter reverts the edit
  revertMainEdit("edit", editInput, repo, cfg);
  expect(readWindow().used.length).toBe(0);
});

test("(c) echo '{\"input\":\"PUT >50:\"}' | bun x counts nothing", () => {
  const cmd = `echo '{"input":"PUT >50:"}' | bun x`;
  expect(changesFiles("bash", { command: cmd })).toBe(false);
  const d = checkTool(mainEvent("bash", { command: cmd }), cfg);
  expect(d.allow).toBe(true);
  expect(readWindow().used.length).toBe(0);
});

test("(d) a real echo x > file and a successful edit still count once each", () => {
  const f1 = join(repo, "src/out1.ts");
  const echoCmd = `echo "export const x = 1;" > ${f1}`;
  expect(changesFiles("bash", { command: echoCmd })).toBe(true);
  const d1 = checkTool(mainEvent("bash", { command: echoCmd }), cfg);
  expect(d1.allow).toBe(true);
  expect(readWindow().used.length).toBe(1);

  const f2 = join(repo, "src/code.ts");
  const editInput = { path: f2, input: `[${f2}#1234]\nPUT 1:=1:\n+export const a = 2;\n` };
  const d2 = checkTool(mainEvent("edit", editInput), cfg);
  expect(d2.allow).toBe(true);
  expect(readWindow().used.length).toBe(2);
});
