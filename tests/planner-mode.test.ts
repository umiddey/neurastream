// Planner mode (plan 20261102_1515 P1): the owner's `planner main|delegated` switch — the
// state file beside the tier file, the config default, and the `config set` door. Everything
// runs in-process against a sandbox HOME (applyQueueEnv points the queue library at it; the
// caller's QUEUE_* env is restored afterAll).

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runConfigKeys } from "../src/cli/config-set.ts";
import { chatPlanner, currentPlanner, plannerFile } from "../src/core/autonomy.ts";
import { configFile, loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit, checkTool, spawnProblem } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

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

test("a bad planner value is refused by config set and the file is untouched", async () => {
	const before = readFileSync(configFile(root), "utf8");
	const set = await capture(() => runConfigKeys(["set", "autonomy.planner", "sideways"], root));
	expect(set.code).toBe(1);
	expect(readFileSync(configFile(root), "utf8")).toBe(before);
	expect(currentPlanner(cfg)).toBe("main");
});
