// Incidents: problems the system itself finds, in one JSONL store under the queue state dir
// (<paths.queue_state>/incidents.jsonl, the directory cancel-pending.json lives in). An incident
// record starts the story; resolution records ({type:"plan"|"dismiss"|"fixed", id, ...}) end it.
// While an incident is open (no resolution yet) the guards inject it into every Main prompt and
// refuse spawns and the stop (src/core/guards.ts), so a found bug is deterministically pushed,
// not remembered. A repeat sighting of an open fingerprint updates count and lastSeen on the
// existing record instead of adding a second incident; after a resolution the same fingerprint
// opens a new incident. Sources: realtime (detectors), daily, weekly, main (`incident add`),
// findings (plan-guard: the Findings: items of a subagent's new Progress entry).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nowSec, strftime } from "./clock.ts";
import type { Config } from "./config.ts";
import * as q from "./queue/lib.ts";

export type IncidentSource = "realtime" | "daily" | "weekly" | "main" | "findings" | "traces";

export interface IncidentRec {
	id: string;
	fingerprint: string;
	source: IncidentSource;
	kind: string;
	summary: string;
	evidence: string;
	ts: number;
	count: number;
	lastSeen: number;
}

export type ResolutionRec =
	| { type: "plan"; id: string; plan: string }
	| { type: "dismiss"; id: string; why: string }
	/** `ts` is the close time; older records (written before plan P5) may lack it. */
	| { type: "fixed"; id: string; plan: string; ts?: number };

/** Main's written reason that a finding is or is not a bug (`incident propose`). Not a resolution: the incident stays open. */
export interface ProposalRec {
	type: "propose";
	id: string;
	why: string;
	ts: number;
}

export interface IncidentView extends IncidentRec {
	/** Last resolution record for the id; null while the incident is open. */
	resolution: ResolutionRec | null;
	/** Main's latest proposal for the id (`incident propose`); null when none. */
	proposal: ProposalRec | null;
}

export interface IncidentInput {
	source: IncidentSource;
	kind: string;
	summary: string;
	evidence?: string;
	/** Stable identity of the problem; detectors pass one, `incident add` derives it from the text. */
	fingerprint?: string;
}

export function incidentsFile(cfg: Config): string {
	return join(cfg.paths.queue_state, "incidents.jsonl");
}

/** Default fingerprint: the finding's own text, normalized, so re-reporting the same bug dedupes. */
export function defaultFingerprint(input: Pick<IncidentInput, "source" | "kind" | "summary">): string {
	return q.sha(`${input.source}|${input.kind}|${input.summary.replace(/\s+/g, " ").trim().toLowerCase()}`);
}

function parseLine(line: string): IncidentRec | ResolutionRec | ProposalRec | null {
	let rec: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		rec = parsed as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof rec.id !== "string") return null;
	if (rec.type === "plan" || rec.type === "fixed") {
		if (typeof rec.plan !== "string") return null;
		return rec.type === "fixed" && typeof rec.ts === "number"
			? { type: "fixed", id: rec.id, plan: rec.plan, ts: rec.ts }
			: { type: rec.type, id: rec.id, plan: rec.plan };
	}
	if (rec.type === "dismiss") {
		if (typeof rec.why !== "string") return null;
		return { type: "dismiss", id: rec.id, why: rec.why };
	}
	if (rec.type === "propose") {
		if (typeof rec.why !== "string" || typeof rec.ts !== "number") return null;
		return { type: "propose", id: rec.id, why: rec.why, ts: rec.ts };
	}
	if (rec.type !== undefined) return null;
	if (typeof rec.fingerprint !== "string" || typeof rec.kind !== "string" || typeof rec.summary !== "string" || typeof rec.ts !== "number")
		return null;
	const source = rec.source === "realtime" || rec.source === "daily" || rec.source === "weekly" || rec.source === "findings" || rec.source === "traces" ? rec.source : "main";
	return {
		id: rec.id,
		fingerprint: rec.fingerprint,
		source,
		kind: rec.kind,
		summary: rec.summary,
		evidence: typeof rec.evidence === "string" ? rec.evidence : "",
		ts: rec.ts,
		count: typeof rec.count === "number" && rec.count >= 1 ? rec.count : 1,
		lastSeen: typeof rec.lastSeen === "number" ? rec.lastSeen : rec.ts,
	};
}

