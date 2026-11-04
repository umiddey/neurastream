// The stop guard's live-subagents allow names the agents it counted, and a row that only looks
// alive (DIED:) no longer releases the stop: a reboot-killed subagent must not let Main stop
// (INCIDENT I-20261103-81). Sandbox modeled on tests/incident-guards.test.ts.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { checkStop } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-stop-live-agents-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const GUARD_LOG = join(HOME, "main-guard.log");
const TOY_PLAN = join(TOY, "docs/plans/20261020_toy.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = "1760000000";

function planText(): string {
	return `# Toy fix

Worktree: -
Branch: feat/toy

## Goal
- Keep the queue honest.

## Forbidden
- Never skip tests.

## Blockers
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.
`;
}

function readBlocker(): string {
	// The blocker script's relative import must survive the copy (tests-only rewrite, as in
	// tests/incident-guards.test.ts).
	const repo = dirname(dirname(import.meta.path));
	return readFileSync(join(repo, "blockers/no-push"), "utf8").replace("../src/core/blockers.ts", join(repo, "src/core/blockers.ts"));
}

const cfg: Config = (() => {
	for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(TOY, "docs/plans"), join(TOY, "src"), join(HOME, ".config/neurastream"), STATE, join(HOME, ".local/bin")])
		mkdirSync(d, { recursive: true });
	writeFileSync(TOY_PLAN, planText());
	writeFileSync(join(AGENT, "INDEX.md"), `${TOY_PLAN}\n`);
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	const noPush = join(AGENT, "blockers/no-push");
	writeFileSync(noPush, readBlocker());
	chmodSync(noPush, 0o755);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${GUARD_LOG}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
review:
  agents: []
  plan: false
`,
	);
	return loadConfig({ home: HOME, env: {} });
})();

applyQueueEnv(cfg);

// queue-check stub with no output, so openQueue holds only the toy plan.
const queueCheck = join(HOME, ".local/bin/queue-check");
writeFileSync(queueCheck, "#!/bin/sh\nexit 0\n");
chmodSync(queueCheck, 0o755);

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

function logTail(): string {
	return readFileSync(GUARD_LOG, "utf8").trimEnd().split("\n").pop() ?? "";
}

test("the live-subagents allow names the agent that released the stop", () => {
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "AgentX zai/glm-5 12 0.1 0% $0.1 11-03 23:00 RUNNING (idle 1m)" }, cfg);
	expect(d.allow).toBe(true);
	expect(logTail().endsWith("ALLOW stop: live subagents: AgentX")).toBe(true);
});

test("a DIED row alone no longer releases the stop: the open plan holds it", () => {
	const d = checkStop({ agent: "main", callsSinceStop: 0, idleStops: 0, ledgerText: "AgentDied zai/glm-5 12 0.1 0% $0.1 11-03 20:00 DIED: killed before the last boot" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(TOY_PLAN);
	expect(logTail()).toContain("BLOCK stop; open:");
	expect(logTail()).toContain(TOY_PLAN);
});
