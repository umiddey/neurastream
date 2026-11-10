// Team queue server (plan 20261027_1305 P2a; claims P2b). Binds the tailnet address only.
// Every route, health included, checks Host, then the peer, then whois membership,
// then Origin on every write. Plan text is stored only when its header is Queue: team.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { claimExpired } from "./claims.ts";
import { nowSec } from "./clock.ts";
import { MAIN_ID_RE } from "./guards.ts";
import { hostAllowlist, isLoopback, isTailnet, originIsHost, type UiHttpServer } from "./owner-ui.ts";
import { headerField, sha } from "./queue/lib.ts";
import { remotePath } from "./mr-sweep.ts";
import type { Tailscale } from "./tailscale.ts";
import { remoteListed } from "./team-labels.ts";

const BODY_MAX = 1024 * 1024;
const PLAN_MAX = 256 * 1024;
const WRITES_PER_MIN = 60;
const WRITE_METHOD: Record<string, true> = { PUT: true, POST: true, DELETE: true };

export interface TeamServerConfig {
	team: string;
	admin: string;
	leader: string;
	repos: string[];
	members: string[];
}

export interface TeamServerOptions {
	tailscale: Tailscale;
	config: TeamServerConfig;
	/** SQLite file. Tests pass a temp path; nothing here touches a home directory. */
	dbPath: string;
	/** Bind port. Tests pass 0. */
	port: number;
	/** Bind address. Default: tailscale.ip4(). Tests bind a loopback address. */
	hostname?: string;
	peerOf?: (req: Request, server: UiHttpServer) => string;
	clock?: () => number;
	/** Minutes without a heartbeat before a claim may be taken over (`queue.claim_ttl_min`). Required: this server has no default. */
	claimTtlMin: number;
}

export interface TeamServer {
	stop(): void;
	hostname: string;
	port: number;
}

/** Stable id for a plan file: hash of the normalized origin plus the relative path. Null when the origin does not parse. */
export function teamPlanId(remote: string, relPath: string): string | null {
	const path = remotePath(remote);
	if (!path || !relPath) return null;
	return createHash("sha256").update(`${path}\n${relPath}`).digest("hex");
}

function bindsEveryInterface(hostname: string): boolean {
	const octets = hostname.split(".");
	return octets.length === 4 && octets.every(octet => /^0+$/.test(octet));
}

function json(body: unknown, status: number): Response {
	return Response.json(body, { status });
}

function relPathOk(relPath: string): boolean {
	if (!relPath || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("\0")) return false;
	return relPath.split("/").every(seg => seg !== "" && seg !== "..");
}

/** Body bytes, or "too-big" before any JSON parse. A declared length over the cap is refused without reading. */
async function readBody(req: Request): Promise<Uint8Array | "too-big"> {
	const declared = req.headers.get("content-length");
	if (declared !== null) {
		const n = Number(declared);
		if (!Number.isFinite(n) || n < 0 || n > BODY_MAX) return "too-big";
	}
	if (!req.body) return new Uint8Array();
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.byteLength > BODY_MAX) return "too-big";
	return bytes;
}

interface PlanRow {
	sha: string;
	text: string;
	remote: string;
	rel_path: string;
	updated_by: string;
	updated_at: number;
}

interface PutArgs {
	id: string;
	remote: string;
	relPath: string;
	text: string;
	nextSha: string;
	base: string | null;
	login: string;
	now: number;
	route: string;
}

/** One claim row. `id` is the plan id; `login` is the whois login that holds it. */
interface ClaimRow {
	id: string;
	team: string;
	main: string;
	host: string;
	pid: number;
	since: number;
	beat: number;
	login: string;
}

type ClaimOutcome = { status: 200; claim: ClaimRow } | { status: 404 } | { status: 409; held: ClaimRow };
type BeatOutcome = { status: 200; claim: ClaimRow } | { status: 404 } | { status: 403 };
type ReleaseOutcome = { status: 200 } | { status: 404 } | { status: 403 };

/** A claim is the caller's own when both the login and the Main id match. */
function isOwn(row: ClaimRow, login: string, main: string): boolean {
	return row.login === login && row.main === main;
}

/** The claim as the wire shows it. `mine` is true when the caller's login holds it. */
function wireClaim(row: ClaimRow, login: string) {
	return {
		plan: row.id,
		main: row.main,
		host: row.host,
		pid: row.pid,
		since: row.since,
		beat: row.beat,
		login: row.login,
		mine: row.login === login,
	};
}

/** The body as a JSON object, or null when it is not one. */
function jsonObject(body: Uint8Array): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

