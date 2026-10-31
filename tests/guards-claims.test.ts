// Guards use claims (plan 20261027_1300 P3): a Main may spawn on or edit a plan only while no
// other Main holds its live claim — a spawn on an unclaimed plan claims it first, a held plan
// refuses with "plan X is held by Main B since HH:MM", a sub's launch is refused once its Main
// no longer holds the claim, and the adapter heartbeats every held claim every 60 s while the
// Main session lives (session_shutdown releases nothing; the TTL covers crashes and restarts).
// Everything runs in-process against a sandbox HOME with the clock pinned via NEURASTREAM_NOW
// (the src/core/clock.ts convention), like tests/guards-priority.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter } from "../src/adapters/omp/index.ts";
import type { SpawnEvent, ToolEvent } from "../src/core/adapter.ts";
import { fileClaimStore } from "../src/core/claims.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { checkPlanEdit, checkSpawn, checkTool, mainId } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-guard-claims-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const NOW = 1_760_000_000;
// The 20261020_* stamp grandfathers the toy plan out of the "## Code read by Main" template check.
const PLAN = join(TOY, "docs/plans/20261020_0103_claim.md");
const SINCE = strftime(NOW, "%H:%M");

const savedId = process.env.NEURASTREAM_MAIN_ID;
const savedNow = process.env.NEURASTREAM_NOW;

beforeAll(() => {
	process.env.NEURASTREAM_NOW = String(NOW);
});

