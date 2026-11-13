// Team client (plan 20261027_1305 P3): the remote ClaimStore over HTTP, the chooser that routes
// each plan to the file or the team store, the summary holder and team sync — against an
// in-process server with injected whois, peer, clock and a temp SQLite file (the team-server
// test convention). Guard and CLI requests run through the real request entry (a bun child of
// src/core/team-client.ts), so every HTTP behaviour here is the shipped one; the "other
// member" is a direct test call with the peer header. A stopped server, then a closed port, is
// the outage group at the end: holder() answers the typed Unreachable, never null, and the
// guards fail closed.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter } from "../src/adapters/omp/index.ts";
import type { RunSource, SpawnEvent } from "../src/core/adapter.ts";
import { fileClaimStore, heldByOther, type Unreachable } from "../src/core/claims.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkInject, checkPlanEdit, checkSpawn } from "../src/core/guards.ts";
import { defaultRunner, type CommandRunner } from "../src/core/mr-sweep.ts";
import { isLoopback, startOwnerUi, type OwnerUiServer } from "../src/core/owner-ui.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { parsePlan, queueSummary, refreshQueuePaths, sha } from "../src/core/queue/lib.ts";
import { startTeamServer, teamPlanId, type TeamServer } from "../src/core/team-server.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import type { TeamEntry, TeamView, WireRequest, WireResponse } from "../src/core/team-client.ts";
import { claimStoreFor, postTeamAnswer, pushTeamPlan, remoteClaimStore, remoteStoreFor, resetTeamStores, summaryHolder, syncTeam, teamPlans, teamSummaryLines, teamViews } from "../src/core/team-client.ts";
import { claimCli } from "../src/cli/claim.ts";
import { runTeam } from "../src/cli/team.ts";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "ns-team-client-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const OTH = join(HOME, "projects/oth");
const DOWNR = join(HOME, "projects/downr");
const STATE = join(HOME, ".local/state/queue");
const INDEX = join(AGENT, "INDEX.md");
const LOOPBACK = [127, 0, 0, 1].join(".");
const A_PEER = "100.64.3.1";
const B_PEER = "100.64.3.2";
const A = "ada@example.com";
const B = "bob@example.com";
const ORIGIN = "https://gitlab.com/acme/pm.git";
const NOW = 1_760_000_000;
const SINCE = strftime(NOW, "%H:%M");
const TTL_MIN = 30;