/** Opens the team database and creates its tables. busy_timeout makes a second writer wait for the lock instead of failing with SQLITE_BUSY. */
export function openTeamDb(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS plans (
			id TEXT PRIMARY KEY,
			team TEXT NOT NULL,
			remote TEXT NOT NULL,
			rel_path TEXT NOT NULL,
			sha TEXT NOT NULL,
			text TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS members (
			login TEXT PRIMARY KEY
		);
		CREATE TABLE IF NOT EXISTS audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			login TEXT NOT NULL,
			time INTEGER NOT NULL,
			route TEXT NOT NULL,
			plan_id TEXT
		);
		CREATE TABLE IF NOT EXISTS claims (
			id TEXT PRIMARY KEY,
			team TEXT NOT NULL,
			main TEXT NOT NULL,
			host TEXT NOT NULL,
			pid INTEGER NOT NULL,
			since INTEGER NOT NULL,
			beat INTEGER NOT NULL,
			login TEXT NOT NULL
		);
	`);
	return db;
}

/** Starts the queue server. Refuses to start with no tailnet address, and never binds every interface. */
export function startTeamServer(opts: TeamServerOptions): TeamServer {
	const { tailscale, config } = opts;
	const hostname = opts.hostname ?? tailscale.ip4();
	if (!hostname) throw new Error("team server: tailscale ip -4 did not answer — is tailscale up?");
	if (bindsEveryInterface(hostname)) throw new Error("team server: refuses to bind every interface");
	const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
	const clock = opts.clock ?? nowSec;
	const hostAllowed = hostAllowlist(tailscale);
	const db = openTeamDb(opts.dbPath);
	const addMember = db.prepare("INSERT OR IGNORE INTO members (login) VALUES (?)");
	for (const login of config.members) addMember.run(login);
	const isMember = db.query<{ ok: number }, [string]>("SELECT 1 AS ok FROM members WHERE login = ?");
	const selectPlan = db.query<PlanRow, [string, string]>("SELECT sha, text, remote, rel_path, updated_by, updated_at FROM plans WHERE id = ? AND team = ?");
	const listPlans = db.query<Omit<PlanRow, "text"> & { id: string }, [string]>(
		"SELECT id, remote, rel_path, sha, updated_by, updated_at FROM plans WHERE team = ? ORDER BY rel_path, id",
	);
	const insertPlan = db.prepare(
		"INSERT INTO plans (id, team, remote, rel_path, sha, text, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const updatePlan = db.prepare(
		"UPDATE plans SET remote = ?, rel_path = ?, sha = ?, text = ?, updated_by = ?, updated_at = ? WHERE id = ? AND team = ?",
	);
	// Audit is insert-only: no update and no delete statement exists for this table.
	const insertAudit = db.prepare("INSERT INTO audit (login, time, route, plan_id) VALUES (?, ?, ?, ?)");
	const writePlan = db.transaction((args: PutArgs): { status: 200; sha: string } | { status: 409; sha: string | null } => {
		const existing = selectPlan.get(args.id, config.team);
		if (!existing) {
			if (args.base !== null) return { status: 409, sha: null };
			insertPlan.run(args.id, config.team, args.remote, args.relPath, args.nextSha, args.text, args.login, args.now);
		} else if (args.base === null || existing.sha !== args.base) {
			return { status: 409, sha: existing.sha };
		} else {
			updatePlan.run(args.remote, args.relPath, args.nextSha, args.text, args.login, args.now, args.id, config.team);
		}
		insertAudit.run(args.login, args.now, args.route, args.id);
		return { status: 200, sha: args.nextSha };
	});
	const planExists = db.query<{ ok: number }, [string, string]>("SELECT 1 AS ok FROM plans WHERE id = ? AND team = ?");
	const selectClaim = db.query<ClaimRow, [string]>("SELECT id, team, main, host, pid, since, beat, login FROM claims WHERE id = ?");
	const listClaims = db.query<ClaimRow, [string]>("SELECT id, team, main, host, pid, since, beat, login FROM claims WHERE team = ? ORDER BY id");
	const replaceClaim = db.prepare("INSERT OR REPLACE INTO claims (id, team, main, host, pid, since, beat, login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const beatClaim = db.prepare("UPDATE claims SET beat = ? WHERE id = ?");
	const deleteClaim = db.prepare("DELETE FROM claims WHERE id = ?");
	// Claim writes run with .immediate (BEGIN IMMEDIATE): the read and the write take the write lock together. Refusals return a status instead of throwing, so their audit row still commits.
	const claimOf = db.transaction((args: { id: string; main: string; host: string; pid: number; login: string; now: number; route: string }): ClaimOutcome => {
		if (!planExists.get(args.id, config.team)) return { status: 404 };
		const cur = selectClaim.get(args.id);
		if (cur && isOwn(cur, args.login, args.main)) {
			beatClaim.run(args.now, args.id);
			insertAudit.run(args.login, args.now, args.route, args.id);
			return { status: 200, claim: { ...cur, beat: args.now } };
		}
		if (cur && !claimExpired(cur, args.now, opts.claimTtlMin)) {
			insertAudit.run(args.login, args.now, `refused ${args.route}`, args.id);
			return { status: 409, held: cur };
		}
		const fresh: ClaimRow = { id: args.id, team: config.team, main: args.main, host: args.host, pid: args.pid, since: args.now, beat: args.now, login: args.login };
		replaceClaim.run(fresh.id, fresh.team, fresh.main, fresh.host, fresh.pid, fresh.since, fresh.beat, fresh.login);
		insertAudit.run(args.login, args.now, args.route, args.id);
		return { status: 200, claim: fresh };
	});
	const beatOf = db.transaction((args: { id: string; main: string; login: string; now: number; route: string }): BeatOutcome => {
		const cur = selectClaim.get(args.id);
		if (!cur) return { status: 404 };
		if (!isOwn(cur, args.login, args.main)) {
			insertAudit.run(args.login, args.now, `refused ${args.route}`, args.id);
			return { status: 403 };
		}
		beatClaim.run(args.now, args.id);
		return { status: 200, claim: { ...cur, beat: args.now } };
	});
	const releaseOf = db.transaction((args: { id: string; main: string; login: string; now: number; route: string }): ReleaseOutcome => {
		const cur = selectClaim.get(args.id);
		if (!cur) return { status: 404 };
		if (!isOwn(cur, args.login, args.main)) {
			insertAudit.run(args.login, args.now, `refused ${args.route}`, args.id);
			return { status: 403 };
		}
		deleteClaim.run(args.id);
		insertAudit.run(args.login, args.now, args.route, args.id);
		return { status: 200 };
	});
	const writes = new Map<string, number[]>();
	function takeWriteSlot(login: string, now: number): boolean {
		const recent = (writes.get(login) ?? []).filter(t => now - t < 60);
		writes.set(login, recent);
		if (recent.length >= WRITES_PER_MIN) return false;
		recent.push(now);
		return true;
	}

	/** Claim routes: POST /claims/:id takes or refreshes, POST /claims/:id/beat heartbeats, DELETE /claims/:id releases, GET /claims/:id reads. */
	async function claimRoute(req: Request, id: string, beat: boolean, login: string): Promise<Response> {
		if (req.method === "GET") {
			if (beat) return json({ error: "not found" }, 404);
			if (!planExists.get(id, config.team)) return json({ error: "no such plan" }, 404);
			const row = selectClaim.get(id);
			if (!row || claimExpired(row, clock(), opts.claimTtlMin)) return json({ claim: null }, 200);
			return json({ claim: wireClaim(row, login) }, 200);
		}
		let op: "claim" | "beat" | "release";
		if (req.method === "POST") op = beat ? "beat" : "claim";
		else if (req.method === "DELETE" && !beat) op = "release";
		else return json({ error: "not found" }, 404);
		const body = await readBody(req);
		if (body === "too-big") return json({ error: "body too large" }, 413);
		const now = clock();
		if (!takeWriteSlot(login, now)) return json({ error: "too many writes" }, 429);
		const fields = jsonObject(body);
		if (!fields) return json({ error: "body must be a JSON object" }, 400);
		const main = fields.main;
		if (typeof main !== "string" || !MAIN_ID_RE.test(main)) return json({ error: "main must be a valid main id" }, 400);
		if (op === "claim") {
			const { host, pid } = fields;
			if (typeof host !== "string" || host.length < 1 || host.length > 253) return json({ error: "host must be 1 to 253 characters" }, 400);
			if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return json({ error: "pid must be a positive integer" }, 400);
			const out = claimOf.immediate({ id, main, host, pid, login, now, route: `POST /claims/${id}` });
			if (out.status === 404) return json({ error: "no such plan" }, 404);
			if (out.status === 409) return json({ heldBy: wireClaim(out.held, login) }, 409);
			return json({ claim: wireClaim(out.claim, login) }, 200);
		}
		if (op === "beat") {
			const out = beatOf.immediate({ id, main, login, now, route: `POST /claims/${id}/beat` });
			if (out.status === 404) return json({ error: "no such claim" }, 404);
			if (out.status === 403) return json({ error: "forbidden: claim belongs to another main" }, 403);
			return json({ claim: wireClaim(out.claim, login) }, 200);
		}
		const out = releaseOf.immediate({ id, main, login, now, route: `DELETE /claims/${id}` });
		if (out.status === 404) return json({ error: "no such claim" }, 404);
		if (out.status === 403) return json({ error: "forbidden: claim belongs to another main" }, 403);
		return json({ ok: true }, 200);
	}
	let server: { stop(closeActiveConnections?: boolean): void; port?: number };
	try {
		server = Bun.serve({
			hostname,
			port: opts.port,
			maxRequestBodySize: BODY_MAX + 1,
			fetch: async (req, srv) => {
				const url = new URL(req.url);
				const hostHeader = req.headers.get("host") ?? "";
				try {
					if (!hostAllowed(hostHeader, srv.port)) return json({ error: "forbidden: host is not this server" }, 403);
					const peer = peerOf(req, srv);
					if (isLoopback(peer)) return json({ error: "forbidden: loopback peer" }, 403);
					if (!isTailnet(peer)) return json({ error: "forbidden: peer is not a tailnet address" }, 403);
					const own = tailscale.ip4();
					if (own !== null && peer === own) return json({ error: "forbidden: this machine's own tailnet address" }, 403);
					const login = tailscale.whois(peer);
					if (!login) return json({ error: "forbidden: tailscale whois failed" }, 403);
					if (!isMember.get(login)) return json({ error: "forbidden: not a team member" }, 403);
					if (WRITE_METHOD[req.method] && !originIsHost(req.headers.get("origin"), hostHeader)) {
						return json({ error: "forbidden: origin is not this server" }, 403);
					}
					if (req.method === "GET" && url.pathname === "/health") return json({ ok: true }, 200);
					if (req.method === "GET" && url.pathname === "/plans") return json({ plans: listPlans.all(config.team) }, 200);
					const idMatch = /^\/plans\/([^/]+)$/.exec(url.pathname);
					let planId: string | null = null;
					if (idMatch?.[1]) {
						try {
							planId = decodeURIComponent(idMatch[1]);
						} catch {
							return json({ error: "bad plan id" }, 400);
						}
					}
					if (req.method === "GET" && planId !== null) {
						const row = selectPlan.get(planId, config.team);
						if (!row) return json({ error: "not found" }, 404);
						return json({ id: planId, ...row }, 200);
					}
					if (req.method === "GET" && url.pathname === "/claims") {
						return json({ claims: listClaims.all(config.team).map(row => wireClaim(row, login)) }, 200);
					}
					const claimMatch = /^\/claims\/([^/]+)(\/beat)?$/.exec(url.pathname);
					if (claimMatch?.[1]) {
						let claimId: string;
						try {
							claimId = decodeURIComponent(claimMatch[1]);
						} catch {
							return json({ error: "bad plan id" }, 400);
						}
						return await claimRoute(req, claimId, claimMatch[2] !== undefined, login);
					}
					if (!WRITE_METHOD[req.method] || planId === null || req.method !== "PUT") return json({ error: "not found" }, 404);
					const body = await readBody(req);
					if (body === "too-big") return json({ error: "body too large" }, 413);
					const now = clock();
					if (!takeWriteSlot(login, now)) return json({ error: "too many writes" }, 429);
					let parsed: unknown;
					try {
						parsed = JSON.parse(new TextDecoder().decode(body));
					} catch {
						return json({ error: "body is not json" }, 400);
					}
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "body must be an object" }, 400);
					const fields = parsed as Record<string, unknown>;
					const remote = fields.remote;
					const relPath = fields.rel_path;
					const text = fields.text;
					if (typeof remote !== "string" || typeof relPath !== "string" || typeof text !== "string") {
						return json({ error: "remote, rel_path and text are required" }, 400);
					}
					let base: string | null;
					if (!("base_sha" in fields) || fields.base_sha === null || fields.base_sha === "") base = null;
					else if (typeof fields.base_sha !== "string") return json({ error: "base_sha must be a string or null" }, 400);
					else base = fields.base_sha;
					if (!relPathOk(relPath)) return json({ error: "rel_path must be a relative path" }, 400);
					if (new TextEncoder().encode(text).byteLength > PLAN_MAX) return json({ error: "plan too large" }, 413);
					if (headerField(text, "Queue") !== "team") return json({ error: "forbidden: plan is not Queue: team" }, 403);
					const storedRemote = remotePath(remote);
					if (!storedRemote || !remoteListed(remote, config.repos)) return json({ error: "forbidden: remote is not in this team's repos" }, 403);
					const id = teamPlanId(remote, relPath);
					if (id === null || id !== planId) return json({ error: "plan id does not match remote and path" }, 400);
					const written = writePlan.immediate({
						id,
						remote: storedRemote,
						relPath,
						text,
						nextSha: sha(text),
						base,
						login,
						now,
						route: `PUT /plans/${id}`,
					});
					if (written.status === 409) return json({ error: "stale base", sha: written.sha }, 409);
					return json({ id, sha: written.sha }, 200);
				} catch {
					return json({ error: "internal error" }, 500);
				}
			},
		});
	} catch (err) {
		db.close();
		throw err;
	}
	let stopped = false;
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			server.stop(true);
			db.close();
		},
		hostname,
		port: Number(server.port),
	};
}
