// Team queue P2c routes (plan 20261027_1305 P2c): members, approvals, plan order, pause, audit,
// and the host-side member exports. Injected whois, per-request peer, clock and tailscale;
// a temp SQLite file and port 0. No real tailnet and no home directory.

import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "../src/core/owner-ui.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import {
	addTeamMember,
	listTeamMembers,
	removeTeamMember,
	startTeamServer,
	teamPlanId,
	type TeamServer,
	type TeamServerConfig,
} from "../src/core/team-server.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const OWN_IP = "100.64.1.2";
const DNS_NAME = "team.tailnet.ts.net";
const A_PEER = "100.64.2.1";
const B_PEER = "100.64.2.2";
const C_PEER = "100.64.2.3";
const D_PEER = "100.64.2.4";
const S_PEER = "100.64.2.9";
const A = "ada";
const B = "bob";
const C = "cy";
const D = "dee";
const REMOTE = "https://gitlab.com/acme/pm.git";
const REL = "docs/plans/toy.md";
const REL2 = "docs/plans/other.md";
const TEAM_TEXT = "Queue: team\n\n## Goal\nShare this plan.\n";
const TTL_MIN = 30;
const T0 = 1_700_000_000;

const NOT_INIT = "team acme not initialised: its server has never started on this database; start it once, then retry";
const LOGIN_ERROR = "login must be 1 to 256 characters with no whitespace or control character";
const ADMIN_REMOVE = "the admin login cannot be removed";
const ADMIN_ONLY = "forbidden: admin only";

const CFG: TeamServerConfig = { team: "acme", admin: A, leader: B, repos: ["gitlab.com/acme/*"], members: [A, B, C] };
const LOGINS = new Map([
	[A_PEER, A],
	[B_PEER, B],
	[C_PEER, C],
	[D_PEER, D],
]);
const TS: Tailscale = {
	ip4: () => OWN_IP,
	dnsName: () => DNS_NAME,
	whois: peer => {
		// A wrong check order that asks whois about this machine becomes a 500, not a pass.
		if (peer === OWN_IP || isLoopback(peer)) throw new Error("whois must not run for this machine");
		return LOGINS.get(peer) ?? null;
	},
	logins: () => [A, B, C, D],
	state: () => "running",
};

const dir = mkdtempSync(join(tmpdir(), "team-routes-"));
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