// The 20261020_* stamp grandfathers the toy plans out of the "## Code read by Main" check.
const TEAMH = join(TOY, "docs/plans/20261020_0104_teamh.md");
const PERS = join(OTH, "docs/plans/20261020_0102_pers.md");
const NS = join(TOY, "docs/plans/20261020_0103_ns.md");
const RP = join(TOY, "docs/plans/20261020_0105_rp.md");
const SP = join(TOY, "docs/plans/20261020_0106_sp.md");
const CP = join(TOY, "docs/plans/20261020_0107_cp.md");
const NP2 = join(TOY, "docs/plans/20261020_0111_np2.md");
const SH = join(TOY, "docs/plans/20261020_0112_sh.md");
const RA = join(TOY, "docs/plans/20261020_0108_ra.md");
const RB = join(TOY, "docs/plans/20261020_0109_rb.md");
const TEAMH2 = join(DOWNR, "docs/plans/20261020_0110_teamh2.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const savedId = process.env.NEURASTREAM_MAIN_ID;
const savedNow = process.env.NEURASTREAM_NOW;

const TS: Tailscale = {
	ip4: () => LOOPBACK,
	dnsName: () => "acme.tailnet.ts.net",
	whois: (peer) => {
		// A wrong check order that asks whois about this machine becomes a 500, not a pass.
		if (peer === LOOPBACK || isLoopback(peer)) throw new Error("whois must not run for this machine");
		if (peer === A_PEER) return A;
		if (peer === B_PEER) return B;
		return null;
	},
	logins: () => [A, B],
	state: () => "running",
};

const SERVER_CFG = { team: "acme", admin: A, leader: A, repos: ["gitlab.com/acme/*"], members: [A, B] };

let now = NOW; // the injected clock: the file store reads the env, the server child reads CLOCK_FILE
let PORT = 0;
let serverProc: { kill(): void } | undefined;
let SERVER_URL = "";
let cfg: Config;
const CLOCK_FILE = join(TMP, "server-clock.txt");

/** Moves the injected clock for both sides: the env (file store) and the server child's file. */
function setNow(sec: number): void {
	now = sec;
	process.env.NEURASTREAM_NOW = String(sec);
	writeFileSync(CLOCK_FILE, String(sec));
}

beforeAll(async () => {
	setNow(NOW);
	process.env.NEURASTREAM_MAIN_ID = "main";
	// Three repos: toy's origin matches the acme glob, oth's matches no team, downr's matches
	// the outage group's second team entry (its port is closed).
	const repos: [string, string][] = [
		[TOY, ORIGIN],
		[OTH, "https://gitlab.com/other/pm.git"],
		[DOWNR, "https://gitlab.com/down/pm.git"],
	];
	for (const [repo, origin] of repos) {
		mkdirSync(join(repo, "docs/plans"), { recursive: true });
		mkdirSync(join(repo, "src"), { recursive: true });
		spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		spawnSync("git", ["remote", "add", "origin", origin], { cwd: repo });
		writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
	}
	for (const d of [join(AGENT, "blockers"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE]) mkdirSync(d, { recursive: true });
	writeFileSync(join(AGENT, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n- `glm`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	const noPush = join(AGENT, "blockers/no-push");
	writeFileSync(noPush, readFileSync(join(ROOT, "blockers/no-push"), "utf8").replace("../src/core/blockers.ts", join(ROOT, "src/core/blockers.ts")));
	chmodSync(noPush, 0o755);
	// The team server runs in its own process: the client is synchronous (one spawnSync child per
	// request), so a server inside this process would block on its own request. It answers only
	// the loopback address and reads the injected clock from CLOCK_FILE.
	const serverChild = join(TMP, "server-child.ts");
	writeFileSync(
		serverChild,
		`import { readFileSync } from "node:fs";
import { startTeamServer } from ${JSON.stringify(join(ROOT, "src", "core", "team-server.ts"))};
const [clockFile, dbPath] = process.argv.slice(2);
const A = ${JSON.stringify(A)}, B = ${JSON.stringify(B)};
const A_PEER = ${JSON.stringify(A_PEER)}, B_PEER = ${JSON.stringify(B_PEER)};
const svc = startTeamServer({
	tailscale: {
		ip4: () => ${JSON.stringify(LOOPBACK)},
		dnsName: () => "acme.tailnet.ts.net",
		whois: (peer: string) => (peer === A_PEER ? A : peer === B_PEER ? B : null),
		logins: () => [A, B],
		state: () => "running",
	},
	config: { team: "acme", admin: A, leader: A, repos: ["gitlab.com/acme/*"], members: [A, B] },
	dbPath: dbPath!,
	port: 0,
	hostname: ${JSON.stringify(LOOPBACK)},
	peerOf: (req: Request) => req.headers.get("x-test-peer") ?? A_PEER,
	clock: () => Number(readFileSync(clockFile!, "utf8")),
	claimTtlMin: ${TTL_MIN},
});
console.log(svc.port);
`,
	);
	const proc = Bun.spawn([process.execPath, serverChild, CLOCK_FILE, join(TMP, "server.sqlite")], { stdout: "pipe", stderr: "pipe" });
	serverProc = proc;
	const reader = proc.stdout.getReader();
	const first = await reader.read();
	await reader.cancel();
	PORT = Number(new TextDecoder().decode(first.value).trim());
	SERVER_URL = `http://${LOOPBACK}:${PORT}`;
	cfg = loadConfig({ file: writeCfg([{ name: "acme", server: SERVER_URL, repos: ["gitlab.com/acme/*"] }]), home: HOME, env: {} });
	applyQueueEnv(cfg);
});

beforeEach(() => {
	// The remote-store memo lives exactly one process; scenarios must not inherit a down mark.
	resetTeamStores();
	setNow(NOW);
	rmSync(join(STATE, "team"), { recursive: true, force: true });
	rmSync(join(STATE, "claims"), { recursive: true, force: true });
});

afterAll(() => {
	serverProc?.kill();
	if (savedId === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = savedId;
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});

// --- helpers ---

function configYaml(teams: TeamEntry[]): string {
	return `paths:
  home: "${HOME}"
  work_roots: ["${TOY}", "${OTH}", "${DOWNR}"]
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
  plan: false
  agents: []
teams:
${teams.map((t) => `  - name: ${t.name}\n    server: "${t.server}"\n    repos: [${t.repos.map((r) => JSON.stringify(r)).join(", ")}]`).join("\n")}
`;
}

const CONFIG_FILE = join(HOME, ".config/neurastream/config.yml");

/** Writes the sandbox config (loadConfig takes a path, not text) and answers its path. */
function writeCfg(teams: TeamEntry[]): string {
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	writeFileSync(CONFIG_FILE, configYaml(teams));
	return CONFIG_FILE;
}

function cfgWith(teams: TeamEntry[]): Config {
	return loadConfig({ file: writeCfg(teams), home: HOME, env: {} });
}

function planText(file: string, extra = "", header = ""): string {
	return `# Toy plan
${header}
Worktree: -
Branch: feat/toy

## Goal
- Team client toy.

## Forbidden
- Never skip tests.
- Never push.

## Blockers
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

- Call budget: 100 tool calls.
- Plan file: ${file}

## Progress
Status: open

- Started.${extra}
`;
}

function writePlan(file: string, extra = "", header = ""): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, planText(file, extra, header));
}

let note = 0;
/** A fresh Progress entry so the plan gate's new-progress rule passes for the next spawn. */
function refresh(file: string, header = "Queue: team"): void {
	note++;
	writePlan(file, `\n- note ${note}: more progress. Findings: none.`, header);
}

function indexPlans(...files: string[]): void {
	writeFileSync(INDEX, `${files.filter(Boolean).join("\n")}\n`);
}

function spawnEv(file: string): SpawnEvent {
	return { agent: "toy-worker", invocationKind: "task", brief: `Work ${file} on P1`, runningJobs: [] };
}

/**
 * The spawn gates' runner: real git (local, fast) and no forge CLI, so the open-MR check skips
 * instead of reaching the network — these tests are about claims, not about MR sweeps.
 */
const gateRun: CommandRunner = (args, opts) =>
	args[0] === "git" ? defaultRunner(args, opts) : { code: 127, stdout: "", stderr: "missing", missing: true };

/** The share tests' runner: real git, and a forge CLI that lists no open MRs, so the same-goal check sees none. */
const shareRun: CommandRunner = (args, opts) => (args[0] === "git" ? defaultRunner(args, opts) : { code: 0, stdout: "[]", stderr: "" });

/** The file claim store the guards used before P3, pointed at this sandbox. */
function claims() {
	return fileClaimStore(STATE, () => nowSec(), TTL_MIN);
}

function claimFileOf(file: string): string {
	return join(STATE, "claims", `${createHash("sha256").update(file).digest("hex")}.json`);
}

/** The sandbox repo a plan file lives in, and that repo's origin (the server's remote). */
function repoOf(file: string): string {
	return [TOY, OTH, DOWNR].find((dir) => file.startsWith(`${dir}/`)) ?? TOY;
}

function originOf(file: string): string {
	return { [TOY]: ORIGIN, [OTH]: "https://gitlab.com/other/pm.git", [DOWNR]: "https://gitlab.com/down/pm.git" }[repoOf(file)]!;
}

function relOf(file: string): string {
	return file.slice(repoOf(file).length + 1);
}

function idOf(file: string): string {
	const id = teamPlanId(originOf(file), relOf(file));
	if (!id) throw new Error("origin did not parse");
	return id;
}

function capture(fn: () => unknown): { rc: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	try {
		const rc = fn();
		return { rc: typeof rc === "number" ? rc : 0, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

interface Reply {
	status: number;
	body: Record<string, unknown>;
}

/** A direct request as a tailnet peer (the "other member"); no child process involved. */
function call(method: string, path_: string, peer: string, body?: unknown): Promise<Reply> {
	const host = `${LOOPBACK}:${PORT}`;
	const headers: Record<string, string> = { host, "x-test-peer": peer };
	let payload: string | undefined;
	if (typeof body === "string") payload = body;
	else if (body !== undefined) payload = JSON.stringify(body);
	if (method !== "GET") headers.origin = `http://${host}`;
	if (payload !== undefined) headers["content-type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const req = request({ host: LOOPBACK, port: PORT, method, path: path_, headers }, (res) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

async function dropClaim(file: string, peer: string): Promise<void> {
	await call("DELETE", `/claims/${idOf(file)}`, peer, { main: "main" }).catch(() => {});
}

/** The server's audit routes, oldest first (admin A reads them). */
async function auditRoutes(): Promise<string[]> {
	const res = await call("GET", "/audit", A_PEER);
	return (res.body.audit as { route: string }[]).map((r) => r.route);
}

interface SpySend {
	send: (req: WireRequest) => WireResponse | null;
	calls: WireRequest[];
}

/** A counting send seam: every request the client makes through it is recorded here. */
function spySend(reply: WireResponse | null = { status: 200, body: {} }): SpySend {
	const calls: WireRequest[] = [];
	return {
		calls,
		send: (req) => {
			calls.push(req);
			return reply === null ? { error: "stubbed outage" } : { status: reply.status, body: reply.body };
		},
	};
}

/** The record for team `name` with one entry mapping `file` to itself. */
function plantRecord(name: string, file: string, entrySha = "deadbeef"): void {
	mkdirSync(join(STATE, "team", name), { recursive: true });
	writeFileSync(join(STATE, "team", name, "record.json"), JSON.stringify({ [idOf(file)]: { path: file, sha: entrySha } }));
}

function readRecord(name: string): Record<string, { path: string; sha: string }> {
	return JSON.parse(readFileSync(join(STATE, "team", name, "record.json"), "utf8")) as Record<string, { path: string; sha: string }>;
}

const DOWN_PORT = "http://127.0.0.1:1"; // a port nothing listens on: every connection is refused
const DOWN_TEAM: TeamEntry = { name: "down", server: DOWN_PORT, repos: ["gitlab.com/down/*"] };

// --- chooser and records ---

test("a personal plan is never sent to the team server (spy on the request entry)", () => {
	writePlan(PERS);
	indexPlans(PERS);
	refresh(PERS, "");
	const spy = spySend();
	remoteStoreFor(cfg.teams[0]!, cfg, { send: spy.send });
	expect(checkSpawn(spawnEv(PERS), cfg, gateRun)).toMatchObject({ allow: true });
	expect(spy.calls).toEqual([]);
	// The claim landed in the file store.
	expect(existsSync(claimFileOf(PERS))).toBe(true);
	claims().release(PERS, "main");
});

test("the chooser runs no git for INDEX.md, a non-plan path or a personal plan, and one for a Queue: team plan", () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(PERS);
	const calls: string[][] = [];
	const run: CommandRunner = (args) => {
		calls.push(args);
		return { code: 0, stdout: `${ORIGIN}\n`, stderr: "" };
	};
	expect(claimStoreFor(INDEX, cfg, undefined, run) === remoteStoreFor(cfg.teams[0]!, cfg)).toBe(false);
	expect(calls).toEqual([]);
	expect(claimStoreFor(join(HOME, "notes/other.txt"), cfg, undefined, run) === remoteStoreFor(cfg.teams[0]!, cfg)).toBe(false);
	expect(calls).toEqual([]);
	expect(claimStoreFor(PERS, cfg, undefined, run) === remoteStoreFor(cfg.teams[0]!, cfg)).toBe(false);
	expect(calls).toEqual([]);
	const store = claimStoreFor(TEAMH, cfg, undefined, run);
	expect(calls).toEqual([["git", "-C", TOY, "remote", "get-url", "origin"]]);
	// The team plan goes to the team's own store from the module map.
	expect(store === remoteStoreFor(cfg.teams[0]!, cfg)).toBe(true);
});

test("a team-repo plan that was never synced and has no header sends no request", () => {
	writePlan(NS);
	indexPlans(NS);
	refresh(NS, "");
	const spy = spySend();
	remoteStoreFor(cfg.teams[0]!, cfg, { send: spy.send });
	expect(checkSpawn(spawnEv(NS), cfg, gateRun)).toMatchObject({ allow: true });
	expect(spy.calls).toEqual([]);
	claims().release(NS, "main");
});

test("a synced team plan whose header was stripped on disk is claimed on the server at spawn and refused while login B holds it", async () => {
	writePlan(RP);
	indexPlans(RP);
	await dropClaim(RP, A_PEER);
	// share records the plan (the record maps the id to the repo path) and pushes it.
	expect(capture(() => runTeam(["share", RP], { cfg, run: shareRun })).rc).toBe(0);
	expect(Object.values(readRecord("acme"))).toEqual([{ path: RP, sha: sha(readFileSync(RP, "utf8")) }]);
	// B holds the plan on the server; the stripped header must not hand it to the file store.
	expect((await call("POST", `/claims/${idOf(RP)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	writePlan(RP); // the header is gone from disk
	refresh(RP, "");
	const refused = checkSpawn(spawnEv(RP), cfg, gateRun);
	expect(refused.allow).toBe(false);
	expect(refused.reason).toContain(`plan ${RP} is held by another member's Main main since ${SINCE}`);
	expect(existsSync(claimFileOf(RP))).toBe(false);
	// Free again: the spawn claims on the server — no claim file, the server row is this login's.
	await dropClaim(RP, B_PEER);
	refresh(RP, "");
	expect(checkSpawn(spawnEv(RP), cfg, gateRun)).toMatchObject({ allow: true });
	const held = await call("GET", `/claims/${idOf(RP)}`, A_PEER);
	expect((held.body.claim as { login: string } | null)?.login).toBe(A);
	expect(existsSync(claimFileOf(RP))).toBe(false);
	await dropClaim(RP, A_PEER);
});

// --- team sync ---

test("team sync pulls into the read copy and the record, and the push sends the base sha", async () => {
	writePlan(SP, "", "Queue: team");
	const v1 = "# SP v1\nQueue: team\n\n## Goal\n- one\n";
	expect((await call("PUT", `/plans/${idOf(SP)}`, B_PEER, { remote: ORIGIN, rel_path: relOf(SP), text: v1, base_sha: null })).status).toBe(200);
	expect(syncTeam(cfg.teams[0]!, cfg)).toBe(0);
	const copy = join(STATE, "team/acme/plans", `${idOf(SP)}.md`);
	expect(readFileSync(copy, "utf8")).toBe(v1);
	expect(readRecord("acme")[idOf(SP)]).toEqual({ path: copy, sha: sha(v1) });
	// The local repo plan differs from the pulled sha: the push sends base = the record sha and wins.
	refresh(SP);
	indexPlans(SP);
	expect(syncTeam(cfg.teams[0]!, cfg)).toBe(0);
	const updated = await call("GET", `/plans/${idOf(SP)}`, A_PEER);
	expect(updated.body.sha).toBe(sha(readFileSync(SP, "utf8")));
	expect(await auditRoutes()).toContain(`PUT /plans/${idOf(SP)}`);
});

test("a 409 with a sha pulls that id, keeps the local file and prints the conflict line", async () => {
	writePlan(CP);
	expect(capture(() => runTeam(["share", CP, "--distinct", "fixture plans share one toy goal"], { cfg, run: shareRun })).rc).toBe(0);
	const local = readFileSync(CP, "utf8");
	const v2 = `${local}\n- B edited this.\n`;
	expect((await call("PUT", `/plans/${idOf(CP)}`, B_PEER, { remote: ORIGIN, rel_path: relOf(CP), text: v2, base_sha: sha(local) })).status).toBe(200);
	// The local edit stays; the record still names sha(local), so the PUT carries a stale base.
	const got = capture(() => pushTeamPlan(cfg.teams[0]!, cfg, CP));
	expect(got.out).toContain(`team sync: ${CP} conflict: the server has a newer version (${sha(v2)}); merge it and run team sync again`);
	expect(readFileSync(CP, "utf8")).toBe(local);
	expect(readRecord("acme")[idOf(CP)]!.sha).toBe(sha(v2));
});

test("a 409 with sha null keeps the local file, prints the conflict line and pulls nothing", () => {
	writePlan(NP2, "", "Queue: team");
	plantRecord("acme", NP2);
	const local = readFileSync(NP2, "utf8");
	const got = capture(() => pushTeamPlan(cfg.teams[0]!, cfg, NP2));
	expect(got.out).toContain(`team sync: ${NP2} conflict: the server has a newer version (null); merge it and run team sync again`);
	expect(readFileSync(NP2, "utf8")).toBe(local);
	expect(readRecord("acme")[idOf(NP2)]).toEqual({ path: NP2, sha: "deadbeef" });
});

test("the record survives two overlapping sync pushes (the lock serializes them)", async () => {
	writePlan(RA, "", "Queue: team");
	writePlan(RB, "", "Queue: team");
	const child = join(TMP, "sync-child.ts");
	writeFileSync(
		child,
		`import { loadConfig } from ${JSON.stringify(join(ROOT, "src", "core", "config.ts"))};
import { pushTeamPlan } from ${JSON.stringify(join(ROOT, "src", "core", "team-client.ts"))};
const [cfgFile, plan] = process.argv.slice(2);
const cfg = loadConfig({ file: cfgFile!, home: ${JSON.stringify(HOME)}, env: {} });
pushTeamPlan(cfg.teams[0]!, cfg, plan!);
`,
	);
	const a = Bun.spawn([process.execPath, child, CONFIG_FILE, RA], { stdout: "pipe", stderr: "pipe" });
	const b = Bun.spawn([process.execPath, child, CONFIG_FILE, RB], { stdout: "pipe", stderr: "pipe" });
	expect(await a.exited).toBe(0);
	expect(await b.exited).toBe(0);
	expect(readRecord("acme")[idOf(RA)]).toEqual({ path: RA, sha: sha(readFileSync(RA, "utf8")) });
	expect(readRecord("acme")[idOf(RB)]).toEqual({ path: RB, sha: sha(readFileSync(RB, "utf8")) });
});

test("team share pushes the plan once, and a second share pushes nothing", async () => {
	writePlan(SH); // no header yet: share writes it and uploads
	const before = (await auditRoutes()).filter((r) => r === `PUT /plans/${idOf(SH)}`).length;
	expect(capture(() => runTeam(["share", SH, "--distinct", "fixture plans share one toy goal"], { cfg, run: shareRun })).rc).toBe(0);
	expect((await auditRoutes()).filter((r) => r === `PUT /plans/${idOf(SH)}`).length).toBe(before + 1);
	expect(capture(() => runTeam(["share", SH], { cfg })).out).toContain(`team share: ${SH} already Queue: team`);
	expect((await auditRoutes()).filter((r) => r === `PUT /plans/${idOf(SH)}`).length).toBe(before + 1);
});

// --- summary holder ---

function teamRow(file: string, login: string): Record<string, unknown> {
	return { id: idOf(file), main: "main", host: "laptop", pid: 4242, since: NOW, beat: NOW, login, mine: login === A };
}

/** Puts the plan on the server as `peer`: P2b stores a claim only for a plan the server holds. */
async function publish(file: string, peer = A_PEER, text = readFileSync(file, "utf8")): Promise<void> {
	const remote = originOf(file);
	const rel = relOf(file);
	const got = await call("GET", `/plans/${idOf(file)}`, peer);
	const base = got.status === 200 && typeof got.body.sha === "string" ? got.body.sha : null;
	const put = await call("PUT", `/plans/${idOf(file)}`, peer, { remote, rel_path: rel, text, base_sha: base });
	if (put.status === 200) return;
	// A writer moved the sha between the read and the put: one re-read, then it must stick.
	const again = await call("GET", `/plans/${idOf(file)}`, peer);
	const retry = await call("PUT", `/plans/${idOf(file)}`, peer, { remote, rel_path: rel, text, base_sha: again.status === 200 && typeof again.body.sha === "string" ? again.body.sha : null });
	if (retry.status !== 200) throw new Error(`publish ${file} failed (${retry.status})`);
}

test("one queueSummary with two team plans and one personal plan sends exactly one GET /claims", async () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(SH, "", "Queue: team");
	writePlan(PERS);
	indexPlans(TEAMH, SH, PERS);
	await dropClaim(TEAMH, A_PEER);
	// B holds TEAMH on the server; SH is free; PERS is a personal plan of another repo.
	await publish(TEAMH, B_PEER);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	const spy = spySend({ status: 200, body: { claims: [teamRow(TEAMH, B)] } });
	const summary = queueSummary(INDEX, [], summaryHolder(cfg, { send: spy.send }));
	expect(spy.calls.filter((c) => c.method === "GET" && c.url.endsWith("/claims")).length).toBe(1);
	expect(summary).toContain(`1. ${TEAMH} [open, 0/1 done, held by main since ${SINCE}]`);
	expect(summary).toContain(`2. ${SH} [open, 0/1 done, free]`);
	expect(summary).toContain(`3. ${PERS} [open, 0/1 done, free]`);
	await dropClaim(TEAMH, B_PEER);
});

test("a never-synced Queue: team plan held on the server shows that holder in the summary, not free", async () => {
	writePlan(TEAMH, "", "Queue: team");
	indexPlans(TEAMH);
	await dropClaim(TEAMH, A_PEER);
	await publish(TEAMH, B_PEER);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	// TEAMH has no record entry: the summary answers by the id computed from the repo origin.
	const summary = queueSummary(INDEX, [], summaryHolder(cfg));
	expect(summary).toContain(`1. ${TEAMH} [open, 0/1 done, held by main since ${SINCE}]`);
	await dropClaim(TEAMH, B_PEER);
});

// --- login-aware holder sites (both Mains on the default id) ---

test("login B's hold refuses A's edit gate, spawn, unshare, next and sync push", async () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(PERS);
	indexPlans(TEAMH, PERS);
	await dropClaim(TEAMH, A_PEER);
	await publish(TEAMH, B_PEER);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	// Edit gate: A's edit is restored.
	const before = readFileSync(TEAMH, "utf8");
	const edit = checkPlanEdit({ path: TEAMH, before, after: `${before}\n- A note.\n`, agent: "main" }, cfg);
	expect(edit.allow).toBe(false);
	expect(edit.reason).toContain(`plan ${TEAMH} is held by another member's Main main since ${SINCE}`);
	expect(edit.restore?.text).toBe(before);
	// Spawn gate.
	const spawn = checkSpawn(spawnEv(TEAMH), cfg, gateRun);
	expect(spawn.allow).toBe(false);
	expect(spawn.reason).toContain(`plan ${TEAMH} is held by another member's Main main since ${SINCE}`);
	// team unshare exits 1, header unchanged.
	const unshare = capture(() => runTeam(["unshare", TEAMH], { cfg }));
	expect(unshare.rc).toBe(1);
	expect(readFileSync(TEAMH, "utf8")).toContain("Queue: team");
	// claim next skips the held team plan and takes the personal one.
	refresh(PERS, "");
	const next = capture(() => claimCli(["next"], cfg));
	expect(next.rc).toBe(0);
	expect(next.out).toContain(`claim: ${PERS} for Main main since ${SINCE}`);
	claims().release(PERS, "main");
	indexPlans(TEAMH);
	const nextOnly = capture(() => claimCli(["next"], cfg));
	expect(nextOnly.rc).toBe(1);
	expect(nextOnly.err).toContain("or their team server is unreachable");
	// The sync sends no PUT for A's local edit (counted server-side: only writes are audited).
	indexPlans(TEAMH);
	refresh(TEAMH);
	const routesBefore = (await auditRoutes()).filter((r) => r === `PUT /plans/${idOf(TEAMH)}`).length;
	const synced = capture(() => syncTeam(cfg.teams[0]!, cfg));
	expect(synced.out).toContain(`team sync: ${TEAMH} not pushed: held by another member's Main`);
	expect((await auditRoutes()).filter((r) => r === `PUT /plans/${idOf(TEAMH)}`).length).toBe(routesBefore);
	await dropClaim(TEAMH, B_PEER);
});

test("a claim of this login on another main refuses this Main's spawn; release needs --force and then frees", async () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(PERS);
	indexPlans(TEAMH);
	await dropClaim(TEAMH, A_PEER);
	await publish(TEAMH, A_PEER);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, A_PEER, { main: "m2", host: "laptop", pid: 4242 })).status).toBe(200);
	const spawn = checkSpawn(spawnEv(TEAMH), cfg, gateRun);
	expect(spawn.allow).toBe(false);
	expect(spawn.reason).toContain(`plan ${TEAMH} is held by Main m2 since ${SINCE}`);
	expect(spawn.reason).not.toContain("another member");
	const noForce = capture(() => claimCli(["release", TEAMH], cfg));
	expect(noForce.rc).toBe(1);
	expect(noForce.err).toContain(`claim: ${TEAMH} is held by Main m2 since ${SINCE}`);
	expect(capture(() => claimCli(["release", TEAMH, "--force"], cfg)).rc).toBe(0);
	expect((await call("GET", `/claims/${idOf(TEAMH)}`, A_PEER)).body.claim).toBeNull();
	// A file claim has no `mine`: with the same main string it is still this Main's.
	claims().claim(PERS, "main");
	expect(heldByOther(claims().holder(PERS), "main")).toBe(false);
	claims().release(PERS, "main");
});

test("the team store's list() returns local paths and drops ids with no recorded path", async () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(SH, "", "Queue: team");
	indexPlans(TEAMH, SH);
	await dropClaim(TEAMH, A_PEER);
	await dropClaim(SH, A_PEER);
	await publish(SH, A_PEER);
	await publish(TEAMH, B_PEER);
	// SH is recorded (the record maps its id to the repo path); TEAMH is not recorded.
	plantRecord("acme", SH);
	expect((await call("POST", `/claims/${idOf(SH)}`, A_PEER, { main: "main", host: "laptop", pid: process.pid })).status).toBe(200);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	const list = remoteStoreFor(cfg.teams[0]!, cfg).list();
	expect("unreachable" in list).toBe(false);
	if (!("unreachable" in list)) {
		expect(list.map((c) => c.plan)).toEqual([SH]); // TEAMH's unrecorded id is dropped
		expect(list[0]!.mine).toBe(true);
	}
	await dropClaim(SH, A_PEER);
	await dropClaim(TEAMH, B_PEER);
});

// --- outage: a stopped server, then a closed port ---

test("holder() answers the typed Unreachable, never null, when the server is down", async () => {
	writePlan(TEAMH, "", "Queue: team");
	const stopped: TeamServer = startTeamServer({
		tailscale: TS,
		config: SERVER_CFG,
		dbPath: join(TMP, "outage.sqlite"),
		port: 0,
		hostname: LOOPBACK,
		peerOf: (req) => req.headers.get("x-test-peer") ?? A_PEER,
		clock: () => now,
		claimTtlMin: TTL_MIN,
	});
	const downTeam: TeamEntry = { name: "acme", server: `http://${LOOPBACK}:${stopped.port}`, repos: ["gitlab.com/acme/*"] };
	stopped.stop();
	const store = remoteClaimStore(downTeam, STATE);
	const h = store.holder(TEAMH) as Unreachable;
	expect(h.unreachable).toBe(downTeam.server);
	expect(store.heartbeat(TEAMH, "main")).toBe(false);
	expect((store.list() as Unreachable).unreachable).toBe(downTeam.server);
});

test("the outage: the edit gate restores with the unreachable text and claimGate refuses leaving no claim", () => {
	writePlan(TEAMH2, "", "Queue: team"); // TEAMH2 lives in DOWNR: its header routes to the down team
	const cfgDown = cfgWith([cfg.teams[0]!, DOWN_TEAM]);
	applyQueueEnv(cfgDown);
	indexPlans(TEAMH2);
	const before = readFileSync(TEAMH2, "utf8");
	const edit = checkPlanEdit({ path: TEAMH2, before, after: `${before}\n- A note.\n`, agent: "main" }, cfgDown);
	expect(edit.allow).toBe(false);
	expect(edit.reason).toContain(`team server ${DOWN_PORT} unreachable`);
	expect(edit.restore?.text).toBe(before);
	const spawn = checkSpawn(spawnEv(TEAMH2), cfgDown, gateRun);
	expect(spawn.allow).toBe(false);
	expect(spawn.reason).toContain(`team server ${DOWN_PORT} unreachable; plan ${TEAMH2} is refused until it answers`);
	expect(existsSync(claimFileOf(TEAMH2))).toBe(false);
});

test("the outage: claim next skips, release and unshare exit 1, the summary flags the team plan", () => {
	writePlan(TEAMH2, "", "Queue: team");
	writePlan(PERS);
	const cfgDown = cfgWith([cfg.teams[0]!, DOWN_TEAM]);
	applyQueueEnv(cfgDown);
	indexPlans(TEAMH2);
	const next = capture(() => claimCli(["next"], cfgDown));
	expect(next.rc).toBe(1);
	expect(next.err).toContain("or their team server is unreachable");
	const release = capture(() => claimCli(["release", TEAMH2], cfgDown));
	expect(release.rc).toBe(1);
	expect(release.err).toContain(`claim: team server ${DOWN_PORT} unreachable`);
	const unshare = capture(() => runTeam(["unshare", TEAMH2], { cfg: cfgDown }));
	expect(unshare.rc).toBe(1);
	expect(unshare.err).toContain(`team unshare: team server ${DOWN_PORT} unreachable`);
	expect(readFileSync(TEAMH2, "utf8")).toContain("Queue: team");
	// The queue summary flags the team plan unreachable and prints the personal plan as today.
	indexPlans(TEAMH2, PERS);
	const summary = queueSummary(INDEX, [], summaryHolder(cfgDown));
	expect(summary).toContain(`1. ${TEAMH2} [open, 0/1 done, team server ${DOWN_PORT} unreachable]`);
	expect(summary).toContain(`2. ${PERS} [open, 0/1 done, free]`);
});

test("the outage between holder() and claim(): claimGate refuses and releases the claim it took", () => {
	const TQ = join(DOWNR, "docs/plans/20261020_0113_tq.md");
	writePlan(TEAMH2, "", "Queue: team");
	writePlan(TQ, "", "Queue: team");
	refresh(TEAMH2, "Queue: team");
	refresh(TQ, "Queue: team");
	indexPlans(TEAMH2, TQ);
	const cfgDown = cfgWith([cfg.teams[0]!, DOWN_TEAM]);
	applyQueueEnv(cfgDown);
	// The stub answers the first plan's holder() and claim(), then refuses every later request:
	// the outage starts between holder() and claim() for the second plan.
	const seen: WireRequest[] = [];
	let up = true;
	const stub = (req: WireRequest): WireResponse | null => {
		seen.push(req);
		if (!up) return { error: "connection lost" };
		if (req.method === "GET") return { status: 200, body: { claim: null } };
		up = false;
		return { status: 200, body: { claim: { plan: idOf(TEAMH2), main: "main", host: "laptop", pid: 4242, since: NOW, beat: NOW, mine: true } } };
	};
	remoteStoreFor(DOWN_TEAM, cfgDown, { send: stub });
	const mixed = checkSpawn(
		{ agent: "toy-worker", invocationKind: "task", brief: `Work ${TEAMH2} and ${TQ} on P1`, runningJobs: [] },
		cfgDown,
		gateRun,
	);
	expect(mixed.allow).toBe(false);
	expect(mixed.reason).toContain(`team server ${DOWN_PORT} unreachable; plan ${TQ} is refused until it answers`);
	// The claim the call took for TEAMH2 was released through the store that took it: no claim
	// file exists, and the release sent nothing (the team is marked down for the process), so the
	// server claim stays until the TTL — the designed fail-closed outcome.
	expect(existsSync(claimFileOf(TEAMH2))).toBe(false);
	expect(existsSync(claimFileOf(TQ))).toBe(false);
	expect(seen.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
});

test("a fresh team claim is released through the remote store that took it, never the file store", () => {
	const TQ = join(DOWNR, "docs/plans/20261020_0113_tq.md");
	writePlan(TEAMH2, "", "Queue: team");
	writePlan(TQ, "", "Queue: team");
	refresh(TEAMH2, "Queue: team");
	refresh(TQ, "Queue: team");
	indexPlans(TEAMH2, TQ);
	const cfgDown = cfgWith([cfg.teams[0]!, DOWN_TEAM]);
	applyQueueEnv(cfgDown);
	// The second plan's claim is refused with a 429 (the write limiter): fail closed, and the
	// team is not marked down — so the release of the first plan reaches the wire. Through the
	// file store it would be a silent no-op and the server claim would outlive the refusal.
	const seen: WireRequest[] = [];
	const stub = (req: WireRequest): WireResponse | null => {
		seen.push(req);
		if (req.method === "GET") return { status: 200, body: { claim: null } };
		if (req.url.endsWith(`/claims/${idOf(TEAMH2)}`)) return { status: 200, body: { claim: { plan: idOf(TEAMH2), main: "main", host: "laptop", pid: 4242, since: NOW, beat: NOW, mine: true } } };
		return { status: 429, body: { error: "too many writes" } };
	};
	remoteStoreFor(DOWN_TEAM, cfgDown, { send: stub });
	const mixed = checkSpawn(
		{ agent: "toy-worker", invocationKind: "task", brief: `Work ${TEAMH2} and ${TQ} on P1`, runningJobs: [] },
		cfgDown,
		gateRun,
	);
	expect(mixed.allow).toBe(false);
	expect(mixed.reason).toContain(`team server ${DOWN_PORT} unreachable; plan ${TQ} is refused until it answers`);
	expect(seen.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual([`${DOWN_PORT}/claims/${idOf(TEAMH2)}`]);
	expect(existsSync(claimFileOf(TEAMH2))).toBe(false);
	expect(existsSync(claimFileOf(TQ))).toBe(false);
});

test("a second request within 60 s sends nothing; one after 60 s does (injected clock)", () => {
	let clock = NOW;
	let sends = 0;
	const store = remoteClaimStore(DOWN_TEAM, STATE, {
		clock: () => clock,
		send: () => {
			sends++;
			return { error: "refused" };
		},
	});
	let h = store.holder(TEAMH2);
	expect(h !== null && "unreachable" in h).toBe(true);
	expect(sends).toBe(1);
	h = store.holder(TEAMH2);
	expect(h !== null && "unreachable" in h).toBe(true);
	expect(sends).toBe(1);
	clock = NOW + 61;
	h = store.holder(TEAMH2);
	expect(h !== null && "unreachable" in h).toBe(true);
	expect(sends).toBe(2);
});

// --- heartbeat ---

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
			const results = await Promise.all((handlers.get(event) ?? []).map((cb) => cb(payload, ctx)));
			return results.filter((r) => r !== undefined);
		},
	};
}

function beatCtx(timers: { cb: () => void; ms: number }[]): unknown {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => "team-client-test", getSessionFile: () => join(TMP, "session.jsonl") },
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		shutdown: () => {},
		ui: { notify: () => {}, getEditorText: () => "" },
		setInterval: (cb: () => void, ms: number) => {
			timers.push({ cb, ms });
			return timers;
		},
	};
}

