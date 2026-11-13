// Team client (plan 20261027_1305 P3): the ClaimStore over a team server, the chooser that
// routes each plan to the file or the team store, the summary holder, and team sync. The
// guards are synchronous, so every request runs in one blocking child: spawnSync of this same
// file — the request entry below runs when team-client.ts is the process entry — with the JSON
// request on stdin, no shell, argv carries no request data, 5 s timeout. A server that did not
// answer is the typed `Unreachable` value (never null) and memoizes per team for 60 s, so a
// down team server costs one 5 s wait per process per minute. Write requests carry
// `Origin: http://<host:port>` (the server's Origin check); no request carries a token — whois
// is the auth. Requests carry plan ids, never plan text or paths (Forbidden).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimExpired, fileClaimStore, heldByOther, type Claim, type ClaimStore, type Unreachable } from "./claims.ts";
import { nowSec, strftime } from "./clock.ts";
import type { Config } from "./config.ts";
import { lock } from "./file-lock.ts";
import { mainId } from "./guards.ts";
import { defaultRunner, type CommandRunner } from "./mr-sweep.ts";
import { activePlans, headerField, parsePlan, planRepo, sha, SUMMARY_CAP, type Plan } from "./queue/lib.ts";
import { teamPlanId, type TeamView } from "./team-server.ts";
import { planShare, repoTeam } from "./team-labels.ts";

/** The server's one-read view, as the server defines it: every client consumer reads it from here. */
export type { TeamView };

/** One `cfg.teams` entry. */
export type TeamEntry = Config["teams"][number];

/** One request for the request entry. */
export interface WireRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
}

/** One answer from the request entry; `error` set means the server did not answer. */
export interface WireResponse {
	status?: number;
	body?: unknown;
	error?: string;
}

export type Send = (req: WireRequest) => WireResponse | null;

export interface RemoteStoreOpts {
	/** Clock in unix seconds; defaults to the NEURASTREAM_NOW-aware nowSec. */
	clock?: () => number;
	/** The transport; defaults to one spawnSync child per request (the request entry). */
	send?: Send;
}

interface RawOpts {
	clock?: () => number;
	send?: Send;
}

/** One wire claim row (`GET /claims`, claim answers); `plan` is the plan id on the wire. */
interface WireRow {
	id?: string;
	plan?: string;
	sha?: string;
	main?: string;
	host?: string;
	pid?: number;
	since?: number;
	beat?: number;
	mine?: boolean;
}

/** A sync record entry: where this plan lives locally and which version this machine last saw. */
interface RecEntry {
	path: string;
	sha: string;
}

type TeamRecord = Record<string, RecEntry>;

const OUTAGE_MEMO_SEC = 60;
/** One request may block the calling process this long (the guards are synchronous). */
const REQUEST_TIMEOUT_MS = 5_000;

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `Origin` header value for a write to this server (the server compares it to its Host header). */
function originOf(server: string): string {
	return `http://${server.replace(/^https?:\/\//, "")}`;
}

// --- the outage memo: per team server, lives exactly as long as one process ---

const downUntil = new Map<string, number>();

function memoDown(name: string, clock: () => number): boolean {
	const until = downUntil.get(name);
	return until !== undefined && clock() < until;
}

function markDown(name: string, clock: () => number): void {
	downUntil.set(name, clock() + OUTAGE_MEMO_SEC);
}

/** One request through the send seam, with the memo: down answers at once; transport failures and 5xx mark the team down. Returns "down" when the server did not answer. */
function askRaw(team: TeamEntry, req: WireRequest, opts: RawOpts = {}): WireResponse | "down" {
	const clock = opts.clock ?? nowSec;
	const send = opts.send ?? defaultSend;
	if (memoDown(team.name, clock)) return "down";
	const res = send(req);
	if (res === null || res.error !== undefined || typeof res.status !== "number" || res.status >= 500) {
		markDown(team.name, clock);
		return "down";
	}
	return res;
}

// --- the request entry (this file as a process) ---