function readStore(file: string): { incidents: IncidentRec[]; resolutions: ResolutionRec[]; proposals: ProposalRec[]; lines: string[] } {
	let lines: string[] = [];
	try {
		lines = readFileSync(file, "utf8").split("\n").filter(l => l.trim());
	} catch {}
	const incidents: IncidentRec[] = [];
	const resolutions: ResolutionRec[] = [];
	const proposals: ProposalRec[] = [];
	for (const line of lines) {
		const rec = parseLine(line);
		if (!rec) continue;
		if (!("type" in rec)) incidents.push(rec);
		else if (rec.type === "propose") proposals.push(rec);
		else resolutions.push(rec);
	}
	return { incidents, resolutions, proposals, lines };
}

function writeFile(cfg: Config, file: string, lines: string[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Every incident in file order, each folded with its last resolution record (if any). */
export function readIncidents(cfg: Config): IncidentView[] {
	const store = readStore(incidentsFile(cfg));
	const views = new Map<string, IncidentView>();
	for (const rec of store.incidents) views.set(rec.id, { ...rec, resolution: null, proposal: null });
	for (const res of store.resolutions) {
		const v = views.get(res.id);
		if (v) v.resolution = res;
	}
	// A later propose replaces an earlier one: file order, last wins.
	for (const p of store.proposals) {
		const v = views.get(p.id);
		if (v) v.proposal = p;
	}
	return [...views.values()];
}

/** Incidents with no plan, no dismissal and no fixed record: the ones the guards push on Main. */
export function openIncidents(cfg: Config): IncidentView[] {
	return readIncidents(cfg).filter(i => !i.resolution);
}

/** Records a sighting. Returns the (open) incident; `deduped` says an open one was updated. */
export function addIncident(cfg: Config, input: IncidentInput, now = nowSec()): { incident: IncidentView; deduped: boolean } {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	const fingerprint = input.fingerprint ?? defaultFingerprint(input);
	const open = store.incidents.find(
		i => i.fingerprint === fingerprint && !store.resolutions.some(r => r.id === i.id),
	);
	if (open) {
		open.count += 1;
		open.lastSeen = now;
		const lines = store.lines.map(line => {
			const rec = parseLine(line);
			return rec && !("type" in rec) && rec.id === open.id ? JSON.stringify(open) : line;
		});
		writeFile(cfg, file, lines);
		return { incident: { ...open, resolution: null, proposal: null }, deduped: true };
	}
	const day = strftime(now, "%Y%m%d");
	const prefix = `I-${day}-`;
	const used = store.incidents.filter(i => i.id.startsWith(prefix)).map(i => Number(i.id.slice(prefix.length)) || 0);
	const rec: IncidentRec = {
		id: `${prefix}${(used.length ? Math.max(...used) : 0) + 1}`,
		fingerprint,
		source: input.source,
		kind: input.kind,
		summary: input.summary,
		evidence: input.evidence ?? "",
		ts: now,
		count: 1,
		lastSeen: now,
	};
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(rec)}\n`);
	return { incident: { ...rec, resolution: null, proposal: null }, deduped: false };
}

/**
 * Records the plan that fixes an incident: refused unless the file exists, is listed in the main
 * index, and contains `INCIDENT <id>` (the spawn gates look for that text). Returns the
 * refusal reason, or null when recorded.
 */
export function planIncident(cfg: Config, id: string, planPath: string): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	if (!store.incidents.some(i => i.id === id)) return `unknown incident ${id}`;
	const res = store.resolutions.filter(r => r.id === id).at(-1);
	if (res) return `incident ${id} already has a ${res.type} record`;
	const abs = resolve(q.expandHome(planPath));
	if (!existsSync(abs)) return `plan file not found: ${abs}`;
	if (!q.readIndex(cfg.paths.queue_index).includes(abs)) return `${abs} is not listed in ${cfg.paths.queue_index}`;
	let text: string;
	try {
		text = readFileSync(abs, "utf8");
	} catch {
		return `cannot read ${abs}`;
	}
	if (!text.includes(`INCIDENT ${id}`)) return `${abs} must contain "INCIDENT ${id}" so the guards can see the fix names the incident`;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "plan", id, plan: abs })}\n`);
	return null;
}

// The owner's own words, as the inject hook saw them (<queue_state>/owner-messages.jsonl, last
// 50 messages). Guards match quotes against them (priority skip, autonomy go); incidents dismiss
// a finding only with them (20261028_0900 P3).