test("one heartbeat tick beats the personal claim through the file store and this login's team claim through the remote store, and no beat for another login's row with the same main", async () => {
	writePlan(TEAMH, "", "Queue: team");
	writePlan(SH, "", "Queue: team");
	writePlan(PERS);
	indexPlans(TEAMH, SH, PERS);
	refresh(PERS, "");
	claims().claim(PERS, "main");
	await dropClaim(TEAMH, A_PEER);
	await dropClaim(SH, A_PEER);
	await dropClaim(SH, B_PEER);
	await publish(SH, A_PEER);
	await publish(TEAMH, B_PEER);
	plantRecord("acme", SH);
	// SH: this login's team claim; TEAMH: another login's row with the same main string.
	expect((await call("POST", `/claims/${idOf(SH)}`, A_PEER, { main: "main", host: "laptop", pid: process.pid })).status).toBe(200);
	expect((await call("POST", `/claims/${idOf(TEAMH)}`, B_PEER, { main: "main", host: "laptop", pid: 4242 })).status).toBe(200);
	const timers: { cb: () => void; ms: number }[] = [];
	const host = fakeHost();
	createOmpAdapter(host as never, cfg);
	await host.emit("session_start", {}, beatCtx(timers));
	const beat = timers.find((t) => t.ms === 60_000);
	expect(beat).toBeTruthy();
	setNow(NOW + 60);
	beat!.cb();
	// The personal claim beat is refreshed in the file store.
	expect(claims().list().find((c) => c.plan === PERS)?.beat).toBe(NOW + 60);
	// This login's team claim is beaten on the server; the other login's row is not.
	const mine = await call("GET", `/claims/${idOf(SH)}`, A_PEER);
	expect((mine.body.claim as { beat: number } | null)?.beat).toBe(NOW + 60);
	const others = await call("GET", `/claims/${idOf(TEAMH)}`, B_PEER);
	expect((others.body.claim as { beat: number } | null)?.beat).toBe(NOW);
	// And no refused beat was audited for the other login's row.
	expect((await auditRoutes()).filter((r) => r.startsWith("refused POST /claims") && r.endsWith("/beat")).length).toBe(0);
	claims().release(PERS, "main");
	await dropClaim(SH, A_PEER);
	await dropClaim(TEAMH, B_PEER);
});