/** Read one JSON request from stdin, perform the HTTP request, write one JSON answer to stdout. */
async function runRequestEntry(): Promise<void> {
	let req: WireRequest;
	try {
		req = JSON.parse(readFileSync(0, "utf8")) as WireRequest;
	} catch (err) {
		writeEntry({ error: `bad request: ${(err as Error).message}` });
		return;
	}
	try {
		const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const text = await res.text();
		let body: unknown = text;
		try {
			body = JSON.parse(text);
		} catch {
			// keep the raw text
		}
		writeEntry({ status: res.status, body });
	} catch (err) {
		writeEntry({ error: String(err) });
	}
}

function writeEntry(out: WireResponse): void {
	writeSync(1, JSON.stringify(out));
}

if (import.meta.main) {
	void runRequestEntry().then(
		() => process.exit(0),
		(err) => {
			try {
				writeEntry({ error: String(err) });
			} catch {}
			process.exit(0);
		},
	);
}

/** The default transport: one synchronous child, JSON request on stdin, JSON answer on stdout. */
function defaultSend(req: WireRequest): WireResponse | null {
	const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
		input: JSON.stringify(req),
		timeout: REQUEST_TIMEOUT_MS,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (r.error || r.status !== 0 || !r.stdout) return { error: r.error ? String(r.error) : `request entry exited ${r.status}` };
	try {
		const out = JSON.parse(r.stdout) as WireResponse;
		return isObj(out) ? (out as WireResponse) : { error: "unparseable answer" };
	} catch {
		return { error: "unparseable answer" };
	}
}

// --- records: <queue_state>/team/<team>/record.json, every read-modify-write under the lock ---

function teamDir(cfg: Config, team: TeamEntry): string {
	return path.join(cfg.paths.queue_state, "team", team.name);
}

function readRecord(cfg: Config, team: TeamEntry): TeamRecord {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(teamDir(cfg, team), "record.json"), "utf8"));
		if (isObj(parsed)) return parsed as TeamRecord;
	} catch {}
	return {};
}

/**
 * One read-modify-write of the sync record, under the file lock the claims store uses
 * (fileClaimStore's run() convention): the lock sits beside the data, the write is tmp + rename
 * inside, released in finally. Unlocked, two racing processes each read the old record and the
 * later rename drops the other's entry — a dropped entry is exactly the record rule's fail-open.
 */
function writeRecord(cfg: Config, team: TeamEntry, mutate: (rec: TeamRecord) => void): void {
	const dir = teamDir(cfg, team);
	mkdirSync(dir, { recursive: true });
	const held = lock(path.join(dir, "record.lock"));
	try {
		const rec = readRecord(cfg, team);
		mutate(rec);
		const file = path.join(dir, "record.json");
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(rec));
		renameSync(tmp, file);
	} finally {
		held.release();
	}
}

// --- path -> id mapping (P2b (2)): the record's id when recorded, else the origin hash ---

const originCache = new Map<string, string>();

function gitOrigin(repo: string, run: CommandRunner): string {
	const hit = originCache.get(repo);
	if (hit !== undefined) return hit;
	const r = run(["git", "-C", repo, "remote", "get-url", "origin"], {});
	const url = r.code === 0 ? r.stdout.trim() : "";
	originCache.set(repo, url);
	return url;
}

/** The server's id for this plan file: the sync record's id for the path when recorded, else the hash of the repo origin and the repo-relative path. Null when neither names a plan. */
function pathId(team: TeamEntry, cfg: Config, file: string, run: CommandRunner): string | null {
	for (const [id, entry] of Object.entries(readRecord(cfg, team))) if (entry.path === file) return id;
	const repo = planRepo(file);
	return teamPlanId(gitOrigin(repo, run), path.relative(repo, file));
}

/** The wire claim as a local Claim: the plan is this machine's path, `mine` rides along. */
function toClaim(row: WireRow, plan: string): Claim {
	return {
		plan,
		main: String(row.main ?? ""),
		host: String(row.host ?? ""),
		pid: Number(row.pid ?? 0),
		since: Number(row.since ?? 0),
		beat: Number(row.beat ?? 0),
		...(row.mine === undefined ? {} : { mine: row.mine }),
	};
}