function serve(dbPath: string, config: TeamServerConfig = CFG): TeamServer {
	const svc = startTeamServer({
		tailscale: TS,
		config,
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

function start(config: TeamServerConfig = CFG): { svc: TeamServer; dbPath: string } {
	const dbPath = join(dir, `${++n}.sqlite`);
	return { svc: serve(dbPath, config), dbPath };
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

async function seedPlan(port: number, rel = REL, peer = A_PEER): Promise<string> {
	const res = await call(port, "PUT", `/plans/${planId(rel)}`, peer, { remote: REMOTE, rel_path: rel, text: TEAM_TEXT, base_sha: null });
	expect(res.status).toBe(200);
	return res.body.sha as string;
}

function claimBody(main: string) {
	return { main, host: "laptop", pid: 4242 };
}

/** Reads rows through a second, read-only connection while the server may be running. */
function readRows<T>(dbPath: string, sql: string): T[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000;");
		return db.query<T, []>(sql).all();
	} finally {
		db.close();
	}
}

interface AuditEntry {
	login: string;
	route: string;
	plan_id: string | null;
}

function auditRows(dbPath: string): AuditEntry[] {
	return readRows<AuditEntry>(dbPath, "SELECT login, route, plan_id FROM audit ORDER BY id");
}

test("before the first start the members table is empty and the host exports refuse", () => {
	const dbPath = join(dir, `${++n}.sqlite`);
	expect(listTeamMembers(dbPath)).toEqual([]);
	expect(addTeamMember(dbPath, CFG, D)).toEqual({ ok: false, error: NOT_INIT });
	expect(removeTeamMember(dbPath, CFG, B)).toEqual({ ok: false, error: NOT_INIT });
	expect(listTeamMembers(dbPath)).toEqual([]);
});

test("the first start seeds the configured members and admin; listTeamMembers reads them sorted", () => {
	const { dbPath } = start();
	expect(listTeamMembers(dbPath)).toEqual([A, B, C]);
});

test("a stranger gets 403 on every P2c route and nothing is audited", async () => {
	const { svc, dbPath } = start();
	const id = planId();
	const routes: [string, string, unknown?][] = [
		["POST", "/members", { login: D }],
		["DELETE", `/members/${C}`],
		["GET", "/audit"],
		["POST", `/approve/${id}`, {}],
		["POST", "/order", { ranks: { [id]: 1 } }],
		["POST", "/order/override", { plan_ids: [id] }],
		["POST", "/pause", {}],
		["POST", "/resume", {}],
		["DELETE", "/members/%E0%A4%A"],
	];
	const replies = await Promise.all(routes.map(([method, path, body]) => call(svc.port, method, path, S_PEER, body)));
	expect(replies.map(r => r.status)).toEqual(routes.map(() => 403));
	expect(auditRows(dbPath)).toEqual([]);
});

test("a leader or member is refused the admin routes, and each refusal is audited", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	expect(await call(port, "POST", "/members", B_PEER, { login: D })).toEqual({ status: 403, body: { error: ADMIN_ONLY } });
	expect((await call(port, "DELETE", `/members/${C}`, B_PEER)).status).toBe(403);
	expect(await call(port, "GET", "/audit", B_PEER)).toEqual({ status: 403, body: { error: ADMIN_ONLY } });
	expect(auditRows(dbPath)).toEqual([
		{ login: B, route: "refused POST /members", plan_id: null },
		{ login: B, route: `refused DELETE /members/${C}`, plan_id: null },
	]);
});

test("the admin login cannot be removed; a bad percent-encoding is a 400 before any audit row", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	expect((await call(port, "DELETE", `/members/${A}`, B_PEER)).status).toBe(403);
	expect(auditRows(dbPath)).toEqual([{ login: B, route: `refused DELETE /members/${A}`, plan_id: null }]);
	expect(await call(port, "DELETE", "/members/%E0%A4%A", B_PEER)).toEqual({ status: 400, body: { error: "bad login" } });
	expect(auditRows(dbPath)).toHaveLength(1);
});

test("a non-leader is refused the order override and the refusal is audited", async () => {
	const { svc, dbPath } = start();
	const id = planId();
	expect(await call(svc.port, "POST", "/order/override", A_PEER, { plan_ids: [id] })).toEqual({ status: 403, body: { error: "forbidden: leader only" } });
	expect(auditRows(dbPath)).toEqual([{ login: A, route: "refused POST /order/override", plan_id: null }]);
});

test("writes are capped at 60 a minute per login: the 61st is 429, and the window slides", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port, REL, C_PEER);
	const id = planId();
	// Sequential on purpose: the clock advances by i/2 seconds per request, so the order is the test.
	const replies = await Array.from({ length: 61 }, (_, i) => i).reduce<Promise<Reply[]>>(async (acc, i) => {
		const out = await acc;
		now = T0 + Math.floor(i / 2);
		out.push(await call(port, "POST", "/order/override", A_PEER, { plan_ids: [id] }));
		return out;
	}, Promise.resolve([]));
	expect(replies.slice(0, 60).map(r => r.status)).toEqual(Array.from({ length: 60 }, () => 403));
	expect(replies[60]).toEqual({ status: 429, body: { error: "too many writes" } });
	const refused = () => auditRows(dbPath).filter(r => r.route === "refused POST /order/override");
	expect(refused()).toHaveLength(60);
	now = T0 + 61;
	expect((await call(port, "POST", "/order/override", A_PEER, { plan_ids: [id] })).status).toBe(403);
	expect(refused()).toHaveLength(61);
});

test("the admin cannot remove itself over HTTP or from the host; the refusal is audited each time", async () => {
	const { svc, dbPath } = start();
	expect(await call(svc.port, "DELETE", `/members/${A}`, A_PEER)).toEqual({ status: 409, body: { error: ADMIN_REMOVE } });
	expect(listTeamMembers(dbPath)).toEqual([A, B, C]);
	expect(removeTeamMember(dbPath, CFG, A)).toEqual({ ok: false, error: ADMIN_REMOVE });
	expect(auditRows(dbPath)).toEqual([
		{ login: A, route: `refused DELETE /members/${A}`, plan_id: null },
		{ login: A, route: `refused DELETE /members/${A}`, plan_id: null },
	]);
});