test("with the team server down the tick still beats the personal claim", async () => {
	writePlan(PERS);
	refresh(PERS, "");
	claims().claim(PERS, "main");
	const cfgDown = cfgWith([DOWN_TEAM]);
	applyQueueEnv(cfgDown);
	// The tick's remote list hits the closed port once, memoizes, and the personal beat runs.
	const timers: { cb: () => void; ms: number }[] = [];
	const host = fakeHost();
	createOmpAdapter(host as never, cfgDown);
	await host.emit("session_start", {}, beatCtx(timers));
	const beat = timers.find((t) => t.ms === 60_000);
	expect(beat).toBeTruthy();
	process.env.NEURASTREAM_NOW = String(NOW + 60);
	beat!.cb();
	expect(claims().list().find((c) => c.plan === PERS)?.beat).toBe(NOW + 60);
	claims().release(PERS, "main");
});

// --- the queue view (P4): the server text is every team section's only source ---

const VIEW_REL = "docs/plans/20261020_0104_teamh.md";

/**
 * Team text as it leaves the server, naming paths that exist nowhere here: an absolute blocker
 * the guard could execute elsewhere, and a reuse citation below its own directory.
 */
const VIEW_TEXT = `# Team plan from the server
Summary: server summary

## Goal
- Team goal from the server.

## Forbidden
- Never push.

## Blockers
- \`/nonexistent-team-queue/blocker.sh\`

## Reuse
- new: thing — checked: \`../missing-team-queue.ts:1\` — reuse: nothing

## Phases
- [ ] P1 do it — verify: \`true\`

## Done check
\`true\`

## Progress
Status: open

WAITING on owner: approve the team plan
`;