// --- the remote claim store ---

/**
 * The ClaimStore over one team server (U = Unreachable). The plan ids ride the wire; every
 * returned Claim names the local path, and ids with no recorded path are dropped from list().
 * On a timeout, a refused connection, a 5xx or an unparseable answer the store answers
 * Unreachable for the next 60 s without sending a request; heartbeat answers false and release
 * sends nothing (the claim lapses at the TTL).
 */
export function remoteClaimStore(team: TeamEntry, queueState: string, opts: RemoteStoreOpts = {}): ClaimStore {
	const optsRaw: RawOpts = opts;
	const cfgLike = { paths: { queue_state: queueState } } as Config;

	function claimHeaders(): Record<string, string> {
		return { "content-type": "application/json", origin: originOf(team.server) };
	}

	return {
		claim(plan, main) {
			const id = pathId(team, cfgLike, plan, defaultRunner);
			if (id === null) return { unreachable: team.server };
			const res = askRaw(team, { url: `${team.server}/claims/${encodeURIComponent(id)}`, method: "POST", headers: claimHeaders(), body: JSON.stringify({ main, host: hostname(), pid: process.pid }) }, optsRaw);
			if (res === "down") return { unreachable: team.server };
			if (res.status === 409 && isObj(res.body) && isObj(res.body.heldBy)) return { heldBy: toClaim(res.body.heldBy as WireRow, plan) };
			if (res.status === 200 && isObj(res.body) && isObj(res.body.claim)) return toClaim(res.body.claim as WireRow, plan);
			// 404 (no such plan), 429, 403: no claim can be taken — fail closed, not null.
			return { unreachable: team.server };
		},
		heartbeat(plan, main) {
			const id = pathId(team, cfgLike, plan, defaultRunner);
			if (id === null) return false;
			const res = askRaw(team, { url: `${team.server}/claims/${encodeURIComponent(id)}/beat`, method: "POST", headers: claimHeaders(), body: JSON.stringify({ main }) }, optsRaw);
			return res !== "down" && res.status === 200;
		},
		holder(plan) {
			const id = pathId(team, cfgLike, plan, defaultRunner);
			if (id === null) return { unreachable: team.server };
			const res = askRaw(team, { url: `${team.server}/claims/${encodeURIComponent(id)}`, method: "GET" }, optsRaw);
			if (res === "down") return { unreachable: team.server };
			if (res.status === 404) return null; // the plan is not stored on the server: free
			if (res.status === 200 && isObj(res.body)) return isObj(res.body.claim) ? toClaim(res.body.claim as WireRow, plan) : null;
			return { unreachable: team.server };
		},
		release(plan, main) {
			const id = pathId(team, cfgLike, plan, defaultRunner);
			if (id === null) return;
			// Void on any answer: an unreachable release sends nothing and the claim lapses at the TTL.
			askRaw(team, { url: `${team.server}/claims/${encodeURIComponent(id)}`, method: "DELETE", headers: claimHeaders(), body: JSON.stringify({ main }) }, optsRaw);
		},
		list() {
			const res = askRaw(team, { url: `${team.server}/claims`, method: "GET" }, optsRaw);
			if (res === "down") return { unreachable: team.server };
			if (res.status !== 200 || !isObj(res.body) || !Array.isArray(res.body.claims)) return { unreachable: team.server };
			const rec = readRecord(cfgLike, team);
			const out: Claim[] = [];
			for (const row of res.body.claims as WireRow[]) {
				const planId = typeof row?.plan === "string" ? row.plan : typeof row?.id === "string" ? row.id : undefined;
				const local = planId !== undefined ? rec[planId]?.path : undefined;
				if (local !== undefined) out.push(toClaim(row, local)); // ids with no recorded path are dropped
			}
			return out;
		},
	};
}

// --- the chooser's module map: one remote store per cfg.teams entry per process ---

const stores = new Map<string, ClaimStore>();

