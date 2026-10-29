// Plan review gate (plan 20261028_1600): P1 reuse lines in queue problems, P2 reviewer PASS lock.
// Everything runs in-process against temp dirs; no live state dir, no real forge.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, reloadingConfig } from "../src/core/config.ts";
import { checkPlanEdit, checkSpawn, checkTool, reviewHash, reviewSpawnEnd } from "../src/core/guards.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { parsePlan, queueProblems, queueSummary, reviewAgentsProblem, type Plan } from "../src/core/queue/lib.ts";
import { fixturePlan } from "./fixtures/plan.ts";

const TMP = mkdtempSync(join(tmpdir(), "plan-review-"));
const REPO = join(TMP, "repo");
const BLOCKERS = join(TMP, "blockers");
const SINCE = "2026-10-28";

mkdirSync(join(REPO, ".git"), { recursive: true }); // planRepo walks up to .git; without it planGate resolves citations under docs/plans
mkdirSync(join(REPO, "docs/plans"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
mkdirSync(BLOCKERS, { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(BLOCKERS, "ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BLOCKERS, "ok.sh"), 0o755);

const REUSE_OK = "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the existing helper\n\n";

function planFile(stamp: string, reuse?: string): string {
	const file = join(REPO, "docs/plans", `${stamp}_toy.md`);
	writeFileSync(file, fixturePlan({ reuse: reuse ?? REUSE_OK }));
	return file;
}

function parsed(file: string): Plan {
	return parsePlan(REPO, file, readFileSync(file, "utf8"), BLOCKERS, SINCE);
}

// --- P1: reuse lines ---

test("a plan with phases and no Reuse section is a queue problem", () => {
	const p = parsed(planFile("20261029_0100", ""));
	expect(p.errors.join("\n")).toMatch(/## Reuse/);
});

test("a reuse line without checked: <path>:<line> is a problem", () => {
	const p = parsed(planFile("20261029_0102", "## Reuse\n- new: gate — reuse: checked nowhere\n\n"));
	expect(p.errors.join("\n")).toMatch(/checked: <path>:<line>/);
});

test("a reuse line citing a nonexistent path is a problem", () => {
	const p = parsed(planFile("20261029_0103", "## Reuse\n- new: gate — checked: src/missing.ts:7 — reuse: would be nice\n\n"));
	expect(p.errors.join("\n")).toMatch(/does not exist/);
});

test("a valid reuse line (including new: none) is clean", () => {
	expect(parsed(planFile("20261029_0104")).errors).toEqual([]);
});

test("a plan stamped before review.since is exempt", () => {
	const p = parsed(planFile("20261020_0100", ""));
	expect(p.errors).toEqual([]);
});

test("Reuse is an allowed plan section", () => {
	const p = parsed(planFile("20261029_0105"));
	expect(p.errors.join("\n")).not.toMatch(/unknown section/);
});

test("queueProblems reports the missing Reuse section under the plan's file", () => {
	const file = planFile("20261029_0106", "");
	const index = join(TMP, "INDEX.md");
	writeFileSync(index, `${file}\n`);
	const probs = queueProblems(index, BLOCKERS, SINCE);
	expect(probs.map(q => `${q.where}: ${q.problem}`).join("\n")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*## Reuse"));
});

// --- P2: reviewer PASS lock (fail-before: the gate and the record do not exist yet) ---

const GHOME = join(TMP, "ghome");
const GAGENT = join(GHOME, ".omp/agent");
const GSTATE = join(GHOME, ".local/state/queue");
const LOCKED = join(REPO, "docs/plans/20261030_0100_locked.md");
const REVIEWS = join(GSTATE, "plan-reviews.json");

mkdirSync(join(GAGENT, "blockers"), { recursive: true });
mkdirSync(join(GAGENT, "notes"), { recursive: true });
mkdirSync(GSTATE, { recursive: true });
mkdirSync(join(GHOME, ".config/neurastream"), { recursive: true });
writeFileSync(join(GAGENT, "INDEX.md"), `${LOCKED}\n`);
writeFileSync(join(GAGENT, "notes/subagents.md"), "## Allowed\n\n- `worker`\n- `reviewer`\n");
writeFileSync(join(GAGENT, "CANCELLED.md"), "");
writeFileSync(LOCKED, fixturePlan());
writeFileSync(
	join(GHOME, ".config/neurastream/config.yml"),
	`paths:
  home: "${GHOME}"
  work_roots: ["${REPO}"]
  agent_dir: "${GAGENT}"
  queue_index: "${join(GAGENT, "INDEX.md")}"
  blockers: "${BLOCKERS}"
  queue_state: "${GSTATE}"
  subagents: "${join(GAGENT, "notes/subagents.md")}"
  cancelled: "${join(GAGENT, "CANCELLED.md")}"
  unlock: "${join(GAGENT, ".guard-unlock")}"
  guard_log: "${join(GHOME, "main-guard.log")}"
  plan_guard_log: "${join(GHOME, "plan-guard.log")}"
review:
  since: "2026-10-28"
  agents: ["reviewer"]
`,
);

const gcfg = loadConfig({ home: GHOME, env: {} });
applyQueueEnv(gcfg);

// No origin remote: the P3 pending-work check degrades off the toy repo, so these tests see only the PASS gate.
const gRunner: CommandRunner = args =>
	args[0] === "git" ? { code: 1, stdout: "", stderr: "no origin", missing: false } : { code: 127, stdout: "", stderr: "", missing: true };

function gspawn(brief: string, agent = "worker", cfg = gcfg, name?: string) {
	return checkSpawn({ agent, invocationKind: "task", brief, ...(name === undefined ? {} : { name }) }, cfg, gRunner);
}

/** A fresh Progress entry so the plan's progress hash is spendable again. */
function freshProgress(): void {
	writeFileSync(LOCKED, `${readFileSync(LOCKED, "utf8")}- more progress\n`);
}

/** The named reviewer registry entry for LOCKED (P4f): written directly, so no spawn state is touched; idempotent. */
function registerReviewer(): void {
	mkdirSync(GSTATE, { recursive: true });
	const text = readFileSync(LOCKED, "utf8");
	writeFileSync(REVIEW_SPAWNS, JSON.stringify({ rev1: { plan: LOCKED, text, hash: reviewHash(text), verdicts: 0 } }));
}

/** A subagent edit adding `entry` as spawn `agentId`'s plan edit (the guard's record path); returns the decision. */
function reviewerEdit(entry: string, agentId = "rev1") {
	registerReviewer();
	const before = readFileSync(LOCKED, "utf8");
	return checkPlanEdit({ path: LOCKED, before, after: before + entry, agent: "sub", agentId }, gcfg);
}

const PASS_ENTRY = "\n- PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: none\n";
const FAIL_ENTRY =
	"\n- PLAN REVIEW: FAIL — redundant: P1 redoes the sweep — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";

test("a spawn on a plan with no recorded review is denied", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a recorded PASS with the same hash allows the spawn", () => {
	expect(reviewerEdit(PASS_ENTRY).allow).toBe(true);
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a phase edited after the PASS expires it", () => {
	// Main's outside-Progress edit: written directly, the way the plan file really changes.
	writeFileSync(LOCKED, readFileSync(LOCKED, "utf8").replace("P1 do the thing", "P1 do it differently"));
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("changed since review"),
	});
});

test("a progress-only edit after the PASS keeps it valid", () => {
	expect(reviewerEdit(PASS_ENTRY).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a recorded FAIL denies with the finding", () => {
	rmSync(REVIEWS, { force: true });
	expect(reviewerEdit(FAIL_ENTRY).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("Main writing the PASS line is refused and records nothing", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "main" }, gcfg)).toMatchObject({ allow: false, restore: { path: LOCKED, text: before } });
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a review spawn is exempt without a record", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true }); // the FAIL test's finding is an open incident; this test is about the PASS gate
	freshProgress();
	expect(gspawn(`Plan review: ${LOCKED}\nReview P1 against its phases.`, "reviewer", gcfg, "rev1")).toMatchObject({ allow: true });
});

// --- P4c: the PASS gate honours review.since (plans stamped before the cutover are exempt) ---

const PRE_SINCE = join(REPO, "docs/plans/20261020_0100_presince.md");
writeFileSync(join(GAGENT, "INDEX.md"), `${LOCKED}\n${PRE_SINCE}\n`);
writeFileSync(PRE_SINCE, fixturePlan());

test("a plan stamped before review.since spawns with no PASS", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${PRE_SINCE} on P1`)).toMatchObject({ allow: true });
});

test("a plan stamped on/after review.since is still refused with no PASS", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test(`since: "" turns the PASS gate off`, () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`, "worker", { ...gcfg, review: { ...gcfg.review, since: "" } })).toMatchObject({
		allow: true,
	});
});

// --- P4g: the review line is matched exactly; a PLAN REVIEW line outside that form is restored ---

const DATED_PASS = "\n- 2026-10-29 09:55 RevX: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: none\n";
const DATED_FAIL = "\n- 2026-10-29 09:55 RevX: PLAN REVIEW: FAIL — redundant: P1 redoes the sweep — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";
const SPOOFED_FAIL = "\n- PLAN REVIEW: FAIL: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none — MRs: none\n  Findings: P1 redoes src/core/mr-sweep.ts:169\n";
const LOOSE_LINE = "\n- PLAN REVIEW - pass\n  Findings: none\n";

test("a dated PASS line from a reviewer records a PASS", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(DATED_PASS).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({ allow: true });
});

