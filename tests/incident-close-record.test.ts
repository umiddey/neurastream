// queue-close's incident record (plan 20261022_2330 P5): when the queue closes a plan that
// cites INCIDENT <id>, a {type:"fixed"} record is appended for each id, so the guards stop
// pushing the bug. The close runs against a throwaway git repo, INDEX and queue state.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strftime } from "../src/core/clock.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { addIncident, planIncident, readIncidents } from "../src/core/incidents.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { queueClose } from "../src/core/queue-close.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-qclose-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const QUEUE_STATE = join(HOME, ".local/state/queue");
const NOW = 1_760_000_000;
const ID = `I-${strftime(NOW, "%Y%m%d")}-1`;

// queueClose drives the queue library through QUEUE_* env vars; save the caller's so nothing
// leaks into the test files that run after this one.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

function seed(): Config {
	for (const d of [
		join(AGENT, "blockers"),
		join(TOY, "docs/plans"),
		join(HOME, ".config/neurastream"),
		QUEUE_STATE,
	]) {
		mkdirSync(d, { recursive: true });
	}
	const blocker = join(AGENT, "blockers/no-push");
	writeFileSync(blocker, "#!/bin/sh\nexit 0\n");
	chmodSync(blocker, 0o755);
	// queueClose leaves the index 0444 (plan 20261031_0911 P2); reseed fresh instead of writing over it.
	rmSync(join(AGENT, "INDEX.md"), { force: true });
	writeFileSync(join(AGENT, "INDEX.md"), `${join(TOY, "docs/plans/20261020_1200_fix.md")}\n`);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${QUEUE_STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	spawnSync("git", ["-C", TOY, "init", "-q"]);
	return loadConfig({ home: HOME, env: {} });
}

test("closing a plan that cites INCIDENT <id> records fixed for each id", () => {
	const cfg = seed();
	const opened = addIncident(cfg, { source: "realtime", kind: "ledger-contradiction", summary: "ledger says RUNNING for a finished agent" }, NOW);
	expect(opened.incident.id).toBe(ID);
	const plan = join(TOY, "docs/plans/20261020_1200_fix.md");
	writeFileSync(
		plan,
		[
			"# 20261020_1200_fix",
			"",
			"## Goal",
			`Fix ${ID}.`,
			"",
			"## Forbidden",
			"- never push",
			"",
			"## Blockers",
			"- no-push",
			"",
			"## Phases",
			"- [x] P1 fix — verify: `true`",
			"",
			"## Done check",
			"`true`",
			"",
			"## Progress",
			"Status: complete",
			"- done.",
			"",
			`INCIDENT ${ID}`,
			"",
		].join("\n"),
	);
	const rc = queueClose([plan], cfg);
	expect(rc).toBe(0);
	const v = readIncidents(cfg).find(i => i.id === ID);
	const res = v?.resolution;
	expect(res).toMatchObject({ type: "fixed", id: ID, plan });
	expect(res?.type === "fixed" && typeof res.ts === "number" && res.plan === plan).toBe(true);
});

/** A plan that closes and cites the incident id `cites` times, like a plan that names it in several places. */
function closedPlan(id: string, cites: number): string {
	return [
		"# plan",
		"",
		"## Goal",
		`Fix ${id}.`,
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		"- [x] P1 fix — verify: `true`",
		"",
		"## Done check",
		"`true`",
		"",
		"## Code read by Main",
		"- `src/core/incidents.ts`",
		"",
		"## Progress",
		"Status: complete",
		"- done.",
		"",
		...Array.from({ length: cites }, () => `INCIDENT ${id}`),
		"",
	].join("\n");
}

test("an incident with a plan record becomes FIXED when a plan citing it closes; a later plan is refused once", () => {
	const cfg = seed();
	const planA = join(TOY, "docs/plans/20261021_0900_plan-a.md");
	const planB = join(TOY, "docs/plans/20261021_0930_plan-b.md");
	const index = join(AGENT, "INDEX.md");
	writeFileSync(index, `${readFileSync(index, "utf8")}${planA}\n${planB}\n`);
	const { incident } = addIncident(cfg, { source: "realtime", kind: "ledger-contradiction", summary: "ledger says RUNNING for a second finished agent" }, NOW);
	const id = incident.id;
	writeFileSync(planA, closedPlan(id, 2));
	writeFileSync(planB, closedPlan(id, 1));
	expect(planIncident(cfg, id, planA)).toBeNull();
	expect(readIncidents(cfg).find(i => i.id === id)?.resolution?.type).toBe("plan");

	const errors: string[] = [];
	const logError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
		logError(...args);
	};
	try {
		expect(queueClose([planA], cfg)).toBe(0);
		expect(queueClose([planB], cfg)).toBe(0);
	} finally {
		console.error = logError;
	}
	const res = readIncidents(cfg).find(i => i.id === id)?.resolution;
	expect(res).toMatchObject({ type: "fixed", id, plan: planA });
	// plan-a cites the id twice: one record, no refusal. plan-b is refused once, the record stays plan-a's.
	expect(errors.filter(l => l.includes("not recording fixed"))).toEqual([
		`queue-close: not recording fixed for ${id}: incident ${id} already has a fixed record`,
	]);
});

