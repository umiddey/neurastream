// Team setup (plan 20261027_1305 P6): `workspace on|off --team`, `workspace members`, `workspace --team`
// and `team join|leave`. Every test runs against a temp HOME with a fake runner, a Tailscale fixture and
// a stubbed team-view probe, so nothing here calls systemctl, the real tailscale binary or the network.
// The one real team server is started on loopback with port 0, to create the database `members` edits.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { listTeamMembers, startTeamServer, type TeamServer } from "../src/core/team-server.ts";
import { readTeamServerFile, teamDbPath, teamServerFile, uiOff, uiOn, type Runner, type Scope } from "../src/core/ui-setup.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import { runWorkspace, type WorkspaceDeps } from "../src/cli/workspace.ts";
import { runTeam } from "../src/cli/team.ts";
import { resetTeamStores } from "../src/core/team-client.ts";

const TMP = mkdtempSync(join(tmpdir(), "team-setup-"));
const HOME = join(TMP, "home");
const CONFIG_FILE = join(HOME, ".config/neurastream/config.yml");
const UNIT_FILE = join(HOME, ".config/systemd/user/neurastream-team-acme.service");
const LOGIN = "a@b.c";
const MEMBER = "m@example.com";
const LOOPBACK = [127, 0, 0, 1].join(".");
const TEAM: Scope = { kind: "team", name: "acme" };
const REPOS = ["github.com/acme/*"];
const TEAM_URL = "http://100.64.1.2:7800";
const EMPTY_VIEW = { plans: [], claims: [], approvals: [], votes: [], paused: [], answers: [], first: [], me_paused: false };
// An existing config that turns nothing on. An empty file is not a YAML object, so loadConfig refuses it.
const BASE_CONFIG = "workspace:\n  enabled: false\n";

// Same save/restore as tests/workspace-on-off.test.ts: a live QUEUE_* must not reach loadConfig.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(HOME, { recursive: true });
});

function fakeRunner(fail: { call?: number } = {}): { runner: Runner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		runner: args => {
			calls.push(args);
			const failing = fail.call !== undefined && calls.length === fail.call;
			return { status: failing ? 1 : 0, stderr: failing ? "systemctl: failed" : "" };
		},
	};
}

function fixtureTailscale(over: Partial<Tailscale> = {}): Tailscale {
	return {
		ip4: () => "100.64.0.9",
		state: () => "running",
		dnsName: () => "ukd.tailc0aee7.ts.net",
		whois: () => null,
		logins: () => [LOGIN, MEMBER],
		...over,
	};
}

function sinks(): { out: string[]; err: string[]; print: (line: string) => void; error: (line: string) => void } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, print: line => out.push(line), error: line => err.push(line) };
}

function writeConfig(text: string): void {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	writeFileSync(CONFIG_FILE, text);
}

function readConfig(): string | null {
	return existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
}

function teamOn(runner: Runner, over: { admin?: string; repos?: string[]; tailscale?: Tailscale; name?: string } = {}): { code: number; err: string[] } {
	const s = sinks();
	const scope: Scope = over.name === undefined ? TEAM : { kind: "team", name: over.name };
	const code = uiOn({
		home: HOME,
		scope,
		admin: "admin" in over ? over.admin : LOGIN,
		repos: over.repos ?? REPOS,
		tailscale: over.tailscale ?? fixtureTailscale(),
		runner,
		print: s.print,
		error: s.error,
	});
	return { code, err: s.err };
}

test("team on installs its own unit and writes the team file, and leaves the personal config alone", () => {
	const r = fakeRunner();
	const s = sinks();
	const code = uiOn({ home: HOME, scope: TEAM, admin: LOGIN, repos: REPOS, tailscale: fixtureTailscale(), runner: r.runner, print: s.print, error: s.error });
	expect(code).toBe(0);
	expect(r.calls).toEqual([
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", "neurastream-team-acme"],
		["systemctl", "--user", "restart", "neurastream-team-acme"],
	]);
	expect(readFileSync(UNIT_FILE, "utf8")).toContain("workspace --team acme");
	expect(readTeamServerFile(HOME, "acme")).toMatchObject({ team: "acme", admin: LOGIN, leader: LOGIN, repos: REPOS, members: [] });
	expect(statSync(teamServerFile(HOME, "acme")).mode & 0o777).toBe(0o600);
	expect(readConfig()).toBeNull();
	expect(s.out.at(-1)).toContain("team acme: admin");
});