test("removing an unknown member is 404 and is not audited", async () => {
	const { svc, dbPath } = start();
	expect(await call(svc.port, "DELETE", "/members/nobody", A_PEER)).toEqual({ status: 404, body: { error: "no such member" } });
	expect(auditRows(dbPath)).toEqual([]);
});

test("POST /members adds a login, reports whether it was new, and refuses bad logins", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	expect(await call(port, "POST", "/members", A_PEER, { login: D })).toEqual({ status: 200, body: { login: D, added: true } });
	expect(await call(port, "POST", "/members", A_PEER, { login: D })).toEqual({ status: 200, body: { login: D, added: false } });
	expect((await call(port, "GET", "/health", D_PEER)).status).toBe(200);
	const badLogins: unknown[] = ["has space", "", 5, "x".repeat(257), "tab\tin", "new\nline"];
	const replies = await Promise.all(badLogins.map(login => call(port, "POST", "/members", A_PEER, { login })));
	expect(replies.map(r => r)).toEqual(badLogins.map(() => ({ status: 400, body: { error: LOGIN_ERROR } })));
	expect(await call(port, "POST", "/members", A_PEER, [])).toEqual({ status: 400, body: { error: "body must be a JSON object" } });
	expect(auditRows(dbPath).map(r => r.route)).toEqual([`POST /members/${D}`, `POST /members/${D}`]);
});

test("approvals: an empty body is refused; a member's approval keeps its first time; an unknown plan is 404", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port);
	const id = planId();
	expect(await call(port, "POST", `/approve/${id}`, A_PEER)).toEqual({ status: 400, body: { error: "body must be a JSON object" } });
	expect(readRows(dbPath, "SELECT plan_id FROM approvals")).toEqual([]);
	expect(await call(port, "POST", `/approve/${id}`, B_PEER, { login: C })).toEqual({ status: 200, body: { approval: { plan: id, login: B, time: T0 } } });
	now = T0 + 5;
	expect(await call(port, "POST", `/approve/${id}`, B_PEER, {})).toEqual({ status: 200, body: { approval: { plan: id, login: B, time: T0 } } });
	expect(readRows(dbPath, "SELECT plan_id, login, time FROM approvals")).toEqual([{ plan_id: id, login: B, time: T0 }]);
	expect(await call(port, "POST", "/approve/nosuch", B_PEER, {})).toEqual({ status: 404, body: { error: "no such plan" } });
	expect(auditRows(dbPath).filter(r => r.route === `POST /approve/${id}`)).toEqual([
		{ login: B, route: `POST /approve/${id}`, plan_id: id },
		{ login: B, route: `POST /approve/${id}`, plan_id: id },
	]);
});

test("plan order: bad ids are named one at a time; a valid vote replaces the last one", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port);
	await seedPlan(port, REL2);
	const id = planId();
	const other = planId(REL2);
	const bad: [unknown, string][] = [
		[{ ranks: { nosuch: 1 } }, "ranks.nosuch is not a stored plan"],
		[{ ranks: { [id]: 0 } }, `ranks.${id} must be a whole number from 1 to 500`],
		[{ ranks: { [id]: 501 } }, `ranks.${id} must be a whole number from 1 to 500`],
		[{ ranks: { [id]: 1.5 } }, `ranks.${id} must be a whole number from 1 to 500`],
		[{ ranks: { [id]: "1" } }, `ranks.${id} must be a whole number from 1 to 500`],
		[{ ranks: {} }, "ranks must hold 1 to 500 plan ids"],
		[{ ranks: [id] }, "ranks must be an object of plan id to rank"],
		[{}, "ranks must be an object of plan id to rank"],
	];
	const replies = await Promise.all(bad.map(([body]) => call(port, "POST", "/order", C_PEER, body)));
	expect(replies).toEqual(bad.map(([, error]) => ({ status: 400, body: { error } })));
	expect(await call(port, "POST", "/order", C_PEER, { ranks: { [id]: 1 } })).toEqual({ status: 200, body: { vote: { login: C, ranks: { [id]: 1 }, time: T0 } } });
	now = T0 + 3;
	expect((await call(port, "POST", "/order", C_PEER, { ranks: { [other]: 2, [id]: 1 } })).status).toBe(200);
	expect(readRows(dbPath, "SELECT login, plan_id, rank, time FROM vote_ranks ORDER BY rank")).toEqual([
		{ login: C, plan_id: id, rank: 1, time: T0 + 3 },
		{ login: C, plan_id: other, rank: 2, time: T0 + 3 },
	]);
	expect(auditRows(dbPath).filter(r => r.route === "POST /order")).toHaveLength(2);
});