afterAll(() => {
	if (savedId === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = savedId;
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	// A full `bun test` must leave nothing under os.tmpdir() (merged b3ffd37).
	rmSync(TMP, { recursive: true, force: true });
});

function planText(extra = ""): string {
	return `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Claim gate toy.

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

- Started.${extra}
`;
}

let note = 0;
/** A fresh Progress entry so the plan gate's new-progress rule passes for the next spawn. */
function refresh(): void {
	note++;
	writeFileSync(PLAN, planText(`\n- note ${note}: more progress. Findings: none.`));
}

function buildCfg(extra = ""): Config {
	for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(TOY, "docs/plans"), join(TOY, "src"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n`);
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n- `glm`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(PLAN, planText());
	// The blocker script's relative import must survive the copy (as in incident-guards.test.ts).
	const noPush = join(AGENT, "blockers/no-push");
	const repo = join(import.meta.dir, "..");
	writeFileSync(noPush, readFileSync(join(repo, "blockers/no-push"), "utf8").replace("../src/core/blockers.ts", join(repo, "src/core/blockers.ts")));
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
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
review:
  agents: []
${extra}`,
	);
	return loadConfig({ home: HOME, env: {} });
}

/** Clock and claims from earlier tests must not leak into the next scenario. */
function fresh(): void {
	process.env.NEURASTREAM_NOW = String(NOW);
	rmSync(join(STATE, "claims"), { recursive: true, force: true });
}

/** The claim store the guards use, pointed at this sandbox's queue state. */
function claims() {
	return fileClaimStore(STATE, () => nowSec(), 30);
}

function as(id: string): void {
	process.env.NEURASTREAM_MAIN_ID = id;
}

function spawnEv(): SpawnEvent {
	return { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} on P1`, runningJobs: [] };
}

function taskEv(): ToolEvent {
	return {
		tool: "task",
		input: { tasks: [{ name: "sub1", agent: "toy-worker", task: `Work ${PLAN} on P1` }] },
		cwd: TOY,
		agent: "sub",
		agentId: "s1",
		calls: 0,
		paths: [],
		writes: [],
		command: "",
		runningJobs: [],
	};
}

test("B cannot spawn on or edit A's plan; A can", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true });
	expect(claims().list().map(c => c.main)).toEqual(["a"]);
	// B: the spawn is refused with the holder named and the claim's HH:MM.
	as("b");
	refresh();
	const b = checkSpawn(spawnEv(), cfg);
	expect(b.allow).toBe(false);
	expect(b.reason).toContain(`plan ${PLAN} is held by Main a since ${SINCE}`);
	// B: the plan edit is refused and restored with the same message.
	const before = readFileSync(PLAN, "utf8");
	const edit = checkPlanEdit({ path: PLAN, before, after: before.replace("- Started.", "- Started.\n- B note."), agent: "main" }, cfg);
	expect(edit.allow).toBe(false);
	expect(edit.reason).toContain(`plan ${PLAN} is held by Main a since ${SINCE}`);
	expect(edit.restore).toEqual({ path: PLAN, text: before });
	// A still edits freely while holding the claim.
	as("a");
	expect(checkPlanEdit({ path: PLAN, before, after: before.replace("- Started.", "- Started.\n- Main note."), agent: "main" }, cfg).allow).toBe(true);
});

test("after A's claim expires B can spawn on and edit the plan", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true });
	// 31 minutes pass without a heartbeat: the claim is free for takeover.
	const later = NOW + 31 * 60;
	process.env.NEURASTREAM_NOW = String(later);
	as("b");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true });
	expect(claims().list().map(c => c.main)).toEqual(["b"]);
	// B edits freely now.
	const before = readFileSync(PLAN, "utf8");
	expect(checkPlanEdit({ path: PLAN, before, after: before.replace("- Started.", "- Started.\n- B note."), agent: "main" }, cfg).allow).toBe(true);
	expect(claims().list()[0]!.since).toBe(later);
});

test("a sub of A is refused once its Main no longer holds the claim", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true }); // A claims the plan
	const later = NOW + 31 * 60;
	process.env.NEURASTREAM_NOW = String(later);
	as("b");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true }); // B takes it over
	// A's sub launch is refused: its Main no longer holds the claim.
	as("a");
	refresh();
	const sub = checkTool(taskEv(), cfg);
	expect(sub.allow).toBe(false);
	expect(sub.reason).toContain(`plan ${PLAN} is held by Main b since ${strftime(later, "%H:%M")}`);
	// B's own sub still launches.
	as("b");
	refresh();
	expect(checkTool(taskEv(), cfg).allow).toBe(true);
});

test("env unset means id main, and the claim is recorded for main", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	delete process.env.NEURASTREAM_MAIN_ID;
	expect(mainId()).toBe("main");
	refresh();
	expect(checkSpawn(spawnEv(), cfg)).toMatchObject({ allow: true });
	expect(claims().list().map(c => c.main)).toEqual(["main"]);
});

// --- adapter heartbeat: the session_start timer refreshes every held claim every 60 s ---

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakeHost(): {
	on(event: string, cb: Handler): void;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
	registerCommand(): void;
	sendUserMessage(): void;
	sendMessage(): void;
} {
	const handlers = new Map<string, Handler[]>();
	return {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage() {},
		sendMessage() {},
		async emit(event, payload, ctx) {
			const results = await Promise.all((handlers.get(event) ?? []).map(cb => cb(payload, ctx)));
			return results.filter(r => r !== undefined);
		},
	};
}

test("the adapter heartbeats every held claim every 60 s while the Main session lives", async () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	const store = claims();
	store.claim(PLAN, "a");
	const otherPlan = join(TOY, "docs/plans/20261020_0104_other.md");
	store.claim(otherPlan, "b"); // another Main's claim must be left alone
	const timers: { cb: () => void; ms: number }[] = [];
	const host = fakeHost();
	createOmpAdapter(host, cfg);
	await host.emit(
		"session_start",
		{},
		{
			agent: { kind: "main", id: "main" },
			cwd: TMP,
			sessionManager: { getSessionId: () => "claims-test", getSessionFile: () => join(TMP, "session.jsonl") },
			getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			shutdown: () => {},
			ui: { notify: () => {}, getEditorText: () => "" },
			setInterval: (cb: () => void, ms: number) => {
				timers.push({ cb, ms });
				return timers;
			},
		},
	);
	const beat = timers.find(t => t.ms === 60_000);
	expect(beat).toBeTruthy();
	process.env.NEURASTREAM_NOW = String(NOW + 60);
	beat!.cb();
	const listed = store.list();
	expect(listed.find(c => c.plan === PLAN)?.beat).toBe(NOW + 60);
	expect(listed.find(c => c.plan === otherPlan)?.beat).toBe(NOW);
});

// --- P4 carry-overs: I-20261031-277/-278/-279 (prefer wrapper text), claim leak (review
// finding 2), I-20261031-280 (bypass launches claim, too) ---

const PLAN2 = join(TOY, "docs/plans/20261020_0105_claim2.md");

/** Both toy plans indexed, the second with a fresh plan text. */
function indexBoth(): void {
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN}\n${PLAN2}\n`);
	writeFileSync(PLAN2, planText());
}