test("bad team names and bad team arguments refuse before anything is read or run", () => {
	for (const name of ["Acme", "-x", "a".repeat(40)]) {
		const r = fakeRunner();
		const s = sinks();
		const code = uiOn({ home: HOME, scope: { kind: "team", name }, admin: LOGIN, repos: REPOS, tailscale: fixtureTailscale(), runner: r.runner, print: s.print, error: s.error });
		expect(code).toBe(2);
		expect(r.calls).toEqual([]);
		expect(existsSync(teamServerFile(HOME, name))).toBe(false);
	}
	const noAdmin = fakeRunner();
	expect(teamOn(noAdmin.runner, { admin: "" }).code).toBe(1);
	expect(noAdmin.calls).toEqual([]);
	const noRepos = fakeRunner();
	expect(teamOn(noRepos.runner, { repos: [] }).code).toBe(1);
	expect(noRepos.calls).toEqual([]);
	const notOnTailnet = fakeRunner();
	expect(teamOn(notOnTailnet.runner, { admin: "stranger@example.com" }).code).toBe(1);
	expect(notOnTailnet.calls).toEqual([]);
	expect(existsSync(teamServerFile(HOME, "acme"))).toBe(false);
});

test("team setup fails closed when the tailnet logins cannot be read", () => {
	const r = fakeRunner();
	const { code, err } = teamOn(r.runner, { tailscale: fixtureTailscale({ logins: () => null }) });
	expect(code).toBe(1);
	expect(err.join("\n")).toContain("cannot read the tailnet logins");
	expect(r.calls).toEqual([]);
	expect(existsSync(teamServerFile(HOME, "acme"))).toBe(false);
});

test("a team and the personal page refuse to run together, in either order", () => {
	writeConfig("workspace:\n  enabled: true\n  owner_login: a@b.c\n");
	const first = fakeRunner();
	expect(teamOn(first.runner).code).toBe(1);
	expect(first.calls).toEqual([]);

	writeConfig(BASE_CONFIG);
	const team = fakeRunner();
	expect(teamOn(team.runner).code).toBe(0);
	const s = sinks();
	const personal = uiOn({ home: HOME, login: LOGIN, tailscale: fixtureTailscale(), runner: fakeRunner().runner, print: s.print, error: s.error });
	expect(personal).toBe(1);
	expect(s.err.join("\n")).toContain("cannot run together");
	expect(readConfig()).toBe(BASE_CONFIG);
});

test("a failed systemctl leaves no team file behind", () => {
	const r = fakeRunner({ call: 2 });
	expect(teamOn(r.runner).code).toBe(1);
	expect(existsSync(teamServerFile(HOME, "acme"))).toBe(false);
	expect(readConfig()).toBeNull();
});

test("team off stops that unit, removes only its settings file and keeps the database", () => {
	expect(teamOn(fakeRunner().runner).code).toBe(0);
	const db = teamDbPath(loadConfig({ home: HOME }), "acme");
	mkdirSync(dirname(db), { recursive: true });
	writeFileSync(db, "queue");

	const r = fakeRunner();
	expect(uiOff({ home: HOME, scope: TEAM, runner: r.runner, tailscale: fixtureTailscale() })).toBe(0);
	expect(r.calls).toEqual([["systemctl", "--user", "disable", "--now", "neurastream-team-acme"]]);
	expect(existsSync(teamServerFile(HOME, "acme"))).toBe(false);
	expect(existsSync(db)).toBe(true);
});