test("the leader's order override is stored in meta and audited", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port);
	const id = planId();
	expect(await call(port, "POST", "/order/override", B_PEER, { plan_ids: [id] })).toEqual({
		status: 200,
		body: { override: { plan_ids: [id], login: B, time: T0 } },
	});
	const meta = readRows<{ value: string }>(dbPath, "SELECT value FROM meta WHERE key = 'order_override'");
	expect(JSON.parse(meta[0]?.value ?? "null")).toEqual({ plan_ids: [id], login: B, time: T0 });
	expect(auditRows(dbPath).filter(r => r.route === "POST /order/override")).toEqual([{ login: B, route: "POST /order/override", plan_id: null }]);
});

test("pause and resume: each member has one pause row, and resume clears only their own", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	expect(await call(port, "POST", "/pause", C_PEER, {})).toEqual({ status: 200, body: { paused: true } });
	expect(await call(port, "POST", "/pause", A_PEER, {})).toEqual({ status: 200, body: { paused: true } });
	expect(readRows(dbPath, "SELECT login FROM paused ORDER BY login")).toEqual([{ login: A }, { login: C }]);
	expect(await call(port, "POST", "/resume", C_PEER, {})).toEqual({ status: 200, body: { paused: false } });
	expect(readRows(dbPath, "SELECT login FROM paused ORDER BY login")).toEqual([{ login: A }]);
	expect(await call(port, "POST", "/resume", C_PEER, {})).toEqual({ status: 200, body: { paused: false } });
	expect(readRows(dbPath, "SELECT login FROM paused ORDER BY login")).toEqual([{ login: A }]);
	expect(auditRows(dbPath).map(r => r.route)).toEqual(["POST /pause", "POST /pause", "POST /resume", "POST /resume"]);
});

test("removing a member frees their claims, keeps their approvals, and cuts off their next request", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port);
	const id = planId();
	expect((await call(port, "POST", `/claims/${id}`, C_PEER, claimBody("m-c"))).status).toBe(200);
	expect((await call(port, "POST", `/approve/${id}`, C_PEER, {})).status).toBe(200);
	expect(await call(port, "DELETE", `/members/${C}`, A_PEER)).toEqual({ status: 200, body: { removed: C, claimsFreed: 1 } });
	expect(await call(port, "GET", `/claims/${id}`, A_PEER)).toEqual({ status: 200, body: { claim: null } });
	expect(readRows(dbPath, "SELECT id FROM claims")).toEqual([]);
	expect(readRows(dbPath, "SELECT login FROM approvals")).toEqual([{ login: C }]);
	expect(await call(port, "GET", "/health", C_PEER)).toEqual({ status: 403, body: { error: "forbidden: not a team member" } });
});

test("GET /audit is admin-only and returns rows newest first; the write sequence is recorded in order", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port);
	const before = auditRows(dbPath).length;
	const id = planId();
	await call(port, "POST", "/members", A_PEER, { login: D });
	await call(port, "POST", `/approve/${id}`, B_PEER, {});
	await call(port, "POST", "/order", C_PEER, { ranks: { [id]: 1 } });
	await call(port, "POST", "/order/override", B_PEER, { plan_ids: [id] });
	await call(port, "POST", "/pause", C_PEER, {});
	await call(port, "POST", "/resume", C_PEER, {});
	await call(port, "DELETE", `/members/${D}`, A_PEER);
	expect(auditRows(dbPath).slice(before).map(r => r.route)).toEqual([
		`POST /members/${D}`,
		`POST /approve/${id}`,
		"POST /order",
		"POST /order/override",
		"POST /pause",
		"POST /resume",
		`DELETE /members/${D}`,
	]);
	const audit = await call(port, "GET", "/audit", A_PEER);
	expect(audit.status).toBe(200);
	const rows = audit.body.audit as AuditEntry[];
	expect(rows.map(r => r.route)).toEqual(auditRows(dbPath).map(r => r.route).toReversed());
	expect(rows[0]?.route).toBe(`DELETE /members/${D}`);
});

