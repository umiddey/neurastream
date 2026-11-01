// queue-cancel (plan 20261027_0915 P5e-a): after flipping a plan to Status: cancelled it hands
// the close to the CLI entry (`bun <cli> queue-close <plan>`). The path must resolve to the
// repo's real CLI (src/cli/main.ts): this regression runs the whole flow in a sandbox and
// expects the close to actually happen — plan archived, CANCELLED list written — which fails
// while the path names a file that does not exist.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { queueCancel } from "../src/core/queue-cancel.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-qcancel-closebin-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, "agent");
const TOY = join(HOME, "projects/toy");
const QUEUE_STATE = join(HOME, "state");
const INDEX = join(AGENT, "INDEX.md");
const PLAN = join(TOY, "docs/plans/20261020_1400_cancel.md");

const homeBefore = process.env.HOME;
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

function plan(): string {
	return [
		"# Cancel plan",
		"Summary: short summary of the work",
		"",
		"## Goal",
		"- first goal line",
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		"- [ ] P1 pending — verify: `true`",
		"",
		"## Done check",
		"`true`",
		"",
		"## Progress",
		"Status: open",
		"- first note.",
		"",
	].join("\n");
}

function seed(): Config {
	for (const d of [join(AGENT, "blockers"), join(TOY, "docs/plans"), join(HOME, ".config/neurastream"), QUEUE_STATE]) {
		mkdirSync(d, { recursive: true });
	}
	const blocker = join(AGENT, "blockers/no-push");
	writeFileSync(blocker, "#!/bin/sh\nexit 0\n");
	chmodSync(blocker, 0o755);
	writeFileSync(INDEX, `${PLAN}\n`);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${INDEX}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${QUEUE_STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	return loadConfig({ home: HOME, env: {} });
}

test("a cancelled plan is closed through the real CLI: archived and listed as cancelled", () => {
	const cfg = seed();
	writeFileSync(PLAN, plan());
	spawnSync("git", ["-C", TOY, "init", "-q"]);
	// The spawned CLI child loads its config from $HOME, so the sandbox must be the test's HOME
	// for the duration; applyQueueEnv already put the sandbox queue paths into the environment.
	process.env.HOME = HOME;
	const rc = queueCancel([PLAN, "stop this work now please"], cfg);
	process.env.HOME = homeBefore;
	expect(rc).toBe(0);
	const month = new Date().toISOString().slice(0, 7).replace("-", "");
	expect(existsSync(join(TOY, "docs/plans/archive", month, "20261020_1400_cancel.md"))).toBe(true);
	expect(readFileSync(join(TOY, "docs/plans/CANCELLED.md"), "utf8")).toContain("20261020_1400_cancel.md");
});

afterAll(() => {
	process.env.HOME = homeBefore;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