/** The team's remote store from the process-wide map; test seams may inject clock and send. */
export function remoteStoreFor(team: TeamEntry, cfg: Config, opts: RemoteStoreOpts = {}): ClaimStore {
	const hit = stores.get(team.name);
	if (hit && !opts.clock && !opts.send) return hit;
	const built = remoteClaimStore(team, cfg.paths.queue_state, opts);
	stores.set(team.name, built);
	return built;
}

/** Clears the process-wide remote stores, the outage memo and the origin cache. A test seam: the memo lives exactly one process, and a scenario must not inherit a down mark. */
export function resetTeamStores(): void {
	stores.clear();
	downUntil.clear();
	originCache.clear();
}

/** The team this plan's claims belong to: a `Queue: team` plan goes to the repo's team (the order planShare uses); a headerless plan whose path sits in some team's sync record goes there anyway — the record is a local JSON read, no git. */
function routeTeam(file: string, cfg: Config, text: string | undefined, run: CommandRunner): TeamEntry | null {
	const header = headerField(text ?? readText(file) ?? "", "Queue");
	if (header === "team") {
		const name = repoTeam(planRepo(file), cfg, run);
		const entry = name ? cfg.teams.find((t) => t.name === name) : undefined;
		if (entry) return entry;
	}
	for (const team of cfg.teams) {
		for (const entry of Object.values(readRecord(cfg, team))) if (entry.path === file) return team;
	}
	return null;
}

function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * The claim store for one plan: the team's remote store when the plan is a team plan (by
 * header, or by the sync record when the header was stripped on disk outside the edit gate),
 * else the local file store. Personal plans never run git and never send.
 */
export function claimStoreFor(file: string, cfg: Config, text?: string, run: CommandRunner = defaultRunner): ClaimStore {
	const team = routeTeam(file, cfg, text, run);
	if (team) return remoteStoreFor(team, cfg);
	return fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min);
}

// --- the summary holder: one GET /claims per team per summary ---

/**
 * A holder-only store for one queue summary (checkInject, queue-check, the owner page's rows):
 * a plan the chooser sends to the file store is answered locally; a plan of team T is answered
 * from that team's claims, fetched once on first use within this summary (one child, one
 * request) — or, when the caller already read a team view (P4's `teamViews`), from that view's
 * `claims`, which are the same rows `GET /claims` sends, so one render stays one request per
 * team. Matching is by plan id, never by recorded path, so a never-synced `Queue: team` plan
 * still shows its server holder. Liveness uses this member's claim_ttl_min; it only colours the
 * summary, every decision still asks the server per plan.
 */
export function summaryHolder(cfg: Config, opts: RawOpts = {}, views?: Map<string, TeamView | Unreachable>): Pick<ClaimStore, "holder"> {
	const clock = opts.clock ?? nowSec;
	const byTeam = new Map<string, Map<string, WireRow> | "down">();

	function rowsFor(team: TeamEntry): Map<string, WireRow> | "down" {
		const hit = byTeam.get(team.name);
		if (hit) return hit;
		let out: Map<string, WireRow> | "down";
		const seen = views?.get(team.name);
		if (seen !== undefined) {
			out = "unreachable" in seen ? "down" : new Map(seen.claims.map(row => [row.plan, row] as const));
		} else {
			const res = askRaw(team, { url: `${team.server}/claims`, method: "GET" }, opts);
			if (res !== "down" && res.status === 200 && isObj(res.body) && Array.isArray(res.body.claims)) {
				const rows = new Map<string, WireRow>();
				for (const row of res.body.claims as WireRow[]) {
					const planId = typeof row?.plan === "string" ? row.plan : typeof row?.id === "string" ? row.id : undefined;
					if (isObj(row) && planId) rows.set(planId, row);
				}
				out = rows;
			} else {
				out = "down";
			}
		}
		byTeam.set(team.name, out);
		return out;
	}

	return {
		holder(plan) {
			const team = routeTeam(plan, cfg, undefined, defaultRunner);
			if (!team) return fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min).holder(plan);
			const rows = rowsFor(team);
			if (rows === "down") return { unreachable: team.server };
			const id = pathId(team, cfg, plan, defaultRunner);
			const row = id === null ? undefined : rows.get(id);
			if (!row) return null;
			return claimExpired({ beat: Number(row.beat ?? 0) }, clock(), cfg.queue.claim_ttl_min) ? null : toClaim(row, plan);
		},
	};
}