test("a removed member stays out after a restart", async () => {
	const { svc, dbPath } = start();
	expect((await call(svc.port, "DELETE", `/members/${C}`, A_PEER)).status).toBe(200);
	svc.stop();
	const again = serve(dbPath);
	expect((await call(again.port, "GET", "/health", C_PEER)).status).toBe(403);
	expect(listTeamMembers(dbPath)).toEqual([A, B]);
});

test("a member removed from the host stays out after a restart", async () => {
	const { svc, dbPath } = start();
	svc.stop();
	expect(removeTeamMember(dbPath, CFG, C)).toEqual({ ok: true, claimsFreed: 0 });
	const again = serve(dbPath);
	expect((await call(again.port, "GET", "/health", C_PEER)).status).toBe(403);
	expect(listTeamMembers(dbPath)).toEqual([A, B]);
});

test("a login added to config.members after the first start is not a member", async () => {
	const { svc, dbPath } = start();
	svc.stop();
	const again = serve(dbPath, { ...CFG, members: [A, B, C, D] });
	expect((await call(again.port, "GET", "/health", D_PEER)).status).toBe(403);
	expect(listTeamMembers(dbPath)).toEqual([A, B, C]);
});

test("the first start seeds config.admin even when config.members omits it", async () => {
	const { svc, dbPath } = start({ ...CFG, members: [B, C] });
	expect(listTeamMembers(dbPath)).toEqual([A, B, C]);
	expect((await call(svc.port, "GET", "/health", A_PEER)).status).toBe(200);
});

test("changing config.admin moves the admin role on restart; the new admin can remove the old one", async () => {
	const { svc, dbPath } = start();
	svc.stop();
	const dee = serve(dbPath, { ...CFG, admin: D });
	expect((await call(dee.port, "GET", "/audit", D_PEER)).status).toBe(200);
	expect(await call(dee.port, "GET", "/audit", A_PEER)).toEqual({ status: 403, body: { error: ADMIN_ONLY } });
	expect((await call(dee.port, "GET", "/health", A_PEER)).status).toBe(200);
	expect((await call(dee.port, "DELETE", `/members/${A}`, D_PEER)).status).toBe(200);
	dee.stop();
	const after = serve(dbPath, { ...CFG, admin: D });
	expect((await call(after.port, "GET", "/health", A_PEER)).status).toBe(403);
	expect(listTeamMembers(dbPath)).toEqual([B, C, D]);
});

test("the host exports change membership on a running server's database", async () => {
	const { svc, dbPath } = start();
	expect(addTeamMember(dbPath, CFG, D)).toEqual({ ok: true, added: true });
	expect((await call(svc.port, "GET", "/health", D_PEER)).status).toBe(200);
	expect(listTeamMembers(dbPath)).toEqual([A, B, C, D]);
	expect(addTeamMember(dbPath, CFG, "has space")).toEqual({ ok: false, error: LOGIN_ERROR });
	expect(removeTeamMember(dbPath, CFG, D)).toEqual({ ok: true, claimsFreed: 0 });
	expect((await call(svc.port, "GET", "/health", D_PEER)).status).toBe(403);
	expect(listTeamMembers(dbPath)).toEqual([A, B, C]);
	expect(removeTeamMember(dbPath, CFG, "nobody")).toEqual({ ok: false, error: "no such member" });
	expect(auditRows(dbPath).map(r => r.route)).toEqual([`POST /members/${D}`, `DELETE /members/${D}`]);
});

// --- P4a: GET /view and POST /answer/:id ---

