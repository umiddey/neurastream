// A "False positive:" line must name the whole ban, including hyphens. The old lazy capture stopped
// at the first hyphen, so "ban-blocks-guard-noted-recorded-be9d" was read as "ban" and never cleared.
// Whitespace is required before the separator; a different name does not clear this ban.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { cancelledMatches, queueProblems, refreshQueuePaths, type Plan } from "../src/core/queue/lib.ts";

const BAN = "ban-blocks-guard-noted-recorded-be9d";
const OTHER = "ban-other-name-not-this-one";
const WHY = "why it differs from that ban";
const TMP = mkdtempSync(join(tmpdir(), "ns-qcheck-fp-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, "agent");
const REPO = join(TMP, "repo");
const PLAN = join(REPO, "docs/plans/20261001_1200_fp.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

function boot(): void {
	mkdirSync(join(REPO, "docs/plans"), { recursive: true });
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	mkdirSync(AGENT, { recursive: true });
	spawnSync("git", ["-C", REPO, "init", "-q"]);
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(
		join(REPO, "docs/plans/CANCELLED.md"),
		[
			`- ${BAN} | 2026-10-27 | owner: owner | words: blocks guard noted recorded`,
			`- ${OTHER} | 2026-10-27 | owner: owner | words: blocks guard noted recorded`,
			"",
		].join("\n"),
	);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${REPO}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${join(HOME, "state")}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	applyQueueEnv(loadConfig({ home: HOME, env: {} }));
}

function plan(line: string): Plan {
	return {
		repo: REPO,
		file: PLAN,
		text: ["# Blocks guard noted recorded", "", "## Goal", "- blocks guard noted recorded stay visible", "", "## Progress", "Status: open", line, ""].join("\n"),
		status: "open",
	} as Plan;
}

function names(line: string): string[] {
	return cancelledMatches(plan(line)).map(c => c.name);
}

test("the hyphenated false-positive line clears that ban and not a different one", () => {
	boot();
	expect(names(`False positive: ${BAN} — ${WHY}`)).toEqual([OTHER]);
	expect(names(`False positive: ${OTHER} — ${WHY}`)).toEqual([BAN]);
	expect(names(`False positive: ${BAN}—${WHY}`)).toEqual([BAN, OTHER]);
	expect(names(`- False positive: \`${BAN}\` — ${WHY}`)).toEqual([OTHER]);

	writeFileSync(PLAN, plan(`False positive: ${BAN} — ${WHY}`).text);
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
	const problems = queueProblems().map(p => p.problem);
	expect(problems.some(p => p.includes(BAN))).toBe(false);
	expect(problems.some(p => p.includes(OTHER))).toBe(true);
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
