// Team queue server (plan 20261027_1305 P2a; claims P2b). Binds the tailnet address only.
// Every route, health included, checks Host, then the peer, then whois membership,
// then Origin on every write. Plan text is stored only when its header is Queue: team.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { claimExpired } from "./claims.ts";
import { nowSec, strftime } from "./clock.ts";
import { MAIN_ID_RE } from "./guards.ts";
import { ANSWER_MAX, fieldsOf, hostAllowlist, isLoopback, isTailnet, jsonFail, jsonSent, originIsHost, pageCsp, renderTeamPage, teamSection, textRes, type UiHttpServer } from "./owner-ui.ts";
import { headerField, parsePlan, sha } from "./queue/lib.ts";
import { remotePath } from "./mr-sweep.ts";
import type { Tailscale } from "./tailscale.ts";
import { viewPlanRows } from "./team-client.ts";
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
	note: string | null;
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

interface AuditRow {
	id: number;
	login: string;
	time: number;
	route: string;
	plan_id: string | null;
}

interface ApprovalRow {
	plan: string;
	login: string;
	time: number;
}

type ClaimOutcome = { status: 200; claim: ClaimRow } | { status: 404 } | { status: 403 } | { status: 409; held: ClaimRow };
type BeatOutcome = { status: 200; claim: ClaimRow } | { status: 404 } | { status: 403 };
type ReleaseOutcome = { status: 200 } | { status: 404 } | { status: 403 };
type ApproveOutcome = { status: 200; approval: ApprovalRow | null } | { status: 404 } | { status: 403 };

/** A claim is the caller's own when both the login and the Main id match. */
function isOwn(row: ClaimRow, login: string, main: string): boolean {
	return row.login === login && row.main === main;
}

/** A claim as the wire shows it. `mine` is true when the caller's login holds it. */
export interface ClaimView {
	plan: string;
	main: string;
	host: string;
	pid: number;
	since: number;
	beat: number;
	login: string;
	mine: boolean;
}

