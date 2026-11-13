// Team queue claims (plan 20261027_1305 P2b). Injected whois, per-request peer (a test header),
// clock and tailscale; a temp SQLite file and port 0. The race test starts four real server
// processes on one database file, from a child script written into the temp dir at runtime.
// No real tailnet and no home directory.

import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "../src/core/owner-ui.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import { startTeamServer, teamPlanId, type TeamServer, type TeamServerConfig } from "../src/core/team-server.ts";

const SERVER_SRC = join(import.meta.dir, "../src/core/team-server.ts");
const LOOPBACK = [127, 0, 0, 1].join(".");
const OWN_IP = "100.64.1.2";
const DNS_NAME = "team.tailnet.ts.net";
const A_PEER = "100.64.2.1";
const B_PEER = "100.64.2.2";
const A = "ada@example.com";
const B = "bob@example.com";
const REMOTE = "https://gitlab.com/acme/pm.git";
const REL = "docs/plans/toy.md";
const REL2 = "docs/plans/other.md";
const TEAM_TEXT = "Queue: team\n\n## Goal\nShare this plan.\n";
const TTL_MIN = 30;
const TTL = TTL_MIN * 60;
const T0 = 1_700_000_000;

const CFG: TeamServerConfig = { team: "acme", admin: A, leader: A, repos: ["gitlab.com/acme/*"], members: [A, B] };
const LOGINS = new Map([
	[A_PEER, A],
	[B_PEER, B],
]);
const TS: Tailscale = {
	ip4: () => OWN_IP,
	dnsName: () => DNS_NAME,
	whois: peer => {
		// A wrong check order that asks whois about this machine becomes a 500, not a pass.
		if (peer === OWN_IP || isLoopback(peer)) throw new Error("whois must not run for this machine");
		return LOGINS.get(peer) ?? null;
	},
	logins: () => [A, B],
	state: () => "running",
};

const dir = mkdtempSync(join(tmpdir(), "team-claims-"));
let n = 0;
let now = T0;
let stopFns: (() => void)[] = [];

afterEach(() => {
	for (const stop of stopFns) stop();
	stopFns = [];
	now = T0;
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function serve(dbPath: string): TeamServer {
	const svc = startTeamServer({
		tailscale: TS,
		config: CFG,
		dbPath,
		port: 0,
		hostname: LOOPBACK,
		peerOf: req => req.headers.get("x-test-peer") ?? "",
		clock: () => now,
		claimTtlMin: TTL_MIN,
	});
	stopFns.push(() => svc.stop());
	return svc;
}

function start(): { svc: TeamServer; dbPath: string } {
	const dbPath = join(dir, `${++n}.sqlite`);
	return { svc: serve(dbPath), dbPath };
}

interface Reply {
	status: number;
	body: Record<string, unknown>;
}

/** One request from a tailnet peer. A string body is sent as-is; anything else is JSON-encoded. */
function call(port: number, method: string, path: string, peer: string, body?: unknown): Promise<Reply> {
	const host = `${OWN_IP}:${port}`;
	const headers: Record<string, string> = { host, "x-test-peer": peer };
	let payload: string | undefined;
	if (typeof body === "string") payload = body;
	else if (body !== undefined) payload = JSON.stringify(body);
	if (method !== "GET") headers.origin = `http://${host}`;
	if (payload !== undefined) headers["content-type"] = "application/json";
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const req = request({ host: LOOPBACK, port, method, path, headers }, res => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

function planId(rel = REL): string {
	const id = teamPlanId(REMOTE, rel);
	if (!id) throw new Error("remote did not parse");
	return id;
}

async function seedPlan(port: number, rel = REL): Promise<void> {
	const res = await call(port, "PUT", `/plans/${planId(rel)}`, A_PEER, { remote: REMOTE, rel_path: rel, text: TEAM_TEXT, base_sha: null });
	expect(res.status).toBe(200);
}

function claimBody(main: string) {
	return { main, host: "laptop", pid: 4242 };
}

interface AuditRow {
	login: string;
	route: string;
	plan_id: string | null;
}

/** A read-only view of the database, with the same busy timeout the server sets; the race test reads while children write. */
function openRead(dbPath: string): Database {
	const db = new Database(dbPath, { readonly: true });
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}

function auditRows(dbPath: string): AuditRow[] {
	const db = openRead(dbPath);
	try {
		return db.query<AuditRow, []>("SELECT login, route, plan_id FROM audit ORDER BY id").all();
	} finally {
		db.close();
	}
}

function storedClaims(dbPath: string, id: string): { login: string; main: string }[] {
	const db = openRead(dbPath);
	try {
		return db.query<{ login: string; main: string }, [string]>("SELECT login, main FROM claims WHERE id = ?").all(id);
	} finally {
		db.close();
	}
}

test("a new claim is taken for the caller's login and Main, and audited", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	const res = await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect(res.status).toBe(200);
	expect(res.body.claim).toEqual({ plan: planId(), main: "m1", host: "laptop", pid: 4242, since: T0, beat: T0, login: A, mine: true });
	expect(auditRows(dbPath).at(-1)).toEqual({ login: A, route: `POST /claims/${planId()}`, plan_id: planId() });
});

test("the same login and Main re-claiming keeps since and refreshes beat", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	now = T0 + 60;
	const res = await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect(res.status).toBe(200);
	expect(res.body.claim).toMatchObject({ since: T0, beat: T0 + 60, mine: true });
	expect(auditRows(dbPath).at(-1)?.route).toBe(`POST /claims/${planId()}`);
});

test("another login's live claim is refused with 409 naming the holder, and the refusal is audited", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	const res = await call(svc.port, "POST", `/claims/${planId()}`, B_PEER, claimBody("m2"));
	expect(res.status).toBe(409);
	expect(res.body.heldBy).toMatchObject({ login: A, main: "m1", mine: false });
	expect(auditRows(dbPath).at(-1)).toEqual({ login: B, route: `refused POST /claims/${planId()}`, plan_id: planId() });
	expect(storedClaims(dbPath, planId())).toEqual([{ login: A, main: "m1" }]);
});

test("the same login with another Main is refused too, and the holder shows mine", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	const res = await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m2"));
	expect(res.status).toBe(409);
	expect(res.body.heldBy).toMatchObject({ login: A, main: "m1", mine: true });
	expect(storedClaims(dbPath, planId())).toEqual([{ login: A, main: "m1" }]);
});