test("a dated FAIL line denies with its finding", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(DATED_FAIL).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("a verdict word inside a FAIL line does not flip it to PASS", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	expect(reviewerEdit(SPOOFED_FAIL).allow).toBe(true);
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/FAIL: .*mr-sweep\.ts:169/),
	});
});

test("a PLAN REVIEW line outside the exact form is restored with a reason", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + LOOSE_LINE, agent: "sub" }, gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringMatching(/PLAN REVIEW/),
		restore: { path: LOCKED, text: before },
	});
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

// --- P4h: the queue summary counts done phases; ticking a phase box does not expire a PASS ---

const THREE_PHASES = fixturePlan().replace(
	"- [ ] P1 do the thing — verify: `test -f src/a.ts`",
	"- [x] P1 do the thing — verify: `test -f src/a.ts`\n- [x] P2 do the next thing — verify: `test -f src/a.ts`\n- [ ] P3 do the last thing — verify: `test -f src/a.ts`",
);

test("the queue summary shows N/M done for a plan's phases", () => {
	const file = join(REPO, "docs/plans/20261029_0110_threephase.md");
	writeFileSync(file, THREE_PHASES);
	const index = join(TMP, "INDEX3.md");
	writeFileSync(index, `${file}\n`);
	expect(queueSummary(index, SINCE)).toMatch(/\[open, 2\/3 done\]/);
});