test("a stranger gets 403 on /view and /answer/<id>, and nothing is audited", async () => {
	const { svc, dbPath } = start();
	const replies = await Promise.all([
		call(svc.port, "GET", "/view", S_PEER),
		call(svc.port, "POST", `/answer/${planId()}`, S_PEER, { answer: "yes" }),
	]);
	expect(replies.map(r => r.status)).toEqual([403, 403]);
	expect(auditRows(dbPath)).toEqual([]);
});

test("GET /view returns the plans with text, the team's claims and P2c's four tables in one answer", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	const putSha = await seedPlan(port);
	const id = planId();
	expect((await call(port, "POST", `/claims/${id}`, B_PEER, claimBody("m-b"))).status).toBe(200);
	expect((await call(port, "POST", `/approve/${id}`, B_PEER, {})).status).toBe(200);
	expect((await call(port, "POST", "/order", A_PEER, { ranks: { [id]: 1 } })).status).toBe(200);
	expect((await call(port, "POST", "/pause", C_PEER, {})).status).toBe(200);
	expect((await call(port, "POST", `/answer/${id}`, A_PEER, { answer: "yes" })).status).toBe(200);
	const claims = (await call(port, "GET", "/claims", C_PEER)).body.claims as unknown[];
	expect(claims).toEqual([{ plan: id, main: "m-b", host: "laptop", pid: 4242, since: T0, beat: T0, login: B, mine: false }]);
	expect(await call(port, "GET", "/view", C_PEER)).toEqual({
		status: 200,
		body: {
			plans: [{ id, remote: "gitlab.com/acme/pm", rel_path: REL, sha: putSha, text: TEAM_TEXT, updated_by: A, updated_at: T0 }],
			claims,
			approvals: [{ plan: id, login: B, time: T0 }],
			votes: [{ login: A, plan_id: id, rank: 1, time: T0 }],
			override: null,
			paused: [{ login: C, time: T0 }],
			answers: [{ id: 1, plan: id, login: A, time: T0, sha: putSha, answer: "yes" }],
			first: [],
			me_paused: true,
		},
	});
	expect((await call(port, "POST", "/order/override", B_PEER, { plan_ids: [id] })).status).toBe(200);
	const after = await call(port, "GET", "/view", C_PEER);
	expect(after.body.override).toEqual({ plan_ids: [id], login: B, time: T0 });
	expect(auditRows(dbPath).map(r => r.route)).not.toContain("GET /view");
});

test("POST /answer stores the whois login, the trimmed answer and the plan's sha; bad answers leave no row and no audit", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	const putSha = await seedPlan(port);
	const id = planId();
	expect(await call(port, "POST", `/answer/${id}`, B_PEER, { answer: " yes ", login: C })).toEqual({
		status: 200,
		body: { answer: { id: 1, plan: id, login: B, time: T0, sha: putSha, answer: "yes" }, earlier: null },
	});
	expect(readRows(dbPath, "SELECT plan_id, login, time, sha, answer FROM answers")).toEqual([
		{ plan_id: id, login: B, time: T0, sha: putSha, answer: "yes" },
	]);
	expect(auditRows(dbPath).filter(r => r.route === `POST /answer/${id}`)).toEqual([{ login: B, route: `POST /answer/${id}`, plan_id: id }]);
	// Without the cap on the server, tooLong would be stored: this 400 is the only thing that stops it.
	const bad = [{ answer: "a".repeat(2001) }, { answer: "   " }, { answer: "" }, { answer: 5 }, {}];
	const refused = await Promise.all(bad.map(body => call(port, "POST", `/answer/${id}`, A_PEER, body)));
	expect(refused).toEqual(bad.map(() => ({ status: 400, body: { error: "answer must be 1 to 2000 characters" } })));
	expect(await call(port, "POST", `/answer/${id}`, A_PEER, "not json")).toEqual({ status: 400, body: { error: "body must be a JSON object" } });
	expect(await call(port, "POST", "/answer/nosuch", A_PEER, { answer: "yes" })).toEqual({ status: 404, body: { error: "no such plan" } });
	expect(await call(port, "POST", "/answer/%E0%A4%A", A_PEER, { answer: "yes" })).toEqual({ status: 400, body: { error: "bad plan id" } });
	expect(readRows(dbPath, "SELECT id FROM answers")).toEqual([{ id: 1 }]);
	expect(auditRows(dbPath).map(r => r.route)).toEqual([`PUT /plans/${id}`, `POST /answer/${id}`]);
});