// --- team sync ---

/** One GET /plans/:id pulled into this machine: the read copy is written unless the record maps the id to a repo path (then the repo file is left alone and only the sha is noted for the next push's base). */
function pullPlan(team: TeamEntry, cfg: Config, id: string): void {
	const res = askRaw(team, { url: `${team.server}/plans/${encodeURIComponent(id)}`, method: "GET" });
	if (res === "down" || res.status !== 200 || !isObj(res.body) || typeof res.body.text !== "string" || typeof res.body.sha !== "string") return;
	const text = res.body.text;
	const nextSha = res.body.sha;
	const copyDir = path.join(teamDir(cfg, team), "plans");
	const entry = readRecord(cfg, team)[id];
	if (entry && !entry.path.startsWith(`${copyDir}/`)) {
		// A repo path: the local repo file is left alone, only the sha is noted.
		writeRecord(cfg, team, (rec) => {
			rec[id] = { path: entry.path, sha: nextSha };
		});
		return;
	}
	mkdirSync(copyDir, { recursive: true });
	const copy = path.join(copyDir, `${id}.md`);
	writeFileSync(copy, text);
	writeRecord(cfg, team, (rec) => {
		rec[id] = { path: entry?.path ?? copy, sha: nextSha };
	});
}

/**
 * One plan's push (share's one-plan push and syncTeam's loop run this): never without the
 * `Queue: team` marker on the text, never while another member's login holds it (the server's
 * PUT has no claim check), with the record's sha as the base. A 409 pulls that id — with the
 * server sha it re-reads, with `sha: null` the plan is absent on the server and the record
 * entry stays, so every later sync conflicts again until the plan is unshared and shared anew.
 */
export function pushTeamPlan(team: TeamEntry, cfg: Config, file: string, text?: string, run: CommandRunner = defaultRunner): void {
	const body = text ?? readText(file) ?? "";
	if (headerField(body, "Queue") !== "team") return; // a plan without the marker is never pushed
	const id = pathId(team, cfg, file, run);
	if (id === null) {
		console.log(`team sync: ${file} not pushed: its repo origin does not parse`);
		return;
	}
	const holder = remoteStoreFor(team, cfg).holder(file);
	if (holder !== null && "unreachable" in holder) {
		console.log(`team sync: ${file} not pushed: team server ${team.server} unreachable`);
		return;
	}
	if (heldByOther(holder, mainId())) {
		console.log(`team sync: ${file} not pushed: held by another member's Main`);
		return;
	}
	const repo = planRepo(file);
	const base = readRecord(cfg, team)[id]?.sha ?? null;
	const res = askRaw(team, {
		url: `${team.server}/plans/${encodeURIComponent(id)}`,
		method: "PUT",
		headers: { "content-type": "application/json", origin: originOf(team.server) },
		body: JSON.stringify({ remote: gitOrigin(repo, run), rel_path: path.relative(repo, file), text: body, base_sha: base }),
	});
	if (res === "down") {
		console.log(`team sync: ${file} not pushed: team server ${team.server} unreachable`);
		return;
	}
	if (res.status === 200 && isObj(res.body) && typeof res.body.sha === "string") {
		const nextSha = res.body.sha;
		writeRecord(cfg, team, (rec) => {
			rec[id] = { path: file, sha: nextSha };
		});
		return;
	}
	if (res.status === 409) {
		const serverSha = isObj(res.body) && typeof res.body.sha === "string" ? res.body.sha : null;
		if (serverSha !== null) pullPlan(team, cfg, id);
		console.log(`team sync: ${file} conflict: the server has a newer version (${serverSha}); merge it and run team sync again`);
		return;
	}
	console.log(`team sync: ${file} not pushed: the server refused (${res.status})`);
}

/**
 * Team sync for one team: pull (GET /plans, then each id whose sha differs from the record),
 * then push every INDEX plan this team shares whose text sha differs from the record. Each
 * request may block its caller up to 5 s; no hook and no heartbeat tick runs sync.
 */
