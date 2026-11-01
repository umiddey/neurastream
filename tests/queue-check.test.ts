// A "False positive:" line must name the whole ban, including hyphens. The old lazy capture stopped
// at the first hyphen, so "ban-blocks-guard-noted-recorded-be9d" was read as "ban" and never cleared.
// Whitespace is required before the separator; a different name does not clear this ban.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { cancelledMatches, DONE_CLAIM_SINCE, holdWarnings, queueProblems, readPlans, refreshQueuePaths, type Plan } from "../src/core/queue/lib.ts";

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
	mkdirSync(join(AGENT, "blockers"), { recursive: true });
	writeFileSync(join(AGENT, "blockers/no-push"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(AGENT, "blockers/no-push"), 0o755);
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

const DONE_PLAN = join(REPO, "docs/plans/20261101_0900_done_claims.md");
const VERIFY_P1 = "bun test tests/parse.test.ts";

function donePlanText(progress: string, hold = ""): string {
	return [
		"# Done claims", "",
		"## Goal", "- done claims carry their proof", "",
		"## Forbidden", "- never push, tag, publish or install", "",
		"## Blockers", "- no-push", "",
		"## Phases",
		`- [x] P1 Parse. split — difficulty: 1 — verify: \`${VERIFY_P1}\``,
		"- [ ] P2 Run. run — difficulty: 2 — verify: `bun test tests/run.test.ts`", "",
		"## Code read by Main", "- `src/core/queue/lib.ts`", "",
		"## Done check", "`echo done-check`", "",
		"## Progress", "Status: open",
		...(hold ? [hold] : []),
		progress, "",
	].join("\n");
}

function doneProblems(progress: string): string[] {
	writeFileSync(DONE_PLAN, donePlanText(progress));
	writeFileSync(join(AGENT, "INDEX.md"), `${DONE_PLAN}\n`);
	return queueProblems().filter(p => p.where === DONE_PLAN).map(p => p.problem);
}

function holdPlan(hold: string): Plan[] {
	writeFileSync(DONE_PLAN, donePlanText(`- ${DONE_CLAIM_SINCE} Main: started P2\n  Findings: none`, hold));
	return readPlans([DONE_PLAN]);
}

test("a dated done claim must quote its phase verify (or the done check) with its result", () => {
	boot();
	// backed: the entry quotes the phase's verify command and its result.
	expect(doneProblems(`- ${DONE_CLAIM_SINCE} Main: P1 done\n  verify: \`${VERIFY_P1}\` 5 pass, 0 fail, exit 0\n  Findings: none`)).toEqual([]);
	// backed via the Done check when the claimed phase has no phase line of its own.
	expect(doneProblems(`- ${DONE_CLAIM_SINCE} Main: P9 finished\n  done check: \`echo done-check\` exit 0\n  Findings: none`)).toEqual([]);
	// unbacked: says done about P1, quotes nothing.
	const probs = doneProblems(`- ${DONE_CLAIM_SINCE} Main: P1 done, nothing left\n  Findings: none`);
	expect(probs.length).toBe(1);
	expect(probs[0]).toContain("unbacked done claim");
	expect(probs[0]).toContain(DONE_PLAN);
	// quoted command without its result is still unbacked.
	expect(doneProblems(`- ${DONE_CLAIM_SINCE} Main: P1 done\n  verify: \`${VERIFY_P1}\`\n  Findings: none`).length).toBe(1);
});

test("done-claim problems ignore old and undated entries", () => {
	boot();
	expect(doneProblems(`- 2026-10-31 Main: P1 done, nothing left\n  Findings: none`)).toEqual([]);
	expect(doneProblems(`- Main: P1 done, nothing left\n  Findings: none`)).toEqual([]);
});

test("a new hold without still true if warns only and never fails queue-check", () => {
	boot();
	// dated hold, no check: one warning naming the plan.
	expect(holdWarnings(holdPlan(`WAITING on owner: ${DONE_CLAIM_SINCE} unlock gateforge — blocked: P2 stuck — why you: guard file`)).join("\n")).toContain('no "still true if"');
	// undated hold without a check: no warning (only holds dated DONE_CLAIM_SINCE or later warn).
	expect(holdWarnings(holdPlan(`WAITING on owner: unlock gateforge — blocked: P2 stuck — why you: guard file`))).toEqual([]);
	// a check present: no warning.
	expect(holdWarnings(holdPlan(`WAITING on owner: ${DONE_CLAIM_SINCE} unlock gateforge — still true if: \`echo hi\``))).toEqual([]);
	// the warning rides queue-check's output while the exit code stays clean.
	writeFileSync(DONE_PLAN, donePlanText(`- ${DONE_CLAIM_SINCE} Main: started P2\n  Findings: none`, `WAITING on owner: ${DONE_CLAIM_SINCE} unlock gateforge — blocked: P2 stuck — why you: guard file`));
	writeFileSync(join(AGENT, "INDEX.md"), `${DONE_PLAN}\n`);
	expect(queueProblems().filter(p => p.where === DONE_PLAN)).toEqual([]);
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