// P5b (I-20261031-349, plan 20261031_0911_forced_close_index_guard): queue-close must not lift
// INCIDENT ids out of ## Progress — an id cited only there was never fixed by a phase, so it
// stays open while ids named in the Goal or a phase still count as fixed on close. Fails on
// origin/main, which records fixed for every id anywhere in the plan text.
test("an incident cited only in ## Progress stays open when the plan closes; one named in a phase is fixed", () => {
	const cfg = seed();
	const plan = join(TOY, "docs/plans/20261022_0900_progress-only.md");
	writeFileSync(join(AGENT, "INDEX.md"), `${plan}\n`);
	const idA = addIncident(cfg, { source: "realtime", kind: "ledger-contradiction", summary: "cited in a phase" }, NOW).incident.id;
	const idB = addIncident(cfg, { source: "realtime", kind: "ledger-contradiction", summary: "cited only in the Progress section" }, NOW).incident.id;
	writeFileSync(plan, [
		"# progress-only",
		"",
		"## Goal",
		`Fix ${idA}.`,
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		`- [x] P1 fix ${idA} — verify: \`true\``,
		"",
		"## Done check",
		"`true`",
		"",
		"## Code read by Main",
		"- `src/core/incidents.ts`",
		"",
		"## Progress",
		"Status: complete",
		"- done.",
		"",
		`INCIDENT ${idA}`,
		`INCIDENT ${idB}`,
		"",
	].join("\n"));
	const errors: string[] = [];
	const logError = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
		logError(...args);
	};
	let rc: number;
	try {
		rc = queueClose([plan], cfg);
	} finally {
		console.error = logError;
	}
	expect(rc).toBe(0);
	const views = readIncidents(cfg);
	expect(views.find(i => i.id === idA)?.resolution).toMatchObject({ type: "fixed", id: idA, plan });
	// idB appears only in ## Progress: no phase fixed it, so it stays open and the close logs it.
	expect(views.find(i => i.id === idB)?.resolution?.type).toBeUndefined();
	expect(errors.filter(l => l.includes(`still open: ${idB}`))).toEqual([
		`queue-close: still open: ${idB} (cited only in ## Progress)`,
	]);
	expect(errors.some(l => l.includes(`still open: ${idA}`))).toBe(false);
});

afterAll(() => {
	// The snapshot above is empty under the deletion-only preload (it deletes every inherited
	// QUEUE_* before any module loads), so delete what queueClose applied in-process, not just
	// the snapshot's keys, then put the snapshot back — else the nsar-qclose sandbox paths leak
	// into the test files that run after this one.
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
