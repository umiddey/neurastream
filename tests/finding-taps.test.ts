// Finding taps (plan 20261028_1135_finding_taps). P1: Main proposes, in writing, why a finding
// incident is or is not a bug (`neurastream incident propose <id> --why "<file:line + reason>"`).
// A proposal is not a resolution: the incident stays open until the owner taps or a plan lands.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runIncident } from "../src/cli/incident.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { addIncident, dismissIncident, openIncidents, readIncidents } from "../src/core/incidents.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const ROOT = "/tmp/neurastream-home-findingtaps/p1";
const HOME = join(ROOT, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const SAVED_HOME = process.env.HOME;

let cfg: Config;

function fresh(): void {
	rmSync(ROOT, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(AGENT, "INDEX.md"), "");
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
`,
	);
	process.env.HOME = HOME;
	cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
}

afterAll(() => {
	if (SAVED_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = SAVED_HOME;
	rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(fresh);

const WHY = "src/core/guards.ts:40 the bucket is never created, so the stop guard reads nothing";

test("incident propose records the reason and the incident stays open", async () => {
	const { incident } = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" });
	expect(await runIncident(["propose", incident.id, "--why", WHY])).toBe(0);
	expect(openIncidents(cfg).map(i => i.id)).toEqual([incident.id]);
	expect(readIncidents(cfg).find(i => i.id === incident.id)?.proposal?.why).toBe(WHY);
});

test("a newer propose replaces the older one", async () => {
	const { incident } = addIncident(cfg, { source: "main", kind: "main-finding", summary: "bucket missing" });
	expect(await runIncident(["propose", incident.id, "--why", WHY])).toBe(0);
	const newer = "src/core/guards.ts:41 the bucket is created after the read, so the reading is empty";
	expect(await runIncident(["propose", incident.id, "--why", newer])).toBe(0);
	expect(readIncidents(cfg).find(i => i.id === incident.id)?.proposal?.why).toBe(newer);
});

test("incident propose refuses an unknown id, a resolved incident, a non-finding kind and a why without file:line", async () => {
	const finding = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" }).incident;
	const toy = addIncident(cfg, { source: "realtime", kind: "toy", summary: "not a finding" }).incident;
	const closed = addIncident(cfg, { source: "realtime", kind: "toy", summary: "already closed" }).incident;
	expect(await runIncident(["propose", "I-19990101-9", "--why", WHY])).toBe(1);
	expect(await runIncident(["propose", toy.id, "--why", WHY])).toBe(1);
	expect(await runIncident(["propose", finding.id, "--why", "no reference at all"])).toBe(1);
	expect(readIncidents(cfg).find(i => i.id === finding.id)?.proposal ?? null).toBe(null);
	expect(dismissIncident(cfg, closed.id, "closed to test refusals")).toBe(null);
	expect(await runIncident(["propose", closed.id, "--why", WHY])).toBe(1);
});