test("ticking a phase box does not change the review hash", () => {
	const text = fixturePlan();
	expect(reviewHash(text.replace("- [ ] P1", "- [x] P1"))).toBe(reviewHash(text));
});

test("editing a phase's text changes the review hash", () => {
	const text = fixturePlan();
	expect(reviewHash(text.replace("P1 do the thing", "P1 do it differently"))).not.toBe(reviewHash(text));
});

// --- P4d: a review spawn needs a review.agents entry that Main may spawn (## Allowed) ---

const withAgents = (agents: string[]) => ({ ...gcfg, review: { ...gcfg.review, agents } });

test("review.agents with no entry in Allowed is a problem naming review.agents", () => {
	const r = reviewAgentsProblem(withAgents(["reviewer"]), new Set(["glm"]));
	expect(r.problem).toContain("review.agents");
});

test("review.agents of an allowed agent alone is clean", () => {
	const r = reviewAgentsProblem(withAgents(["glm"]), new Set(["glm"]));
	expect(r.problem).toBeNull();
	expect(r.warnings).toEqual([]);
});

test("review.agents with an allowed and a not-allowed entry warns naming the other, exit stays clean", () => {
	const r = reviewAgentsProblem(withAgents(["glm", "reviewer"]), new Set(["glm"]));
	expect(r.problem).toBeNull();
	expect(r.warnings.join("\n")).toContain("reviewer");
});

