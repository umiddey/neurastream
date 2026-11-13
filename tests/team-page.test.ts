// Team page (plan 20261027_1305 P5): GET / renders the team's plans, questions and audit for the
// caller; its plain forms write through the same gates as the JSON routes. Injected whois, a
// per-request peer, a fixed clock and a temp SQLite file on port 0. No real tailnet, no home directory.

import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopback } from "../src/core/owner-ui.ts";
import type { Tailscale } from "../src/core/tailscale.ts";
import { startTeamServer, teamPlanId, type TeamServer, type TeamServerConfig } from "../src/core/team-server.ts";

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
const ALPHA_TEXT = "Queue: team\n\n# Alpha plan\n\n## Goal\nShip alpha.\n\n## Progress\nStatus: open\n";
const WAITING_TEXT = "Queue: team\n\n# Beta plan\n\nWAITING on owner: Which database?\n\n## Goal\nShip beta.\n\n## Progress\nStatus: open\n";
const TTL_MIN = 30;
const T0 = 1_700_000_000;

const ADMIN_REMOVE = "the admin login cannot be removed";
const LOGIN_ERROR = "login must be 1 to 256 characters with no whitespace or control character";

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
		if (peer === OWN_IP || isLoopback(peer)) throw new Error("whois must not run for this machine");
		return LOGINS.get(peer) ?? null;
	},
	logins: () => [A, B, C, D],
	state: () => "running",
};

const dir = mkdtempSync(join(tmpdir(), "team-page-"));
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

function start(): { svc: TeamServer; dbPath: string } {
	const dbPath = join(dir, `${++n}.sqlite`);
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
	return { svc, dbPath };
}

interface Raw {
	status: number;
	type: string;
	csp: string;
	location: string;
	text: string;
}

interface Opts {
	form?: Record<string, string>;
	json?: unknown;
	accept?: string;
	origin?: boolean;
}

/** One request from a tailnet peer, returned as raw text. A form is sent urlencoded, as the page's forms send it. */
function raw(port: number, method: string, path: string, peer: string, opts: Opts = {}): Promise<Raw> {
	const host = `${OWN_IP}:${port}`;
	const headers: Record<string, string> = { host, "x-test-peer": peer };
	if (method !== "GET" && opts.origin !== false) headers.origin = `http://${host}`;
	if (opts.accept !== undefined) headers.accept = opts.accept;
	let payload: string | undefined;
	if (opts.form !== undefined) {
		payload = new URLSearchParams(opts.form).toString();
		headers["content-type"] = "application/x-www-form-urlencoded";
	} else if (opts.json !== undefined) {
		payload = JSON.stringify(opts.json);
		headers["content-type"] = "application/json";
	}
	const { promise, resolve, reject } = Promise.withResolvers<Raw>();
	const req = request({ host: LOOPBACK, port, method, path, headers }, res => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () =>
			resolve({
				status: res.statusCode ?? 0,
				type: String(res.headers["content-type"] ?? ""),
				csp: String(res.headers["content-security-policy"] ?? ""),
				location: String(res.headers.location ?? ""),
				text: Buffer.concat(chunks).toString(),
			}),
		);
	});
	req.on("error", reject);
	req.end(payload);
	return promise;
}

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

/** Seeds one team plan through the JSON PUT route as admin and returns its id. */
async function seed(port: number, rel: string, text: string): Promise<string> {
	const id = teamPlanId(REMOTE, rel);
	if (!id) throw new Error("remote did not parse");
	const res = await raw(port, "PUT", `/plans/${id}`, A_PEER, {
		json: { remote: REMOTE, rel_path: rel, text, base_sha: null },
	});
	expect(res.status).toBe(200);
	return id;
}

async function seedTeam(port: number): Promise<{ alpha: string; waiting: string }> {
	const alpha = await seed(port, REL, ALPHA_TEXT);
	const waiting = await seed(port, REL2, WAITING_TEXT);
	return { alpha, waiting };
}

test("GET / shows a member the team's plans, the waiting question and Approve forms, with no admin cards", async () => {
	const { svc } = start();
	const { alpha, waiting } = await seedTeam(svc.port);
	const res = await raw(svc.port, "GET", "/", C_PEER);
	expect(res.status).toBe(200);
	expect(res.type).toStartWith("text/html");
	expect(res.csp).toContain("script-src 'nonce-");
	expect(res.text).toContain("Alpha plan");
	expect(res.text).toContain("Beta plan");
	expect(res.text).toContain("Which database?");
	expect(res.text).toContain(`action="/answer"`);
	expect(res.text).toContain(`value="${waiting}"`);
	expect(res.text).toContain(`action="/approve"`);
	expect(res.text).toContain(`value="${alpha}"`);
	expect(res.text).not.toContain("<h2>Audit");
	expect(res.text).not.toContain(`action="/member"`);
});

test("the admin also sees the audit card, the add-member form and remove buttons for everyone but itself", async () => {
	const { svc } = start();
	await seedTeam(svc.port);
	const res = await raw(svc.port, "GET", "/", A_PEER);
	expect(res.status).toBe(200);
	expect(res.text).toContain("<h2>Audit");
	expect(res.text).toContain(`action="/member"`);
	expect(res.text).toContain(`name="op" value="add"`);
	expect(res.text.split(`value="remove"`)).toHaveLength(3);
});

