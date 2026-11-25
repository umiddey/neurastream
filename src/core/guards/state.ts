// Shared guard state, primitives, and pure helpers.
// Zero imports from team-client.ts or sibling guards/* modules so the barrel export order is TDZ-safe.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { Decision } from "../adapter.ts";
import type { Claim, Unreachable } from "../claims.ts";
import { nowSec, strftime } from "../clock.ts";
import type { Config } from "../config.ts";
import { withFileLock, writeAtomicSync } from "../file-lock.ts";
import { appendOwnerMessage, openIncidents, ownerMessagesFile, type IncidentView } from "../incidents.ts";
import { ownerLogFile, recordOwnerLog } from "../owner-log.ts";
import { MAIN_ONLY_LINE } from "../plan-approval.ts";
import * as q from "../queue/lib.ts";
import type { Plan } from "../queue/lib.ts";
import { ownerText, UNANSWERED_PREFIX } from "../rollover.ts";
import { levelFor, readLevels } from "../rule-levels.ts";

export const ALLOW: Decision = { allow: true, reason: "" };

/**
 * The plan-edit decision: a Decision plus the allow-with-amendment fields of the plan-read guard
 * (I-20261025-208). On allow, `rewrite` names the file the caller writes back (the auto-listed
 * read section) and `note` is the receipt for the tool result; both travel through the guard
 * CLI's JSON output. They live here, not on the shared Decision, so every other check keeps the
 * plain shape.
 */
export interface PlanEditDecision extends Decision {
	rewrite?: { path: string; text: string };
	note?: string;
}

/** Who launches an agent: Main's launch may use a plan review's exemption, a sub's never may (plan 20261028_1600 P4i). */
export type Spawner = "main" | "sub";

/** Every refusal names its guard rule id (plan 20261110_1746 P8a); the id ends the text as ` [rule <id>]`. */
export function deny(reason: string, rule: string): Decision {
	return { allow: false, reason: `${reason} [rule ${rule}]` };
}

/** Guard-log line, `<ISO UTC> [<main id>] <line>`; a failed append is swallowed. */
export function log(file: string, line: string): void {
	try {
		appendFileSync(file, `${new Date().toISOString()} [${mainId()}] ${line}\n`);
	} catch {}
}

// Owner message that may call work off ("don't do X" must hold even if no plan
// exists yet). Flagged until Main records it with queue-cancel; no spawn and no stop until then.
export const CANCEL_TODO =
	'the owner\'s message may call work off. Record it first: an indexed plan → `queue-cancel <plan> "<owner words>"`; ' +
	'work with no plan (yet) → `queue-cancel --never "<what must not be done>" "<owner words>" [--repo <repo>]`; ' +
	'nothing was called off → `queue-cancel --not-a-cancel "<why>"`.';

/** A live plan file (archived plans excluded); Main's plan-text checks run on these. Subfolders like docs/plans/immediate/ hold live plans too. */
export const MAIN_PLAN_FILE = /\/docs\/plans\/(?!archive\/)(?:[^/]+\/)*[^/]+\.md$/;

// --- state the decisions keep in the queue state dir (survives one-shot CLI calls) ---

export interface EditWindow {
	used: string[];
	windowStart: number;
	/** Main tool calls since the last owner prompt or terminal hand-back (main_call_exempt_tools never count). */
	mainCalls: number;
	/** When the first of those calls was counted; the count expires MAIN_CALLS_RESET_SEC later. */
	mainCallsStart?: number;
}

// --- this Main's identity (plan 20261027_1300_multi_main P2) ---

/** What `neurastream main --name` accepts and what `NEURASTREAM_MAIN_ID` may hold. */
export const MAIN_ID_RE = /^[a-z0-9-]{1,24}$/;

/** This Main's id: the launcher sets `NEURASTREAM_MAIN_ID` (default `main`); a bogus value falls back to `main`. */
export function mainId(): string {
	const id = process.env.NEURASTREAM_MAIN_ID ?? "main";
	return MAIN_ID_RE.test(id) ? id : "main";
}