export function syncTeam(team: TeamEntry, cfg: Config, run: CommandRunner = defaultRunner): number {
	const res = askRaw(team, { url: `${team.server}/plans`, method: "GET" });
	if (res === "down" || res.status !== 200 || !isObj(res.body) || !Array.isArray(res.body.plans)) {
		console.log(`team sync: team server ${team.server} unreachable`);
	} else {
		const rec = readRecord(cfg, team);
		for (const row of res.body.plans as WireRow[]) {
			if (typeof row?.id === "string" && typeof row.sha === "string" && rec[row.id]?.sha !== row.sha) pullPlan(team, cfg, row.id);
		}
	}
	for (const plan of activePlans(cfg.paths.queue_index)) {
		if (planShare(plan, cfg, run) !== team.name) continue;
		const id = pathId(team, cfg, plan.file, run);
		if (id === null) continue;
		if (readRecord(cfg, team)[id]?.sha === sha(plan.text)) continue;
		pushTeamPlan(team, cfg, plan.file, plan.text, run);
	}
	return 0;
}

/** Deletes this plan's record entries (by path and by plan id) from every team's record — `team unshare` runs it after rewriting the header. */
export function deleteRecordEntries(cfg: Config, file: string, run: CommandRunner = defaultRunner): void {
	for (const team of cfg.teams) {
		const rec = readRecord(cfg, team);
		const id = pathId(team, cfg, file, run);
		const hits = Object.entries(rec).filter(([entryId, entry]) => entry.path === file || entryId === id);
		if (!hits.length) continue;
		writeRecord(cfg, team, (next) => {
			for (const [entryId] of hits) delete next[entryId];
		});
	}
}

// --- team views: one GET /view per team per render or summary (P4) ---

/** One plan of a team's view, as every team section reads it. */
export interface TeamPlanRow {
	/** The server's plan id. */
	id: string;
	/** This machine's path for the plan: the sync record's path, else the read copy `team sync` writes. Display only. */
	file: string;
	/** The server text parsed with `localPaths` false, its worktree and appliesTo blanked: nothing stats a team-chosen path. */
	plan: Plan;
	/** The repo-relative path on the server: the plan's identity in a team card. */
	relPath: string;
	/** The live claim on the server; `login` is the member holding it. */
	holder: (Claim & { login: string }) | null;
	approvals: string[];
	/** The plan's answers, newest first (the view's own order). */
	answers: TeamView["answers"];
	/** The first answer to the plan's current WAITING question (the server's), or null when none. */
	answered: TeamEarlier | null;
}

/** True when the body carries the arrays `readTeamView` sends. */
function isView(body: unknown): body is TeamView {
	return (
		isObj(body) &&
		Array.isArray(body.plans) &&
		Array.isArray(body.claims) &&
		Array.isArray(body.approvals) &&
		Array.isArray(body.votes) &&
		Array.isArray(body.paused) &&
		Array.isArray(body.answers) &&
		Array.isArray(body.first) &&
		typeof body.me_paused === "boolean"
	);
}

/**
 * One `GET /view` per `cfg.teams` entry: plan text, claims and the P2c tables in one request, so
 * a render costs one child per team instead of one per table. The outage memo and the 5 s bound
 * are askRaw's, and a non-200 or a body of the wrong shape is Unreachable — the same answer
 * remoteClaimStore.list() gives its own read.
 */
export function teamViews(cfg: Config, opts: RawOpts = {}): Map<string, TeamView | Unreachable> {
	const out = new Map<string, TeamView | Unreachable>();
	for (const team of cfg.teams) {
		const res = askRaw(team, { url: `${team.server}/view`, method: "GET" }, opts);
		out.set(team.name, res === "down" || res.status !== 200 || !isView(res.body) ? { unreachable: team.server } : res.body);
	}
	return out;
}