// --- P4j: a relative plan target is refused for every agent (the sub edit lands on a missing file, so the plan gate never sees it) ---

function editEvent(agent: "main" | "sub", input: Record<string, unknown>, tool = "edit"): ToolEvent {
	return { tool, input, cwd: REPO, agent, agentId: "p4j", calls: 1, paths: [], writes: [], command: "" };
}

const PLAN_NAME = "20261030_0100_locked.md";

test("a sub edit whose [path#TAG] header is a relative plan path is denied", () => {
	expect(checkTool(editEvent("sub", { input: `[docs/plans/${PLAN_NAME}#ABCD]\nPUT 1.=1:\n+x` }), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("absolute plan path"),
	});
});

test("a main write to a relative docs/plans path is denied", () => {
	expect(checkTool(editEvent("main", { path: `docs/plans/${PLAN_NAME}`, content: "x" }, "write"), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("absolute plan path"),
	});
});

test("a ~/ plan path is denied (it is not absolute)", () => {
	expect(checkTool(editEvent("sub", { path: `~/x/docs/plans/${PLAN_NAME}` }), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("absolute plan path"),
	});
});

test("a bare relative plan file name in a header is denied", () => {
	expect(checkTool(editEvent("sub", { input: `[${PLAN_NAME}#ABCD]\nPUT 1.=1:\n+x` }), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("absolute plan path"),
	});
});

test("an edit to the absolute plan path is not refused by this rule", () => {
	expect(checkTool(editEvent("sub", { input: `[${LOCKED}#ABCD]\nPUT 1.=1:\n+x` }), gcfg).allow).toBe(true);
});

test("relative edits outside plan paths are unchanged", () => {
	expect(checkTool(editEvent("sub", { path: "src/a.ts" }), gcfg).allow).toBe(true);
	expect(checkTool(editEvent("sub", { path: "notes.md" }), gcfg).allow).toBe(true);
});

// --- P4e: the guard re-reads config.yml when its mtime changes; a broken edit keeps the last good config ---

const RHOME = join(TMP, "rhome");
const RCFG = join(RHOME, ".config/neurastream/config.yml");
mkdirSync(join(RHOME, ".config/neurastream"), { recursive: true });

/** Writes the config and pins its mtime, so two writes in one test always differ. */
function writeRConfig(text: string, mtimeSec: number): void {
	writeFileSync(RCFG, text);
	utimesSync(RCFG, mtimeSec, mtimeSec);
}

test("a config.yml edit is seen by the next guard call", () => {
	writeRConfig(`review:\n  agents: ["reviewer"]\n`, 1_800_000_000);
	const logged: string[] = [];
	const current = reloadingConfig(
		loadConfig({ home: RHOME, env: {} }),
		RCFG,
		() => loadConfig({ home: RHOME, env: {} }),
		line => logged.push(line),
	);
	expect(current().review.agents).toEqual(["reviewer"]);
	writeRConfig(`review:\n  agents: ["worker"]\n`, 1_800_000_100);
	expect(current().review.agents).toEqual(["worker"]);
	expect(logged).toEqual([]);
});

test("an invalid config.yml keeps the last good config and logs one line", () => {
	writeRConfig(`review:\n  agents: ["worker"]\n`, 1_800_000_200);
	const logged: string[] = [];
	const current = reloadingConfig(
		loadConfig({ home: RHOME, env: {} }),
		RCFG,
		() => loadConfig({ home: RHOME, env: {} }),
		line => logged.push(line),
	);
	writeRConfig(`review:\n  agents: ["worker"\n`, 1_800_000_300);
	expect(current().review.agents).toEqual(["worker"]);
	expect(current().review.agents).toEqual(["worker"]);
	expect(logged).toHaveLength(1);
	expect(logged[0]).toContain("keeping the last good config");
});

// --- P4i: a sub's own spawn passes the same gates as Main's (Allowed, plan review, shell bypass) ---

