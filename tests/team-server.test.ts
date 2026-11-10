// Team queue server (plan 20261027_1305 P2a). Injected whois, peer, clock and tailscale;
// a temp SQLite file and port 0. No real tailnet and no home directory.

import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "../src/core/owner-ui.ts";
import { sha } from "../src/core/queue/lib.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import { startTeamServer, teamPlanId, type TeamServer, type TeamServerConfig, type TeamServerOptions } from "../src/core/team-server.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const OWN_IP = "100.64.1.2";
const DNS_NAME = "team.tailnet.ts.net";
const PEER = "100.64.1.9";
const STRANGER_PEER = "100.64.1.7";
const MEMBER = "ada@example.com";
const STRANGER = "stranger@example.com";
const REMOTE = "https://gitlab.com/acme/pm.git";
const SCP_REMOTE = "git@gitlab.com:acme/pm.git";
const FOREIGN = "https://gitlab.com/other/pm.git";
const REL = "docs/plans/toy.md";
const TEAM_TEXT = "Queue: team\n\n## Goal\nShare this plan.\n";
const PERSONAL_TEXT = "Queue: personal\n\n## Goal\nStay here.\n";
const UNMARKED_TEXT = "# Toy\n\n## Goal\nNo marker.\n";
const BODY_MAX = 1024 * 1024;
const PLAN_MAX = 256 * 1024;

const CFG: TeamServerConfig = {
	team: "acme",
	admin: MEMBER,
	leader: MEMBER,
	repos: ["gitlab.com/acme/*"],
	members: [MEMBER],
};

const TS: Tailscale = {
	ip4: () => OWN_IP,
	dnsName: () => DNS_NAME,
	whois: peer => {
		// A wrong check order that asks whois about this machine becomes a 500, not a pass.
		if (peer === OWN_IP || isLoopback(peer)) throw new Error("whois must not run for this machine");
		if (peer === PEER) return MEMBER;
		if (peer === STRANGER_PEER) return STRANGER;
		return null;
	},
	logins: () => [MEMBER, STRANGER],
	state: () => "running",
};

const dir = mkdtempSync(join(tmpdir(), "team-server-"));
let n = 0;
let now = 1_700_000_000;
let stopFns: (() => void)[] = [];

afterEach(() => {
	for (const stop of stopFns) stop();
	stopFns = [];
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function start(over: Partial<TeamServerOptions> = {}): { svc: TeamServer; dbPath: string } {
	const dbPath = join(dir, `${++n}.sqlite`);
	const svc = startTeamServer({
		tailscale: TS,
		config: CFG,
		dbPath,
		port: 0,
		hostname: LOOPBACK,
		peerOf: () => PEER,
		clock: () => now,
		claimTtlMin: 30,
		...over,
	});
	stopFns.push(() => svc.stop());
	return { svc, dbPath };
}

function raw(
	svc: TeamServer,
	method: string,
	path: string,
	opts: { host?: string | null; origin?: string | null; body?: Uint8Array } = {},
): Promise<Response> {
	const host = opts.host === null ? null : (opts.host ?? `${OWN_IP}:${svc.port}`);
	const headers: Record<string, string> = {};
	if (host !== null) headers.host = host;
	if (opts.origin) headers.origin = opts.origin;
	if (opts.body) headers["content-type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const req = request({ host: LOOPBACK, port: svc.port, method, path, headers }, res => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
	});
	req.on("error", reject);
	req.end(opts.body);
	return promise;
}

function planId(remote = REMOTE, rel = REL): string {
	const id = teamPlanId(remote, rel);
	if (!id) throw new Error("remote did not parse");
	return id;
}

function putBody(remote: string, rel: string, text: string, base: string | null): Uint8Array {
	return Buffer.from(JSON.stringify({ remote, rel_path: rel, text, base_sha: base }));
}

function put(svc: TeamServer, remote: string, rel: string, text: string, base: string | null, host?: string): Promise<Response> {
	const hostHeader = host ?? `${OWN_IP}:${svc.port}`;
	return raw(svc, "PUT", `/plans/${planId(remote, rel)}`, {
		host: hostHeader,
		origin: `http://${hostHeader}`,
		body: putBody(remote, rel, text, base),
	});
}

async function expectAuth403(svc: TeamServer, host?: string): Promise<void> {
	const paths = ["/health", "/plans", `/plans/${planId()}`];
	const origin = `http://${host ?? `${OWN_IP}:${svc.port}`}`;
	const gets = await Promise.all(paths.map(path => raw(svc, "GET", path, { host })));
	const puts = await Promise.all(
		paths.map(path =>
			raw(svc, "PUT", path === "/health" ? `/plans/${planId()}` : path, {
				host,
				origin,
				body: putBody(REMOTE, REL, TEAM_TEXT, null),
			}),
		),
	);
	for (const res of [...gets, ...puts]) expect(res.status).toBe(403);
}

function auditOf(dbPath: string): { login: string; time: number; route: string; plan_id: string | null }[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.query<{ login: string; time: number; route: string; plan_id: string | null }, []>("SELECT login, time, route, plan_id FROM audit ORDER BY id").all();
	} finally {
		db.close();
	}
}

function planCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plans").get()?.n ?? 0;
	} finally {
		db.close();
	}
}

async function putSeq(svc: TeamServer, i: number): Promise<void> {
	if (i > 60) return;
	const res = await put(svc, REMOTE, `docs/plans/n${i}.md`, TEAM_TEXT, null);
	expect(res.status).toBe(200);
	await putSeq(svc, i + 1);
}

test("no tailnet address refuses to start; binding every interface refuses to start", () => {
	expect(() => start({ tailscale: { ...TS, ip4: () => null }, hostname: undefined })).toThrow(/tailscale ip -4/);
	expect(() => start({ hostname: [0, 0, 0, 0].join(".") })).toThrow(/every interface/);
});

test("a foreign Host from a member is 403 on every route", async () => {
	const { svc } = start();
	await expectAuth403(svc, `evil.example:${svc.port}`);
});

test("a Host without the served port is 403", async () => {
	const { svc } = start();
	expect((await raw(svc, "GET", "/health", { host: OWN_IP })).status).toBe(403);
});

test("loopback, a non-tailnet peer, and this machine's own address are 403", async () => {
	await expectAuth403(start({ peerOf: () => LOOPBACK }).svc);
	await expectAuth403(start({ peerOf: () => "::1" }).svc);
	await expectAuth403(start({ peerOf: () => "192.168.1.50" }).svc);
	await expectAuth403(start({ peerOf: () => OWN_IP }).svc);
});

test("a stranger login and a whois failure are 403", async () => {
	await expectAuth403(start({ peerOf: () => STRANGER_PEER }).svc);
	await expectAuth403(start({ peerOf: () => "100.64.1.8" }).svc);
});

test("a member GET is 200, including the MagicDNS host; a write without Origin or with a foreign Origin is 403", async () => {
	const { svc } = start();
	expect((await raw(svc, "GET", "/health")).status).toBe(200);
	expect((await raw(svc, "GET", "/plans")).status).toBe(200);
	expect((await raw(svc, "GET", "/health", { host: `${DNS_NAME}:${svc.port}` })).status).toBe(200);
	expect((await raw(svc, "GET", `/plans/${planId()}`)).status).toBe(404);
	const host = `${OWN_IP}:${svc.port}`;
	expect((await raw(svc, "PUT", `/plans/${planId()}`, { body: putBody(REMOTE, REL, TEAM_TEXT, null) })).status).toBe(403);
	expect((await raw(svc, "PUT", `/plans/${planId()}`, { origin: "http://evil.example", body: putBody(REMOTE, REL, TEAM_TEXT, null) })).status).toBe(403);
	expect((await raw(svc, "PUT", `/plans/${planId()}`, { host: `${DNS_NAME}:${svc.port}`, origin: `http://${host}`, body: putBody(REMOTE, REL, TEAM_TEXT, null) })).status).toBe(403);
	expect((await raw(svc, "POST", "/health")).status).toBe(403);
	expect((await raw(svc, "DELETE", `/plans/${planId()}`)).status).toBe(403);
	expect((await raw(svc, "GET", "/plans")).status).toBe(200);
});

test("a member stores a Queue: team plan and a stale base is 409 with the current sha", async () => {
	const { svc } = start();
	const missing = await put(svc, REMOTE, REL, TEAM_TEXT, "deadbeef");
	expect(missing.status).toBe(409);
	expect(await missing.json()).toEqual({ error: "stale base", sha: null });
	const created = await put(svc, REMOTE, REL, TEAM_TEXT, null);
	expect(created.status).toBe(200);
	const createdBody = (await created.json()) as { sha: string };
	expect(createdBody.sha).toBe(sha(TEAM_TEXT));
	const again = await put(svc, REMOTE, REL, TEAM_TEXT, null);
	expect(again.status).toBe(409);
	expect(await again.json()).toEqual({ error: "stale base", sha: createdBody.sha });
	const next = "Queue: team\n\n## Goal\nUpdated.\n";
	const stale = await put(svc, REMOTE, REL, next, "not-the-sha");
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "stale base", sha: createdBody.sha });
	const updated = await put(svc, REMOTE, REL, next, createdBody.sha);
	expect(updated.status).toBe(200);
	const got = await raw(svc, "GET", `/plans/${planId()}`);
	expect(got.status).toBe(200);
	expect(await got.json()).toMatchObject({ text: next, sha: sha(next), remote: "gitlab.com/acme/pm" });
	const listed = (await (await raw(svc, "GET", "/plans")).json()) as { plans: { id: string }[] };
	expect(listed.plans.map(p => p.id)).toEqual([planId()]);
});