/**
 * The plans of one team's view in the server's order (`ORDER BY rel_path, id`), as every team
 * section reads them. The text is the server's; the path is the record's, else the read copy.
 * `parsePlan` runs with `localPaths` false: team text names paths on its author's machine, so no
 * blocker is executed and no reuse citation is stat'ed. Worktree and appliesTo are blanked for
 * the same reason — later code that stats or runs git on them must never see a team-chosen path.
 */
export function teamPlans(cfg: Config, team: TeamEntry, view: TeamView): TeamPlanRow[] {
	const rec = readRecord(cfg, team);
	const copyDir = path.join(teamDir(cfg, team), "plans");
	return viewPlanRows(view, cfg.queue.claim_ttl_min, nowSec(), id => rec[id]?.path ?? path.join(copyDir, `${id}.md`));
}

/** A plan's sort key: [tier, value]. Tier 0 is the leader's override (value: its position); tier 1 a voted plan (value: its rank sum); tier 2 no vote. */
function planOrderKey(id: string, overridePos: Map<string, number>, scores: Map<string, number>): [number, number] {
	const pos = overridePos.get(id);
	if (pos !== undefined) return [0, pos];
	const score = scores.get(id);
	return score === undefined ? [2, 0] : [1, score];
}

/**
 * The plan rows of one view, each parsed under the file `fileOf` names for it. The phone section
 * (teamPlans) and the team page (P5) share this body. Reads no path and runs no git.
 * Order: the leader's override first, in its order; then the voted plans by rank sum, lowest first
 * (ranked 1 by one member and 2 by another scores 3); then the plans nobody voted on. Ties keep
 * `rel_path, id`. `answered` is the server's first answer to the current WAITING question.
 */