/** One `GET /view` body: the plan text plus the P2c rows the view carries for it. */
function viewBody(text: string, o: { claim?: string; approvals?: string[]; answers?: { login: string; answer: string }[] } = {}): Record<string, unknown> {
	const id = teamPlanId(ORIGIN, VIEW_REL)!;
	return {
		plans: [{ id, remote: ORIGIN, rel_path: VIEW_REL, sha: sha(text), text, updated_by: B, updated_at: NOW }],
		claims: o.claim ? [{ plan: id, main: "main", host: "laptop", pid: 4242, since: NOW, beat: NOW, login: o.claim, mine: false }] : [],
		approvals: (o.approvals ?? []).map((login) => ({ plan: id, login, time: NOW })),
		votes: [],
		override: null,
		paused: [],
		answers: (o.answers ?? []).map((a, i) => ({ id: i + 1, plan: id, login: a.login, time: NOW, sha: sha(text), answer: a.answer })),
		first: [],
		me_paused: false,
	};
}

test("team rows come from the view text: the blocker path and the ../ reuse citation are never stat'ed", () => {
	const body = viewBody(VIEW_TEXT, { claim: B, approvals: [A, B], answers: [{ login: B, answer: "yes" }] });
	const [row] = teamPlans(cfg, cfg.teams[0]!, body as unknown as TeamView);
	expect(row!.relPath).toBe(VIEW_REL);
	expect(row!.file).toBe(join(STATE, "team/acme/plans", `${row!.id}.md`));
	expect(existsSync(row!.file)).toBe(false);
	expect(row!.plan.title).toBe("Team plan from the server");
	expect(row!.plan.summary).toBe("server summary");
	expect(row!.plan.waitingLine).toBe("approve the team plan");
	expect(row!.plan.blockers).toEqual([]);
	expect(row!.plan.errors.join("\n")).not.toContain("nonexistent-team-queue");
	// A team-chosen worktree and appliesTo never reach code that stats or runs git.
	expect(row!.plan.worktree).toBeNull();
	expect(row!.plan.appliesTo).toEqual([]);
	expect(row!.holder).toMatchObject({ main: "main", login: B });
	expect(row!.approvals).toEqual([A, B]);
	expect(row!.answers.map((a) => a.answer)).toEqual(["yes"]);
	// The sixth argument itself, with a reviewer list so the reuse gate would run: false means
	// neither path is touched; today's five arguments report both.
	const dir = join(STATE, "team/acme/plans");
	const gated = parsePlan(dir, join(dir, "x.md"), VIEW_TEXT, undefined, ["reviewer"], false);
	expect(gated.blockers).toEqual([]);
	expect(gated.errors.join("\n")).not.toContain("nonexistent-team-queue");
	expect(gated.errors.join("\n")).not.toContain("missing-team-queue");
	const local = parsePlan(dir, join(dir, "x.md"), VIEW_TEXT, undefined, ["reviewer"]);
	expect(local.blockers.length).toBe(1);
	expect(local.errors.join("\n")).toContain("nonexistent-team-queue/blocker.sh");
	expect(local.errors.join("\n")).toContain("missing-team-queue.ts");
});