test("an scp origin in the repo list is stored; a foreign remote is 403 and not listed", async () => {
	const { svc, dbPath } = start();
	const ok = await put(svc, SCP_REMOTE, "docs/plans/scp.md", TEAM_TEXT, null);
	expect(ok.status).toBe(200);
	const foreign = await put(svc, FOREIGN, REL, TEAM_TEXT, null);
	expect(foreign.status).toBe(403);
	const listed = (await (await raw(svc, "GET", "/plans")).json()) as { plans: { rel_path: string }[] };
	expect(listed.plans.map(p => p.rel_path)).toEqual(["docs/plans/scp.md"]);
	expect(planCount(dbPath)).toBe(1);
});

test("a plan with no Queue header, Queue: personal, or the marker only after a section is 403 and not listed", async () => {
	const { svc, dbPath } = start();
	expect((await put(svc, REMOTE, REL, UNMARKED_TEXT, null)).status).toBe(403);
	expect((await put(svc, REMOTE, "docs/plans/personal.md", PERSONAL_TEXT, null)).status).toBe(403);
	expect((await put(svc, REMOTE, "docs/plans/buried.md", "## Goal\nQueue: team\n", null)).status).toBe(403);
	const listed = (await (await raw(svc, "GET", "/plans")).json()) as { plans: unknown[] };
	expect(listed.plans).toEqual([]);
	expect(planCount(dbPath)).toBe(0);
	expect(auditOf(dbPath)).toEqual([]);
});

test("a body over 1 MB and a plan over 256 KB are 413 and not stored", async () => {
	const { svc, dbPath } = start();
	const huge = await raw(svc, "PUT", `/plans/${planId()}`, {
		origin: `http://${OWN_IP}:${svc.port}`,
		body: new Uint8Array(BODY_MAX + 1),
	});
	expect(huge.status).toBe(413);
	const head = "Queue: team\n";
	const exact = head + "a".repeat(PLAN_MAX - head.length);
	expect(new TextEncoder().encode(exact).byteLength).toBe(PLAN_MAX);
	expect((await put(svc, REMOTE, REL, exact, null)).status).toBe(200);
	expect((await put(svc, REMOTE, "docs/plans/big.md", `${exact}a`, null)).status).toBe(413);
	expect(planCount(dbPath)).toBe(1);
});

test("the 61st write in a minute is 429; a minute later a write is accepted", async () => {
	const { svc, dbPath } = start();
	await putSeq(svc, 1);
	const blocked = await put(svc, REMOTE, "docs/plans/n61.md", TEAM_TEXT, null);
	expect(blocked.status).toBe(429);
	expect(planCount(dbPath)).toBe(60);
	expect(auditOf(dbPath)).toHaveLength(60);
	now += 60;
	expect((await put(svc, REMOTE, "docs/plans/n61.md", TEAM_TEXT, null)).status).toBe(200);
	expect(planCount(dbPath)).toBe(61);
});

test("each accepted write appends one audit row and a refusal appends none", async () => {
	const { svc, dbPath } = start();
	expect((await put(svc, REMOTE, REL, PERSONAL_TEXT, null)).status).toBe(403);
	expect(auditOf(dbPath)).toEqual([]);
	const created = await put(svc, REMOTE, REL, TEAM_TEXT, null);
	const body = (await created.json()) as { sha: string };
	const next = "Queue: team\n\n## Goal\nSecond write.\n";
	expect((await put(svc, REMOTE, REL, next, body.sha)).status).toBe(200);
	const rows = auditOf(dbPath);
	expect(rows).toEqual([
		{ login: MEMBER, time: now, route: `PUT /plans/${planId()}`, plan_id: planId() },
		{ login: MEMBER, time: now, route: `PUT /plans/${planId()}`, plan_id: planId() },
	]);
	expect((await raw(svc, "DELETE", `/plans/${planId()}`, { origin: `http://${OWN_IP}:${svc.port}` })).status).toBe(404);
	expect(auditOf(dbPath)).toHaveLength(2);
	expect(planCount(dbPath)).toBe(1);
});
