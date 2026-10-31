// `neurastream claim` (plan 20261027_1300 P4): picking work across several Mains over one queue.
// `claim next` takes the highest free plan in index order with the queue's own skip rules (open
// only, not WAITING on the owner, not waiting on another open plan, not held by another live
// Main), `claim list` shows the holders, `claim release <plan>` frees this Main's claim and
// `--force` frees another Main's — refused for every agent by the guard, the owner's terminal
// move. The queue summary flags each plan `held by <id> since HH:MM` or `free`. Everything runs
// in-process against a sandbox HOME with the clock pinned via NEURASTREAM_NOW, like
// tests/claims.test.ts and tests/queue-summary.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileClaimStore } from "../src/core/claims.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { strftime } from "../src/core/clock.ts";
import { claimCli } from "../src/cli/claim.ts";
import { checkTool } from "../src/core/guards.ts";
import type { ToolEvent } from "../src/core/adapter.ts";
import { queueSummary } from "../src/core/queue/lib.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-claims-cli-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const INDEX = join(AGENT, "INDEX.md");
const NOW = 1_760_000_000;
const SINCE = strftime(NOW, "%H:%M");

const PLAN_A = join(TOY, "docs/plans/20261020_0101_a.md");
const PLAN_B = join(TOY, "docs/plans/20261020_0102_b.md");
const PLAN_C = join(TOY, "docs/plans/20261020_0103_c.md");
const PLAN_D = join(TOY, "docs/plans/20261020_0104_d.md");

// Inherited QUEUE_* (the caller's live session) beats the sandbox config; save, delete, restore
// (the provider-state-enforce.test.ts pattern; INCIDENT I-20261027-129).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const savedId = process.env.NEURASTREAM_MAIN_ID;
const savedNow = process.env.NEURASTREAM_NOW;

beforeAll(() => {
	process.env.NEURASTREAM_NOW = String(NOW);
	process.env.NEURASTREAM_MAIN_ID = "a";
});

afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (savedId === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = savedId;
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	// A full `bun test` must leave nothing under os.tmpdir() (merged b3ffd37).
	rmSync(TMP, { recursive: true, force: true });
});

function planText(title: string, extra = ""): string {
	return `# ${title}

## Goal
- Claim toy.

## Forbidden
- Never skip tests.

## Phases
- [ ] P1 do the thing — verify: \`true\`

## Done check
\`true\`

## Progress
Status: open
${extra}`;
}

function build(): Config {
	mkdirSync(join(TOY, "docs/plans"), { recursive: true });
	for (const d of [join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE]) mkdirSync(d, { recursive: true });
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: TOY });
	// A holds it (rank 1), B waits on the owner (rank 2), C waits on the open D (rank 3),
	// D is free (rank 4): `claim next` must take D.
	writeFileSync(PLAN_A, planText("Plan A"));
	writeFileSync(PLAN_B, planText("Plan B", "WAITING on owner: ship it when I say so\n"));
	writeFileSync(PLAN_C, planText("Plan C", `Waits on: ${PLAN_D}\n`));
	writeFileSync(PLAN_D, planText("Plan D"));
	writeFileSync(INDEX, `${PLAN_A}\n${PLAN_B}\n${PLAN_C}\n${PLAN_D}\n`);
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${INDEX}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
review:
  agents: []
