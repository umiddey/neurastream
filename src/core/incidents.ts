// Incidents: problems the system itself finds, in one JSONL store under the queue state dir
// (<paths.queue_state>/incidents.jsonl, the directory cancel-pending.json lives in). An incident
// record starts the story; resolution records ({type:"plan"|"dismiss"|"fixed", id, ...}) end it.
// While an incident is open (no resolution yet) the guards inject it into every Main prompt and
// refuse spawns and the stop (src/core/guards.ts), so a found bug is deterministically pushed,
// not remembered. A repeat sighting of an open fingerprint updates count and lastSeen on the
// existing record instead of adding a second incident; after a resolution the same fingerprint
// opens a new incident. Sources: realtime (detectors), daily, weekly, main (`incident add`).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nowSec, strftime } from "./clock.ts";
import type { Config } from "./config.ts";
import * as q from "./queue/lib.ts";

export type IncidentSource = "realtime" | "daily" | "weekly" | "main";

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

export interface IncidentView extends IncidentRec {
	/** Last resolution record for the id; null while the incident is open. */
	resolution: ResolutionRec | null;
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

function parseLine(line: string): IncidentRec | ResolutionRec | null {
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
	if (rec.type !== undefined) return null;
	if (typeof rec.fingerprint !== "string" || typeof rec.kind !== "string" || typeof rec.summary !== "string" || typeof rec.ts !== "number")
		return null;
	const source = rec.source === "realtime" || rec.source === "daily" || rec.source === "weekly" ? rec.source : "main";
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

function readStore(file: string): { incidents: IncidentRec[]; resolutions: ResolutionRec[]; lines: string[] } {
	let lines: string[] = [];
	try {
		lines = readFileSync(file, "utf8").split("\n").filter(l => l.trim());
	} catch {}
	const incidents: IncidentRec[] = [];
	const resolutions: ResolutionRec[] = [];
	for (const line of lines) {
		const rec = parseLine(line);
		if (!rec) continue;
		if ("type" in rec) resolutions.push(rec);
		else incidents.push(rec);
	}
	return { incidents, resolutions, lines };
}

function writeFile(cfg: Config, file: string, lines: string[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${lines.join("\n")}\n`);
}

/** Every incident in file order, each folded with its last resolution record (if any). */
export function readIncidents(cfg: Config): IncidentView[] {
	const store = readStore(incidentsFile(cfg));
	const views = new Map<string, IncidentView>();
	for (const rec of store.incidents) views.set(rec.id, { ...rec, resolution: null });
	for (const res of store.resolutions) {
		const v = views.get(res.id);
		if (v) v.resolution = res;
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
		return { incident: { ...open, resolution: null }, deduped: true };
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
	return { incident: { ...rec, resolution: null }, deduped: false };
}

/**
 * Records the plan that fixes an incident: refused unless the file exists, is listed in its repo
 * INDEX.md, and contains `INCIDENT <id>` (the spawn gates look for that text). Returns the
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
	const repo = dirname(dirname(dirname(abs)));
	if (!q.readRepoIndex(repo).includes(abs)) return `${abs} is not listed in ${join(repo, q.REPO_INDEX)}`;
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

/** Records why an incident is not a bug (or not worth fixing); an empty why is refused. */
export function dismissIncident(cfg: Config, id: string, why: string): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	if (!store.incidents.some(i => i.id === id)) return `unknown incident ${id}`;
	const res = store.resolutions.filter(r => r.id === id).at(-1);
	if (res) return `incident ${id} already has a ${res.type} record`;
	if (!why.trim()) return "refused: an empty --why would hide the incident without a recorded reason";
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "dismiss", id, why })}\n`);
	return null;
}

/**
 * Records that an incident's fix shipped: the queue writes this when it closes a plan citing
 * `INCIDENT <id>` (plan P5), so the guards stop pushing a bug whose fix just landed. Refusals
 * mirror `incident plan`; the caller logs them and closes anyway.
 */
export function fixedIncident(cfg: Config, id: string, plan: string, now = nowSec()): string | null {
	const file = incidentsFile(cfg);
	const store = readStore(file);
	if (!store.incidents.some(i => i.id === id)) return `unknown incident ${id}`;
	const res = store.resolutions.filter(r => r.id === id).at(-1);
	if (res) return `incident ${id} already has a ${res.type} record`;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify({ type: "fixed", id, plan, ts: now })}\n`);
	return null;
}