test("the team serve path hands the stored settings to the server", async () => {
	expect(teamOn(fakeRunner().runner).code).toBe(0);
	const cfg = loadConfig({ home: HOME });
	const seen: Parameters<NonNullable<WorkspaceDeps["startTeam"]>>[0][] = [];
	// The address moves on the second poll: serving ends that way, and systemd restarts the unit on the new address.
	let polls = 0;
	const deps: WorkspaceDeps = {
		home: HOME,
		cfg,
		tailscale: fixtureTailscale({ ip4: () => (++polls > 1 ? "100.64.0.10" : "100.64.0.9") }),
		ipPollMs: 1,
		startTeam: opts => {
			seen.push(opts);
			return { stop: () => {}, hostname: "100.64.0.9", port: 7800 } as TeamServer;
		},
	};
	expect(await runWorkspace(["--team", "acme"], deps)).toBe(1);
	expect(seen).toHaveLength(1);
	expect(seen[0]!.dbPath).toBe(teamDbPath(cfg, "acme"));
	expect(seen[0]!.config).toMatchObject({ team: "acme", admin: LOGIN, leader: LOGIN, members: [] });
	expect(await runWorkspace(["--team", "nope"], deps)).toBe(1);
});

test("members add, list and remove edit the team's member list", async () => {
	expect(teamOn(fakeRunner().runner).code).toBe(0);
	const cfg = loadConfig({ home: HOME });
	const dbPath = teamDbPath(cfg, "acme");
	mkdirSync(dirname(dbPath), { recursive: true });
	// The member commands need the database, which exists once the team server has started once.
	startTeamServer({
		tailscale: fixtureTailscale({ ip4: () => LOOPBACK }),
		config: { team: "acme", admin: LOGIN, leader: LOGIN, repos: REPOS, members: [] },
		dbPath,
		port: 0,
		hostname: LOOPBACK,
		peerOf: () => LOGIN,
		claimTtlMin: 30,
	}).stop();

	const deps: WorkspaceDeps = { home: HOME, cfg, tailscale: fixtureTailscale() };
	expect(await runWorkspace(["members", "add", MEMBER, "--team", "acme"], deps)).toBe(0);
	expect(listTeamMembers(dbPath)).toContain(MEMBER);
	expect(await runWorkspace(["members", "list", "--team", "acme"], deps)).toBe(0);
	expect(await runWorkspace(["members", "remove", MEMBER, "--team", "acme"], deps)).toBe(0);
	expect(listTeamMembers(dbPath)).not.toContain(MEMBER);
	expect(await runWorkspace(["members", "list", "--team", "nope"], deps)).toBe(1);
});

// Each probe starts from a clean outage memo: a down mark from one probe must not answer the next.
function joinTeam(send: NonNullable<Parameters<typeof runTeam>[1]>["send"]): number {
	resetTeamStores();
	return runTeam(["join", TEAM_URL, "--name", "acme", "--repo", REPOS[0]!], { home: HOME, send });
}

test("team join adds one teams: entry only when the server answers this login", () => {
	writeConfig(BASE_CONFIG);
	expect(joinTeam(() => ({ error: "stubbed outage" }))).toBe(1);
	expect(joinTeam(() => ({ status: 403, body: {} }))).toBe(1);
	expect(readConfig()).toBe(BASE_CONFIG);

	expect(joinTeam(() => ({ status: 200, body: EMPTY_VIEW }))).toBe(0);
	expect(loadConfig({ home: HOME }).teams).toEqual([{ name: "acme", server: TEAM_URL, repos: REPOS }]);

	expect(joinTeam(() => ({ status: 200, body: EMPTY_VIEW }))).toBe(1);
	expect(loadConfig({ home: HOME }).teams).toHaveLength(1);
});

test("team leave removes the entry and refuses a name it does not hold", () => {
	writeConfig(BASE_CONFIG);
	expect(joinTeam(() => ({ status: 200, body: EMPTY_VIEW }))).toBe(0);
	expect(runTeam(["leave", "nope"], { home: HOME })).not.toBe(0);
	expect(runTeam(["leave", "acme"], { home: HOME })).toBe(0);
	expect(loadConfig({ home: HOME }).teams).toEqual([]);
});
