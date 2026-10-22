// Incidents: the store (src/core/incidents.ts) and the `neurastream incident` CLI. Core tests
// call the functions with a sandbox config (no live files); CLI tests run src/cli/main.ts as a
// subprocess with HOME pointed at the same sandbox.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strftime } from "../src/core/clock.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import {
	addIncident,
	defaultFingerprint,
	dismissIncident,
	openIncidents,
	planIncident,
	readIncidents,
} from "../src/core/incidents.ts";

const REPO = dirname(dirname(import.meta.path));
const TMP = mkdtempSync(join(tmpdir(), "nsar-incidents-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const QUEUE_STATE = join(HOME, ".local/state/queue");

// One sandbox, several far-apart days so every test's ids start at I-<day>-1 again.
const NOW1 = 1760000000;
const NOW2 = 1752000000;
const NOW3 = 1754000000;
const NOW4 = 1756000000;
const NOW5 = 1758000000;
const NOW6 = 1761000000;

function seed(): Config {
	for (const d of [join(AGENT, "notes"), join(TOY, "docs/plans"), join(HOME, ".config/neurastream"), QUEUE_STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(TOY, "INDEX.md"), "docs/plans/20261020_fix.md\n");
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
	return loadConfig({ home: HOME, env: {} });
}
const cfg = seed();

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

test("add creates I-<day>-<n> with the record fields; a different summary opens the next id", () => {
	const a = addIncident(cfg, { source: "main", kind: "toy-bug", summary: "ledger says RUNNING for a finished agent" }, NOW1);
	expect(a.deduped).toBe(false);
	expect(a.incident.id).toBe(`I-${strftime(NOW1, "%Y%m%d")}-1`);
	expect(a.incident).toMatchObject({
		source: "main",
		kind: "toy-bug",
		summary: "ledger says RUNNING for a finished agent",
		evidence: "",
		ts: NOW1,
		lastSeen: NOW1,
		count: 1,
		resolution: null,
	});
	const b = addIncident(cfg, { source: "daily", kind: "metric", summary: "M2 rose" }, NOW1 + 1);
	expect(b.incident.id).toBe(`I-${strftime(NOW1, "%Y%m%d")}-2`);
	expect(readIncidents(cfg).filter(v => v.source === "main" || v.source === "daily")).toHaveLength(2);
});

test("an open fingerprint dedupes: count and lastSeen are updated, no new record", () => {
	const s = { source: "main" as const, kind: "toy", summary: "same bug twice" };
	const a = addIncident(cfg, s, NOW2);
	const b = addIncident(cfg, { ...s, evidence: "seen again" }, NOW2 + 60);
	expect(b.deduped).toBe(true);
	expect(b.incident.id).toBe(a.incident.id);
	expect(b.incident.count).toBe(2);
	expect(b.incident.ts).toBe(NOW2);
	expect(b.incident.lastSeen).toBe(NOW2 + 60);
	expect(readIncidents(cfg).filter(v => v.id === a.incident.id)).toHaveLength(1);
	expect(a.incident.fingerprint).toBe(defaultFingerprint(s));
	// An explicit fingerprint dedupes across differently worded findings; a different source
	// (other default fingerprint) with the same wording opens its own incident.
	const c = addIncident(cfg, { source: "daily", kind: "m2", summary: "worded differently", fingerprint: a.incident.fingerprint }, NOW2 + 90);
	expect(c.deduped).toBe(true);
	const d = addIncident(cfg, { source: "daily", kind: "toy", summary: "same bug twice" }, NOW2 + 120);
	expect(d.deduped).toBe(false);
});

test("after a resolution the same fingerprint opens a new incident", () => {
	const s = { source: "realtime" as const, kind: "ledger-contradiction", summary: "ledger says RUNNING for a completed agent" };
	const a = addIncident(cfg, s, NOW3);
	expect(dismissIncident(cfg, a.incident.id, "dup of an older report")).toBe(null);
	const b = addIncident(cfg, s, NOW3 + 5);
	expect(b.deduped).toBe(false);
	expect(b.incident.id).toBe(`I-${strftime(NOW3, "%Y%m%d")}-2`);
	expect(b.incident.fingerprint).toBe(a.incident.fingerprint);
});

test("incident plan refusals: unknown id, missing file, missing citation, not in repo INDEX", () => {
	const { incident } = addIncident(cfg, { source: "realtime", kind: "k", summary: "s" }, NOW4);
	const id = incident.id;
	const ok = join(TOY, "docs/plans/20261020_ok.md");
	expect(planIncident(cfg, "I-19990101-9", ok)).toBe("unknown incident I-19990101-9");
	expect(planIncident(cfg, id, join(TOY, "docs/plans/nope.md"))).toBe(`plan file not found: ${join(TOY, "docs/plans/nope.md")}`);
	writeFileSync(ok, "# fix\n\nno citation yet\n");
	// refusal order follows the plan: exists → listed in repo INDEX → cites INCIDENT <id>
	expect(planIncident(cfg, id, ok)).toContain("is not listed in");
	writeFileSync(join(TOY, "INDEX.md"), "docs/plans/20261020_fix.md\ndocs/plans/20261020_ok.md\n");
	expect(planIncident(cfg, id, ok)).toContain('must contain "INCIDENT ' + id + '"');
	writeFileSync(ok, `# fix\n\nINCIDENT ${id}\n`);
	expect(planIncident(cfg, id, ok)).toBe(null);
	expect(openIncidents(cfg).find(x => x.id === id)).toBeUndefined();
	const v = readIncidents(cfg).find(x => x.id === id);
	expect(v?.resolution).toEqual({ type: "plan", id, plan: ok });
	expect(planIncident(cfg, id, ok)).toBe(`incident ${id} already has a plan record`);
});

test("incident dismiss: empty why refused, unknown id refused, a real why closes it", () => {
	const { incident } = addIncident(cfg, { source: "weekly", kind: "m5", summary: "guard blocks flat" }, NOW5);
	const id = incident.id;
	expect(dismissIncident(cfg, id, "")).toContain("refused");
	expect(dismissIncident(cfg, id, "   ")).toContain("refused");
	expect(dismissIncident(cfg, "I-19990101-9", "why")).toBe("unknown incident I-19990101-9");
	expect(dismissIncident(cfg, id, "shape matches the known false-alarm family")).toBe(null);
	expect(openIncidents(cfg).find(x => x.id === id)).toBeUndefined();
	const v = readIncidents(cfg).find(x => x.id === id);
	expect(v?.resolution).toEqual({ type: "dismiss", id, why: "shape matches the known false-alarm family" });
});

// --- the CLI, as a subprocess against the same sandbox HOME ---

function incidentCli(args: string[]): { code: number; out: string; err: string } {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("QUEUE_") && v !== undefined) env[k] = v;
	env.HOME = HOME;
	env.NEURASTREAM_NOW = String(NOW6);
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "incident", ...args], { encoding: "utf8", env, cwd: TOY });
	return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

// Day boundaries follow the machine TZ, which differs between this process and the CLI child
// near midnight: parse the id the CLI itself reports instead of recomputing the date here.
let cliId1 = "";

test("CLI add records with source main and dedupes a repeat; list --json shows the record", () => {
	const r = incidentCli(["add", "cli-found bug", "--kind", "cli-kind", "--evidence", "ev"]);
	expect(r.code).toBe(0);
	cliId1 = /I-\d{8}-\d+/.exec(r.out)?.[0] ?? "";
	expect(cliId1).toMatch(/^I-\d{8}-1$/);
	expect(r.out).toContain(`${cliId1} recorded (open) [main/cli-kind]: cli-found bug`);
	const j = incidentCli(["list", "--json"]);
	expect(j.code).toBe(0);
	const views = JSON.parse(j.out) as { id: string; source: string; evidence: string; resolution: string | null }[];
	const mine = views.filter(v => v.id === cliId1);
	expect(mine).toHaveLength(1);
	expect(mine[0]).toMatchObject({ source: "main", evidence: "ev", resolution: null });
	const again = incidentCli(["add", "cli-found bug", "--kind", "cli-kind"]);
	expect(again.code).toBe(0);
	expect(again.out).toContain(`${cliId1} already open`);
	expect(again.out).toContain("x2");
});

test("CLI list --open filters, dismiss refuses an empty why and closes with a real one", () => {
	const empty = incidentCli(["dismiss", cliId1, "--why", ""]);
	expect(empty.code).toBe(1);
	expect(empty.err).toContain("refused");
	const open = incidentCli(["list", "--open"]);
	expect(open.code).toBe(0);
	expect(open.out).toContain(`${cliId1} OPEN [main/cli-kind] x2 cli-found bug`);
	const ok = incidentCli(["dismiss", cliId1, "--why", "same as an older closed report"]);
	expect(ok.code).toBe(0);
	expect(incidentCli(["list", "--open"]).out).not.toContain(cliId1);
	expect(incidentCli(["list"]).out).toContain(`${cliId1} DISMISSED [main/cli-kind] x2 cli-found bug`);
});

test("CLI plan records a listed citing plan and refuses a second resolution", () => {
	const r = incidentCli(["add", "cli plan bug", "--kind", "k"]);
	expect(r.code).toBe(0);
	const id = /I-\d{8}-\d+/.exec(r.out)?.[0] ?? "";
	expect(id).toBe(cliId1.replace(/-\d+$/, m => `-${Number(m.slice(1)) + 1}`));
	const plan = join(TOY, "docs/plans/20261020_fix.md");
	const missing = incidentCli(["plan", id, join(TOY, "docs/plans/ghost.md")]);
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("plan file not found");
	writeFileSync(plan, `# Fix\n\nINCIDENT ${id}\n`);
	const ok = incidentCli(["plan", id, plan]);
	expect(ok.code).toBe(0);
	expect(ok.out).toContain(`incident ${id}: plan recorded`);
	const again = incidentCli(["plan", id, plan]);
	expect(again.code).toBe(1);
	expect(again.err).toContain("already has a plan record");
});

test("CLI usage errors exit 2", () => {
	expect(incidentCli([]).code).toBe(2);
	expect(incidentCli(["nope"]).code).toBe(2);
	expect(incidentCli(["add"]).code).toBe(2);
	expect(incidentCli(["dismiss", cliId1]).code).toBe(2);
});