test("the team summary lists a view plan by rel_path with its holder and approvals, and a down team prints one line", () => {
	const body = viewBody(VIEW_TEXT, { claim: B, approvals: [A, B] });
	const views = teamViews(cfg, { send: () => ({ status: 200, body }) });
	expect(views.get("acme")).not.toHaveProperty("unreachable");
	const lines = teamSummaryLines(cfg, views);
	expect(lines[0]).toBe("Team acme: 1 plan(s)");
	expect(lines[1]).toContain(`T1. ${VIEW_REL} [held by main (${B}) since ${SINCE}, WAITING on owner: approve the team plan, approved by ${A}, ${B}]`);
	expect(lines[1]).toContain("Team goal from the server.");
	// A 200 whose body is not the view is Unreachable, as list() answers its own read.
	expect(teamViews(cfg, { send: () => ({ status: 200, body: { plans: [] } }) }).get("acme")).toEqual({ unreachable: SERVER_URL });
	// One line for the team that did not answer, no plans, and nothing added to the personal summary.
	const cfgDown = cfgWith([cfg.teams[0]!, DOWN_TEAM]);
	const down = teamViews(cfgDown, { send: (req) => (req.url.startsWith(SERVER_URL) ? { status: 200, body } : { error: "stubbed outage" }) });
	const downLines = teamSummaryLines(cfgDown, down);
	expect(downLines[0]).toBe("Team acme: 1 plan(s)");
	expect(downLines.at(-1)).toBe(`Team down: team server ${DOWN_PORT} unreachable`);
	expect(queueSummary(INDEX, [], summaryHolder(cfgDown, {}, down), Infinity)).not.toContain("Team down");
});