function wireClaim(row: ClaimRow, login: string): ClaimView {
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

/** The form fields of a POST whose body the write gate has already read. */
function formOf(req: Request, body: Uint8Array): Promise<Record<string, string>> {
	return fieldsOf(new Request(req.url, { method: "POST", headers: req.headers, body: new TextDecoder().decode(body) }));
}

/** A JSON client (Accept asks for application/json) gets JSON; the page's scriptless forms get a 303 back to the page. */
function wantsJson(req: Request): boolean {
	return (req.headers.get("accept") ?? "").includes("application/json");
}

function pageDone(req: Request, sent: string): Response {
	return wantsJson(req) ? jsonSent(sent) : new Response(null, { status: 303, headers: { location: "/" } });
}

function pageRefused(req: Request, error: string, status: number): Response {
	return wantsJson(req) ? jsonFail(error, status) : textRes(error, status);
}

/** The reply when an earlier answer to the same question already won: the new answer is kept, and the sender is told who won. */
function earlierReply(req: Request, earlier: FirstAnswer): Response {
	const note = `answer kept; an earlier answer by ${earlier.login} at ${strftime(earlier.time, "%H:%M")} won: "${earlier.answer}"`;
	return wantsJson(req) ? jsonSent(note) : textRes(note, 200);
}

/** A path segment decoded, or null when its percent-encoding is bad. */
function decodeSegment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

const LOGIN_RE = /^[^\s\p{Cc}]{1,256}$/u;
const LOGIN_ERROR = "login must be 1 to 256 characters with no whitespace or control character";
const ADMIN_REMOVE = "the admin login cannot be removed";
const NO_MEMBER = "no such member";
const CROSS_REVIEW = "forbidden: cross review: you last claimed this plan; another member approves it";

function validLogin(login: unknown): login is string {
	return typeof login === "string" && LOGIN_RE.test(login);
}

/** True once the first start has seeded the members table. Before that the team is not initialised. */
function initialised(db: Database): boolean {
	return db.query("SELECT 1 FROM meta WHERE key = 'members_seeded'").get() !== null;
}

function writeAudit(db: Database, login: string, now: number, route: string, planId: string | null): void {
	db.query("INSERT INTO audit (login, time, route, plan_id) VALUES (?, ?, ?, ?)").run(login, now, route, planId);
}

/** Adds a member and audits it. POST /members and addTeamMember both run this. */
function addMemberTx(db: Database, login: string, actor: string, now: number): { added: boolean } {
	return db.transaction((): { added: boolean } => {
		const added = db.query("INSERT OR IGNORE INTO members (login) VALUES (?)").run(login).changes > 0;
		writeAudit(db, actor, now, `POST /members/${login}`, null);
		return { added };
	}).immediate();
}

type RemoveOutcome = { status: 200; claimsFreed: number } | { status: 404 } | { status: 409 };

/** Removes a member with the claims, votes and pause that the login holds for this team. Approvals stay. The admin login is never removed. DELETE /members/:login and removeTeamMember both run this. */
function removeMemberTx(db: Database, config: TeamServerConfig, login: string, actor: string, now: number): RemoveOutcome {
	return db.transaction((): RemoveOutcome => {
		if (login === config.admin) {
			writeAudit(db, actor, now, `refused DELETE /members/${login}`, null);
			return { status: 409 };
		}
		if (!db.query("SELECT 1 FROM members WHERE login = ?").get(login)) return { status: 404 };
		const claimsFreed = db.query("DELETE FROM claims WHERE login = ? AND team = ?").run(login, config.team).changes;
		db.query("DELETE FROM vote_ranks WHERE login = ?").run(login);
		db.query("DELETE FROM paused WHERE login = ?").run(login);
		db.query("DELETE FROM members WHERE login = ?").run(login);
		writeAudit(db, actor, now, `DELETE /members/${login}`, null);
		return { status: 200, claimsFreed };
	}).immediate();
}

/** Adds one column to a table when it is absent. CREATE TABLE IF NOT EXISTS never alters a table an earlier start made, so new columns arrive this way. */
function addColumn(db: Database, table: string, column: string, decl: string): void {
	const have = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
	if (have.some(row => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
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
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS approvals (
			plan_id TEXT NOT NULL,
			login TEXT NOT NULL,
			time INTEGER NOT NULL,
			PRIMARY KEY (plan_id, login)
		);
		CREATE TABLE IF NOT EXISTS vote_ranks (
			login TEXT NOT NULL,
			plan_id TEXT NOT NULL,
			rank INTEGER NOT NULL CHECK (rank >= 1),
			time INTEGER NOT NULL,
			PRIMARY KEY (login, plan_id)
		);
		CREATE TABLE IF NOT EXISTS paused (
			login TEXT PRIMARY KEY,
			time INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS answers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id TEXT NOT NULL,
			login TEXT NOT NULL,
			time INTEGER NOT NULL,
			sha TEXT NOT NULL,
			answer TEXT NOT NULL
		);
	`);
	addColumn(db, "answers", "waiting_key", "TEXT");
	addColumn(db, "audit", "note", "TEXT");
	addColumn(db, "plans", "last_claimer", "TEXT");
	return db;
}

interface AnswerRow {
	id: number;
	plan: string;
	login: string;
	time: number;
	sha: string;
	answer: string;
}

interface FirstAnswer {
	plan: string;
	login: string;
	time: number;
	answer: string;
}

interface PausedRow {
	login: string;
	time: number;
}

interface VoteRow {
	login: string;
	plan_id: string;
	rank: number;
	time: number;
}

interface OverrideRow {
	plan_ids: string[];
	login: string;
	time: number;
}

/** The one read the team page and P4's client render: every plan with its text, the team's claims and P2c's four tables. */
export interface TeamView {
	plans: ({ id: string } & PlanRow)[];
	claims: ClaimView[];
	approvals: ApprovalRow[];
	votes: VoteRow[];
	override: OverrideRow | null;
	paused: PausedRow[];
	answers: AnswerRow[];
	first: FirstAnswer[];
	me_paused: boolean;
}

/** The hash of a plan's current WAITING line: the question an answer is for. Null when the plan waits on nothing. */
function waitingKeyOf(text: string, id: string): string | null {
	const line = parsePlan(".", id, text, undefined, [], false).waitingLine;
	return line === null ? null : sha(line);
}

/** The earliest answer to a plan's current WAITING question, by its waiting key. */
const FIRST_ANSWER_SQL = "SELECT plan_id AS plan, login, time, answer FROM answers WHERE plan_id = ? AND waiting_key = ? ORDER BY id LIMIT 1";

/** Reads a team view in one deferred transaction: one snapshot, nothing written. P5's page calls this in process. */
export function readTeamView(db: Database, team: string, login: string): TeamView {
	return db.transaction((): TeamView => {
		const plans = db
			.query<{ id: string } & PlanRow, [string]>("SELECT id, remote, rel_path, sha, text, updated_by, updated_at FROM plans WHERE team = ? ORDER BY rel_path, id")
			.all(team);
		const claims = db
			.query<ClaimRow, [string]>("SELECT id, team, main, host, pid, since, beat, login FROM claims WHERE team = ? ORDER BY id")
			.all(team)
			.map(row => wireClaim(row, login));
		const approvals = db.query<ApprovalRow, []>("SELECT plan_id AS plan, login, time FROM approvals ORDER BY plan_id, time").all();
		const votes = db.query<VoteRow, []>("SELECT login, plan_id, rank, time FROM vote_ranks ORDER BY login, plan_id").all();
		const override = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'order_override'").get();
		const paused = db.query<PausedRow, []>("SELECT login, time FROM paused ORDER BY login").all();
		const answers = db.query<AnswerRow, []>("SELECT id, plan_id AS plan, login, time, sha, answer FROM answers ORDER BY id DESC LIMIT 500").all();
		const mePaused = db.query<{ ok: number }, [string]>("SELECT 1 AS ok FROM paused WHERE login = ?").get(login) !== null;
		const first: FirstAnswer[] = [];
		for (const plan of plans) {
			const key = waitingKeyOf(plan.text, plan.id);
			const row = key === null ? null : db.query<FirstAnswer, [string, string]>(FIRST_ANSWER_SQL).get(plan.id, key);
			if (row) first.push(row);
		}
		return {
			plans,
			claims,
			approvals,
			votes,
			override: override ? (JSON.parse(override.value) as OverrideRow) : null,
			paused,
			answers,
			first,
			me_paused: mePaused,
		};
	})();
}

/** Starts the queue server. Refuses to start with no tailnet address, and never binds every interface. */
export function startTeamServer(opts: TeamServerOptions): TeamServer {
	const { tailscale, config } = opts;
	const ownAddress = tailscale.ip4();
	const hostname = opts.hostname ?? ownAddress;
	if (!hostname) throw new Error("team server: tailscale ip -4 did not answer — is tailscale up?");
	if (bindsEveryInterface(hostname)) throw new Error("team server: refuses to bind every interface");
	const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
	const clock = opts.clock ?? nowSec;
	const hostAllowed = hostAllowlist(tailscale);
	const db = openTeamDb(opts.dbPath);
	// Step A seeds config.members once, on the first start only (marked by the members_seeded row). Step B upserts config.admin on every start.
	const seed = db.transaction(() => {
		if (!initialised(db)) {
			const addMember = db.prepare("INSERT OR IGNORE INTO members (login) VALUES (?)");
			for (const login of config.members) addMember.run(login);
			db.run("INSERT INTO meta (key, value) VALUES ('members_seeded', '1')");
		}
		db.query("INSERT OR IGNORE INTO members (login) VALUES (?)").run(config.admin);
	});
	seed.immediate();
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
	const insertNoteAudit = db.prepare("INSERT INTO audit (login, time, route, plan_id, note) VALUES (?, ?, ?, ?, ?)");
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
		insertNoteAudit.run(args.login, args.now, args.route, args.id, args.note);
		return { status: 200, sha: args.nextSha };
	});
	const planExists = db.query<{ ok: number }, [string, string]>("SELECT 1 AS ok FROM plans WHERE id = ? AND team = ?");
	const selectClaim = db.query<ClaimRow, [string]>("SELECT id, team, main, host, pid, since, beat, login FROM claims WHERE id = ?");
	const pausedOf = db.query<{ ok: number }, [string]>("SELECT 1 AS ok FROM paused WHERE login = ?");
	const setClaimer = db.prepare("UPDATE plans SET last_claimer = ? WHERE id = ?");
	const claimerOf = db.query<{ last_claimer: string | null }, [string]>("SELECT last_claimer FROM plans WHERE id = ?");
	const memberCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM members");
	const listClaims = db.query<ClaimRow, [string]>("SELECT id, team, main, host, pid, since, beat, login FROM claims WHERE team = ? ORDER BY id");
	const replaceClaim = db.prepare("INSERT OR REPLACE INTO claims (id, team, main, host, pid, since, beat, login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const beatClaim = db.prepare("UPDATE claims SET beat = ? WHERE id = ?");
	const deleteClaim = db.prepare("DELETE FROM claims WHERE id = ?");
	// Claim writes run with .immediate (BEGIN IMMEDIATE): the read and the write take the write lock together. Refusals return a status instead of throwing, so their audit row still commits.
	const claimOf = db.transaction((args: { id: string; main: string; host: string; pid: number; login: string; now: number; route: string }): ClaimOutcome => {
		if (!planExists.get(args.id, config.team)) return { status: 404 };
		if (pausedOf.get(args.login)) {
			insertAudit.run(args.login, args.now, `refused ${args.route}`, args.id);
			return { status: 403 };
		}
		const cur = selectClaim.get(args.id);
		if (cur && isOwn(cur, args.login, args.main)) {
			beatClaim.run(args.now, args.id);
			setClaimer.run(args.login, args.id);
			insertAudit.run(args.login, args.now, args.route, args.id);
			return { status: 200, claim: { ...cur, beat: args.now } };
		}
		if (cur && !claimExpired(cur, args.now, opts.claimTtlMin)) {
			insertAudit.run(args.login, args.now, `refused ${args.route}`, args.id);
			return { status: 409, held: cur };
		}
		const fresh: ClaimRow = { id: args.id, team: config.team, main: args.main, host: args.host, pid: args.pid, since: args.now, beat: args.now, login: args.login };
		replaceClaim.run(fresh.id, fresh.team, fresh.main, fresh.host, fresh.pid, fresh.since, fresh.beat, fresh.login);
		setClaimer.run(args.login, args.id);
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

	const listAudit = db.query<AuditRow, []>("SELECT id, login, time, route, plan_id FROM audit ORDER BY id DESC LIMIT 200");
	const listMembers = db.query<{ login: string }, []>("SELECT login FROM members ORDER BY login");
	const insertApproval = db.prepare("INSERT OR IGNORE INTO approvals (plan_id, login, time) VALUES (?, ?, ?)");
	const selectApproval = db.query<ApprovalRow, [string, string]>("SELECT plan_id AS plan, login, time FROM approvals WHERE plan_id = ? AND login = ?");
	const deleteVotes = db.prepare("DELETE FROM vote_ranks WHERE login = ?");
	const insertVote = db.prepare("INSERT INTO vote_ranks (login, plan_id, rank, time) VALUES (?, ?, ?, ?)");
	const setOverride = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('order_override', ?)");
	const replacePause = db.prepare("INSERT OR REPLACE INTO paused (login, time) VALUES (?, ?)");
	const deletePause = db.prepare("DELETE FROM paused WHERE login = ?");
	// P2c writes run with .immediate, as the claim writes do: each reads, decides, writes and audits in one step.
	const approveOf = db.transaction((id: string, login: string, now: number): ApproveOutcome => {
		if (!planExists.get(id, config.team)) return { status: 404 };
		const last = claimerOf.get(id)?.last_claimer;
		const solo = (memberCount.get()?.n ?? 0) < 2;
		if (last === login && !solo) {
			insertAudit.run(login, now, `refused POST /approve/${id}`, id);
			return { status: 403 };
		}
		insertApproval.run(id, login, now);
		if (last === login) insertNoteAudit.run(login, now, `POST /approve/${id}`, id, "solo");
		else insertAudit.run(login, now, `POST /approve/${id}`, id);
		return { status: 200, approval: selectApproval.get(id, login) };
	});
	// A vote is the member's whole rank map: the old map goes, the new one lands, and one audit row is written, all in one step.
	const voteOf = db.transaction((ranks: [string, number][], login: string, now: number) => {
		deleteVotes.run(login);
		for (const [planId, rank] of ranks) insertVote.run(login, planId, rank, now);
		insertAudit.run(login, now, "POST /order", null);
		return { login, ranks: Object.fromEntries(ranks), time: now };
	});
	const overrideOf = db.transaction((planIds: string[], login: string, now: number) => {
		const override = { plan_ids: planIds, login, time: now };
		setOverride.run(JSON.stringify(override));
		insertAudit.run(login, now, "POST /order/override", null);
		return override;
	});
	const pauseOf = db.transaction((login: string, paused: boolean, now: number) => {
		if (paused) replacePause.run(login, now);
		else deletePause.run(login);
		insertAudit.run(login, now, paused ? "POST /pause" : "POST /resume", null);
	});
	const insertAnswer = db.prepare("INSERT INTO answers (plan_id, login, time, sha, answer, waiting_key) VALUES (?, ?, ?, ?, ?, ?)");
	// The answer keeps the plan's sha when it landed, so a reader can tell an answer to an older version. A `login` in the body is ignored: the whois login is stored, as approve does.
	// Answers are keyed by the WAITING line they answer: the first one to a question is the one that counts. A later answer is still stored; `earlier` names the one that won.
	const answerOf = db.transaction((id: string, login: string, now: number, answer: string) => {
		const plan = selectPlan.get(id, config.team);
		if (!plan) return null;
		const key = waitingKeyOf(plan.text, id);
		const earlier = key === null ? null : db.query<FirstAnswer, [string, string]>(FIRST_ANSWER_SQL).get(id, key);
		const { lastInsertRowid } = insertAnswer.run(id, login, now, plan.sha, answer, key);
		insertAudit.run(login, now, `POST /answer/${id}`, id);
		return { answer: { id: Number(lastInsertRowid), plan: id, login, time: now, sha: plan.sha, answer }, earlier };
	});

	/** plan_ids as a checked list: 1 to 500 distinct ids, each a stored plan of this team. The first bad entry is named. */
	function planIdList(raw: unknown): { ids: string[] } | { error: string } {
		if (!Array.isArray(raw) || raw.length < 1 || raw.length > 500) return { error: "plan_ids must be an array of 1 to 500 plan ids" };
		const seen = new Set<string>();
		for (const [i, id] of raw.entries()) {
			if (typeof id !== "string") return { error: `plan_ids[${i}] must be a string` };
			if (seen.has(id)) return { error: `plan_ids[${i}] repeats ${id}` };
			if (!planExists.get(id, config.team)) return { error: `plan_ids[${i}] is not a stored plan: ${id}` };
			seen.add(id);
		}
		return { ids: raw as string[] };
	}

	/** `ranks` as a checked map: 1 to 500 entries, each key a stored plan of this team and each value a whole number from 1 to 500. The first bad entry is named. */
	function rankList(raw: unknown): { ranks: [string, number][] } | { error: string } {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "ranks must be an object of plan id to rank" };
		const entries = Object.entries(raw);
		if (entries.length < 1 || entries.length > 500) return { error: "ranks must hold 1 to 500 plan ids" };
		for (const [id, rank] of entries) {
			if (!planExists.get(id, config.team)) return { error: `ranks.${id} is not a stored plan` };
			if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || rank > 500) return { error: `ranks.${id} must be a whole number from 1 to 500` };
		}
		return { ranks: entries as [string, number][] };
	}

	/** Head of every POST and DELETE in P2c, in the claim routes' order: body size, write slot, role check (a refusal is audited, body not parsed). The caller parses the body when its route takes one. */
	async function writeGate(req: Request, login: string, need: "admin" | "leader" | "member", refused: string): Promise<{ body: Uint8Array; now: number } | { res: Response }> {
		const body = await readBody(req);
		if (body === "too-big") return { res: json({ error: "body too large" }, 413) };
		const now = clock();
		if (!takeWriteSlot(login, now)) return { res: json({ error: "too many writes" }, 429) };
		const allowed = need === "admin" ? login === config.admin : need === "leader" ? login === config.leader : true;
		if (!allowed) {
			insertAudit.run(login, now, `refused ${refused}`, null);
			return { res: json({ error: `forbidden: ${need} only` }, 403) };
		}
		return { body, now };
	}

	/** P2c routes: audit read, members, approvals, plan order, pause. Null when the request matches none of them. */
	async function memberRoute(req: Request, path: string, login: string): Promise<Response | null> {
		if (req.method === "GET" && path === "/audit") {
			if (login !== config.admin) return json({ error: "forbidden: admin only" }, 403);
			return json({ audit: listAudit.all() }, 200);
		}
		if (req.method === "POST" && path === "/members") {
			const gate = await writeGate(req, login, "admin", "POST /members");
			if ("res" in gate) return gate.res;
			const fields = jsonObject(gate.body);
			if (!fields) return json({ error: "body must be a JSON object" }, 400);
			const member = fields.login;
			if (!validLogin(member)) return json({ error: LOGIN_ERROR }, 400);
			return json({ login: member, added: addMemberTx(db, member, login, gate.now).added }, 200);
		}
		const memberPath = /^\/members\/([^/]+)$/.exec(path);
		if (req.method === "DELETE" && memberPath?.[1]) {
			const target = decodeSegment(memberPath[1]);
			if (target === null) return json({ error: "bad login" }, 400);
			const gate = await writeGate(req, login, "admin", `DELETE /members/${target}`);
			if ("res" in gate) return gate.res;
			const out = removeMemberTx(db, config, target, login, gate.now);
			if (out.status === 409) return json({ error: ADMIN_REMOVE }, 409);
			if (out.status === 404) return json({ error: NO_MEMBER }, 404);
			return json({ removed: target, claimsFreed: out.claimsFreed }, 200);
		}
		const approvePath = /^\/approve\/([^/]+)$/.exec(path);
		if (req.method === "POST" && approvePath?.[1]) {
			const id = decodeSegment(approvePath[1]);
			if (id === null) return json({ error: "bad plan id" }, 400);
			const gate = await writeGate(req, login, "member", `POST /approve/${id}`);
			if ("res" in gate) return gate.res;
			if (!jsonObject(gate.body)) return json({ error: "body must be a JSON object" }, 400);
			const out = approveOf.immediate(id, login, gate.now);
			if (out.status === 404) return json({ error: "no such plan" }, 404);
			if (out.status === 403) return json({ error: CROSS_REVIEW }, 403);
			return json({ approval: out.approval }, 200);
		}
		const answerPath = /^\/answer\/([^/]+)$/.exec(path);
		if (req.method === "POST" && answerPath?.[1]) {
			const id = decodeSegment(answerPath[1]);
			if (id === null) return json({ error: "bad plan id" }, 400);
			const gate = await writeGate(req, login, "member", `POST /answer/${id}`);
			if ("res" in gate) return gate.res;
			const fields = jsonObject(gate.body);
			if (!fields) return json({ error: "body must be a JSON object" }, 400);
			const text = typeof fields.answer === "string" ? fields.answer.trim() : "";
			if (text.length < 1 || text.length > ANSWER_MAX) return json({ error: `answer must be 1 to ${ANSWER_MAX} characters` }, 400);
			const result = answerOf.immediate(id, login, gate.now, text);
			if (!result) return json({ error: "no such plan" }, 404);
			return json({ answer: result.answer, earlier: result.earlier }, 200);
		}
		if (req.method === "POST" && (path === "/order" || path === "/order/override")) {
			const override = path === "/order/override";
			const gate = await writeGate(req, login, override ? "leader" : "member", `POST ${path}`);
			if ("res" in gate) return gate.res;
			const fields = jsonObject(gate.body);
			if (!fields) return json({ error: "body must be a JSON object" }, 400);
			if (override) {
				const checked = planIdList(fields.plan_ids);
				if ("error" in checked) return json({ error: checked.error }, 400);
				return json({ override: overrideOf.immediate(checked.ids, login, gate.now) }, 200);
			}
			const checked = rankList(fields.ranks);
			if ("error" in checked) return json({ error: checked.error }, 400);
			return json({ vote: voteOf.immediate(checked.ranks, login, gate.now) }, 200);
		}
		if (req.method === "POST" && (path === "/pause" || path === "/resume")) {
			const paused = path === "/pause";
			const gate = await writeGate(req, login, "member", `POST ${path}`);
			if ("res" in gate) return gate.res;
			if (!jsonObject(gate.body)) return json({ error: "body must be a JSON object" }, 400);
			pauseOf.immediate(login, paused, gate.now);
			return json({ paused }, 200);
		}
		return null;
	}

	/** The team page's plain forms (P5, P6b1): exact paths /approve, /answer, /member, /vote and /override. Success answers 303 back to the page, or JSON when Accept asks for it. Auth chain and Origin run before this. */
	async function pageRoute(req: Request, path: string, login: string): Promise<Response | null> {
		if (req.method !== "POST") return null;
		if (path === "/approve") {
			const gate = await writeGate(req, login, "member", "POST /approve");
			if ("res" in gate) return gate.res;
			const form = await formOf(req, gate.body);
			const out = approveOf.immediate(form.plan ?? "", login, gate.now);
			if (out.status === 404) return pageRefused(req, "no such plan", 404);
			if (out.status === 403) return pageRefused(req, CROSS_REVIEW, 403);
			return pageDone(req, "approve");
		}
		if (path === "/answer") {
			const gate = await writeGate(req, login, "member", "POST /answer");
			if ("res" in gate) return gate.res;
			const form = await formOf(req, gate.body);
			const text = (form.answer_text ?? form.answer ?? "").trim();
			if (text.length < 1 || text.length > ANSWER_MAX) return pageRefused(req, `answer must be 1 to ${ANSWER_MAX} characters`, 400);
			const result = answerOf.immediate(form.plan ?? "", login, gate.now, text);
			if (!result) return pageRefused(req, "no such plan", 404);
			if (result.earlier) return earlierReply(req, result.earlier);
			return pageDone(req, "answer");
		}
		if (path === "/member") {
			const gate = await writeGate(req, login, "admin", "POST /member");
			if ("res" in gate) return gate.res;
			const form = await formOf(req, gate.body);
			const member = form.login ?? "";
			if (!validLogin(member)) return pageRefused(req, LOGIN_ERROR, 400);
			if (form.op === "add") {
				addMemberTx(db, member, login, gate.now);
				return pageDone(req, "add");
			}
			if (form.op === "remove") {
				const out = removeMemberTx(db, config, member, login, gate.now);
				if (out.status === 409) return pageRefused(req, ADMIN_REMOVE, 409);
				if (out.status === 404) return pageRefused(req, NO_MEMBER, 404);
				return pageDone(req, "remove");
			}
			return pageRefused(req, "op must be add or remove", 400);
		}
		if (path === "/vote") {
			const gate = await writeGate(req, login, "member", "POST /vote");
			if ("res" in gate) return gate.res;
			const form = await formOf(req, gate.body);
			const ranks = Object.fromEntries(Object.entries(form).filter(([key, value]) => key.startsWith("rank:") && value.trim() !== "").map(([key, value]) => [key.slice("rank:".length), Number(value.trim())]));
			const checked = rankList(ranks);
			if ("error" in checked) return pageRefused(req, checked.error, 400);
			voteOf.immediate(checked.ranks, login, gate.now);
			return pageDone(req, "vote");
		}
		if (path === "/override") {
			const gate = await writeGate(req, login, "leader", "POST /override");
			if ("res" in gate) return gate.res;
			const form = await formOf(req, gate.body);
			const picked: [string, number][] = [];
			for (const [key, value] of Object.entries(form)) {
				if (!key.startsWith("pos:") || value.trim() === "") continue;
				const pos = Number(value.trim());
				if (!Number.isInteger(pos)) return pageRefused(req, `${key} must be a whole number`, 400);
				picked.push([key.slice("pos:".length), pos]);
			}
			const ids = picked.toSorted(([idA, posA], [idB, posB]) => posA - posB || (idA < idB ? -1 : idA > idB ? 1 : 0)).map(([id]) => id);
			const checked = planIdList(ids);
			if ("error" in checked) return pageRefused(req, checked.error, 400);
			overrideOf.immediate(checked.ids, login, gate.now);
			return pageDone(req, "override");
		}
		return null;
	}

	/** The team page (P5): one read of the team view, rendered in process. Auth chain only, no write slot, not audited. Audit rows go to the admin only. */
	function teamPage(req: Request, login: string): Response {
		const admin = login === config.admin;
		const rows = viewPlanRows(readTeamView(db, config.team, login), opts.claimTtlMin, clock(), id => id);
		const html = renderTeamPage({
			team: config.team,
			login,
			admin,
			leader: login === config.leader,
			adminLogin: config.admin,
			section: teamSection(config.team, req.headers.get("host") ?? "", rows),
			plans: rows.map(row => ({ id: row.id, relPath: row.relPath, title: row.plan.title, approvals: row.approvals })),
			members: listMembers.all().map(row => row.login),
			audit: admin ? listAudit.all().map(row => ({ at: strftime(row.time, "%H:%M"), login: row.login, route: row.route })) : null,
		});
		return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": pageCsp(randomBytes(16).toString("base64")) } });
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
			if (out.status === 403) return json({ error: "paused: this member takes no claims on this team" }, 403);
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
					if (peer === ownAddress) return json({ error: "forbidden: this machine's own tailnet address" }, 403);
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
						planId = decodeSegment(idMatch[1]);
						if (planId === null) return json({ error: "bad plan id" }, 400);
					}
					if (req.method === "GET" && planId !== null) {
						const row = selectPlan.get(planId, config.team);
						if (!row) return json({ error: "not found" }, 404);
						return json({ id: planId, ...row }, 200);
					}
					if (req.method === "GET" && url.pathname === "/claims") {
						return json({ claims: listClaims.all(config.team).map(row => wireClaim(row, login)) }, 200);
					}
					if (req.method === "GET" && url.pathname === "/") return teamPage(req, login);
					// One read for P4/P5: plan text, claims and P2c's tables together. Auth chain only, no write slot, not audited.
					if (req.method === "GET" && url.pathname === "/view") return json(readTeamView(db, config.team, login), 200);
					const claimMatch = /^\/claims\/([^/]+)(\/beat)?$/.exec(url.pathname);
					if (claimMatch?.[1]) {
						const claimId = decodeSegment(claimMatch[1]);
						if (claimId === null) return json({ error: "bad plan id" }, 400);
						return await claimRoute(req, claimId, claimMatch[2] !== undefined, login);
					}
					const memberResponse = await memberRoute(req, url.pathname, login);
					if (memberResponse) return memberResponse;
					const pageResponse = await pageRoute(req, url.pathname, login);
					if (pageResponse) return pageResponse;
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
					let note: string | null = null;
					if (fields.distinct !== undefined) {
						if (typeof fields.distinct !== "string" || fields.distinct.trim() === "" || fields.distinct.length > 200) {
							return json({ error: "distinct must be a reason of 1 to 200 characters" }, 400);
						}
						note = fields.distinct;
					}
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
						note,
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

/** Members of this team on the database, sorted. Before the first start the members table is empty, so this returns []. Opens through openTeamDb and closes again. */
export function listTeamMembers(dbPath: string): string[] {
	const db = openTeamDb(dbPath);
	try {
		return db.query<{ login: string }, []>("SELECT login FROM members ORDER BY login").all().map(row => row.login);
	} finally {
		db.close();
	}
}

/** Adds a member from the host, acting as the admin. No write slot and no role check. Refuses until the team has started once. */
export function addTeamMember(dbPath: string, config: TeamServerConfig, login: string): { ok: true; added: boolean } | { ok: false; error: string } {
	const db = openTeamDb(dbPath);
	try {
		if (!initialised(db)) return { ok: false, error: `team ${config.team} not initialised: its server has never started on this database; start it once, then retry` };
		if (!validLogin(login)) return { ok: false, error: LOGIN_ERROR };
		return { ok: true, added: addMemberTx(db, login, config.admin, nowSec()).added };
	} finally {
		db.close();
	}
}

/** Removes a member from the host, acting as the admin. Refuses exactly as DELETE /members/:login does. Refuses until the team has started once. */
export function removeTeamMember(dbPath: string, config: TeamServerConfig, login: string): { ok: true; claimsFreed: number } | { ok: false; error: string } {
	const db = openTeamDb(dbPath);
	try {
		if (!initialised(db)) return { ok: false, error: `team ${config.team} not initialised: its server has never started on this database; start it once, then retry` };
		const out = removeMemberTx(db, config, login, config.admin, nowSec());
		if (out.status === 409) return { ok: false, error: ADMIN_REMOVE };
		if (out.status === 404) return { ok: false, error: NO_MEMBER };
		return { ok: true, claimsFreed: out.claimsFreed };
	} finally {
		db.close();
	}
}