`,
	);
	return loadConfig({ home: HOME, env: {} });
}

const cfg = build();
applyQueueEnv(cfg);

/** The claim store the CLI and guards use, clock pinned to NOW (TTL 30 min). */
function store() {
	return fileClaimStore(STATE, () => NOW, 30);
}

/** Claims live in one store dir across this file's tests: wipe for a fresh scenario. */
function resetClaims(): void {
	rmSync(join(STATE, "claims"), { recursive: true, force: true });
}

/** claimCli prints to stdout; capture so the tests can pin the lines. */
function capture(fn: () => number): { rc: number; out: string[] } {
	const out: string[] = [];
	const orig = console.log;
	console.log = (m: unknown) => out.push(String(m));
	try {
		return { rc: fn(), out };
	} finally {
		console.log = orig;
	}
}

function bashEv(agent: "main" | "sub", command: string): ToolEvent {
	return { tool: "bash", input: { command }, cwd: TOY, agent, agentId: agent === "main" ? "m1" : "s1", calls: 0, paths: [], writes: [], command, runningJobs: [] };
}

test("claim next takes the highest free plan, skipping held, owner-waiting and waits-on plans", () => {
	resetClaims();
	store().claim(PLAN_A, "b"); // another live Main holds the top plan
	const { rc, out } = capture(() => claimCli(["next"], cfg));
	expect(rc).toBe(0);
	expect(out.join("\n")).toContain(`claim: ${PLAN_D} for Main a since ${SINCE}`);
	expect(store().holder(PLAN_D)!.main).toBe("a");
	expect(store().holder(PLAN_A)!.main).toBe("b"); // another Main's claim is untouched
});

test("claim next claims nothing and exits 1 when every open plan is held, waiting or waits-on", () => {
	resetClaims();
	store().claim(PLAN_A, "b");
	store().claim(PLAN_D, "b"); // C waits on D, D itself is held: nothing is pickable
	const { rc, out } = capture(() => claimCli(["next"], cfg));
	expect(rc).toBe(1);
	expect(out.join("\n")).not.toContain("claim:");
	store().release(PLAN_A, "b");
	store().release(PLAN_D, "b");
});

test("claim list shows each live holder with since HH:MM", () => {
	resetClaims();
	store().claim(PLAN_A, "b");
	store().claim(PLAN_D, "a");
	const { rc, out } = capture(() => claimCli(["list"], cfg));
	expect(rc).toBe(0);
	expect(out).toContain(`${PLAN_A} — held by Main b since ${SINCE}`);
	expect(out).toContain(`${PLAN_D} — held by Main a since ${SINCE}`);
});

test("claim release frees this Main's claim; another Main's needs --force, which frees it", () => {
	resetClaims();
	store().claim(PLAN_D, "a");
	store().claim(PLAN_A, "b");
	expect(capture(() => claimCli(["release", PLAN_D], cfg)).rc).toBe(0);
	expect(store().holder(PLAN_D)).toBeNull();
	const refused = capture(() => claimCli(["release", PLAN_A], cfg));
	expect(refused.rc).toBe(1);
	expect(store().holder(PLAN_A)!.main).toBe("b"); // the other Main's claim survived
	expect(capture(() => claimCli(["release", PLAN_A, "--force"], cfg)).rc).toBe(0);
	expect(store().holder(PLAN_A)).toBeNull();
});

test("the guard refuses claim release --force for every agent, owner-only", () => {
	const cmd = `neurastream claim release ${PLAN_A} --force`;
	for (const agent of ["main", "sub"] as const) {
		const d = checkTool(bashEv(agent, cmd), cfg);
		expect(d.allow).toBe(false);
		expect(d.reason).toContain("plan-guard:");
		expect(d.reason).toContain("--force");
	}
	// The same release without --force is an agent's normal move: no refusal.
	expect(checkTool(bashEv("main", `neurastream claim release ${PLAN_A}`), cfg).allow).toBe(true);
});

test("queueSummary flags each plan held by <id> since HH:MM or free, and an expired claim is free", () => {
	resetClaims();
	const claims = store();
	claims.claim(PLAN_A, "b");
	claims.claim(PLAN_D, "a");
	// An expired claim (beat 31 min old, TTL 30) must not flag its holder.
	fileClaimStore(STATE, () => NOW - 31 * 60, 30).claim(PLAN_C, "c");
	const s = queueSummary(INDEX, [], claims);
	expect(s).toContain(`1. ${PLAN_A} [open, 0/1 done, held by b since ${SINCE}]`);
	expect(s).toContain(`2. ${PLAN_B} [open, 0/1 done, WAITING on owner:`);
	expect(s).toContain(`3. ${PLAN_C} [open, 0/1 done, waits on #4, free]`);
	expect(s).toContain(`4. ${PLAN_D} [open, 0/1 done, held by a since ${SINCE}]`);
});