test("strangers and logged-in non-members get 403 on the page and on its writes, and nothing is written", async () => {
	const { svc, dbPath } = start();
	const { alpha } = await seedTeam(svc.port);
	const outsiders = await Promise.all(
		[S_PEER, D_PEER].map(async peer => ({
			page: await raw(svc.port, "GET", "/", peer),
			write: await raw(svc.port, "POST", "/approve", peer, { form: { plan: alpha } }),
		})),
	);
	for (const { page, write } of outsiders) {
		expect(page.status).toBe(403);
		expect(page.text).not.toContain("Alpha plan");
		expect(write.status).toBe(403);
	}
	expect(readRows(dbPath, "SELECT plan_id FROM approvals")).toEqual([]);
});

test("POST /approve from the page: a form gets a 303 back to the page, a JSON client gets JSON, a missing Origin is refused", async () => {
	const { svc, dbPath } = start();
	const { alpha } = await seedTeam(svc.port);
	const form = await raw(svc.port, "POST", "/approve", B_PEER, { form: { plan: alpha } });
	expect(form.status).toBe(303);
	expect(form.location).toBe("/");
	const asJson = await raw(svc.port, "POST", "/approve", C_PEER, { form: { plan: alpha }, accept: "application/json" });
	expect(asJson.status).toBe(200);
	expect(JSON.parse(asJson.text)).toMatchObject({ ok: true, sent: "approve" });
	const noOrigin = await raw(svc.port, "POST", "/approve", A_PEER, { form: { plan: alpha }, origin: false });
	expect(noOrigin.status).toBe(403);
	expect(readRows(dbPath, "SELECT plan_id, login FROM approvals ORDER BY login")).toEqual([
		{ plan_id: alpha, login: B },
		{ plan_id: alpha, login: C },
	]);
	expect(auditRows(dbPath).filter(r => r.plan_id === alpha && r.route.startsWith("POST /approve")).map(r => r.login)).toEqual([B, C]);
	const page = await raw(svc.port, "GET", "/", A_PEER);
	expect(page.text).toContain("approved by bob, cy");
});

test("POST /answer from the page: answer_text wins over answer, and a bad length leaves no row", async () => {
	const { svc, dbPath } = start();
	const { waiting } = await seedTeam(svc.port);
	const ok = await raw(svc.port, "POST", "/answer", C_PEER, { form: { plan: waiting, answer_text: "Postgres", answer: "ignored" } });
	expect(ok.status).toBe(303);
	expect(readRows(dbPath, "SELECT plan_id, login, answer FROM answers")).toEqual([{ plan_id: waiting, login: C, answer: "Postgres" }]);
	const long = await raw(svc.port, "POST", "/answer", C_PEER, { form: { plan: waiting, answer_text: "a".repeat(2001) } });
	expect(long.status).toBe(400);
	expect(long.text).toContain("answer must be 1 to 2000 characters");
	const blank = await raw(svc.port, "POST", "/answer", C_PEER, { form: { plan: waiting, answer_text: "   " } });
	expect(blank.status).toBe(400);
	expect(readRows(dbPath, "SELECT id FROM answers")).toHaveLength(1);
	const fallback = await raw(svc.port, "POST", "/answer", B_PEER, { form: { plan: waiting, answer: "Sqlite" } });
	expect(fallback.status).toBe(200);
	expect(fallback.text).toContain(`answer kept; an earlier answer by ${C} at `);
	expect(fallback.text).toContain(`won: "Postgres"`);
	expect(readRows(dbPath, "SELECT login, answer FROM answers ORDER BY id")).toEqual([
		{ login: C, answer: "Postgres" },
		{ login: B, answer: "Sqlite" },
	]);
});

test("POST /member: the admin adds and removes members; a member is refused and audited; the admin cannot remove itself", async () => {
	const { svc, dbPath } = start();
	const add = await raw(svc.port, "POST", "/member", A_PEER, { form: { op: "add", login: D } });
	expect(add.status).toBe(303);
	expect(readRows(dbPath, "SELECT login FROM members ORDER BY login")).toEqual([{ login: A }, { login: B }, { login: C }, { login: D }]);
	const refused = await raw(svc.port, "POST", "/member", B_PEER, { form: { op: "add", login: "eve" } });
	expect(refused.status).toBe(403);
	expect(auditRows(dbPath).some(r => r.login === B && r.route.includes("POST /member"))).toBe(true);
	expect(readRows(dbPath, "SELECT login FROM members WHERE login = 'eve'")).toEqual([]);
	const bad = await raw(svc.port, "POST", "/member", A_PEER, { form: { op: "add", login: "bad login" } });
	expect(bad.status).toBe(400);
	expect(bad.text).toContain(LOGIN_ERROR);
	const other = await raw(svc.port, "POST", "/member", A_PEER, { form: { op: "toggle", login: D } });
	expect(other.status).toBe(400);
	expect(other.text).toContain("op must be add or remove");
	const rm = await raw(svc.port, "POST", "/member", A_PEER, { form: { op: "remove", login: D } });
	expect(rm.status).toBe(303);
	expect(readRows(dbPath, "SELECT login FROM members ORDER BY login")).toEqual([{ login: A }, { login: B }, { login: C }]);
	const self = await raw(svc.port, "POST", "/member", A_PEER, { form: { op: "remove", login: A } });
	expect(self.status).toBe(409);
	expect(self.text).toContain(ADMIN_REMOVE);
});

test("the page escapes plan titles", async () => {
	const { svc } = start();
	await seed(svc.port, REL, "Queue: team\n\n# <script>x</script>\n\n## Goal\nShip.\n");
	const res = await raw(svc.port, "GET", "/", C_PEER);
	expect(res.status).toBe(200);
	expect(res.text).toContain("&lt;script&gt;x&lt;/script&gt;");
	expect(res.text).not.toContain("<script>x</script>");
});