const subEvent = (tool: string, input: Record<string, unknown>) => ({
	tool,
	input,
	cwd: REPO,
	agent: "sub" as const,
	agentId: "s1",
	calls: 0,
	paths: [],
	writes: [],
	command: "",
});
const bypassCfg = { ...gcfg, guards: { ...gcfg.guards, bypass_spawn: ["opencode run"] } };

test("a sub task naming an agent outside Allowed is denied", () => {
	const d = checkTool(subEvent("task", { context: "", tasks: [{ agent: "rogue", name: "t1", task: "x" }] }), gcfg);
	expect(d).toMatchObject({ allow: false, reason: expect.stringContaining("not in") });
});

test("a sub task naming a plan with no reviewer PASS is denied", () => {
	rmSync(REVIEWS, { force: true });
	const input = { tasks: [{ agent: "worker", name: "t1", task: `Work ${LOCKED} on P1` }] };
	expect(checkTool(subEvent("task", input), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a sub task naming a plan with a current PASS and an Allowed agent is allowed", () => {
	expect(reviewerEdit(PASS_ENTRY).allow).toBe(true);
	freshProgress();
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	const input = { tasks: [{ agent: "worker", name: "t1", task: `Work ${LOCKED} on P1` }] };
	expect(checkTool(subEvent("task", input), gcfg)).toMatchObject({ allow: true });
});

test("a sub cannot spawn a plan review: the review exemption is Main's only", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	const input = { tasks: [{ agent: "reviewer", name: "r1", task: `Plan review: ${LOCKED}\nReview P1 against its phases.` }] };
	expect(checkTool(subEvent("task", input), gcfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("a sub's shell launch of a bypass agent naming an unreviewed plan is denied", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	const input = { command: `opencode run "Work ${LOCKED} on P1"` };
	expect(checkTool(subEvent("bash", input), bypassCfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

test("Main's shell launch of a bypass agent naming an unreviewed plan is denied", () => {
	rmSync(REVIEWS, { force: true });
	rmSync(join(GSTATE, "incidents.jsonl"), { force: true });
	freshProgress();
	const input = { command: `opencode run "Work ${LOCKED} on P1"` };
	const main = { tool: "bash", input, cwd: REPO, agent: "main" as const, agentId: "m1", calls: 0, paths: [], writes: [], command: "" };
	expect(checkTool(main, bypassCfg)).toMatchObject({
		allow: false,
		reason: expect.stringContaining("no current reviewer PASS"),
	});
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// P4f (plan 20261028_1600): a PASS counts only from the plan's named review spawn, and that spawn
// is locked to reading, todo, and editing its own plan. The registry is review-spawns.json.
const REVIEW_SPAWNS = join(GSTATE, "review-spawns.json");
const reviewSpawns = (): Record<string, { plan: string; verdicts: number }> => (existsSync(REVIEW_SPAWNS) ? JSON.parse(readFileSync(REVIEW_SPAWNS, "utf8")) : {});
const reviewsNow = (): Record<string, { verdict: string }> => (existsSync(REVIEWS) ? JSON.parse(readFileSync(REVIEWS, "utf8")).reviews : {});
const spawnedAs = (tool: string, input: Record<string, unknown>, agentId: string, extra: Record<string, unknown> = {}): ToolEvent =>
	({ tool, input, cwd: REPO, agent: "sub", agentId, calls: 0, paths: [], writes: [], command: String(input.command ?? ""), ...extra }) as ToolEvent;

test("a named review spawn of its plan is registered and exempt", () => {
	rmSync(REVIEW_SPAWNS, { force: true });
	freshProgress();
	expect(gspawn(`Plan review: ${LOCKED}\nReview P1 of ${LOCKED}.`, "reviewer", gcfg, "rev1")).toMatchObject({ allow: true });
	expect(reviewSpawns()).toMatchObject({ rev1: { plan: LOCKED, verdicts: 0 } });
});

test("a review spawn with no name is denied", () => {
	freshProgress();
	expect(gspawn(`Plan review: ${LOCKED}\nReview P1 of ${LOCKED}.`, "reviewer")).toMatchObject({
		allow: false,
		reason: expect.stringContaining("needs a name"),
	});
});

test("a PASS from a spawn that is not the plan's review spawn is restored and not recorded", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	const d = checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "sub", agentId: "rev2" }, gcfg);
	expect(d).toMatchObject({ allow: false, restore: { path: LOCKED, text: before } });
	expect(reviewsNow()[LOCKED]).toBeUndefined();
});

test("the named review spawn's PASS records", () => {
	rmSync(REVIEWS, { force: true });
	freshProgress();
	registerReviewer();
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "sub", agentId: "rev1" }, gcfg)).toMatchObject({ allow: true });
	expect(reviewsNow()[LOCKED]).toMatchObject({ verdict: "PASS" });
});

test("a non-review spawn reusing the review name drops the entry and its lock", () => {
	registerReviewer();
	freshProgress();
	expect(gspawn(`Work ${LOCKED} on P1`, "worker", gcfg, "rev1")).toMatchObject({ allow: true });
	expect(reviewSpawns()).toEqual({});
	expect(checkTool(spawnedAs("bash", { command: "echo hi" }, "rev1"), gcfg)).toMatchObject({ allow: true });
});

test("a review spawn's shell, spawn, cancel and MCP tools are denied", () => {
	for (const [tool, input] of [
		["bash", { command: "echo hi" }],
		["eval", { code: "1" }],
		["node_repl", { code: "1" }],
		["task", { tasks: [] }],
		["cancel_job", {}],
		["mcp__x_y", {}],
	] as const) {
		registerReviewer();
		const d = checkTool(spawnedAs(tool, { ...input }, "rev1"), gcfg);
		expect(`${tool}: ${d.allow}`).toBe(`${tool}: false`);
		expect(d.reason).toMatch(/review spawn/);
	}
});

test("a review spawn may edit only its own plan", () => {
	registerReviewer();
	expect(checkTool(spawnedAs("edit", {}, "rev1"), gcfg).reason).toMatch(/review spawn/);
	expect(checkTool(spawnedAs("edit", {}, "rev1", { writes: [join(REPO, "src/x.ts")] }), gcfg).reason).toMatch(/review spawn/);
	expect(checkTool(spawnedAs("write", {}, "rev1", { writes: [join(REPO, "docs/plans/20261030_0200_other.md")] }), gcfg).reason).toMatch(/review spawn/);
	expect(checkTool(spawnedAs("edit", {}, "rev1", { writes: [LOCKED] }), gcfg).reason).not.toMatch(/review spawn/);
});

test("a review spawn's read, grep and todo calls are allowed", () => {
	registerReviewer();
	const src = join(REPO, "src/a.ts");
	for (const tool of ["read", "grep", "glob", "find", "todo"]) {
		const d = checkTool(spawnedAs(tool, { path: src }, "rev1", { paths: [src] }), gcfg);
		expect(`${tool}: ${d.reason}`).not.toMatch(/review spawn/);
	}
});

test("a review spawn may not read credentials or env files", () => {
	registerReviewer();
	for (const p of [join(GHOME, ".config/gateforge/x/pin.env"), join(GHOME, ".ssh/id_ed25519"), join(REPO, ".env.local")]) {
		const d = checkTool(spawnedAs("read", { path: p }, "rev1", { paths: [p] }), gcfg);
		expect(`${p}: ${d.allow}`).toBe(`${p}: false`);
		expect(d.reason).toMatch(/review spawn/);
	}
});

test("a review spawn's suffixed sub agent id (rev1-2) keeps the review lock", () => {
	registerReviewer();
	const d = checkTool(spawnedAs("bash", { command: "echo hi" }, "rev1-2"), gcfg);
	expect(d).toMatchObject({ allow: false });
	expect(d.reason).toMatch(/review spawn/);
});

test("a review spawn may not read a configured notify secret outside the credential dirs", () => {
	registerReviewer();
	const hook = join(TMP, "hooks/discord-webhook");
	const ncfg = { ...gcfg, notify: { ...gcfg.notify, discord_webhook_file: hook } };
	const d = checkTool(spawnedAs("read", { path: hook }, "rev1", { paths: [hook] }), ncfg);
	expect(d).toMatchObject({ allow: false });
	expect(d.reason).toContain(hook);
});

test("review reads count toward the sub call budget", () => {
	registerReviewer();
	const src = join(REPO, "src/a.ts");
	expect(checkTool(spawnedAs("read", { path: src }, "rev1", { paths: [src], calls: gcfg.guards.sub_max_calls }), gcfg).allow).toBe(false);
});

test("a review spawn that writes PASS then FAIL has two verdicts: the record is FAIL", () => {
	rmSync(REVIEWS, { force: true });
	registerReviewer();
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "sub", agentId: "rev1" }, gcfg)).toMatchObject({ allow: true });
	const after = before + PASS_ENTRY;
	expect(checkPlanEdit({ path: LOCKED, before: after, after: after + FAIL_ENTRY, agent: "sub", agentId: "rev1" }, gcfg)).toMatchObject({ allow: true });
	expect(JSON.parse(readFileSync(REVIEWS, "utf8")).reviews[LOCKED]).toMatchObject({ verdict: "FAIL", finding: "review spawn wrote 2 verdicts", by: "rev1" });
});

test("a plan changed during review: the review spawn's PASS is recorded as FAIL", () => {
	rmSync(REVIEWS, { force: true });
	registerReviewer();
	const original = readFileSync(LOCKED, "utf8");
	const changed = `Edited during review.\n${original}`;
	writeFileSync(LOCKED, changed);
	expect(checkPlanEdit({ path: LOCKED, before: changed, after: changed + PASS_ENTRY, agent: "sub", agentId: "rev1" }, gcfg)).toMatchObject({ allow: true });
	expect(JSON.parse(readFileSync(REVIEWS, "utf8")).reviews[LOCKED]).toMatchObject({ verdict: "FAIL", finding: "plan changed during review" });
	writeFileSync(LOCKED, original);
});

test("Main may not add a PLAN REVIEW line: the edit is refused and restored", () => {
	rmSync(REVIEWS, { force: true });
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "main" }, gcfg)).toMatchObject({
		allow: false,
		restore: { path: LOCKED, text: before },
	});
	expect(reviewsNow()[LOCKED]).toBeUndefined();
});