test("a claim is takeable exactly when its last beat is claim_ttl_min old", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	now = T0 + TTL - 1;
	expect((await call(svc.port, "POST", `/claims/${planId()}`, B_PEER, claimBody("m2"))).status).toBe(409);
	now = T0 + TTL;
	const res = await call(svc.port, "POST", `/claims/${planId()}`, B_PEER, claimBody("m2"));
	expect(res.status).toBe(200);
	expect(res.body.claim).toMatchObject({ login: B, main: "m2", since: T0 + TTL, beat: T0 + TTL, mine: true });
	expect(auditRows(dbPath).at(-1)).toEqual({ login: B, route: `POST /claims/${planId()}`, plan_id: planId() });
});

test("the holder keeps an expired claim on re-claim: since unchanged, beat refreshed", async () => {
	const { svc } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	now = T0 + TTL + 5;
	const res = await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect(res.status).toBe(200);
	expect(res.body.claim).toMatchObject({ since: T0, beat: T0 + TTL + 5 });
});

test("a heartbeat from the holder refreshes beat and writes no audit row", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	const before = auditRows(dbPath).length;
	now = T0 + 100;
	const res = await call(svc.port, "POST", `/claims/${planId()}/beat`, A_PEER, { main: "m1" });
	expect(res.status).toBe(200);
	expect(res.body.claim).toMatchObject({ since: T0, beat: T0 + 100, mine: true });
	expect(auditRows(dbPath).length).toBe(before);
});

test("a heartbeat from another login, or from the same login with another Main, is refused with 403 and audited", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect((await call(svc.port, "POST", `/claims/${planId()}/beat`, B_PEER, { main: "m2" })).status).toBe(403);
	expect((await call(svc.port, "POST", `/claims/${planId()}/beat`, A_PEER, { main: "m2" })).status).toBe(403);
	expect(auditRows(dbPath).slice(-2)).toEqual([
		{ login: B, route: `refused POST /claims/${planId()}/beat`, plan_id: planId() },
		{ login: A, route: `refused POST /claims/${planId()}/beat`, plan_id: planId() },
	]);
	expect(storedClaims(dbPath, planId())).toEqual([{ login: A, main: "m1" }]);
});

test("a heartbeat with no claim is 404 and writes no audit row", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	const before = auditRows(dbPath).length;
	expect((await call(svc.port, "POST", `/claims/${planId()}/beat`, A_PEER, { main: "m1" })).status).toBe(404);
	expect(auditRows(dbPath).length).toBe(before);
});