function spawnBoth(): SpawnEvent {
	return { agent: "toy-worker", invocationKind: "task", brief: `Work ${PLAN} and ${PLAN2} on P1`, runningJobs: [] };
}

function bashEv(command: string): ToolEvent {
	return { tool: "bash", input: { command }, cwd: TOY, agent: "main", agentId: "m", calls: 0, paths: [], writes: [], command, runningJobs: [] };
}

test("checkSpawn's preferProblem refusal keeps the wrapper: main-guard: <agent>: <pick> (I-20261031-277/-278/-279)", () => {
	const cfg = buildCfg(
		`adapter:
  name: omp
  pins: "${join(AGENT, "agents")}"
ledger:
  prefer:
    - ahead
    - glm
`,
	);
	mkdirSync(join(AGENT, "agents"), { recursive: true });
	writeFileSync(join(AGENT, "agents/ahead.md"), "---\nname: ahead\nmodel: zai/glm-5.3-flash\n---\n\nBody.\n");
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	const d = checkSpawn({ ...spawnEv(), agent: "glm" }, cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toBe(
		`main-guard: glm: ahead is ahead of glm in ledger.prefer and free (under its provider cap) — spawn ahead, or add "Pick note: <why>" to the brief.`,
	);
});

test("a refused claim gate releases the claims this call created (review finding 2a)", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	indexBoth();
	claims().claim(PLAN2, "b"); // another Main holds file 2
	as("a");
	refresh();
	const d = checkSpawn(spawnBoth(), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`plan ${PLAN2} is held by Main b since ${SINCE}`);
	expect(claims().holder(PLAN)).toBeNull(); // file 1's fresh claim is released again
	expect(claims().holder(PLAN2)!.main).toBe("b");
});

test("a refused claim gate keeps a claim this Main already held (review finding 2b)", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	indexBoth();
	claims().claim(PLAN, "a"); // A already held file 1 before the call
	claims().claim(PLAN2, "b");
	refresh();
	const d = checkSpawn(spawnBoth(), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`plan ${PLAN2} is held by Main b since ${SINCE}`);
	expect(claims().holder(PLAN)!.main).toBe("a"); // A still holds file 1
	expect(claims().holder(PLAN2)!.main).toBe("b");
});

test("a bypass launch claims the free plan it names (I-20261031-280)", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	const d = checkTool(bashEv(`opencode run "Work ${PLAN} on P1"`), cfg);
	expect(d.allow).toBe(true);
	expect(claims().holder(PLAN)!.main).toBe("a");
});

test("a bypass launch refuses a plan another Main holds, with the held text (I-20261031-280)", () => {
	const cfg = buildCfg();
	applyQueueEnv(cfg);
	fresh();
	as("a");
	refresh();
	claims().claim(PLAN, "b");
	const d = checkTool(bashEv(`opencode run "Work ${PLAN} on P1"`), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toBe(`main-guard: plan ${PLAN} is held by Main b since ${SINCE}`);
});