export function viewPlanRows(view: TeamView, ttlMin: number, now: number, fileOf: (id: string) => string): TeamPlanRow[] {
	const claims = new Map(view.claims.map(row => [row.plan, row] as const));
	const approvals = new Map<string, string[]>();
	for (const a of view.approvals) approvals.set(a.plan, [...(approvals.get(a.plan) ?? []), a.login]);
	const answers = new Map<string, TeamView["answers"]>();
	for (const a of view.answers) answers.set(a.plan, [...(answers.get(a.plan) ?? []), a]);
	const answered = new Map(view.first.map(a => [a.plan, { login: a.login, time: a.time, answer: a.answer }] as const));
	const overridePos = new Map((view.override?.plan_ids ?? []).map((id, i) => [id, i] as const));
	const scores = new Map<string, number>();
	for (const v of view.votes) scores.set(v.plan_id, (scores.get(v.plan_id) ?? 0) + v.rank);
	const ordered = view.plans.toSorted((a, b) => {
		const [tierA, valueA] = planOrderKey(a.id, overridePos, scores);
		const [tierB, valueB] = planOrderKey(b.id, overridePos, scores);
		if (tierA !== tierB) return tierA - tierB;
		if (valueA !== valueB) return valueA - valueB;
		if (a.rel_path !== b.rel_path) return a.rel_path < b.rel_path ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return ordered.map(row => {
		const file = fileOf(row.id);
		const claim = claims.get(row.id);
		const live = claim !== undefined && !claimExpired(claim, now, ttlMin) ? { ...toClaim(claim, file), login: claim.login } : null;
		return {
			id: row.id,
			file,
			plan: { ...parsePlan(path.dirname(file), file, row.text, undefined, [], false), worktree: null, appliesTo: [] },
			relPath: row.rel_path,
			holder: live,
			approvals: approvals.get(row.id) ?? [],
			answers: answers.get(row.id) ?? [],
			answered: answered.get(row.id) ?? null,
		};
	});
}

/**
 * The team half of the queue summary and `main-start`: per team one line, then up to `cap`
 * plans in queueSummary's line form — rel_path, the holder with its login, the WAITING ask, the
 * approvals, the first Goal bullet. A team whose view is Unreachable prints one line and no
 * plans. Sends nothing: the caller built `views` once.
 */
export function teamSummaryLines(cfg: Config, views: Map<string, TeamView | Unreachable>, cap = SUMMARY_CAP): string[] {
	const lines: string[] = [];
	for (const team of cfg.teams) {
		const view = views.get(team.name);
		if (view === undefined || "unreachable" in view) {
			lines.push(`Team ${team.name}: team server ${team.server} unreachable`);
			continue;
		}
		const rows = teamPlans(cfg, team, view);
		lines.push(`Team ${team.name}: ${rows.length} plan(s)`);
		rows.slice(0, cap).forEach((row, i) => {
			const flags = [
				row.holder ? `held by ${row.holder.main} (${row.holder.login}) since ${strftime(row.holder.since, "%H:%M")}` : "free",
				row.plan.waiting ? `WAITING on owner: ${(row.plan.waitingLine ?? "").slice(0, 80)}` : "",
				row.approvals.length ? `approved by ${row.approvals.join(", ")}` : "",
			]
				.filter(Boolean)
				.join(", ");
			lines.push(`  T${i + 1}. ${row.relPath} [${flags}] ${(row.plan.goal[0] ?? "").slice(0, 100)}`);
		});
	}
	return lines;
}

/** An answer to a WAITING question: the first one to it (a plan's `answered`), or the earlier one a later answer lost to. */
export interface TeamEarlier {
	login: string;
	time: number;
	answer: string;
}

/** What `POST /answer/<id>` answered: stored (with the earlier answer to the same question, when one won), the server's refusal, or a team that did not answer. */
export type TeamAnswerOutcome = { ok: true; earlier: TeamEarlier | null } | { ok: false; status: number; error: string } | Unreachable;

/**
 * One member's answer to a team plan's WAITING line: `POST /answer/<id>` with `{ answer }` only.
 * The body carries no login — the server stores the whois login. Built as pushTeamPlan builds
 * its write (content-type and Origin), with the id percent-encoded like every other route id.
 */
export function postTeamAnswer(team: TeamEntry, id: string, answer: string, opts: RawOpts = {}): TeamAnswerOutcome {
	const res = askRaw(
		team,
		{ url: `${team.server}/answer/${encodeURIComponent(id)}`, method: "POST", headers: { "content-type": "application/json", origin: originOf(team.server) }, body: JSON.stringify({ answer }) },
		opts,
	);
	if (res === "down" || res.status === undefined) return { unreachable: team.server };
	if (res.status === 200) {
		const e = isObj(res.body) ? res.body.earlier : null;
		const earlier = isObj(e) && typeof e.login === "string" && typeof e.time === "number" && typeof e.answer === "string" ? { login: e.login, time: e.time, answer: e.answer } : null;
		return { ok: true, earlier };
	}
	return { ok: false, status: res.status, error: isObj(res.body) && typeof res.body.error === "string" ? res.body.error : `team server answered ${res.status}` };
}

/** `team pause|resume`: the server's POST /pause or /resume for this login. Ok only on a 200; any other answer carries the server's error text. */
export function postTeamPause(team: TeamEntry, paused: boolean, opts: RawOpts = {}): { ok: true } | { ok: false; error: string } {
	const res = askRaw(team, { url: `${team.server}/${paused ? "pause" : "resume"}`, method: "POST", headers: { "content-type": "application/json", origin: originOf(team.server) }, body: "{}" }, opts);
	if (res === "down" || res.status === undefined) return { ok: false, error: `team server ${team.server} unreachable` };
	if (res.status === 200) return { ok: true };
	return { ok: false, error: isObj(res.body) && typeof res.body.error === "string" ? res.body.error : `team server answered ${res.status}` };
}

/** `team pause` releases this Main's own claims by plan id, so a plan with no local copy is released too. Void on any answer, as the store's release is. */
export function releaseTeamClaim(team: TeamEntry, id: string, main: string, opts: RawOpts = {}): void {
	askRaw(team, { url: `${team.server}/claims/${encodeURIComponent(id)}`, method: "DELETE", headers: { "content-type": "application/json", origin: originOf(team.server) }, body: JSON.stringify({ main }) }, opts);
}

/** This machine's file for a plan as the sync record names it; undefined when the record has no entry for the id. */
export function recordPath(cfg: Config, team: TeamEntry, id: string): string | undefined {
	return readRecord(cfg, team)[id]?.path;
}