test("the holder releases the claim: the row is gone and the release is audited", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	const res = await call(svc.port, "DELETE", `/claims/${planId()}`, A_PEER, { main: "m1" });
	expect(res.status).toBe(200);
	expect(res.body).toEqual({ ok: true });
	expect(auditRows(dbPath).at(-1)).toEqual({ login: A, route: `DELETE /claims/${planId()}`, plan_id: planId() });
	expect(storedClaims(dbPath, planId())).toEqual([]);
});

test("a release by another login is refused with 403 and audited; the claim stays", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect((await call(svc.port, "DELETE", `/claims/${planId()}`, B_PEER, { main: "m1" })).status).toBe(403);
	expect(auditRows(dbPath).at(-1)).toEqual({ login: B, route: `refused DELETE /claims/${planId()}`, plan_id: planId() });
	expect(storedClaims(dbPath, planId())).toEqual([{ login: A, main: "m1" }]);
});

test("a release with no claim is 404 and writes no audit row", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	const before = auditRows(dbPath).length;
	expect((await call(svc.port, "DELETE", `/claims/${planId()}`, A_PEER, { main: "m1" })).status).toBe(404);
	expect(auditRows(dbPath).length).toBe(before);
});

test("GET reads a plan's claim: null when none or expired, mine set for the caller, 404 for an unknown plan", async () => {
	const { svc } = start();
	expect(await call(svc.port, "GET", `/claims/${planId()}`, A_PEER)).toEqual({ status: 404, body: { error: "no such plan" } });
	await seedPlan(svc.port);
	expect((await call(svc.port, "GET", `/claims/${planId()}`, A_PEER)).body).toEqual({ claim: null });
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect((await call(svc.port, "GET", `/claims/${planId()}`, B_PEER)).body.claim).toMatchObject({ login: A, mine: false });
	expect((await call(svc.port, "GET", `/claims/${planId()}`, A_PEER)).body.claim).toMatchObject({ login: A, mine: true });
	now = T0 + TTL;
	expect((await call(svc.port, "GET", `/claims/${planId()}`, A_PEER)).body).toEqual({ claim: null });
});

test("GET /claims lists every claim of the team, expired ones included, each with mine", async () => {
	const { svc } = start();
	await seedPlan(svc.port);
	await seedPlan(svc.port, REL2);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	now = T0 + TTL;
	await call(svc.port, "POST", `/claims/${planId(REL2)}`, B_PEER, claimBody("m2"));
	const res = await call(svc.port, "GET", "/claims", A_PEER);
	expect(res.status).toBe(200);
	const rows = res.body.claims as { plan: string; login: string; mine: boolean; beat: number }[];
	expect(rows).toHaveLength(2);
	expect(rows.find(r => r.plan === planId())).toMatchObject({ login: A, mine: true, beat: T0 });
	expect(rows.find(r => r.plan === planId(REL2))).toMatchObject({ login: B, mine: false, beat: T0 + TTL });
});

test("a claim on a plan the team does not hold is 404 and writes nothing", async () => {
	const { svc, dbPath } = start();
	const res = await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	expect(res).toEqual({ status: 404, body: { error: "no such plan" } });
	expect(auditRows(dbPath)).toEqual([]);
	expect(storedClaims(dbPath, planId())).toEqual([]);
});

test("a malformed claim body is 400 before any row or audit is written", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	const before = auditRows(dbPath).length;
	const bad: unknown[] = [
		"not json",
		[1, 2],
		{ host: "laptop", pid: 1 },
		{ main: "Bad_Main", host: "laptop", pid: 1 },
		{ main: "m1", host: "", pid: 1 },
		{ main: "m1", host: "x".repeat(254), pid: 1 },
		{ main: "m1", host: "laptop", pid: 0 },
		{ main: "m1", host: "laptop", pid: "1" },
		{ main: "m1", host: "laptop", pid: 1.5 },
	];
	const replies = await Promise.all(bad.map(body => call(svc.port, "POST", `/claims/${planId()}`, B_PEER, body)));
	expect(replies.map(r => r.status)).toEqual(bad.map(() => 400));
	expect((await call(svc.port, "POST", `/claims/${planId()}/beat`, A_PEER, { main: "Bad_Main" })).status).toBe(400);
	expect((await call(svc.port, "DELETE", `/claims/${planId()}`, A_PEER, {})).status).toBe(400);
	expect(storedClaims(dbPath, planId())).toEqual([{ login: A, main: "m1" }]);
	expect(auditRows(dbPath).length).toBe(before);
});

