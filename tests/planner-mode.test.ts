// Planner mode (plan 20261102_1515 P1): the owner's `planner main|delegated` switch — the
// state file beside the tier file, the config default, and the `config set` door. Everything
// runs in-process against a sandbox HOME (applyQueueEnv points the queue library at it; the
// caller's QUEUE_* env is restored afterAll).

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runConfigKeys } from "../src/cli/config-set.ts";
import { chatPlanner, currentPlanner, plannerBaselineFile, plannerFile, plannerPin, verifyPlannerMode } from "../src/core/autonomy.ts";
import { configFile, loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit, checkTool, plannerBody, plannerSpawnPlan, spawnProblem } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { PROTECTED, protectedHit, STATE_DIR } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let cfg: Config;

const UNLOCKED = (planner: "main" | "delegated" = "main"): string =>
	`paths:
  home: "${root}"
  queue_state: "${root}/state"
  plan_guard_log: "${root}/plan-guard.log"
guards:
  chat_unlock: true
autonomy:
  planner: ${planner}
`;

function load(text: string): Config {
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(configFile(root), text);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	env.HOME = root;
	return loadConfig({ home: root, env });
}

function writePlannerFile(word: string): void {
	mkdirSync(join(root, "state"), { recursive: true });
	writeFileSync(plannerFile(), `${word}\n`);
}

function clearPlannerFile(): void {
	rmSync(plannerFile(), { force: true });
}

function plannerLogLines(): string[] {
	try {
		return readFileSync(cfg.paths.plan_guard_log, "utf8").split("\n").filter((l) => / PLANNER /.test(l));
	} catch {
		return [];
	}
}

// Runs fn with console.log/error captured; the real console is restored even when fn throws.
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	try {
		const code = await fn();
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-planner-"));
	roots.push(root);
	clearPlannerFile();
	cfg = load(UNLOCKED());
	applyQueueEnv(cfg);
	clearPlannerFile();
});

// --- currentPlanner ---

test("no planner file: the config default main is in force", () => {
	expect(cfg.autonomy.planner).toBe("main");
	expect(currentPlanner(cfg)).toBe("main");
	expect(existsSync(plannerFile())).toBe(false);
});

// --- chatPlanner: a non-owner source changes nothing ---

test("chat unlock off: the switch refuses and writes nothing", () => {
	const locked = load(UNLOCKED().replace("chat_unlock: true", "chat_unlock: false"));
	applyQueueEnv(locked);
	expect(chatPlanner("planner delegated", locked, "interactive")).toEqual({ applied: false });
	expect(existsSync(plannerFile())).toBe(false);
});

test("anything that is not the whole-message `planner <mode>` command is ignored", () => {
	for (const text of ["planner", "planner sideways", "please planner delegated", "planner delegated now", "delegated", ""]) {
		expect(chatPlanner(text, cfg, "interactive")).toEqual({ applied: false });
	}
	expect(existsSync(plannerFile())).toBe(false);
	expect(plannerLogLines()).toEqual([]);
});

// --- chatPlanner: the owner path ---

test("planner delegated writes the file, logs PLANNER with the source, and currentPlanner reads it back", () => {
	const r = chatPlanner("planner delegated", cfg, "interactive");
	expect(r).toEqual({ applied: true, planner: "delegated" });
	expect(readFileSync(plannerFile(), "utf8")).toBe("delegated\n");
	expect(currentPlanner(cfg)).toBe("delegated");
	expect(plannerLogLines().join("\n")).toContain(" PLANNER delegated chat source=interactive");
});

test("matching is trimmed and case-insensitive", () => {
	expect(chatPlanner("  PLANNER Delegated  ", cfg, "interactive")).toEqual({ applied: true, planner: "delegated" });
	expect(currentPlanner(cfg)).toBe("delegated");
});

test("planner main returns to the default", () => {
	writePlannerFile("delegated");
	expect(chatPlanner("planner main", cfg, "interactive")).toEqual({ applied: true, planner: "main" });
	expect(readFileSync(plannerFile(), "utf8")).toBe("main\n");
	expect(currentPlanner(cfg)).toBe("main");
});

test("junk in the file falls back to the config value", () => {
	writePlannerFile("banana");
	expect(currentPlanner(cfg)).toBe("main");
});

// --- config set door ---

