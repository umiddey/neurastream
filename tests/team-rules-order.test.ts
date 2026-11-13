import { Database } from "bun:sqlite";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Tailscale } from "../src/core/tailscale.ts";
import { viewPlanRows, type TeamPlanRow } from "../src/core/team-client.ts";
import { startTeamServer, teamPlanId, type TeamServer, type TeamServerConfig, type TeamView } from "../src/core/team-server.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const OWN_IP = "100.64.1.2";
const DNS_NAME = "team.tailnet.ts.net";
const A_PEER = "100.64.2.1";
const B_PEER = "100.64.2.2";
const C_PEER = "100.64.2.3";
const A = "ada";
const B = "bob";
const C = "cy";
const REMOTE = "https://gitlab.com/acme/pm.git";
const REL = "docs/plans/toy.md";
const REL2 = "docs/plans/other.md";
const REL_ZZ = "docs/plans/zz.md";
const REL_AAA = "docs/plans/aaa.md";
const REL_BBB = "docs/plans/bbb.md";
const TEAM_TEXT = "Queue: team\n\n## Goal\nShare this plan.\n";
const WAITING_DB = "Queue: team\n\n# Beta plan\n\nWAITING on owner: Which database?\n\n## Goal\nShip beta.\n";
const WAITING_CACHE = "Queue: team\n\n# Beta plan\n\nWAITING on owner: Which cache?\n\n## Goal\nShip beta.\n";
const PAUSED = "paused: this member takes no claims on this team";
const TTL_MIN = 30;
const T0 = 1_700_000_000;

const CFG: TeamServerConfig = { team: "acme", admin: A, leader: B, repos: ["gitlab.com/acme/*"], members: [A, B, C] };
const LOGINS = new Map([
	[A_PEER, A],
	[B_PEER, B],
	[C_PEER, C],
]);
const TS: Tailscale = {
	ip4: () => OWN_IP,
	dnsName: () => DNS_NAME,
	whois: peer => {
		if (peer === OWN_IP || peer === LOOPBACK) throw new Error("whois must not run for this machine");
		return LOGINS.get(peer) ?? null;
	},
	logins: () => [A, B, C],
	state: () => "running",
};

const dir = mkdtempSync(join(tmpdir(), "team-rules-"));
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

/** One JSON request from a tailnet peer. */
function call(port: number, method: string, path: string, peer: string, body?: unknown): Promise<Reply> {
	const host = `${OWN_IP}:${port}`;
	const headers: Record<string, string> = { host, "x-test-peer": peer };
	let payload: string | undefined;
	if (body !== undefined) payload = JSON.stringify(body);
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

/** One urlencoded form post from a tailnet peer, as the page's forms send it. */
function postForm(port: number, path: string, peer: string, form: Record<string, string>): Promise<{ status: number; location: string }> {
	const host = `${OWN_IP}:${port}`;
	const headers: Record<string, string> = {
		host,
		"x-test-peer": peer,
		origin: `http://${host}`,
		"content-type": "application/x-www-form-urlencoded",
	};
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; location: string }>();
	const req = request({ host: LOOPBACK, port, method: "POST", path, headers }, res => {
		res.resume();
		res.on("end", () => resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? "") }));
	});
	req.on("error", reject);
	req.end(new URLSearchParams(form).toString());
	return promise;
}

function planId(rel: string): string {
	const id = teamPlanId(REMOTE, rel);
	if (!id) throw new Error("remote did not parse");
	return id;
}

/** Writes one plan as admin; returns its id and sha. */
async function putPlan(port: number, rel: string, text: string, baseSha: string | null): Promise<{ id: string; sha: string }> {
	const id = planId(rel);
	const res = await call(port, "PUT", `/plans/${id}`, A_PEER, { remote: REMOTE, rel_path: rel, text, base_sha: baseSha });
	expect(res.status).toBe(200);
	return { id, sha: res.body.sha as string };
}

/** The team view as the plan list sees it: rows in the order the plan list shows them. */
async function rowsOf(port: number): Promise<TeamPlanRow[]> {
	const res = await call(port, "GET", "/view", A_PEER);
	expect(res.status).toBe(200);
	return viewPlanRows(res.body as unknown as TeamView, TTL_MIN, now, () => "");
}

test("plans order by rank sum, a tie by rel_path, and unvoted plans last by rel_path then id", async () => {
	const { svc } = start();
	const port = svc.port;
	const toy = (await putPlan(port, REL, TEAM_TEXT, null)).id;
	const other = (await putPlan(port, REL2, TEAM_TEXT, null)).id;
	const zz = (await putPlan(port, REL_ZZ, TEAM_TEXT, null)).id;
	await putPlan(port, REL_AAA, TEAM_TEXT, null);
	await putPlan(port, REL_BBB, TEAM_TEXT, null);
	// Sums: other 1+1=2, toy 2+3=5, zz 3+2=5. The toy/zz tie goes to the rel_path: toy.md before zz.md.
	expect((await call(port, "POST", "/order", A_PEER, { ranks: { [other]: 1, [toy]: 2, [zz]: 3 } })).status).toBe(200);
	expect((await call(port, "POST", "/order", B_PEER, { ranks: { [other]: 1, [zz]: 2, [toy]: 3 } })).status).toBe(200);
	expect((await rowsOf(port)).map(r => r.relPath)).toEqual([REL2, REL, REL_ZZ, REL_AAA, REL_BBB]);
});