test("claim writes share the 60-per-minute budget per login, and reads are not counted", async () => {
	const { svc } = start();
	await seedPlan(svc.port); // the seed PUT is A's first write this minute
	const beats = await Promise.all(Array.from({ length: 59 }, () => call(svc.port, "POST", `/claims/${planId()}/beat`, A_PEER, { main: "m1" })));
	expect(beats.every(r => r.status === 404)).toBe(true);
	expect((await call(svc.port, "DELETE", `/claims/${planId()}`, A_PEER, { main: "m1" })).status).toBe(429);
	expect((await call(svc.port, "GET", `/claims/${planId()}`, A_PEER)).status).toBe(200);
	expect((await call(svc.port, "POST", `/claims/${planId()}/beat`, B_PEER, { main: "m2" })).status).toBe(404);
});

test("claims are stored in the database and survive a restart", async () => {
	const { svc, dbPath } = start();
	await seedPlan(svc.port);
	await call(svc.port, "POST", `/claims/${planId()}`, A_PEER, claimBody("m1"));
	svc.stop();
	const again = serve(dbPath);
	const res = await call(again.port, "GET", `/claims/${planId()}`, B_PEER);
	expect(res.body.claim).toMatchObject({ login: A, main: "m1", mine: false });
});

// Runs in its own process: starts one team server on the database path it is given and prints the port.
const CHILD = `
import { startTeamServer } from ${JSON.stringify(SERVER_SRC)};
const svc = startTeamServer({
	tailscale: {
		ip4: () => ${JSON.stringify(OWN_IP)},
		dnsName: () => ${JSON.stringify(DNS_NAME)},
		whois: peer => (peer.startsWith("100.64.2.") ? \`m\${peer.split(".")[3]}\` : null),
		logins: () => ["m1", "m2", "m3", "m4"],
		state: () => "running",
	},
	config: { team: "acme", admin: "m1", leader: "m1", repos: ["gitlab.com/acme/*"], members: ["m1", "m2", "m3", "m4"] },
	dbPath: process.argv[2],
	port: 0,
	hostname: "127.0.0.1",
	peerOf: req => req.headers.get("x-test-peer") ?? "",
	claimTtlMin: 30,
});
console.log(svc.port);
`;

/** The first line a child process prints on stdout; reads chunks by recursion, not a loop. */
function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const pump = (text: string): void => {
		reader.read().then(({ value, done }) => {
			if (done) return reject(new Error("child exited before printing its port"));
			const next = text + decoder.decode(value);
			if (!next.includes("\n")) return pump(next);
			reader.releaseLock();
			return resolve(next.slice(0, next.indexOf("\n")));
		}, reject);
	};
	pump("");
	return promise;
}

test("four server processes sharing one database give exactly one winner per race", async () => {
	const script = join(dir, "team-child.ts");
	writeFileSync(script, CHILD);
	const dbPath = join(dir, "race.sqlite");
	const procs = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, script, dbPath], { stdout: "pipe", stderr: "inherit" }));
	try {
		const ports = (await Promise.all(procs.map(p => firstLine(p.stdout)))).map(Number);
		const portAt = (k: number): number => ports[k % 4] as number;
		// Five rounds, each on its own plan, all raced at once. Each round: one seed PUT, then twenty
		// claims spread over the four processes, each with its own Main.
		await Promise.all(
			[1, 2, 3, 4, 5].map(async round => {
				const rel = `docs/plans/race-${round}.md`;
				const id = planId(rel);
				await seedPlan(portAt(0), rel);
				const replies = await Promise.all(
					Array.from({ length: 20 }, (_, i) => {
						const k = (i % 4) + 1;
						return call(portAt(k), "POST", `/claims/${id}`, `100.64.2.${k}`, { main: `m${i}`, host: "laptop", pid: i + 1 });
					}),
				);
				const winners = replies.filter(r => r.status === 200);
				const losers = replies.filter(r => r.status === 409);
				expect(winners).toHaveLength(1);
				expect(losers).toHaveLength(19);
				expect(losers.every(r => "heldBy" in r.body)).toBe(true);
				const rows = storedClaims(dbPath, id);
				expect(rows).toHaveLength(1);
				expect(winners[0]?.body.claim).toMatchObject({ login: rows[0]?.login, main: rows[0]?.main });
			}),
		);
	} finally {
		for (const proc of procs) proc.kill();
		await Promise.all(procs.map(proc => proc.exited));
	}
}, 60_000);