test("config set autonomy.planner round-trips: set, get, effective mode, back to main", async () => {
	expect(currentPlanner(cfg)).toBe("main");
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "delegated"], root))).code).toBe(0);
	const got = await capture(() => runConfigKeys(["get", "autonomy.planner"], root));
	expect(got.code).toBe(0);
	expect(got.out).toBe("delegated");
	// No state file: the effective mode follows the config door.
	const delegated = load(UNLOCKED("delegated"));
	applyQueueEnv(delegated);
	expect(delegated.autonomy.planner).toBe("delegated");
	expect(currentPlanner(delegated)).toBe("delegated");
	// The owner's chat switch wins over the config default.
	writePlannerFile("main");
	expect(currentPlanner(delegated)).toBe("main");
	clearPlannerFile();
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "main"], root))).code).toBe(0);
	expect((await capture(() => runConfigKeys(["get", "autonomy.planner"], root))).out).toBe("main");
});

// --- P2 guard teeth (plan 20261102_1515 P2 a-c): the denials ---

const MAIN_REFUSAL = "planner is delegated — route the ask to the planner agent";

// Mirrors a real plan's shape: the body Main plans, then the Progress section (Status: lives
// inside it, like every plan file's tail).
const PLAN_BODY = `# Thing

## Phases
- [ ] P1 do it

## Code read by Main
- src/core/guards.ts

## Progress
Status: open
`;

function planPath(name: string): string {
	return join(root, "docs/plans", name);
}

// The real spawn path binds a delegated planner spawn's name to the plan its brief named in the
// `Planner role for` line; the `## Allowed` fixture lists the plain task agent.
function bindPlanner(name: string, plan: string): string | null {
	mkdirSync(join(root, "docs/plans"), { recursive: true });
	mkdirSync(dirname(cfg.paths.subagents), { recursive: true });
	writeFileSync(cfg.paths.subagents, "## Allowed\n\n- `task`\n");
	return spawnProblem({ context: "# Goal\nRoute the planning.\n", tasks: [{ name, agent: "task", task: `Planner role for ${plan}\n\nDraft the plan for the thing.` }] }, cfg);
}