test("checkInject reads one GET /view per team and never GET /claims", async () => {
	// checkInject has no send seam, so the count is read where the requests land: a recorder
	// in another process logs every path and answers the view (the client sends in a child).
	const log = join(TMP, "inject-view.log");
	const child = join(TMP, "view-recorder.ts");
	writeFileSync(
		child,
		`import { appendFileSync } from "node:fs";
const [logFile, viewJson] = process.argv.slice(2);
const view = JSON.parse(viewJson!);
const svc = Bun.serve({
	hostname: ${JSON.stringify(LOOPBACK)},
	port: 0,
	fetch: (req) => {
		appendFileSync(logFile!, req.method + " " + new URL(req.url).pathname + "\\n");
		return Response.json(view);
	},
});
console.log(svc.port);
`,
	);
	const proc = Bun.spawn([process.execPath, child, log, JSON.stringify(viewBody(VIEW_TEXT, { claim: B, approvals: [A] }))], { stdout: "pipe", stderr: "pipe" });
	const reader = proc.stdout.getReader();
	const first = await reader.read();
	await reader.cancel();
	const PORT_REC = Number(new TextDecoder().decode(first.value).trim());
	const recCfg = cfgWith([{ name: "acme", server: `http://${LOOPBACK}:${PORT_REC}`, repos: ["gitlab.com/acme/*"] }]);
	applyQueueEnv(recCfg);
	writePlan(TEAMH, "", "Queue: team");
	indexPlans(TEAMH);
	const d = checkInject({ agent: "main", inject: "what is next" }, recCfg);
	expect(d.inject).toContain("Team acme: 1 plan(s)");
	expect(d.inject).toContain(VIEW_REL);
	expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["GET /view"]);
	proc.kill();
	applyQueueEnv(cfg);
});