/** The kinds plan-guard's recordFindings writes; only the owner's own words dismiss them. */
const FINDING_KINDS: Record<string, true> = { "agent-finding": true, "main-finding": true };

export function isFindingKind(kind: string): boolean {
	return Object.hasOwn(FINDING_KINDS, kind);
}

export interface OwnerMessage {
	at: number;
	text: string;
}

export function ownerMessagesFile(): string {
	return join(q.STATE_DIR, "owner-messages.jsonl");
}

export function readOwnerMessages(): OwnerMessage[] {
	try {
		return readFileSync(ownerMessagesFile(), "utf8").split("\n").filter(Boolean)
			.map(line => JSON.parse(line) as OwnerMessage);
	} catch {
		return [];
	}
}

export function ownerSaid(words: string, messages: OwnerMessage[], now: number): boolean {
	const quote = words.toLowerCase().replace(/\s+/g, " ").trim();
	if (quote.split(" ").length < 4) return false;
	return messages.some(m => now - m.at >= 0 && now - m.at <= 86400 && m.text.toLowerCase().replace(/\s+/g, " ").includes(quote));
}

/** The proof a proposal must cite: a file and a line, e.g. `src/core/guards.ts:40`. */
const PROOF_REF = /\S+:\d+/;

/** Records Main's reason that a finding is or is not a bug. A finding stays open after a proposal: the
 *  owner taps it on the phone page or a plan closes it. A newer proposal replaces the older one. */
export function proposeIncident(cfg: Config, id: string, why: string, now = nowSec()): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	const rec = store.incidents.find(i => i.id === id);
	if (!rec) return `unknown incident ${id}`;
	if (store.resolutions.some(r => r.id === id)) return `incident ${id} already has a resolution record`;
	if (!isFindingKind(rec.kind)) return `refused: propose is for finding incidents (agent-finding, main-finding); ${id} is ${rec.kind}`;
	if (!PROOF_REF.test(why)) return "refused: the why must cite the proof as file:line, e.g. src/core/guards.ts:40";
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "propose", id, why: why.trim(), ts: now })}\n`);
	return null;
}

/** Records why an incident is not a bug (or not worth fixing); an empty why is refused. A finding
 *  incident (kind "agent-finding"/"main-finding") is dismissed only with `owner` — a quote
 *  `ownerSaid` matches against the owner's own messages of the last 24 h (20261028_0900 P3: the
 *  agent that found the bug cannot also wave it away). `tapLogin` is the owner's login from the
 *  owner page's authenticated POST /incident ("false alarm" tap); only that handler passes it. */
export function dismissIncident(cfg: Config, id: string, why: string, owner?: string, tapLogin?: string): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	const rec = store.incidents.find(i => i.id === id);
	if (!rec) return `unknown incident ${id}`;
	const res = store.resolutions.filter(r => r.id === id).at(-1);
	if (res) return `incident ${id} already has a ${res.type} record`;
	if (!why.trim()) return "refused: an empty --why would hide the incident without a recorded reason";
	if (isFindingKind(rec.kind) && tapLogin === undefined) {
		if (owner === undefined)
			return `refused: a ${rec.kind} is dismissed only with the owner's words: --owner "<quote>" (part of an owner message of the last 24 h)`;
		if (!ownerSaid(owner, readOwnerMessages(), nowSec()))
			return "refused: the --owner quote is not part of an owner message of the last 24 h";
	}
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "dismiss", id, why })}\n`);
	return null;
}

/**
 * Records that an incident's fix shipped: the queue writes this when it closes a plan citing
 * `INCIDENT <id>` (plan P5), so the guards stop pushing a bug whose fix just landed. A plan record
 * (the normal path: planned, then fixed) may be closed out; a dismissed or fixed incident is final.
 * The caller logs refusals and closes anyway.
 */
export function fixedIncident(cfg: Config, id: string, plan: string, now = nowSec()): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	if (!store.incidents.some(i => i.id === id)) return `unknown incident ${id}`;
	const res = store.resolutions.filter(r => r.id === id).at(-1);
	// A plan record is the normal path (planned, then fixed); dismissed or fixed is final.
	if (res && res.type !== "plan") return `incident ${id} already has a ${res.type} record`;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "fixed", id, plan, ts: now })}\n`);
	return null;
}