test("answers are capped at 60 a minute per login: the 61st is 429 with no answer row and no audit row", async () => {
	const { svc, dbPath } = start();
	const port = svc.port;
	await seedPlan(port, REL, C_PEER); // C's write slot, so A's window is untouched
	const id = planId();
	const replies = await Array.from({ length: 61 }, (_, i) => i).reduce<Promise<Reply[]>>(async (acc, i) => {
		const out = await acc;
		out.push(await call(port, "POST", `/answer/${id}`, A_PEER, { answer: `a${i}` }));
		return out;
	}, Promise.resolve([]));
	expect(replies.slice(0, 60).map(r => r.status)).toEqual(Array.from({ length: 60 }, () => 200));
	expect(replies[60]).toEqual({ status: 429, body: { error: "too many writes" } });
	expect(readRows(dbPath, "SELECT id FROM answers")).toHaveLength(60);
	expect(auditRows(dbPath).filter(r => r.route === `POST /answer/${id}`)).toHaveLength(60);
});

test("a GET /view over the client's 8 MB defaultSend cap is sent whole and the client fails closed on it", async () => {
	const childServer = join(dir, "cap-server.ts");
	writeFileSync(
		childServer,
		`import { startTeamServer } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core", "team-server.ts"))};
const whois = ${JSON.stringify(Object.fromEntries(LOGINS))};
const svc = startTeamServer({
	tailscale: {
		ip4: () => ${JSON.stringify(OWN_IP)},
		dnsName: () => ${JSON.stringify(DNS_NAME)},
		whois: (peer: string) => whois[peer] ?? null,
		logins: () => ${JSON.stringify([...LOGINS.values()])},
		state: () => "running",
	},
	config: ${JSON.stringify(CFG)},
	dbPath: process.argv[2]!,
	port: 0,
	hostname: ${JSON.stringify(LOOPBACK)},
	peerOf: (req: Request) => req.headers.get("x-test-peer") ?? "",
	clock: () => ${T0},
	claimTtlMin: ${TTL_MIN},
});
console.log(svc.port);
`,
	);
	const dbPath = join(dir, `${++n}.sqlite`);
	// A child server: the test must block in spawnSync to observe the transport's cap.
	const child = Bun.spawn([process.execPath, childServer, dbPath], { stdout: "pipe", stderr: "pipe" });
	try {
		const reader = child.stdout!.getReader();
		const first = await reader.read();
		await reader.cancel();
		const port = Number(new TextDecoder().decode(first.value ?? new Uint8Array()).trim());
		expect(port).toBeGreaterThan(0);
		const text = `Queue: team\n${"x".repeat(256 * 1024 - 12)}`; // the server's 256 KiB plan cap
		const seeded = await Promise.all(
			Array.from({ length: 33 }, (_, i) => {
				const rel = `docs/plans/big-${i}.md`;
				return call(port, "PUT", `/plans/${planId(rel)}`, A_PEER, { remote: REMOTE, rel_path: rel, text, base_sha: null });
			}),
		);
		expect(seeded.map(r => r.status)).toEqual(Array.from({ length: 33 }, () => 200));
		const view = await call(port, "GET", "/view", C_PEER);
		expect(view.status).toBe(200);
		const texts = (view.body.plans as { text: string }[]).map(plan => plan.text);
		expect(texts).toHaveLength(33);
		expect(texts.reduce((sum, t) => sum + t.length, 0)).toBeGreaterThan(8 * 1024 * 1024);
		// The client's transport (team-client.ts defaultSend: one child, maxBuffer 8 MB) cannot read that answer: the child hits ENOBUFS, which askRaw treats as an error, so the team reads as unreachable (fail closed) — never a truncated view.
		const wired = { url: `http://${LOOPBACK}:${port}/view`, method: "GET", headers: { host: `${OWN_IP}:${port}`, "x-test-peer": C_PEER } };
		const sent = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "core", "team-client.ts")], {
			input: JSON.stringify(wired),
			timeout: 5_000,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});
		expect(String(sent.error)).toContain("ENOBUFS");
	} finally {
		child.kill();
		await child.exited;
	}
}, 30_000);