test("a review spawn's PASS that never reached an edit is recorded at its agent_end", () => {
	rmSync(REVIEWS, { force: true });
	registerReviewer();
	const before = readFileSync(LOCKED, "utf8");
	writeFileSync(LOCKED, before + PASS_ENTRY);
	expect(reviewSpawnEnd("rev1", gcfg)).toBeNull();
	expect(reviewsNow()[LOCKED]).toMatchObject({ verdict: "PASS", by: "rev1" });
	writeFileSync(LOCKED, before);
});

test("a review spawn whose PASS was recorded at its edit gets nothing more at agent_end", () => {
	rmSync(REVIEWS, { force: true });
	registerReviewer();
	const before = readFileSync(LOCKED, "utf8");
	expect(checkPlanEdit({ path: LOCKED, before, after: before + PASS_ENTRY, agent: "sub", agentId: "rev1" }, gcfg)).toMatchObject({ allow: true });
	const recorded = readFileSync(REVIEWS, "utf8");
	expect(reviewSpawnEnd("rev1", gcfg)).toBeNull();
	expect(readFileSync(REVIEWS, "utf8")).toBe(recorded);
});

test("a review spawn that ends with no verdict tells Main and records nothing", () => {
	rmSync(REVIEWS, { force: true });
	registerReviewer();
	expect(reviewSpawnEnd("rev1", gcfg)).toBe(`rev1 wrote no verdict on ${LOCKED}.`);
	expect(reviewSpawnEnd("rev1-2", gcfg)).toBe(`rev1 wrote no verdict on ${LOCKED}.`);
	expect(reviewsNow()[LOCKED]).toBeUndefined();
	expect(reviewSpawnEnd("worker-1", gcfg)).toBeNull();
});