test("postTeamAnswer posts the answer alone to the percent-encoded /answer/<id>, and the server stores the caller's login", async () => {
	const spy = spySend({ status: 200, body: { answer: {} } });
	// The route id is percent-encoded, like every other id in a path.
	expect(postTeamAnswer(cfg.teams[0]!, "a/b?c d", "yes", { send: spy.send })).toEqual({ ok: true, earlier: null });
	const [sent] = spy.calls;
	expect(sent!.url).toBe(`${SERVER_URL}/answer/a%2Fb%3Fc%20d`);
	expect(sent!.method).toBe("POST");
	expect(sent!.body).toBe(JSON.stringify({ answer: "yes" }));
	expect(sent!.headers!.origin).toBe(SERVER_URL);
	// The real route: B holds the text, A answers; the whois login is stored, the body carries none.
	writePlan(TEAMH, "", "Queue: team");
	await publish(TEAMH, B_PEER);
	const id = idOf(TEAMH);
	expect(postTeamAnswer(cfg.teams[0]!, id, "ship it")).toEqual({ ok: true, earlier: null });
	const view = await call("GET", "/view", B_PEER);
	const answer = (view.body.answers as { plan: string; login: string; answer: string }[]).find((a) => a.plan === id);
	expect(answer).toMatchObject({ login: A, answer: "ship it" });
});

const PAGE_SOURCE: RunSource = { listRuns: () => [], mainSession: () => null };

/** POST /answer to the page as the owner's phone (form-encoded, the browser's own shape). */
function pagePost(svc: OwnerUiServer, fields: Record<string, string>): Promise<{ status: number; text: string; location: string }> {
	const host = `${LOOPBACK}:${svc.port}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string; location: string }>();
	const req = request(
		{ host: LOOPBACK, port: svc.port, method: "POST", path: "/answer", headers: { host, origin: `http://${host}`, "content-type": "application/x-www-form-urlencoded" } },
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), location: String(res.headers.location ?? "") }),
			);
		},
	);
	req.on("error", reject);
	req.end(new URLSearchParams(fields).toString());
	return promise;
}

test("a team answer from the page goes to the team server only: login stored, nothing in the inbox", async () => {
	writePlan(TEAMH, "", "Queue: team");
	await publish(TEAMH, A_PEER);
	const id = idOf(TEAMH);
	const pageCfg: Config = { ...cfg, workspace: { ...cfg.workspace, enabled: true, owner_login: A } };
	applyQueueEnv(pageCfg);
	const page = startOwnerUi({ cfg: pageCfg, tailscale: TS, source: PAGE_SOURCE, hostname: LOOPBACK, port: 0, peerOf: () => A_PEER, resultsBuild: () => {} });
	try {
		const answersOf = async (): Promise<{ plan: string; login: string; answer: string }[]> =>
			((await call("GET", "/view", B_PEER)).body.answers as { plan: string; login: string; answer: string }[]).filter((a) => a.plan === id);
		// The id was answered on this server by the test above, so count from here.
		const before = (await answersOf()).length;
		const sent = await pagePost(page, { plan: id, team: "acme", answer: "yes" });
		expect(sent.status).toBe(303);
		expect(sent.location).toBe("/?sent=team-answer&team=acme");
		const after = await answersOf();
		expect(after).toHaveLength(before + 1);
		expect(after[0]).toMatchObject({ login: A, answer: "yes" }); // the view is newest first
		// A second identical press within 10 s sends nothing.
		expect((await pagePost(page, { plan: id, team: "acme", answer: "yes" })).status).toBe(303);
		expect(await answersOf()).toHaveLength(before + 1);
		// Longer than ANSWER_MAX: 400 and no request (the server still holds the one answer).
		expect((await pagePost(page, { plan: id, team: "acme", answer: "x".repeat(2001) })).status).toBe(400);
		expect(await answersOf()).toHaveLength(before + 1);
		// The answer went to the team alone: no inbox file was written.
		expect(existsSync(join(STATE, "owner-inbox.jsonl"))).toBe(false);
	} finally {
		page.stop();
	}
	// A team whose server did not answer is a 503, not a stored answer.
	const downCfg: Config = { ...pageCfg, teams: [pageCfg.teams[0]!, DOWN_TEAM] };
	const downPage = startOwnerUi({ cfg: downCfg, tailscale: TS, source: PAGE_SOURCE, hostname: LOOPBACK, port: 0, peerOf: () => A_PEER, resultsBuild: () => {} });
	try {
		expect((await pagePost(downPage, { plan: "any", team: "down", answer: "yes" })).status).toBe(503);
	} finally {
		downPage.stop();
	}
});

// A stub team server in its own process: the client sends from a blocking child, so a stub in
// this process could not answer. It logs each request as one JSON line and answers from
// `replies`, keyed "METHOD /path" then "METHOD"; anything else is a 404 with no body.
let stubs = 0;
async function stubTeam(replies: Record<string, { status: number; body: unknown }>): Promise<{ url: string; requests: () => { method: string; path: string; body: string }[]; stop: () => void }> {
	const log = join(TMP, `stub-${stubs++}.log`);
	const child = join(TMP, "stub-team.ts");
	writeFileSync(
		child,
		`import { appendFileSync } from "node:fs";
const [logFile, repliesJson] = process.argv.slice(2);
const replies = JSON.parse(repliesJson!);
const svc = Bun.serve({
	hostname: ${JSON.stringify(LOOPBACK)},
	port: 0,
	fetch: async (req) => {
		const path = new URL(req.url).pathname;
		const body = await req.text();
		appendFileSync(logFile!, JSON.stringify({ method: req.method, path, body }) + "\\n");
		const r = replies[req.method + " " + path] ?? replies[req.method] ?? { status: 404, body: {} };
		return Response.json(r.body, { status: r.status });
	},
});
console.log(svc.port);
`,
	);
	const proc = Bun.spawn([process.execPath, child, log, JSON.stringify(replies)], { stdout: "pipe", stderr: "pipe" });
	const reader = proc.stdout.getReader();
	const first = await reader.read();
	await reader.cancel();
	const port = Number(new TextDecoder().decode(first.value).trim());
	return {
		url: `http://${LOOPBACK}:${port}`,
		requests: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l) as { method: string; path: string; body: string }) : []),
		stop: () => proc.kill(),
	};
}

test("the PUT body names the origin as host/path: no userinfo, no port (ii-1)", async () => {
	const stub = await stubTeam({ PUT: { status: 200, body: { sha: "s1" } } });
	try {
		const repo = join(TMP, "creds");
		mkdirSync(repo, { recursive: true });
		spawnSync("git", ["init", "-q"], { cwd: repo });
		spawnSync("git", ["remote", "add", "origin", "https://user:pw@gitlab.com:8443/acme/pm.git"], { cwd: repo });
		const file = join(repo, "docs/plans/20261101_0900_creds.md");
		writePlan(file, "", "Queue: team");
		const team: TeamEntry = { name: "stubteam", server: stub.url, repos: ["gitlab.com/acme/*"] };
		pushTeamPlan(team, cfgWith([team]), file);
		const puts = stub.requests().filter(r => r.method === "PUT");
		expect(puts).toHaveLength(1);
		expect(JSON.parse(puts[0]!.body).remote).toBe("https://gitlab.com/acme/pm");
	} finally {
		stub.stop();
	}
});