test("delegated: Main writing a NEW plan file is refused", () => {
	writePlannerFile("delegated");
	const d = checkPlanEdit({ path: planPath("20261102_1800_new_thing.md"), before: "", after: PLAN_BODY, agent: "main", agentId: "main" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(MAIN_REFUSAL);
	// before "" → the adapter deletes the file the call created.
	expect(d.restore?.text).toBeNull();
});

test("delegated: Main rewriting a plan's non-Progress body is refused", () => {
	writePlannerFile("delegated");
	const p = planPath("20261102_1500_existing.md");
	const d = checkPlanEdit({ path: p, before: PLAN_BODY, after: PLAN_BODY.replace("- [ ] P1 do it", "- [ ] P1 do something else entirely"), agent: "main", agentId: "main" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(MAIN_REFUSAL);
	expect(d.restore?.text).toBe(PLAN_BODY);
});

test("delegated: Main appending a Progress entry stays allowed", () => {
	writePlannerFile("delegated");
	const p = planPath("20261102_1500_existing.md");
	const after = `${PLAN_BODY}- 2026-11-02 18:00 Main: parked the plan for the planner\n  Findings: none\n`;
	const d = checkPlanEdit({ path: p, before: PLAN_BODY, after, agent: "main", agentId: "main" }, cfg);
	expect(d.allow).toBe(true);
});

test("delegated: the planner sub's brief-named NEW plan with its Planner header is allowed", () => {
	writePlannerFile("delegated");
	const plan = planPath("immediate/20261102_1801_planner_work.md");
	const content = "# Planner work\n\nPlanner: PlannerGlm\n\n## Phases\n- [ ] P1 research and draft\n\n## Progress\n";
	// The approved spawn binds the role; the create then passes the pre-tool seam (a new plan file
	// is invisible to the indexed gates) and the plan-edit seam (header + no Main-only lines).
	expect(bindPlanner("PlannerGlm", plan)).toBeNull();
	const pre = checkTool({ tool: "write", input: { path: plan, content }, cwd: root, agent: "sub", agentId: "PlannerGlm", calls: 0, paths: [], writes: [], command: "" }, cfg);
	expect(pre.allow).toBe(true);
	const d = checkPlanEdit({ path: plan, before: "", after: content, agent: "sub", agentId: "PlannerGlm" }, cfg);
	expect(d.allow).toBe(true);
});

// I-20261102-27: the delegated seam refused the review spawn too, and a review spawn's only write
// is its own verdict line — so no plan could record a PASS and no implementer could ever spawn.
test("delegated: the named review spawn may write its own plan's verdict, anyone else may not", () => {
	writePlannerFile("delegated");
	const plan = planPath("immediate/20261102_1801_planner_work.md");
	writeFileSync(join(STATE_DIR, "review-spawns.json"), JSON.stringify({ revPunch: { plan, text: "", hash: "x", verdicts: 0 } }));
	const line = "- 2026-11-02 23:40 revPunch: PLAN REVIEW: PASS — redundant: none — inefficient: none — insecure: none\n";
	const pre = checkTool({ tool: "edit", input: { path: plan, old_string: "## Progress\n", new_string: `## Progress\n${line}` }, cwd: root, agent: "sub", agentId: "revPunch", calls: 0, paths: [], writes: [], command: "" }, cfg);
	expect(pre.allow).toBe(true);
	// The exemption is that one spawn on that one plan: a different reviewer is still refused.
	const other = checkTool({ tool: "write", input: { path: plan, content: "# Other\n" }, cwd: root, agent: "sub", agentId: "revOther", calls: 0, paths: [], writes: [], command: "" }, cfg);
	expect(other.allow).toBe(false);
	expect(other.reason).toContain("planner is delegated");
});

// Punch list (plan 20261102_2315): Main keeps two zones of the plan text in delegated mode — a
// Done check command and a phase line's `verify:` command — and a planner header names the agent,
// not the spawn instance.
const PUNCH_BODY = `# Punch
Planner: glm

## Phases
- [ ] P1 the work \`verify: bun test tests/a.test.ts\`

## Done check
\`\`\`bash
git log --grep=x -1
\`\`\`

## Progress
`;

test("delegated: a Done check command and a phase verify command are not the planner's text", () => {
	writePlannerFile("delegated");
	// Identical once masked: these two zones are Main's to correct.
	expect(plannerBody(PUNCH_BODY.replace("git log --grep=x -1", "git log --grep=y -1"))).toBe(plannerBody(PUNCH_BODY));
	expect(plannerBody(PUNCH_BODY.replace("bun test tests/a.test.ts", "bun test tests/b.test.ts"))).toBe(plannerBody(PUNCH_BODY));
	// Anything else is still the planner's.
	expect(plannerBody(PUNCH_BODY.replace("## Phases", "## Phases\nSome new prose."))).not.toBe(plannerBody(PUNCH_BODY));
	// And the delegated refusal still fires for that prose.
	const prose = checkPlanEdit({ path: planPath("20261102_1900_punch.md"), before: PUNCH_BODY, after: PUNCH_BODY.replace("## Phases", "## Phases\nSome new prose."), agent: "main", agentId: "main" }, cfg);
	expect(prose.allow).toBe(false);
	expect(prose.reason).toContain("planner is delegated");
});

test("delegated: a spawn may head its plan with its agent, not only its instance id", () => {
	writePlannerFile("delegated");
	const plan = planPath("immediate/20261102_1901_family.md");
	expect(bindPlanner("glm-3", plan)).toBeNull();
	const ok = checkPlanEdit({ path: plan, before: "", after: "# Family\nPlanner: glm\n\n## Progress\n", agent: "sub", agentId: "glm-3" }, cfg);
	expect(ok.allow).toBe(true);
	const foreign = checkPlanEdit({ path: plan, before: "", after: "# Family\nPlanner: opus-planner\n\n## Progress\n", agent: "sub", agentId: "glm-3" }, cfg);
	expect(foreign.allow).toBe(false);
	expect(foreign.reason).toContain("carries no \"Planner: glm-3\" header");
});

test("delegated: the planner sub writing a DIFFERENT plan path is refused", () => {
	writePlannerFile("delegated");
	const named = planPath("immediate/20261102_1801_planner_work.md");
	const other = planPath("20261102_1802_someone_elses.md");
	expect(bindPlanner("PlannerGlm", named)).toBeNull();
	const pre = checkTool({ tool: "write", input: { path: other, content: "# Other\n" }, cwd: root, agent: "sub", agentId: "PlannerGlm", calls: 0, paths: [], writes: [], command: "" }, cfg);
	expect(pre.allow).toBe(false);
	expect(pre.reason).toContain("planner is delegated");
	expect(pre.reason).toContain(named);
});

test("delegated: the planner sub editing a Main-only line is refused", () => {
	writePlannerFile("delegated");
	const plan = planPath("immediate/20261102_1801_planner_work.md");
	const before = "# Planner work\n\nPlanner: PlannerGlm\n\n## Phases\n- [ ] P1 research\n\n## Progress\nStatus: open\n";
	expect(bindPlanner("PlannerGlm", plan)).toBeNull();
	const d = checkPlanEdit({ path: plan, before, after: before.replace("Status: open", "Status: WAITING on owner: a reply"), agent: "sub", agentId: "PlannerGlm" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("Main-only lines");
	expect(d.restore?.text).toBe(before);
});

test("delegated: a sub WITHOUT a Planner-role brief writing any new plan file is refused", () => {
	writePlannerFile("delegated");
	const plan = planPath("20261102_1803_smuggled.md");
	const pre = checkTool({ tool: "write", input: { path: plan, content: "# Smuggled\n" }, cwd: root, agent: "sub", agentId: "HelperOne", calls: 0, paths: [], writes: [], command: "" }, cfg);
	expect(pre.allow).toBe(false);
	expect(pre.reason).toContain("planner is delegated");
	expect(pre.reason).toContain("Planner role for");
});

test("mode main: a task brief with a Planner-role line is refused at spawn", () => {
	const plan = planPath("immediate/20261102_1804_future_plan.md");
	const why = spawnProblem({ context: "# Goal\nRoute the planning.\n", tasks: [{ name: "PlanThing", agent: "task", task: `Planner role for ${plan}\n\nDraft the plan for the thing.` }] }, cfg);
	expect(why).toContain("planner mode is main");
});

test("delegated: text after the plan path on the Planner-role line never joins the bound path", () => {
	writePlannerFile("delegated");
	const plan = planPath("20261103_1100_binding.md");
	expect(bindPlanner("PlanBound", `${plan}. Read the brief at local://x.md. MR: none open.`)).toBeNull();
	expect(plannerSpawnPlan("PlanBound")).toBe(plan);
});

test("delegated: a relative, outside-docs/plans, non-.md or missing-docs/plans path is refused at spawn", () => {
	writePlannerFile("delegated");
	for (const bad of ["docs/plans/x.md", join(root, "elsewhere/x.md"), join(root, "docs/plans/x.txt"), "/nonexistent-root/docs/plans/x.md"]) {
		expect(bindPlanner("PlanBad", bad)).toContain("must be an absolute .md path");
	}
});

test("a bad planner value is refused by config set and the file is untouched", async () => {
	const before = readFileSync(configFile(root), "utf8");
	const set = await capture(() => runConfigKeys(["set", "autonomy.planner", "sideways"], root));
	expect(set.code).toBe(1);
	expect(readFileSync(configFile(root), "utf8")).toBe(before);
	expect(currentPlanner(cfg)).toBe("main");
});

// --- P2 (d): the mode facts are owner-only and baseline-anchored ---

// The config as it now stands on disk, read the way a seam reads it (no QUEUE_* overlay masks a
// dirty line).
function reread(): Config {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	env.HOME = root;
	return loadConfig({ home: root, env });
}

function editConfig(text: string): void {
	writeFileSync(configFile(root), text);
}

// The owner's clean stamp: the chat command records the state it wrote.
function ownerStamp(mode: "main" | "delegated" = "delegated"): void {
	expect(chatPlanner(`planner ${mode}`, cfg, "interactive")).toEqual({ applied: true, planner: mode });
}

test("(d1) a hand-edited config value is reverted at the next seam; the mode stays what the baseline says", () => {
	ownerStamp("delegated");
	editConfig(UNLOCKED("delegated"));
	const dirty = reread();
	expect(dirty.autonomy.planner).toBe("delegated");
	const v = verifyPlannerMode(plannerPin(dirty));
	expect(v.reverted).toBe(true);
	expect(v.hint).toContain("planner mode changes need your terminal");
	expect(reread().autonomy.planner).toBe("main");
	// The baseline's state file was never touched, so the mode in force is still delegated.
	expect(currentPlanner(reread())).toBe("delegated");
});

test("(d2) a deleted baseline reverts the mode to main and the config value to the default", () => {
	ownerStamp("delegated");
	editConfig(UNLOCKED("delegated"));
	rmSync(plannerBaselineFile(plannerPin(cfg)), { force: true });
	expect(verifyPlannerMode(plannerPin(reread())).reverted).toBe(true);
	expect(reread().autonomy.planner).toBe("main");
	expect(currentPlanner(reread())).toBe("main");
	expect(existsSync(plannerFile())).toBe(false);
});

test("(d3) a hand-edited state file is reverted to the baseline bytes", () => {
	ownerStamp("delegated");
	writeFileSync(plannerFile(), "main\n");
	const v = verifyPlannerMode(plannerPin(cfg));
	expect(v.reverted).toBe(true);
	expect(readFileSync(plannerFile(), "utf8")).toBe("delegated\n");
	expect(currentPlanner(cfg)).toBe("delegated");
});

test("(d4) a clean stamp is accepted: the baseline records it and the next seam does not revert", () => {
	ownerStamp("delegated");
	const base = JSON.parse(readFileSync(plannerBaselineFile(plannerPin(cfg)), "utf8")) as { planner: { exists: boolean; bytes: string }; config: { planner: string } };
	expect(base.planner).toEqual({ exists: true, bytes: "delegated\n" });
	expect(base.config.planner).toBe("main");
	expect(verifyPlannerMode(plannerPin(reread())).reverted).toBe(false);
	expect(readFileSync(plannerFile(), "utf8")).toBe("delegated\n");
});

test("(d5) the baseline path is in the built-in protected set", () => {
	expect(PROTECTED).toContain(join(dirname(configFile()), "guard-baseline"));
});

test("(d6) a queue-side edit to the baseline is refused by protectedHit", () => {
	const baseline = join(dirname(configFile()), "guard-baseline");
	expect(protectedHit([baseline])).toBe(baseline);
	expect(protectedHit([join(root, "docs/plans/20261102_1500_thing.md")])).toBeNull();
});

test("(d7) with no baseline, a planted state file is deleted and the mode stays main", () => {
	writePlannerFile("delegated");
	expect(currentPlanner(cfg)).toBe("delegated");
	const v = verifyPlannerMode(plannerPin(cfg));
	expect(v.reverted).toBe(true);
	expect(existsSync(plannerFile())).toBe(false);
	expect(currentPlanner(cfg)).toBe("main");
});

test("(d8) with no baseline, a planted config value is restored to main", () => {
	editConfig(UNLOCKED("delegated"));
	const dirty = reread();
	expect(dirty.autonomy.planner).toBe("delegated");
	expect(verifyPlannerMode(plannerPin(dirty)).reverted).toBe(true);
	expect(reread().autonomy.planner).toBe("main");
	expect(currentPlanner(reread())).toBe("main");
});

test("(d9) a non-TTY config set writes but does not stamp: the next seam reverts it with the hint", async () => {
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "delegated"], root, false))).code).toBe(0);
	expect(existsSync(plannerBaselineFile(plannerPin(cfg)))).toBe(false);
	expect(reread().autonomy.planner).toBe("delegated");
	const v = verifyPlannerMode(plannerPin(reread()));
	expect(v.reverted).toBe(true);
	expect(v.hint).toContain("planner mode changes need your terminal");
	expect(reread().autonomy.planner).toBe("main");
});

test("(d10) a TTY config set of a mode key stamps and survives the next seam; another key never stamps", async () => {
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "delegated"], root, true))).code).toBe(0);
	expect(existsSync(plannerBaselineFile(plannerPin(cfg)))).toBe(true);
	expect(verifyPlannerMode(plannerPin(reread())).reverted).toBe(false);
	expect(reread().autonomy.planner).toBe("delegated");
	rmSync(plannerBaselineFile(plannerPin(cfg)), { force: true });
	expect((await capture(() => runConfigKeys(["set", "workspace.port", "7788"], root, true))).code).toBe(0);
	expect(existsSync(plannerBaselineFile(plannerPin(cfg)))).toBe(false);
});