/** One-time move of the pre-multi-main top-level state into `mains/main/` (renameSync, idempotent). */
function moveLegacyState(stateDir: string, dir: string): void {
	if (existsSync(dir)) return;
	mkdirSync(dir, { recursive: true });
	for (const name of ["edit-window.json", "rollover"]) {
		try {
			renameSync(path.join(stateDir, name), path.join(dir, name));
		} catch {}
	}
}

/** This Main's own state dir, `<queue_state>/mains/<id>/`: edit window, rollover notes, running lock. */
export function mainStateDir(cfgOrPaths: Config | Pick<q.QueuePaths, "queue_state">): string {
	const stateDir = "paths" in cfgOrPaths ? cfgOrPaths.paths.queue_state : cfgOrPaths.queue_state;
	const id = mainId();
	const dir = path.join(stateDir, "mains", id);
	if (id === "main") moveLegacyState(stateDir, dir);
	return dir;
}

function windowFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(mainStateDir(paths), "edit-window.json");
}

export function readWindow(paths: Pick<q.QueuePaths, "queue_state">): EditWindow {
	try {
		const w = JSON.parse(readFileSync(windowFile(paths), "utf8")) as Partial<EditWindow>;
		if (Array.isArray(w.used) && typeof w.windowStart === "number")
			return { used: w.used, windowStart: w.windowStart, mainCalls: typeof w.mainCalls === "number" ? w.mainCalls : 0, mainCallsStart: typeof w.mainCallsStart === "number" ? w.mainCallsStart : 0 };
	} catch {}
	return { used: [], windowStart: 0, mainCalls: 0 };
}

export function writeWindow(w: EditWindow, paths: Pick<q.QueuePaths, "queue_state">): void {
	const file = windowFile(paths);
	try {
		withFileLock(`${file}.lock`, () => {
			writeAtomicSync(file, JSON.stringify(w, null, 1));
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${file}: ${err}`);
	}
}

/**
 * Locked read-modify-write helper for `edit-window.json`.
 *
 * Args:
 *     paths (Pick<q.QueuePaths, "queue_state">): Queue state paths
 *     mutate ((w: EditWindow) => { write: boolean; result: T }): Mutation callback executed under lock
 *
 * Returns:
 *     T: Callback result
 */
export function updateWindow<T>(paths: Pick<q.QueuePaths, "queue_state">, mutate: (w: EditWindow) => { write: boolean; result: T }): T {
	const file = windowFile(paths);
	try {
		return withFileLock(`${file}.lock`, () => {
			const w = readWindow(paths);
			const { write, result } = mutate(w);
			if (write) writeAtomicSync(file, JSON.stringify(w, null, 1));
			return result;
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${file}: ${err}`);
		return mutate(readWindow(paths)).result;
	}
}

/**
 * A count older than this starts over, even with no owner message or hand-back: a blocked stop is
 * a continuation, not a hand-back, so without it a capped Main with no owner awake stays refused
 * all night.
 */
export const MAIN_CALLS_RESET_SEC = 15 * 60;

export function mainCallsExpired(w: EditWindow): boolean {
	return w.mainCalls > 0 && nowSec() - (w.mainCallsStart ?? 0) >= MAIN_CALLS_RESET_SEC;
}

/** Main's terminal hand-back (the adapter's agent_end without willContinue): the turn is over, so
 * the next one starts at 0 calls. The edit window keeps its own reset rules. */
export function resetMainCalls(paths: Pick<q.QueuePaths, "queue_state">): void {
	updateWindow(paths, (w) => {
		if (w.mainCalls === 0) return { write: false, result: undefined };
		w.mainCalls = 0;
		return { write: true, result: undefined };
	});
}

// --- spawn & staffing persistence ---

function spawnsFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "spawns.json");
}

function staffingFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "staffing.json");
}

/** One staffing.json entry: the task names of a plan's newest spawn and when it was spawned (epoch sec). An old bare-array entry has no spawn time and reads as at 0. */
export interface StaffingEntry {
	names: string[];
	at: number;
}