test("the leader's override puts its plans first in the order given, ahead of any vote", async () => {
	const { svc } = start();
	const port = svc.port;
	const toy = (await putPlan(port, REL, TEAM_TEXT, null)).id;
	const other = (await putPlan(port, REL2, TEAM_TEXT, null)).id;
	const zz = (await putPlan(port, REL_ZZ, TEAM_TEXT, null)).id;
	await putPlan(port, REL_AAA, TEAM_TEXT, null);
	const bbb = (await putPlan(port, REL_BBB, TEAM_TEXT, null)).id;
	expect((await call(port, "POST", "/order", A_PEER, { ranks: { [other]: 1, [toy]: 2 } })).status).toBe(200);
	expect((await call(port, "POST", "/order/override", B_PEER, { plan_ids: [zz, bbb] })).status).toBe(200);
	expect((await rowsOf(port)).map(r => r.relPath)).toEqual([REL_ZZ, REL_BBB, REL2, REL, REL_AAA]);
});

test("a member's vote from the page form is stored and orders the plan list the same way as the JSON route", async () => {
	const { svc } = start();
	const port = svc.port;
	const toy = (await putPlan(port, REL, TEAM_TEXT, null)).id;
	const other = (await putPlan(port, REL2, TEAM_TEXT, null)).id;
	await putPlan(port, REL_AAA, TEAM_TEXT, null);
	const res = await postForm(port, "/vote", C_PEER, { [`rank:${other}`]: "1", [`rank:${toy}`]: "2" });
	expect(res).toEqual({ status: 303, location: "/" });
	expect((await rowsOf(port)).map(r => r.relPath)).toEqual([REL2, REL, REL_AAA]);
});

test("a paused member's claim is refused with the paused message until they resume", async () => {
	const { svc } = start();
	const port = svc.port;
	const other = (await putPlan(port, REL2, TEAM_TEXT, null)).id;
	expect((await call(port, "POST", "/pause", C_PEER, {})).status).toBe(200);
	expect(await call(port, "POST", `/claims/${other}`, C_PEER, { main: "m-c", host: "laptop", pid: 4242 })).toEqual({
		status: 403,
		body: { error: PAUSED },
	});
	expect((await call(port, "POST", "/resume", C_PEER, {})).status).toBe(200);
	expect((await call(port, "POST", `/claims/${other}`, C_PEER, { main: "m-c", host: "laptop", pid: 4242 })).status).toBe(200);
});

test("the first answer to a WAITING question is the plan's answer; a later one is told who answered first", async () => {
	const { svc } = start();
	const port = svc.port;
	const { id } = await putPlan(port, REL2, WAITING_DB, null);
	const first = await call(port, "POST", `/answer/${id}`, B_PEER, { answer: "Postgres" });
	expect(first.status).toBe(200);
	expect(first.body).toMatchObject({ earlier: null });
	const second = await call(port, "POST", `/answer/${id}`, A_PEER, { answer: "MySQL" });
	expect(second.status).toBe(200);
	expect(second.body).toMatchObject({ earlier: { login: B, answer: "Postgres" } });
	const row = (await rowsOf(port)).find(r => r.id === id);
	expect(row?.answered).toMatchObject({ login: B, answer: "Postgres" });
});

test("a new WAITING question starts a new first answer; the old answer no longer counts", async () => {
	const { svc } = start();
	const port = svc.port;
	const { id, sha } = await putPlan(port, REL2, WAITING_DB, null);
	expect((await call(port, "POST", `/answer/${id}`, B_PEER, { answer: "Postgres" })).status).toBe(200);
	await putPlan(port, REL2, WAITING_CACHE, sha);
	const reply = await call(port, "POST", `/answer/${id}`, A_PEER, { answer: "Redis" });
	expect(reply.status).toBe(200);
	expect(reply.body).toMatchObject({ earlier: null });
	const row = (await rowsOf(port)).find(r => r.id === id);
	expect(row?.answered).toMatchObject({ login: A, answer: "Redis" });
});

test("an answers table from before waiting_key is migrated in place and keeps its rows", () => {
	const dbPath = join(dir, `${++n}.sqlite`);
	const old = new Database(dbPath);
	old.exec(
		`CREATE TABLE answers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id TEXT NOT NULL,
			login TEXT NOT NULL,
			time INTEGER NOT NULL,
			sha TEXT NOT NULL,
			answer TEXT NOT NULL
		);
		INSERT INTO answers (plan_id, login, time, sha, answer) VALUES ('p1', 'ada', ${T0}, 'abc', 'old answer');`,
	);
	old.close();
	serve(dbPath);
	const db = new Database(dbPath, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		expect(db.query<{ plan_id: string; login: string; answer: string; waiting_key: string | null }, []>("SELECT plan_id, login, answer, waiting_key FROM answers").all()).toEqual([
			{ plan_id: "p1", login: "ada", answer: "old answer", waiting_key: null },
		]);
	} finally {
		db.close();
	}
});