/** plan → its staffing entry (staffing.json). */
export function readStaffingEntries(paths: Pick<q.QueuePaths, "queue_state">): Record<string, StaffingEntry> {
	try {
		const raw: unknown = JSON.parse(readFileSync(staffingFile(paths), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, StaffingEntry> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (Array.isArray(v)) out[k] = { names: v.map(String), at: 0 };
			else if (v && typeof v === "object" && "names" in v && Array.isArray(v.names)) {
				out[k] = { names: v.names.map(String), at: "at" in v ? Number(v.at) || 0 : 0 };
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** plan → the task names of its newest spawn (staffing.json); read for the staffed check. */
export function readStaffing(paths: Pick<q.QueuePaths, "queue_state">): Record<string, string[]> {
	return Object.fromEntries(Object.entries(readStaffingEntries(paths)).map(([f, e]) => [f, e.names]));
}

export function readSpawns(paths: Pick<q.QueuePaths, "queue_state">): Record<string, string> {
	try {
		const raw: unknown = JSON.parse(readFileSync(spawnsFile(paths), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) out[k] = String(v);
		return out;
	} catch {
		return {};
	}
}

/** Remember the "## Progress" hash of the plans an agent was just spawned on. With `staffing`, also record the spawn's task names per plan (staffing.json); a plan's entry is replaced by the newest spawn that names it. */
export function recordSpawns(files: string[], paths: Pick<q.QueuePaths, "queue_state">, staffing: Record<string, string[]> = {}): void {
	const spFile = spawnsFile(paths);
	try {
		withFileLock(`${spFile}.lock`, () => {
			const s = readSpawns(paths);
			for (const f of files) {
				try {
					s[f] = q.sha(q.progressBody(readFileSync(f, "utf8")));
				} catch {}
			}
			writeAtomicSync(spFile, JSON.stringify(s, null, 1));
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${spFile}: ${err}`);
	}
	if (!Object.keys(staffing).length) return;
	const stFile = staffingFile(paths);
	try {
		withFileLock(`${stFile}.lock`, () => {
			const st = readStaffingEntries(paths);
			const at = nowSec();
			for (const [f, names] of Object.entries(staffing)) if (names.length) st[f] = { names: [...names], at };
			writeAtomicSync(stFile, JSON.stringify(st, null, 1));
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${stFile}: ${err}`);
	}
}

/**
 * Remove one plan's entry from `spawns.json` atomically under its file lock.
 *
 * Args:
 *     file (string): Absolute plan file path to remove
 *     paths (Pick<q.QueuePaths, "queue_state">): Queue state paths
 *
 * Returns:
 *     void
 */
export function deleteSpawnRecord(file: string, paths: Pick<q.QueuePaths, "queue_state">): void {
	const spFile = spawnsFile(paths);
	try {
		withFileLock(`${spFile}.lock`, () => {
			if (!existsSync(spFile)) return;
			const s = readSpawns(paths);
			if (!(file in s)) return;
			delete s[file];
			writeAtomicSync(spFile, JSON.stringify(s, null, 1));
		});
	} catch {}
}

/** Plans with a running subagent: one of the plan's staffing names equals a running job label, or the label is that name with the spawner's uniqueness suffix ("-2", "-3", …; real snapshot 2026-10-25: `allocate()` keeps the exact name first, then appends). Pure; no job info staffs nothing. */
export function staffedPlans(staffing: Record<string, string[]>, runningJobs: string[] | undefined): string[] {
	if (!runningJobs?.length) return [];
	return Object.entries(staffing)
		.filter(([, names]) => names.some(n => runningJobs.some(j => j === n || j.startsWith(`${n}-`))))
		.map(([file]) => file);
}

/** Re-key a plan's spawn hash after its Progress body was trimmed. Only a hash that matched the old body moves. Pure. */
export function rekeySpawns(spawns: Record<string, string>, file: string, before: string, after: string): boolean {
	if (spawns[file] !== q.sha(before)) return false;
	spawns[file] = q.sha(after);
	return true;
}

/** Apply rekeySpawns to the stored spawn hashes under the spawns.json lock. */
export function rekeySpawnFile(file: string, before: string, after: string, paths: Pick<q.QueuePaths, "queue_state">): void {
	const spFile = spawnsFile(paths);
	try {
		withFileLock(`${spFile}.lock`, () => {
			const s = readSpawns(paths);
			if (!rekeySpawns(s, file, before, after)) return;
			writeAtomicSync(spFile, JSON.stringify(s, null, 1));
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${spFile}: ${err}`);
	}
}

// --- per-spawn call budgets ---

// A per-spawn call budget: `Call budget: <N>` on its own line in a task brief (the task's own
// text wins over the shared context). Main sets it at spawn time; the run's hard stop is N and
// its warning band has the global width (sub_max_calls - sub_warn_calls), floored at 1.
const BUDGET_LINE = /^\s*(?:[-*]\s+)?call budget:\s*(\d{1,4})\s*$/im;

/** The first `Call budget: <N>` line of a brief, or null. */
export function briefBudget(brief: string): number | null {
	const m = BUDGET_LINE.exec(brief);
	return m ? Number(m[1]) : null;
}

function budgetsFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "spawn-budgets.json");
}

/** The budgets recorded at spawn: task name → calls (next to the spawn hashes). */
export function readBudgets(dir: string): Record<string, number> {
	try {
		const raw: unknown = JSON.parse(readFileSync(path.join(dir, "spawn-budgets.json"), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** Remember the named tasks' call budgets atomically under lock; a name's old budget is replaced, a null one removed. */
export function recordBudgets(entries: Record<string, number | null>, paths: Pick<q.QueuePaths, "queue_state">): void {
	const names = Object.keys(entries);
	if (!names.length) return;
	const bFile = budgetsFile(paths);
	try {
		withFileLock(`${bFile}.lock`, () => {
			const budgets = readBudgets(paths.queue_state);
			for (const n of names) {
				const b = entries[n];
				if (b == null) delete budgets[n];
				else budgets[n] = b;
			}
			writeAtomicSync(bFile, JSON.stringify(budgets, null, 1));
		});
	} catch (err) {
		log(`${paths.queue_state}/../main-guard.log`, `cannot write ${bFile}: ${err}`);
	}
}

/** A sub's hard call cap: the budget recorded for its task name at spawn, else the global cap. */
export function subCallCap(agentId: string, cfg: Config): number {
	return readBudgets(cfg.paths.queue_state)[agentId] ?? cfg.guards.sub_max_calls;
}

// --- Main's read log (`main-reads.json` in the queue state dir): files Main has read itself ---

const MAIN_READ_KEEP_MS = 7 * 86_400_000;
const GREP_LINE = /^([^\s:]+):\d+:/gm;

/** Logs existing files as read now atomically under lock; entries older than 7 days are dropped on each write. */
export function recordMainReads(files: string[], paths: Pick<q.QueuePaths, "queue_state">, now = Date.now()): void {
	const file = path.join(paths.queue_state, "main-reads.json");
	const existing = files.filter(f => {
		try {
			return statSync(f).isFile();
		} catch {
			return false;
		}
	});
	if (existing.length === 0) return;
	try {
		withFileLock(`${file}.lock`, () => {
			let reads: Record<string, string> = {};
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reads = parsed as Record<string, string>;
			} catch {}
			const stamp = new Date(now).toISOString();
			for (const f of existing) reads[f] = stamp;
			const cutoff = now - MAIN_READ_KEEP_MS;
			for (const [f, t] of Object.entries(reads)) if (!(Date.parse(t) >= cutoff)) delete reads[f];
			writeAtomicSync(file, JSON.stringify(reads, null, 2));
		});
	} catch {}
}

export function readMainReads(paths: Pick<q.QueuePaths, "queue_state">): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path.join(paths.queue_state, "main-reads.json"), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

export function recordMainResult(tool: string, input: Record<string, unknown>, cwd: string, text: string, paths: Pick<q.QueuePaths, "queue_state">): void {
	const base = typeof input.cwd === "string" ? path.resolve(cwd, q.expandHome(input.cwd)) : cwd;
	const dir = q.shellCwd(String(input.command ?? input.code ?? ""), base);
	recordMainReads([...text.matchAll(GREP_LINE)].map(m => path.resolve(dir, m[1] ?? "")), paths);
}

// --- shared pure helpers used across multiple guard submodules ---

/** Applies the owner's rule level to a refusal. Only with `tuning.guards` on; a refusal with no `[rule <id>]` suffix, or a pinned, unset or corrupt id, stays `block`. */
export function tuned(d: Decision, cfg: Config): Decision {
	if (d.allow || !cfg.tuning.guards) return d;
	const id = /\[rule ([\w.-]+)\]$/.exec(d.reason)?.[1];
	if (!id) return d;
	const level = levelFor(readLevels(cfg), id);
	if (level === "block") return d;
	return { allow: true, reason: level === "tell" ? d.reason : "" };
}

/** Epoch ms when the owner's open unlock window closes, or null when the guard is locked. */
export function unlockUntilMs(cfg: Config): number | null {
	try {
		const until = statSync(cfg.paths.unlock).mtimeMs + cfg.guards.unlock_minutes * 60_000;
		return Date.now() < until ? until : null;
	} catch {
		return null;
	}
}

/**
 * One line for Main's prompt while the owner's unlock is open. A chat "unlock" is swallowed by the
 * input handler (the model never sees the message), so the adapter also wakes Main with a message.
 */
export function unlockLine(cfg: Config): string {
	const until = unlockUntilMs(cfg);
	if (until === null) return "";
	const hhmm = new Date(until).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return `\nguards: UNLOCKED until ${hhmm} — guard files are open; do the step that waited on the unlock now.`;
}

// Text files never count: only files apart from .md or .txt do.
function freeExt(cfg: Config): RegExp {
	return new RegExp(cfg.guards.free_ext, "i");
}

export function isProjectPath(p: string, cfg: Config): boolean {
	const roots = cfg.paths.work_roots.map(r => q.expandHome(r));
	const free = cfg.guards.free_prefixes.map(f => q.expandHome(f));
	return (
		roots.some(r => p.startsWith(r) && p.length > r.length) &&
		!free.some(f => p.startsWith(f) || `${p}/` === f) &&
		!q.isOrchestrationPath(p, q.activePlans(cfg.paths), cfg.paths.queue_index)
	);
}

// Project files this call would change; empty = the call does not count toward the limit.
// Only real write targets count: reads, git landing commands (commit, push, merge, pull, rebase,
// cherry-pick, worktree) and paths merely mentioned in a body or command are free.
export function changedProjectFiles(toolName: string, input: Record<string, unknown>, cwd: string, cfg: Config): string[] {
	return q
		.writeTargets(toolName, input ?? {}, cwd, cfg.paths)
		.filter(p => !freeExt(cfg).test(p) && isProjectPath(p, cfg));
}

/**
 * Main's tool result: each `path:line:` at a line start (grep -n / grep -rn output) names a file
 * Main read. Paths resolve against the directory the call ran in (its `cwd`, then any `cd`).
 */
export function revertMainEdit(tool: string, input: Record<string, unknown>, cwd: string, cfg: Config): void {
	const files = changedProjectFiles(tool, input, cwd, cfg);
	if (!files.length) return;
	const entry = `${tool}:${files[0]!}`;
	updateWindow(cfg.paths, (w) => {
		const idx = w.used.lastIndexOf(entry);
		if (idx < 0) return { write: false, result: undefined };
		w.used.splice(idx, 1);
		return { write: true, result: undefined };
	});
}

// A bypass launch goes around the harness guards (today's config entry names a CLI runner), so it
// needs an open plan: first word ... last word of the config entry must appear in the command line.
export function bypassRegExp(entry: string): RegExp {
	const words = entry.trim().split(/\s+/).filter(Boolean);
	if (words.length === 1) return new RegExp(`\\b${(words[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	const head = (words[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const tail = (words[words.length - 1] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\b${head}\\b[^\\n]*\\b${tail}\\b`);
}

// --- owner prose & incidents helpers ---

/** P3 (plan 20261031_1207): the text is owner prose — not Main's own guard output, a system notice, a task result — so its words are the owner's. Gates both the owner-message store and the cancel flag. The P5b resume prefix makes a wrapped machine prompt owner-shaped, so it is excluded here like its unwrapped form. */
export function isOwnerProse(text: string): boolean {
	const t = text.trimStart();
	return !(t.startsWith("main-guard:") || t.startsWith(UNANSWERED_PREFIX) || t.startsWith("<system-notice>") || text.includes("<task-result"));
}

export function recordOwnerMessage(text: string, cfg: Config): void {
	if (!isOwnerProse(text)) return;
	const owner = ownerText(text);
	if (owner) {
		try {
			recordOwnerLog(cfg, "owner", owner);
		} catch (err) {
			log(cfg.paths.guard_log, `cannot write ${ownerLogFile(cfg.paths)}: ${err}`);
		}
	}
	try {
		appendOwnerMessage(text, cfg.paths, nowSec());
	} catch (err) {
		log(cfg.paths.guard_log, `cannot write ${ownerMessagesFile(cfg.paths)}: ${err}`);
	}
}

export function openIncidentList(cfg: Config): IncidentView[] {
	try {
		return openIncidents(cfg);
	} catch (err) {
		log(cfg.paths.guard_log, `cannot read incidents: ${err}`);
		return [];
	}
}

/** The injected prompt line for one open incident, with the two ways to clear it. */
export function incidentLine(i: IncidentView): string {
	return (
		`INCIDENT ${i.id} [${i.source}/${i.kind}]: ${i.summary} — plan the fix: \`neurastream incident plan ${i.id} <plan.md>\`` +
		` (the plan must contain "INCIDENT ${i.id}"), or dismiss: \`neurastream incident dismiss ${i.id} --why "<text>"\``
	);
}

/** The held refusal (plan 20261027_1300 P3, widened 20261027_1305 P3): a down team server, another member's row, or today's "plan X is held by Main B since HH:MM" (HH:MM local). */
export function heldProblem(file: string, held: Claim | Unreachable): string {
	if ("unreachable" in held) return `team server ${held.unreachable} unreachable; plan ${file} is refused until it answers`;
	if (held.mine === false) return `plan ${file} is held by another member's Main ${held.main} since ${strftime(held.since, "%H:%M")}`;
	return `plan ${file} is held by Main ${held.main} since ${strftime(held.since, "%H:%M")}`;
}

// --- plan progress & phase helpers ---

// Phase ids (P1, P2, P4a ...) in the plan's Phases section that are not ticked yet.
export function unticked(p: Plan): string[] {
	const phases = q.sections(p.text).get("phases") ?? "";
	return [...phases.matchAll(/^\s*[-*]\s+\[ \]\s+(P\d+[a-z]?)\b/gm)].map(m => m[1]!);
}

/** Phase ids an edit newly ticks: `[ ]` in `before`, `[x]` in `after` (P6, read from the Phases section like unticked). */
export function newlyTicked(before: string, after: string): string[] {
	const was = new Set([...(q.sections(before).get("phases") ?? "").matchAll(/^\s*[-*]\s+\[ \]\s+(P\d+[a-z]?)\b/gm)].map(m => m[1]!));
	return [...(q.sections(after).get("phases") ?? "").matchAll(/^\s*[-*]\s+\[[xX]\]\s+(P\d+[a-z]?)\b/gm)].map(m => m[1]!).filter(id => was.has(id));
}

/** One "## Progress" entry: its "- " line plus indented continuation lines (trimProgressBody's entry rule). */
export function progressEntries(text: string): string[] {
	const blocks: string[] = [];
	const lines = q.progressBody(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i];
		if (head === undefined || !head.startsWith("- ") || MAIN_ONLY_LINE.test(head)) continue;
		const block = [head];
		while (i + 1 < lines.length) {
			const cont = lines[i + 1];
			if (cont === undefined || !/^[ \t]/.test(cont)) break;
			block.push(cont);
			i++;
		}
		blocks.push(block.join("\n"));
	}
	return blocks;
}

/** Entries an edit adds or rewrites: blocks whose text was not in the Progress section before. */
export function newProgressEntries(before: string, after: string): string[] {
	const old = new Set(progressEntries(before));
	return progressEntries(after).filter(b => !old.has(b));
}

/** The value after the entry's last "Findings:", or null when it has no Findings line with content. A "Findings:"
 *  quoted earlier in the entry (e.g. inside resume steps) is entry text, never the findings (I-20261025-51). */
export function findingsValue(block: string): string | null {
	const line = block.split("\n").findLast(l => l.includes("Findings:"));
	if (!line) return null;
	return line.slice(line.lastIndexOf("Findings:") + "Findings:".length).trim() || null;
}
