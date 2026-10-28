// Guard rules, ported from the original main-guard and plan-guard extensions as pure decision
// functions on one event + config. No harness here: an adapter (or `neurastream guard <event>
// --json`) maps its own events onto these, applies `restore`, and feeds back the counters the
// decision returns in `state`.
//
// Callers must first map config into the queue paths (applyQueueEnv): the queue library resolves
// INDEX.md, blockers, state, subagents, cancelled and unlock from those env vars.
//
// Ported rules:
//   - protected guard files, unlockable by the owner for `guards.unlock_minutes`
//   - subs: no queue-close/queue-cancel, call budget 90/100, plan edits only inside "## Progress",
//     blocker execution, invalid plans refuse
//   - main: project-file changes per `main_window_min` window capped by the autonomy tier
//     (strict: `autonomy.strict_edit_limit`, opinionated: 5, full: none), spawn
//     gate (allow-list, task-only, open plan, new Progress since last run), bypass launches go
//     through the same plan gate, cancel-pending blocks spawns and stops, keep-working stop rule;
//     tier strict additionally refuses `git push` / `glab mr merge` / `gh pr merge` until the
//     owner's one-shot `go`, and tier full lets a `Priority skip: <plan> — Main: "<reason>"` line
//     past the priority gate
//   - incidents: while an incident is open (src/core/incidents.ts: no plan/dismiss/fixed record)
//     every Main prompt lists it, a spawn must be fix work (its plan cites `INCIDENT <id>`), and
//     the stop is refused; an incident with a plan no longer blocks

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision, InjectEvent, PlanEditEvent, SpawnEvent, StopEvent, ToolEvent } from "./adapter.ts";
import { currentTier, takeGo, type Tier } from "./autonomy.ts";
import { approvalProblem } from "./plan-approval.ts";
import type { Config } from "./config.ts";
import { addIncident, openIncidents, ownerMessagesFile, ownerSaid, readOwnerMessages, type IncidentView, type OwnerMessage } from "./incidents.ts";
import { notifyProtectedPaths, notifySecretReadHit } from "./notify.ts";
import * as q from "./queue/lib.ts";
import type { Plan } from "./queue/lib.ts";

import { nowSec } from "./clock.ts";
import { outUntil, pinModel, providerOfModel, readOut } from "./provider-state.ts";
const ALLOW: Decision = { allow: true, reason: "" };

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

function deny(reason: string): Decision {
	return { allow: false, reason };
}

/** Guard-log line, `<ISO UTC> <line>`; a failed append is swallowed. */
export function log(file: string, line: string): void {
	try {
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

// Owner message that may call work off ("don't do X" must hold even if no plan
// exists yet). Flagged until Main records it with queue-cancel; no spawn and no stop until then.
export const CANCEL_TODO =
	'the owner\'s message may call work off. Record it first: an indexed plan → `queue-cancel <plan> "<owner words>"`; ' +
	'work with no plan (yet) → `queue-cancel --never "<what must not be done>" "<owner words>" [--repo <repo>]`; ' +
	'nothing was called off → `queue-cancel --not-a-cancel "<why>"`.';

// --- state the decisions keep in the queue state dir (survives one-shot CLI calls) ---

interface EditWindow {
	used: string[];
	windowStart: number;
}

function windowFile(): string {
	return path.join(q.STATE_DIR, "edit-window.json");
}

export function readWindow(): EditWindow {
	try {
		const w = JSON.parse(readFileSync(windowFile(), "utf8")) as EditWindow;
		if (Array.isArray(w.used) && typeof w.windowStart === "number") return w;
	} catch {}
	return { used: [], windowStart: 0 };
}

export function writeWindow(w: EditWindow): void {
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(windowFile(), JSON.stringify(w, null, 1));
	} catch (err) {
		log(`${q.STATE_DIR}/../main-guard.log`, `cannot write ${windowFile()}: ${err}`);
	}
}

function spawnsFile(): string {
	return path.join(q.STATE_DIR, "spawns.json");
}

function staffingFile(): string {
	return path.join(q.STATE_DIR, "staffing.json");
}

// The owner-message store (owner-messages.jsonl) and its matcher live in src/core/incidents.ts
// (20261028_0900 P3): dismissIncident needs them too, and guards already imports incidents.

function recordOwnerMessage(text: string, cfg: Config): void {
	if (text.trimStart().startsWith("main-guard:") || text.trimStart().startsWith("<system-notice>") || text.includes("<task-result")) return;
	const file = ownerMessagesFile();
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		const messages = readOwnerMessages();
		messages.push({ at: nowSec(), text });
		writeFileSync(file, `${messages.slice(-50).map(m => JSON.stringify(m)).join("\n")}\n`);
	} catch (err) {
		log(cfg.paths.guard_log, `cannot write ${file}: ${err}`);
	}
}

/** plan → the task names of its newest spawn (staffing.json); read for the staffed check. */
export function readStaffing(): Record<string, string[]> {
	try {
		const raw: unknown = JSON.parse(readFileSync(staffingFile(), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.map(String);
		return out;
	} catch {
		return {};
	}
}

function readSpawns(): Record<string, string> {
	try {
		const raw: unknown = JSON.parse(readFileSync(spawnsFile(), "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) out[k] = String(v);
		return out;
	} catch {
		return {};
	}
}

/** Remember the "## Progress" hash of the plans an agent was just spawned on. With `staffing`, also record the spawn's task names per plan (staffing.json); a plan's entry is replaced by the newest spawn that names it. */
export function recordSpawns(files: string[], staffing: Record<string, string[]> = {}): void {
	const s = readSpawns();
	for (const f of files) {
		try {
			s[f] = q.sha(q.progressBody(readFileSync(f, "utf8")));
		} catch {}
	}
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(spawnsFile(), JSON.stringify(s, null, 1));
	} catch (err) {
		log(`${q.STATE_DIR}/../main-guard.log`, `cannot write ${spawnsFile()}: ${err}`);
	}
	if (!Object.keys(staffing).length) return;
	const st = readStaffing();
	for (const [f, names] of Object.entries(staffing)) if (names.length) st[f] = [...names];
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(staffingFile(), JSON.stringify(st, null, 1));
	} catch (err) {
		log(`${q.STATE_DIR}/../main-guard.log`, `cannot write ${staffingFile()}: ${err}`);
	}
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

/** Apply rekeySpawns to the stored spawn hashes. */
export function rekeySpawnFile(file: string, before: string, after: string): void {
	const s = readSpawns();
	if (!rekeySpawns(s, file, before, after)) return;
	try {
		writeFileSync(spawnsFile(), JSON.stringify(s, null, 1));
	} catch (err) {
		log(`${q.STATE_DIR}/../main-guard.log`, `cannot write ${spawnsFile()}: ${err}`);
	}
}

// A per-spawn call budget: `Call budget: <N>` on its own line in a task brief (the task's own
// text wins over the shared context). Main sets it at spawn time; the run's hard stop is N and
// its warning band has the global width (sub_max_calls - sub_warn_calls), floored at 1.
const BUDGET_LINE = /^\s*(?:[-*]\s+)?call budget:\s*(\d{1,4})\s*$/im;

/** The first `Call budget: <N>` line of a brief, or null. */
export function briefBudget(brief: string): number | null {
	const m = BUDGET_LINE.exec(brief);
	return m ? Number(m[1]) : null;
}

function budgetsFile(): string {
	return path.join(q.STATE_DIR, "spawn-budgets.json");
}

/** The budgets recorded at spawn: task name → calls (next to the spawn hashes). */
export function readBudgets(dir: string = q.STATE_DIR): Record<string, number> {
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

/** Remember the named tasks' call budgets; a name's old budget is replaced, a null one removed. */
export function recordBudgets(entries: Record<string, number | null>): void {
	const names = Object.keys(entries);
	if (!names.length) return;
	const budgets = readBudgets();
	for (const n of names) {
		const b = entries[n];
		if (b == null) delete budgets[n];
		else budgets[n] = b;
	}
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(budgetsFile(), JSON.stringify(budgets, null, 1));
	} catch (err) {
		log(`${q.STATE_DIR}/../main-guard.log`, `cannot write ${budgetsFile()}: ${err}`);
	}
}

/** A sub's hard call cap: the budget recorded for its task name at spawn, else the global cap. */
export function subCallCap(agentId: string, cfg: Config): number {
	return readBudgets()[agentId] ?? cfg.guards.sub_max_calls;
}

// --- shared pieces ---

function unlocked(cfg: Config): boolean {
	try {
		return Date.now() - statSync(q.UNLOCK).mtimeMs < cfg.guards.unlock_minutes * 60_000;
	} catch {
		return false;
	}
}

function protectedHit(paths: string[], cfg: Config): string | null {
	const hit = q.protectedHit(paths);
	if (hit) return hit;
	for (const p of paths) {
		for (const raw of cfg.guards.protected) {
			const g = q.expandHome(raw);
			if (g.endsWith("/") ? p.startsWith(g) || `${p}/` === g : p === g) return p;
		}
		// The user's config file and the configured notify secret files are guard surface too:
		// an agent that could rewrite them could point notify at its own webhook.
		if (notifyProtectedPaths(cfg).includes(p)) return p;
	}
	return null;
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
		!q.isOrchestrationPath(p)
	);
}

// Project files this call would change; empty = the call does not count toward the limit.
// Only real write targets count: reads, git landing commands (commit, push, merge, pull, rebase,
// cherry-pick, worktree) and paths merely mentioned in a body or command are free.
export function changedProjectFiles(toolName: string, input: Record<string, unknown>, cwd: string, cfg: Config): string[] {
	return q
		.writeTargets(toolName, input ?? {}, cwd)
		.filter(p => !freeExt(cfg).test(p) && isProjectPath(p, cfg));
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

const RESEARCH_ASK = /\b(research|investigate|find where|map the code|read the code for)\b/i;
const PLAN_WRITE = /\b(write|writing|draft|drafting|author)\b[^\n]*\bplan\b/i;

// Phase ids (P1, P2, P4a ...) in the plan's Phases section that are not ticked yet.
function unticked(p: Plan): string[] {
	const phases = q.sections(p.text).get("phases") ?? "";
	return [...phases.matchAll(/^\s*[-*]\s+\[ \]\s+(P\d+[a-z]?)\b/gm)].map(m => m[1]!);
}

// Plans an implementer brief may run on; returns [reason, null] or [null, plan files].
export function planGate(text: string, label: string, cfg?: Config): [string | null, string[]] {
	const plans = q.activePlans(undefined, undefined, cfg?.review.since ?? "");
	const unclosed = plans.filter(p => (p.status === "complete" || p.status === "cancelled") && !q.awaitingMerge(p));
	if (unclosed.length)
		return [
			`${label}: ${unclosed.map(p => `${p.file} (${p.status})`).join(", ")} is still indexed. Verify it and run \`queue-close <plan>\` before any new spawn.`,
			[],
		];
	// A `Priority skip: <path> — <why>` line names a plan it does NOT run on (20261025_0215 P3);
	// only the remaining text decides which plans this brief targets.
	const body = text.replace(/^\s*(?:[-*]\s+)?priority skip:.*$/gim, "");
	const named = plans.filter(p => body.includes(p.file));
	if (!named.length)
		return [
			`${label}: an implementer needs an open plan. Name the plan's absolute path in the brief; the plan must be listed in ${q.INDEX}.`,
			[],
		];
	if (RESEARCH_ASK.test(text) && PLAN_WRITE.test(text))
		return [
			`${label}: a brief must not ask for research for a plan to be written. Please never ever ever write a plan when another agent is doing the research or reading for you. Main reads the code for its plans itself.`,
			[],
		];
	const spawns = readSpawns();
	for (const p of named) {
		if (p.errors.length) return [`${label}: plan ${p.file} is not ready (${p.errors.join("; ")}).`, []];
		if (p.waiting) return [`${label}: plan ${p.file} is parked "WAITING on owner".`, []];
		if (p.status !== "open") return [`${label}: plan ${p.file} says "Status: ${p.status}".`, []];
		const cancelled = q.cancelledMatches(p);
		if (cancelled.length) return [`${label}: plan ${p.file} ${q.cancelledProblem(p, cancelled[0]!)}`, []];
		const before = spawns[p.file];
		if (before && before === q.sha(q.progressBody(p.text)))
			return [
				`${label}: plan ${p.file} has no new "## Progress" entry since the last agent ran on it. Write that run's progress (from its report) into the plan first.`,
				[],
			];
		if (cfg) {
			const approval = approvalProblem(p.text, p.file, cfg.pages.dir);
			if (approval) return [approval, []];
		}
		const open = unticked(p);
		if (!open.length) return [`${label}: plan ${p.file} has no unticked phase left.`, []];
		if (!open.some(id => new RegExp(`\\b${id}\\b`).test(text)))
			return [`${label}: the brief must name an unticked phase of ${p.file} (${open.join(", ")}).`, []];
	}
	return [null, named.map(p => p.file)];
}

// --- priority: index order is priority (plan 20261025_0215_index_priority) ---

export interface PrioritySkip {
	plan: string;
	why: string;
}

export interface PriorityOutcome {
	/** Refusal text, without the caller's label prefix. */
	problem?: string;
	/** Skip lines the brief justified; the caller logs each, then allows. */
	skips?: PrioritySkip[];
	/** No job info was available: the gate never refuses. */
	unknown?: boolean;
}

const SKIP_LINE = /^\s*(?:[-*]\s+)?priority skip:\s*(.+?)\s+[—–-]\s*(.+?)\s*$/gim;

/** One plan is idle when a subagent could start on it right now: open, no owner hold, not awaiting merge, no template errors, an unticked phase left, and not waiting on another open plan of the active index. */
function priorityIdle(p: Plan, plans: Plan[]): boolean {
	if (p.waitsOn.some(f => plans.some(w => w.file === f && w.status === "open"))) return false;
	return p.status === "open" && !p.waiting && !q.awaitingMerge(p) && !p.errors.length && unticked(p).length > 0;
}

/**
 * Pure priority gate: for the brief's named plans, every higher plan in index order that is idle
 * and unstaffed needs proof before a lower plan takes a free slot; otherwise the spawn is refused.
 * Proof is either the higher plan's own `Waits on: <plan>` line for a plan still open in the index
 * (then it is not idle at all) or a `Priority skip: <path> — owner: "<words>"` line whose quoted
 * words (≥ 4, normalised) appear in one of `messages` (the owner's recorded words of the last
 * 24 h; `now` is the current unix seconds). In tier full (`cfg`) a `Priority skip: <path> —
 * Main: "<reason>"` line with ≥ 4 words is proof too; without `cfg` the refusal behaviour is the
 * pre-tier one. Any other skip line is refused.
 * `staffed === undefined` means the caller had no running-job info (CLI spawn without it): never
 * refuse. Plans already named by this call never block it.
 */
export function priorityProblem(plans: Plan[], named: string[], staffed: string[] | undefined, brief: string, messages: OwnerMessage[] = [], now: number = nowSec(), cfg?: Config): PriorityOutcome | null {
	if (staffed === undefined) return { unknown: true };
	const namedRanks = named.map(f => plans.findIndex(p => p.file === f)).filter(n => n >= 0);
	if (!namedRanks.length) return null;
	const higher = plans.slice(0, Math.min(...namedRanks));
	const tier = cfg ? currentTier(cfg) : "opinionated";
	const skipLines: Record<string, string> = {};
	for (const m of brief.matchAll(SKIP_LINE)) {
		const plan = (m[1] ?? "").trim();
		const why = (m[2] ?? "").trim();
		if (plan && why) skipLines[plan] = why;
	}
	const skips: PrioritySkip[] = [];
	for (let i = 0; i < higher.length; i++) {
		const p = higher[i]!;
		if (!priorityIdle(p, plans) || staffed.includes(p.file)) continue;
		const why = skipLines[p.file];
		// Tier full (20261025_1940 P2): Main's own >= 4-word reason is proof enough; every other
		// tier refuses it exactly as before — only the owner's recorded words let a skip through.
		const mainWhy = tier === "full" ? why?.match(/^Main:\s*"(.+)"\s*$/) : undefined;
		if (why && mainWhy && mainWhy[1]!.trim().split(/\s+/).length >= 4) {
			skips.push({ plan: p.file, why });
			continue;
		}
		const quote = why?.match(/^owner:\s*"(.+)"\s*$/);
		if (why && quote && ownerSaid(quote[1]!, messages, now)) {
			skips.push({ plan: p.file, why });
			continue;
		}
		return { problem: `higher plan ${p.file} (rank ${i + 1}) is idle; a skip needs the owner's words (Priority skip: ${p.file} — owner: "<quote>") or a "Waits on: ${p.file}" line in that plan` };
	}
	return skips.length ? { skips } : null;
}

/** Load staffing and the owner's recorded words, run the pure priority gate and log its outcome; the refusal comes back with the caller's label, or null. */
function priorityGate(named: string[], runningJobs: string[] | undefined, brief: string, cfg: Config, label: string): string | null {
	const outcome = priorityProblem(q.activePlans(), named, runningJobs === undefined ? undefined : staffedPlans(readStaffing(), runningJobs), brief, readOwnerMessages(), nowSec(), cfg);
	if (outcome?.unknown) log(cfg.paths.guard_log, "PRIORITY unknown jobs");
	for (const s of outcome?.skips ?? []) log(cfg.paths.guard_log, `PRIORITY skip ${s.plan}: ${s.why}`);
	return outcome?.problem ? `${label}: ${outcome.problem}` : null;
}

/**
 * The owner's pick order (plan 20261025_1700 P3): refuse a later `ledger.prefer` agent while an
 * earlier one is free and under its provider cap, unless the brief carries "Pick note: <why>".
 * Free comes from the pin's provider and provider-out.jsonl (absence of a record is free);
 * "under its cap" counts the caller's running jobs whose label embeds the higher agent's name —
 * a caller without job info counts 0, erring toward the owner's order, which Pick note unlocks.
 */
export function preferProblem(agent: string, brief: string, runningJobs: readonly string[] | undefined, cfg: Config): string | null {
	const prefer = cfg.ledger.prefer;
	if (!prefer.length) return null;
	const mine = prefer.indexOf(agent);
	if (mine <= 0) return null; // the first pick, or an agent the order does not name
	if (/\bPick note:/i.test(brief)) return null;
	for (let j = 0; j < mine; j++) {
		const higher = prefer[j]!;
		const provider = providerOfModel(pinModel(cfg, higher));
		if (provider === null || outUntil(cfg, provider) !== null) continue; // unknown or out
		const running = (runningJobs ?? []).filter(l => l.toLowerCase().includes(higher.toLowerCase())).length;
		if (running >= cfg.ledger.max_running_per_provider) continue; // the higher pick is at its provider cap
		return `${higher} is ahead of ${agent} in ledger.prefer and free (under its provider cap) — spawn ${higher}, or add "Pick note: <why>" to the brief.`;
	}
	return null;
}

/**
 * Who is rate-limited comes from live data (plan 20261025_1700 P1): refuse a brief that asserts a
 * provider shown free by providerStatus is rate-limited — named directly or through a prefer
 * agent's pin. providerStatus lists only providers with a record, so a never-recorded provider is
 * not protected here; a past-tense mention does not match, because the claim must say "is …".
 */
export function providerClaimProblem(text: string, cfg: Config): string | null {
	const recorded = new Set(readOut(cfg).map(r => r.provider));
	const free = (provider: string | null): boolean => provider !== null && recorded.has(provider) && outUntil(cfg, provider) === null;
	const names = new Map<string, string>();
	for (const p of cfg.ledger.providers) if (free(p)) names.set(p, p);
	for (const agent of cfg.ledger.prefer) {
		const provider = providerOfModel(pinModel(cfg, agent));
		if (free(provider) && !names.has(agent) && provider !== null) names.set(agent, provider);
	}
	if (!names.size || !/\bis\b/i.test(text)) return null;
	const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`\\b(${[...names.keys()].map(esc).join("|")})\\b[^.\\n]{0,80}?\\b(?:is|are)\\s+(?:still\\s+|now\\s+)?(?:rate[ -]?limited|rate limiting|throttled|out until|limited)`, "i").exec(text);
	if (!m) return null;
	const hit = [...names.entries()].find(([n]) => n.toLowerCase() === (m[1] ?? "").toLowerCase());
	if (hit === undefined) return null;
	const [name, provider] = hit;
	return `${name === provider ? provider : `${name} (provider ${provider})`} is free per the recorded provider state — do not claim it is rate-limited; read the providers line from agent-ledger --cap.`;
}

/** Reason to refuse a `task` brief, or null; `files` receives the plans to record, `budgets` every named task's call budget (null = none), `staffing` each plan's named tasks of this call, `runningJobs` the caller's running job labels (undefined = no job info). */
export function spawnProblem(
	input: Record<string, unknown>,
	cfg: Config,
	files: string[] = [],
	budgets: Record<string, number | null> = {},
	staffing: Record<string, string[]> = {},
	runningJobs?: string[],
): string | null {
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const context = String(input?.context ?? "");
	const allowed = q.allowedAgents();
	const shared = briefBudget(context);
	const named: Record<string, number | null> = {};
	for (const t of tasks) {
		const agent = String(t?.agent ?? "task");
		const label = String(t?.name ?? agent);
		if (!allowed.has(agent)) return `${label}: agent "${agent}" is not in "## Allowed" of ${q.SUBAGENTS_MD} (no expensive or unpinned models).`;
		const [why, plans] = planGate(`${context}\n${String(t?.task ?? "")}`, label, cfg);
		if (why) return why;
		// The task's own `Call budget:` line wins over the shared context's.
		const budget = briefBudget(String(t?.task ?? "")) ?? shared;
		if (budget !== null) {
			if (!t?.name) return `${label}: "Call budget: ${budget}" needs a task name (the budget is keyed by it).`;
			if (budget < 10 || budget > cfg.guards.sub_max_calls_cap)
				return `${label}: call budget ${budget} is outside the allowed range 10..${cfg.guards.sub_max_calls_cap}.`;
		}
		if (t?.name) {
			named[label] = budget;
			for (const f of plans) staffing[f] = [...(staffing[f] ?? []), label];
		}
		files.push(...plans);
	}
	Object.assign(budgets, named);
	// Who is limited and who goes first come from live data and ledger.prefer (plan 20261025_1700
	// P3): the same rules checkSpawn applies to single-spawn events, per task.
	const claim = providerClaimProblem(`${context}\n${tasks.map(t => String(t?.task ?? "")).join("\n")}`, cfg);
	if (claim) return claim;
	for (const t of tasks) {
		const pick = preferProblem(String(t?.agent ?? "task"), `${context}\n${String(t?.task ?? "")}`, runningJobs, cfg);
		if (pick) return `${String(t?.name ?? t?.agent ?? "task")}: ${pick}`;
	}
	// Priority gate (20261025_0215 P3): once per `task` call, over the plans this call names; the
	// skip lines may sit in the shared context or any task text.
	const gate = priorityGate(
		files,
		runningJobs,
		`${context}\n${tasks.map(t => String(t?.task ?? "")).join("\n")}`,
		cfg,
		String((tasks[0] && (tasks[0].name ?? tasks[0].agent)) ?? "task"),
	);
	return gate;
}

function runBlockers(plan: Plan, hit: string[], e: ToolEvent, cfg: Config): string | null {
	// A caller staffed on a different plan (staffing.json holds the task names, keyed by agentId)
	// only grazes this plan (I-20261028-111): its path blockers must judge the covered paths,
	// not every path the command names.
	const staffing = readStaffing();
	const foreign = !(staffing[plan.file] ?? []).includes(e.agentId) && Object.entries(staffing).some(([f, names]) => f !== plan.file && names.includes(e.agentId));
	for (const b of plan.blockers) {
		try {
			execFileSync(b.script, b.args, {
				input: JSON.stringify({ tool: e.tool, input: e.input, cwd: e.cwd, agent: e.agent, repo: plan.repo, plan: plan.file, paths: hit, ...(foreign ? { foreign: true } : {}) }),
				encoding: "utf8",
				timeout: cfg.guards.blocker_timeout_ms,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			const stderr = typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string" ? err.stderr.trim() : "";
			const message = err instanceof Error ? err.message : String(err);
			const why = stderr || `${path.basename(b.script)} failed (${message})`;
			return `blocked by plan ${path.basename(plan.file)}: ${why}`;
		}
	}
	return null;
}

// Words a shell line may put before the tool: launchers, shells with -c, VAR=value, and a script path ending in main.ts.
const LAUNCHERS: Record<string, true> = { bun: true, run: true, neurastream: true, node: true, npx: true, bunx: true, env: true, sudo: true, nohup: true, exec: true, bash: true, sh: true, zsh: true, "-c": true };

// True when a command segment runs queue-close or queue-cancel: the tool is the segment's first word after launchers.
// Segments also split at $( and backticks, so substitutions and `sh -c "..."` bodies are checked too.
function runsCloser(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = (words[i] ?? "").split("/").pop() ?? "";
		return /^queue-(close|cancel)$/.test(cmd);
	});
}

// True when a command segment starts the owner page (plan 20261024_2230 P3c): `neurastream ui`
// serves it and `systemctl --user start/restart/enable` of neurastream-ui relaunches it — the
// owner's systemd moves, never an agent's, unlocked or not. Segment splitting and launcher
// skipping match runsCloser, so `sh -c "neurastream ui"` and `sudo systemctl --user ...` are seen.
function startsOwnerUi(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	const bin = (w: string | undefined) => (w ?? "").replace(/^["']+|["']+$/g, "").split("/").pop() ?? "";
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = bin(words[i]);
		if ((cmd === "ui" && bin(words[i - 1]) === "neurastream") || (cmd === "neurastream" && bin(words[i + 1]) === "ui")) return true;
		return (
			cmd === "systemctl" &&
			words.some(w => w === "--user") &&
			words.some(w => w === "start" || w === "restart" || w === "enable") &&
			words.some(w => bin(w) === "neurastream-ui" || w.startsWith("neurastream-ui."))
		);
	});
}

// True when a command segment lands work on a remote (plan 20261025_1940 P2): `git push`,
// `glab mr merge`, `gh pr merge`. Segment splitting and launcher skipping match startsOwnerUi,
// so `sh -c "git push"`, `sudo git push` and chained pushes are seen too.
function landingCommand(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = (words[i] ?? "").split("/").pop() ?? "";
		if (cmd === "git" && words[i + 1] === "push") return true;
		if (cmd === "glab" && words[i + 1] === "mr" && words[i + 2] === "merge") return true;
		if (cmd === "gh" && words[i + 1] === "pr" && words[i + 2] === "merge") return true;
		return false;
	});
}

// The read tool's stand-in for a value it hid. A file may hold one only where it is produced
// (secret-redact.ts) or exercised (its tests).
const PLACEHOLDER = "[REDACTED:";
const PLACEHOLDER_FILES = [/\/src\/core\/secret-redact\.ts$/, /\/tests\/secret-redact[^/]*\.test\.ts$/];
/** What a write/edit/ast_edit call would add: every text argument but the targets and the replaced text. */
function addedText(input: Record<string, unknown>): string {
	const skip = ["path", "file", "cwd", "old_string", "old", "oldText", "i"];
	return Object.entries(input)
		.filter(([key, value]) => typeof value === "string" && !skip.includes(key))
		.map(([, value]) => value as string)
		.join("\n");
}

// Subagent half of a tool call (the original plan-guard checkCall without the main return).
// `cap` is the sub's hard call cap: its recorded per-spawn budget, else the global sub_max_calls.
function subRules(e: ToolEvent, input: Record<string, unknown>, paths: string[], writes: string[], cfg: Config, cap: number): string | null {
	// Closing and cancelling are Main's decisions: a shell that runs the tool is refused; one that only names its path is not.
	if (cfg.guards.shell_tools.includes(e.tool) && runsCloser(input))
		return 'queue-close and queue-cancel are Main\'s; report in your plan\'s "## Progress" instead.';
	// The read tool prints a placeholder for a value it hid, never the value (I-20261027-158,
	// I-20261027-160: one copy silently broke the shipped config template). Writing that text back
	// is refused; the file that produces one and the tests that exercise it are the exceptions.
	if ((e.tool === "write" || e.tool === "edit" || e.tool === "ast_edit") && addedText(input).includes(PLACEHOLDER)) {
		const keeper = writes.length > 0 && writes.every(p => PLACEHOLDER_FILES.some(rx => rx.test(p)));
		if (!keeper)
			return "this is the read tool's redaction placeholder, not the real value; re-read the file raw or keep the original line";
	}
	const plans = q.activePlans();
	if (e.calls >= cap) {
		// Plan edit targets come from writeTargets (write and structured/hashline edit)
		// with touchedPaths as fallback; plan reads match any read tool.
		const planEdit =
			(e.tool === "write" || e.tool === "edit") &&
			(writes.length > 0 ? writes.every(p => q.planAt(p, plans)) : paths.length > 0 && paths.every(p => q.planAt(p, plans)));
		const planRead = cfg.guards.read_tools.includes(e.tool) && paths.length > 0 && paths.every(p => q.planAt(p, plans));
		if (!planEdit && !planRead)
			return `call budget spent (${e.calls}/${cap}). Only reading and editing your plan's "## Progress" is allowed now: write what you did, what is verified, what is next, then end your run.`;
	}
	if (!plans.length || !paths.length) return null;
	for (const p of writes) {
		if (!q.isOrchestrationPath(p, plans)) continue;
		if (!q.planAt(p, plans)) return `${p} belongs to Main (main index / blocker script); read it, never change it. Report instead.`;
		if (e.tool !== "write" && e.tool !== "edit")
			return `${p} is a plan file: change its "## Progress" section only with the edit or write tool.`;
	}
	for (const plan of plans) {
		const hit = paths.filter(p => !q.isOrchestrationPath(p, plans) && q.planCovers(plan, p, plans));
		if (!hit.length) continue;
		if (plan.errors.length) return `plan ${plan.file} is invalid (${plan.errors.join("; ")}). Stop and report to Main.`;
		const why = runBlockers(plan, hit, e, cfg);
		if (why) return why;
	}
	return null;
}

// Main's edit limit (20261025_1940 P2): the cap follows the autonomy tier — autonomy.strict_edit_limit
// in strict, guards.main_edit_limit in opinionated, none in full. Window starts at the first counted
// change, resets after main_window_min minutes and at every owner message. State lives in the queue
// state dir so one-shot CLI processes share the window (the original kept it in extension memory for
// one session).
function editWindow(e: ToolEvent, input: Record<string, unknown>, cfg: Config): Decision {
	const files = changedProjectFiles(e.tool, input, e.cwd, cfg);
	if (!files.length) return ALLOW;
	const tier = currentTier(cfg);
	if (tier === "full") return ALLOW; // no cap: Main works unattended
	const limit = tier === "strict" ? cfg.autonomy.strict_edit_limit : cfg.guards.main_edit_limit;
	const limitName = tier === "strict" ? "autonomy.strict_edit_limit" : "owner limit";
	const now = Date.now();
	const w = readWindow();
	if (w.used.length && now - w.windowStart >= cfg.guards.main_window_min * 60_000) w.used = [];
	if (w.used.length >= limit) {
		const mins = Math.ceil((w.windowStart + cfg.guards.main_window_min * 60_000 - now) / 60_000);
		log(cfg.paths.guard_log, `BLOCK tool=${e.tool} after ${w.used.length} edits (tier ${tier}): ${files.join(",")}`);
		return deny(
			`main-guard: tier ${tier} — Main already changed project files ${w.used.length} times in this ${cfg.guards.main_window_min}-minute window ` +
				`(${limitName} ${limit}; resets in ${mins} min). Main writes plans, not code: put the work in a plan ` +
				`(listed in ${q.INDEX}, phase-0 blockers first) and spawn an implementer. Changes so far: ${w.used.join(", ")}`,
		);
	}
	if (!w.used.length) w.windowStart = now;
	w.used.push(`${e.tool}:${files[0]!}`);
	writeWindow(w);
	const left = limit - w.used.length;
	if (left <= 2)
		return {
			allow: true,
			reason: "",
			inject: `main-guard: tier ${tier} — ${left} project-file change(s) left in this ${cfg.guards.main_window_min}-minute window; then delegate.`,
		};
	return ALLOW;
}

// --- incidents (src/core/incidents.ts): open ones push Main until each has a plan or dismissal ---

function openIncidentList(cfg: Config): IncidentView[] {
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

/**
 * While an incident is open, a launch must be fix work: its brief (or a plan the brief names)
 * cites `INCIDENT <id>` of an open incident. Anything else is refused until every open incident
 * has a plan or a dismissal. Returns the refusal reason, or null; `label` names the log line.
 */
function incidentSpawnProblem(label: string, brief: string, namedPlans: string[], cfg: Config): string | null {
	const open = openIncidentList(cfg);
	if (!open.length) return null;
	const texts = [brief];
	for (const f of namedPlans) {
		try {
			texts.push(readFileSync(f, "utf8"));
		} catch {}
	}
	const remaining = open.filter(i => !texts.some(t => t.includes(`INCIDENT ${i.id}`)));
	if (!remaining.length) return null;
	const ids = remaining.map(i => i.id).join(", ");
	log(cfg.paths.guard_log, `BLOCK ${label}: open incidents: ${ids}`);
	return (
		`open incident(s) ${ids} must be acted on before other work. Write a plan that contains "INCIDENT <id>" ` +
		`(listed in ${q.INDEX}) and record it: \`neurastream incident plan <id> <plan.md>\`, or dismiss the ` +
		'incident: `neurastream incident dismiss <id> --why "<text>"`. Fix work goes through: name that plan in the brief.'
	);
}

function mainTool(e: ToolEvent, input: Record<string, unknown>, cfg: Config): Decision {
	if (e.tool === "task") {
		const pending = q.cancelPending();
		if (pending) {
			log(cfg.paths.guard_log, `BLOCK spawn: cancel pending (${pending.words})`);
			return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`);
		}
		const files: string[] = [];
		const budgets: Record<string, number | null> = {};
		const staffing: Record<string, string[]> = {};
		const why = spawnProblem(input, cfg, files, budgets, staffing, e.runningJobs);
		if (why) {
			log(cfg.paths.guard_log, `BLOCK spawn: ${why}`);
			return deny(`main-guard: ${why}`);
		}
		const inc = incidentSpawnProblem("spawn", JSON.stringify(input), files, cfg);
		if (inc) return deny(`main-guard: ${inc}`);
		recordSpawns(files, staffing);
		recordBudgets(budgets);
		return ALLOW;
	}
	if (cfg.guards.shell_tools.includes(e.tool)) {
		// Strict landing gate (20261025_1940 P2, P5): in tier strict every push/merge waits for the
		// owner's approve phrase (autonomy.go_phrase, default "go push"); the landing that consumes
		// it goes through. Opinionated and full keep today's allowance. Owner-only rules above are
		// untouched.
		if (landingCommand(input) && currentTier(cfg) === "strict" && !takeGo(cfg)) {
			log(cfg.paths.guard_log, "BLOCK landing: tier strict, no approve phrase");
			return deny(`main-guard: tier strict — type "${cfg.autonomy.go_phrase}" to approve one push/merge`);
		}
		const command = String(input?.command ?? input?.code ?? "");
		for (const entry of cfg.guards.bypass_spawn) {
			if (!bypassRegExp(entry).test(command)) continue;
			const pending = q.cancelPending();
			if (pending) {
				log(cfg.paths.guard_log, `BLOCK bypass launch: cancel pending (${pending.words})`);
				return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`);
			}
			const [why, named] = planGate(command, entry, cfg);
			if (why) {
				log(cfg.paths.guard_log, `BLOCK bypass launch: ${why}`);
				return deny(`main-guard: ${why}`);
			}
			const inc = incidentSpawnProblem("bypass launch", command, named, cfg);
			if (inc) return deny(`main-guard: ${inc}`);
			if (named.length) recordSpawns(named);
		}
	}
	return editWindow(e, input, cfg);
}

/** A live plan file (archived plans excluded); Main's plan-text checks run on these. */
export const MAIN_PLAN_FILE = /\/docs\/plans\/(?!archive\/)[^/]+\.md$/;

/**
 * pre-tool: plan-guard checkCall for subs (protected files, budget, plan-edit rules, blockers)
 * plus, for Main, the spawn gates and the project-file edit window.
 */
export function checkTool(e: ToolEvent, cfg: Config): Decision {
	if (cfg.guards.skip_tools.includes(e.tool)) return ALLOW;
	const input = e.input ?? {};
	// Starting the owner page (plan 20261024_2230 P3c) is the owner's systemd move, never an
	// agent's, unlocked or not: refused plan-guard style like a protected-file write.
	if (cfg.guards.shell_tools.includes(e.tool) && startsOwnerUi(input)) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} ui-start: ${String(input.command ?? "")}`);
		return deny(
			"plan-guard: starting the owner page (neurastream ui, or systemctl --user start/restart/enable of neurastream-ui) is the owner's move, not an agent's.",
		);
	}
	// The caller may know paths the text search cannot see (structured edits); union, never shrink.
	const paths: string[] = [];
	for (const p of [...(e.paths ?? []), ...q.touchedPaths(e.tool, input, e.cwd)]) if (!paths.includes(p)) paths.push(p);
	const writes: string[] = [];
	for (const p of [...(e.writes ?? []), ...q.writeTargets(e.tool, input, e.cwd)]) if (!writes.includes(p)) writes.push(p);
	// Notify secrets: no agent, main or sub, reads a webhook URL — with or without the unlock.
	// A call that changes a secret is not a read: its target goes through the protected-write
	// rule above, so the owner's unlock covers it like any guard file.
	const secretHit = notifySecretReadHit(paths.filter(p => !writes.includes(p)), cfg);
	if (secretHit) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} notify secret: ${secretHit}`);
		return deny(`plan-guard: ${secretHit} is a notify secret path. Only the owner touches the webhook files, in a terminal.`);
	}
	// Main writes its own rollover note unattended (the note turn has nobody to ask). Only a Write
	// of a .md directly in <state>/rollover/ is exempt; shell writes, subagents and relaunch.json stay refused.
	const rolloverDir = path.join(q.stateDirPath(), "rollover");
	const openWrites =
		e.agent === "main" && e.tool === "write"
			? writes.filter(p => !(path.extname(p) === ".md" && path.dirname(path.resolve(p)) === rolloverDir))
			: writes;
	const hit = protectedHit(openWrites, cfg);
	if (hit && !unlocked(cfg)) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} protected: ${hit}`);
		return deny(
			`plan-guard: ${hit} is a protected guard file. Only the owner changes it (unlock: \`touch ${q.UNLOCK}\` in a terminal${
				cfg.guards.chat_unlock ? `, or type \`unlock ${cfg.guards.unlock_minutes}\` in chat` : ""
			}, valid ${cfg.guards.unlock_minutes} min).`,
		);
	}
	if (e.agent === "main") {
		// The plan-text checks (checkPlanEdit) see only edit/write results; a shell redirect,
		// sed -i or heredoc into a plan would skip them, so plans change through edit/write only.
		const shellPlan = e.tool !== "write" && e.tool !== "edit" ? writes.find(p => MAIN_PLAN_FILE.test(p)) : undefined;
		if (shellPlan) {
			log(cfg.paths.plan_guard_log, `BLOCK main tool=${e.tool} shell write to plan ${shellPlan}`);
			return deny(`plan-guard: ${shellPlan} is a plan file: change it with the edit or write tool (close or cancel it with queue-close / queue-cancel).`);
		}
		const d = mainTool(e, input, cfg);
		// A task brief names paths it does not read; only the other tools' paths count as reads.
		if (d.allow && e.tool !== "task") recordMainReads(paths.filter(p => !writes.includes(p)));
		return d;
	}
	const cap = subCallCap(e.agentId, cfg);
	const why = subRules(e, input, paths, writes, cfg, cap);
	if (why) {
		log(cfg.paths.plan_guard_log, `BLOCK sub:${e.agentId} tool=${e.tool} ${why}`);
		return deny(`plan-guard: ${why}`);
	}
	const n = e.calls + 1;
	// The warn band has the global width (sub_max_calls - sub_warn_calls) ending at the cap;
	// unbudgeted subs keep sub_warn_calls exactly.
	const warn = cap === cfg.guards.sub_max_calls ? cfg.guards.sub_warn_calls : Math.max(1, cap - (cfg.guards.sub_max_calls - cfg.guards.sub_warn_calls));
	if (n >= warn && n < cap)
		return {
			allow: true,
			reason: "",
			inject: `plan-guard: call ${n}/${cap}. Update your plan's "## Progress" now (done, verified, next); at ${cap} only that edit is allowed.`,
		};
	return ALLOW;
}

// --- Main's read log (`main-reads.json` in the queue state dir): files Main has read itself ---

const MAIN_READ_KEEP_MS = 7 * 86_400_000;
const GREP_LINE = /^([^\s:]+):\d+:/gm;
/** Logs existing files as read now; entries older than 7 days are dropped on each write. */
function recordMainReads(files: string[], now = Date.now()): void {
	const file = path.join(q.STATE_DIR, "main-reads.json");
	const existing = files.filter(f => {
		try {
			return statSync(f).isFile();
		} catch {
			return false;
		}
	});
	if (existing.length === 0) return;
	let reads: Record<string, string> = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reads = parsed as Record<string, string>;
	} catch {}
	const stamp = new Date(now).toISOString();
	for (const f of existing) reads[f] = stamp;
	const cutoff = now - MAIN_READ_KEEP_MS;
	for (const [f, t] of Object.entries(reads)) if (!(Date.parse(t) >= cutoff)) delete reads[f];
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(file, JSON.stringify(reads, null, 2));
	} catch {}
}

/**
 * Main's tool result: each `path:line:` at a line start (grep -n / grep -rn output) names a file
 * Main read. Paths resolve against the directory the call ran in (its `cwd`, then any `cd`).
 */
export function revertMainEdit(tool: string, input: Record<string, unknown>, cwd: string, cfg: Config): void {
	const files = changedProjectFiles(tool, input, cwd, cfg);
	if (!files.length) return;
	const w = readWindow();
	const entry = `${tool}:${files[0]!}`;
	const idx = w.used.lastIndexOf(entry);
	if (idx >= 0) {
		w.used.splice(idx, 1);
		writeWindow(w);
	}
}

export function recordMainResult(tool: string, input: Record<string, unknown>, cwd: string, text: string): void {
	const base = typeof input.cwd === "string" ? path.resolve(cwd, q.expandHome(input.cwd)) : cwd;
	const dir = q.shellCwd(String(input.command ?? input.code ?? ""), base);
	recordMainReads([...text.matchAll(GREP_LINE)].map(m => path.resolve(dir, m[1] ?? "")));
}

/**
 * The pre-draft warning (I-20261025-208): when Main reads a plan file (the read tool, or a result
 * whose first `path:line:` hit is the plan), the tool result gains one note naming the plan's
 * listed files that would fail the read check right now — before Main drafts an edit the guard
 * would refuse and throw away. Silence when every listed file is fresh in some checkout.
 */
export function planReadNote(tool: string, input: Record<string, unknown>, cwd: string, text: string, cfg: Config): string | undefined {
	let planPath = "";
	if (tool === "read" && typeof input.path === "string") planPath = path.resolve(cwd, q.expandHome(input.path));
	else {
		const first = [...text.matchAll(GREP_LINE)][0];
		if (first) {
			const base = typeof input.cwd === "string" ? path.resolve(cwd, q.expandHome(input.cwd)) : cwd;
			planPath = path.resolve(q.shellCwd(String(input.command ?? input.code ?? ""), base), first[1] ?? "");
		}
	}
	if (!planPath || !MAIN_PLAN_FILE.test(planPath)) return undefined;
	let plan: string;
	try {
		plan = readFileSync(planPath, "utf8");
	} catch {
		return undefined;
	}
	const stale = planReadProblems(plan, planPath, cfg)
		.filter(p => p.includes(" was not read by Main within "))
		.map(p => p.slice(0, p.indexOf(" was not read by Main within ")));
	if (!stale.length) return undefined;
	return `plan-guard: before you edit this plan, re-read: ${stale.join(", ")}`;
}

/**
 * spawn: the allow-list, task-only and open-plan gates for one implementer launch. Covers both
 * original paths (the extension spawn event and a `task` tool call); the brief names the plan.
 */
export function checkSpawn(e: SpawnEvent, cfg: Config): Decision {
	const pending = q.cancelPending();
	if (pending) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: cancel pending (${pending.words})`);
		return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`);
	}
	const allowed = q.allowedAgents();
	if (!allowed.has(e.agent))
		return deny(`main-guard: ${e.agent}: agent "${e.agent}" is not in "## Allowed" of ${q.SUBAGENTS_MD} (no expensive or unpinned models).`);
	if (e.invocationKind !== "task")
		return deny("main-guard: spawn implementers with the task tool (the plan gate checks its brief).");
	const [why, named] = planGate(e.brief, e.agent, cfg);
	if (why) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${why}`);
		return deny(`main-guard: ${why}`);
	}
	const gate = priorityGate(named, e.runningJobs, e.brief, cfg, e.agent);
	if (gate) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${gate}`);
		return deny(`main-guard: ${gate}`);
	}
	const inc = incidentSpawnProblem(`spawn ${e.agent}`, e.brief, named, cfg);
	if (inc) return deny(`main-guard: ${inc}`);
	// The owner's pick order and live provider state (plan 20261025_1700 P3), before the spawn records.
	const claim = providerClaimProblem(e.brief, cfg);
	if (claim) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${claim}`);
		return deny(`main-guard: ${e.agent}: ${claim}`);
	}
	const pick = preferProblem(e.agent, e.brief, e.runningJobs, cfg);
	if (pick) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${pick}`);
		return deny(`main-guard: ${e.agent}: ${pick}`);
	}
	const staffing: Record<string, string[]> = {};
	for (const f of named) staffing[f] = [e.agent];
	recordSpawns(named, staffing);
	return ALLOW;
}

// Owner message that may call work off: flag it; until Main records it with queue-cancel, no
// spawn and no stop. Returns the text appended to the injected summary.
export function flagCancel(text: string, cfg: Config): string {
	const m = text.match(q.CANCEL_WORDS);
	if (!m) return "";
	const at = m.index ?? 0;
	const words = text.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, " ").trim();
	const prev = q.cancelPending();
	try {
		mkdirSync(q.STATE_DIR, { recursive: true });
		writeFileSync(q.CANCEL_PENDING, JSON.stringify({ at: new Date().toISOString(), words: prev ? `${prev.words} … ${words}` : words }));
	} catch (err) {
		log(cfg.paths.guard_log, `cannot write ${q.CANCEL_PENDING}: ${err}`);
	}
	log(cfg.paths.guard_log, `cancel flagged: ${words}`);
	return `\nmain-guard: ${CANCEL_TODO} Flagged: "${words}"`;
}

/**
 * prompt/owner message: inject the queue summary, flag cancel wording, list open incidents, reset
 * Main's edit window and the stop counters (the original resets them at every user message). A
 * turn the harness
 * starts from this guard's own stop continuation ("main-guard: …") is not an owner message: it
 * keeps the counters and the edit window, else every continuation reset the idle streak and a
 * model that only answers text was nudged again forever (2026-10-21 OOM: ~205 agent starts in one
 * non-interactive session).
 */
export function checkInject(e: InjectEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	const continuation = e.inject.trimStart().startsWith("main-guard:");
	if (!continuation) writeWindow({ used: [], windowStart: 0 });
	recordOwnerMessage(e.inject, cfg);
	let summary: string;
	try {
		summary = q.queueSummary(undefined, cfg.review.since);
	} catch (err) {
		summary = `Queue unreadable (${q.INDEX}): ${err}`;
	}
	const cancel = continuation ? "" : flagCancel(e.inject, cfg);
	const incidents = openIncidentList(cfg);
	const incidentText = incidents.length ? `\n${incidents.map(incidentLine).join("\n")}` : "";
	// 20261025_1940 P2: the injected line names the autonomy tier and what Main does without asking in it.
	const tier = currentTier(cfg);
	const tierNote =
		tier === "strict"
			? `Main changes at most ${cfg.autonomy.strict_edit_limit} project files per ${cfg.guards.main_window_min} min, and every git push / glab mr merge / gh pr merge waits for your "${cfg.autonomy.go_phrase}" (one landing, valid ${cfg.autonomy.go_minutes} min).`
			: tier === "full"
				? `Main works unattended: no edit cap, its own "Priority skip: <plan> — Main: \\"<reason>\\"" skips pass, pushes and merges go through. Owner-only moves (guard files, the phone page, notify secrets, the unlock) stay locked.`
				: `Main changes at most ${cfg.guards.main_edit_limit} project files per ${cfg.guards.main_window_min} min; pushes and merges go through.`;
	const editLimit = continuation ? "" : `\nautonomy: ${tier} — ${tierNote}`;
	return {
		allow: true,
		reason: "",
		inject: `${summary}\n(main-guard: read ${q.INDEX}; the listed plans are summarised above; work the open plans, close finished ones with queue-close.)${editLimit}${cancel}${incidentText}`,
		...(continuation ? {} : { state: { callsSinceStop: 0, idleStops: 0 } }),
	};
}

// Lines only Main may write: the status, owner parking, plan waits, owner cancellation, cancelled-list clearance.
const MAIN_ONLY_LINE = /^\s*(?:[-*]\s+)?(Status:|WAITING on owner:|Waits on:|Cancelled by owner:|False positive:)/;

function mainOnlyLines(text: string): string {
	return text.split("\n").filter(l => MAIN_ONLY_LINE.test(l)).join("\n");
}

/**
 * plan-edit: after a subagent changed a plan, everything outside "## Progress" and every
 * Main-only line must be unchanged, and every Progress entry the edit adds must carry a
 * "Findings:" line (2026-10-24: a finding buried in a Progress note never became a plan);
 * `restore` hands back the untouched text for the caller to write (the original restored the
 * file itself before reporting).
 */
export function checkPlanEdit(e: PlanEditEvent, cfg: Config): PlanEditDecision {
	if (e.agent === "main") return checkMainPlan(e, cfg);
	if (q.outsideProgress(e.after) !== q.outsideProgress(e.before) || mainOnlyLines(e.after) !== mainOnlyLines(e.before)) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path}`);
		return {
			allow: false,
			reason: `plan-guard: you changed ${e.path} outside your progress entries (only "## Progress" entries are yours; the "Status:", "WAITING on owner:", "Waits on:", "Cancelled by owner:" and "False positive:" lines are Main's, it marks a plan complete after reviewing your work). The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	const missing = newProgressEntries(e.before, e.after).filter(b => !findingsValue(b));
	if (missing.length) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (no Findings line)`);
		return {
			allow: false,
			reason: `plan-guard: ${missing.length === 1 ? "your new entry in" : `${missing.length} of your new entries in`} ${e.path} ${missing.length === 1 ? "has" : "have"} no "Findings:" line. End every new "## Progress" entry with "Findings: none", or "Findings: <one item per finding (bug, workaround, improvement — any repo), each with file:line evidence>", items separated by ";". The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	recordFindings(e, cfg);
	return ALLOW;
}

/**
 * Each finding item of an allowed plan edit becomes an incident (source "findings", evidence =
 * plan path + agent; the default fingerprint dedupes the same item text). A subagent's items are
 * kind "agent-finding"; Main's own are kind "main-finding" (20261028_0900 P1: a bug Main writes
 * down must block the stop like a subagent's). A store failure is logged and swallowed: it must
 * not break the verified edit.
 */
function recordFindings(e: PlanEditEvent, cfg: Config, kind: "agent-finding" | "main-finding" = "agent-finding"): void {
	try {
		const evidence = `${e.path} (${e.agent})`;
		for (const block of newProgressEntries(e.before, e.after)) {
			const value = findingsValue(block);
			if (!value || /^none\.?$/i.test(value)) continue;
			for (const item of value.split(";")) {
				if (item.trim()) addIncident(cfg, { source: "findings", kind, summary: item.trim(), evidence });
			}
		}
	} catch (err) {
		log(cfg.paths.plan_guard_log, `findings: cannot record incidents for ${e.path}: ${err}`);
	}
}

/** One "## Progress" entry: its "- " line plus indented continuation lines (trimProgressBody's entry rule). */
function progressEntries(text: string): string[] {
	const blocks: string[] = [];
	const lines = q.progressBody(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i];
		if (head === undefined || !/^- /.test(head) || MAIN_ONLY_LINE.test(head)) continue;
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

// Main's plan text outside "## Progress" must rest on files Main read itself (planReadProblems).
// An empty `before` means the plan file did not exist yet; a refusal then deletes it.
function checkMainPlan(e: PlanEditEvent, cfg: Config): PlanEditDecision {
	if (q.outsideProgress(e.after) === q.outsideProgress(e.before)) {
		recordFindings(e, cfg, "main-finding");
		return ALLOW;
	}
	// A cited file Main did read lands in the list instead of the refusal (I-20261025-208): fix the
	// text first, then judge the fixed text like any other edit.
	const fix = autoListReads(e.after, e.path, cfg);
	const fixed = fix ? fix.text : e.after;
	// Refuse only what this edit adds: a problem the plan already had is not Main's doing now.
	// The missing-section problem is always refused: a plan with no read list has no evidence behind its text.
	const known = new Set(e.before ? planReadProblems(e.before, e.path, cfg) : []);
	const problems = planReadProblems(fixed, e.path, cfg).filter(p => p === NO_SECTION || !known.has(p));
	if (!problems.length) {
		recordFindings(e, cfg, "main-finding");
		if (!fix) return ALLOW;
		const list = fix.paths.join(", ");
		log(cfg.paths.plan_guard_log, `AUTO-LIST ${e.path}: ${list}`);
		return {
			allow: true,
			reason: "",
			rewrite: { path: e.path, text: fix.text },
			note: `plan-guard: added ${fix.paths.length} file(s) to "## Code read by Main": ${list}`,
		};
	}
	log(cfg.paths.plan_guard_log, `REFUSE-READ ${e.path}: ${problems.join("; ")}`);
	return {
		allow: false,
		reason: `plan-guard: ${e.path} cites code Main has not read for this plan:\n- ${problems.join("\n- ")}\nRead each file (read or grep it), list it under "## Code read by Main", then edit again. ${e.before ? "The file was restored." : "The new file was removed."}`,
		restore: { path: e.path, text: e.before || null },
	};
}

const READ_SECTION = /^## Code read by Main[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const LISTED_PATH = /`([^`\s]+)`/g;
const CITED_PATH = /((?:~\/|\/|\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]+):\d+/g;

const NO_SECTION = `no "## Code read by Main" section lists a file (list each file you read for this plan as a backticked path)`;

/** Read evidence behind a plan edit: section present, each listed path read within the window, no unlisted cited path. */
function planReadProblems(text: string, planPath: string, cfg: Config): string[] {
	const listed = [...(READ_SECTION.exec(text)?.[1] ?? "").matchAll(LISTED_PATH)].map(m => (m[1] ?? "").replace(/:[\d,+\- ]+$/, ""));
	if (!listed.length) return [NO_SECTION];
	const reads = readMainReads();
	const maxMs = cfg.guards.plan_read_max_hours * 3_600_000;
	const problems: string[] = [];
	const named = new Set<string>();
	for (const p of listed) {
		const abs = planFile(p, planPath, text);
		named.add(abs);
		if (!isFile(abs)) problems.push(`${p} does not exist`);
		else if (!readWithin(abs, planPath, text, reads, maxMs)) problems.push(`${p} was not read by Main within ${cfg.guards.plan_read_max_hours} h`);
	}
	for (const [, cited = ""] of q.outsideProgress(text).matchAll(CITED_PATH)) {
		const abs = planFile(cited, planPath, text);
		if (abs.includes("/docs/plans/") || namedOrTwin(named, abs, planPath, text) || !isFile(abs)) continue;
		problems.push(`${cited} is cited but not listed under "## Code read by Main"`);
	}
	return problems;
}

/** A plan-cited path: absolute, else under the plan's Worktree (when set) or its repo root. */
function planFile(p: string, planPath: string, text: string): string {
	const home = q.expandHome(p);
	if (path.isAbsolute(home)) return home;
	const roots = planRoots(planPath, text);
	const root = roots.find(r => isFile(path.join(r, home))) ?? roots[roots.length - 1]!;
	return path.join(root, home);
}

/** The roots a plan-relative path resolves against: the plan's Worktree (when set), then its repo (dirname³ of the plan file). */
function planRoots(planPath: string, text: string): string[] {
	const wt = /^Worktree:\s*(\S+)/m.exec(text)?.[1];
	const repo = path.dirname(path.dirname(path.dirname(planPath)));
	return wt && wt !== "-" ? [wt, repo] : [repo];
}

/** The same repo-relative file under the plan's other root (Worktree ↔ main checkout), or null when `abs` sits under neither. */
function twinFile(abs: string, planPath: string, text: string): string | null {
	const roots = planRoots(planPath, text);
	for (const root of roots) {
		const prefixed = root.endsWith("/") ? root : `${root}/`;
		if (!abs.startsWith(prefixed)) continue;
		for (const other of roots) {
			if (other === root) continue;
			return `${other.endsWith("/") ? other : `${other}/`}${abs.slice(prefixed.length)}`;
		}
	}
	return null;
}

/** Main read this file within the window — at the resolved path or at its twin under the plan's other root (I-20261025-208 evidence: the same file read in the main checkout must cover its Worktree copy). */
function readWithin(abs: string, planPath: string, text: string, reads: Record<string, string>, maxMs: number): boolean {
	const cutoff = Date.now() - maxMs;
	const fresh = (f: string) => Date.parse(reads[f] ?? "") >= cutoff;
	if (fresh(abs)) return true;
	const twin = twinFile(abs, planPath, text);
	return twin !== null && fresh(twin);
}

/** The resolved path, or its twin under the plan's other root, is already in the set (cited-vs-listed matches files, not spellings). */
function namedOrTwin(named: Set<string>, abs: string, planPath: string, text: string): boolean {
	if (named.has(abs)) return true;
	const twin = twinFile(abs, planPath, text);
	return twin !== null && named.has(twin);
}

/**
 * Cited paths (outside Progress) Main read within the window but the list omits: returns the plan
 * text with one `- \`<path as cited>\`` line appended to "## Code read by Main" (the section is
 * created before "## Progress" when missing), or null when nothing qualifies. Never-read citations
 * stay out: they are refused like today.
 */
function autoListReads(text: string, planPath: string, cfg: Config): { text: string; paths: string[] } | null {
	const reads = readMainReads();
	const maxMs = cfg.guards.plan_read_max_hours * 3_600_000;
	const covered = new Set<string>();
	for (const p of [...(READ_SECTION.exec(text)?.[1] ?? "").matchAll(LISTED_PATH)].map(m => (m[1] ?? "").replace(/:[\d,+\- ]+$/, "")))
		covered.add(planFile(p, planPath, text));
	const added: string[] = [];
	const seen = new Set<string>();
	for (const [, cited = ""] of q.outsideProgress(text).matchAll(CITED_PATH)) {
		const abs = planFile(cited, planPath, text);
		if (abs.includes("/docs/plans/") || seen.has(cited) || !isFile(abs)) continue;
		if (namedOrTwin(covered, abs, planPath, text)) continue;
		if (!readWithin(abs, planPath, text, reads, maxMs)) continue;
		seen.add(cited);
		covered.add(abs);
		added.push(cited);
	}
	if (!added.length) return null;
	const lines = added.map(p => `- \`${p}\``);
	const m = READ_SECTION.exec(text);
	let out: string;
	if (m && m[1] !== undefined) {
		// Append after the section's last entry, ahead of the blank lines before the next heading.
		const bodyStart = m.index + m[0].length - m[1].length;
		const at = bodyStart + m[1].replace(/\s+$/, "").length;
		out = `${text.slice(0, at)}\n${lines.join("\n")}${text.slice(at)}`;
	} else {
		// No section yet: create it right before "## Progress" (or at the end when that is missing too).
		const at = text.search(/^## Progress\b/m);
		const block = `## Code read by Main\n${lines.join("\n")}\n\n`;
		out = at === -1 ? `${text}${block}` : `${text.slice(0, at)}${block}${text.slice(at)}`;
	}
	return { text: out, paths: added };
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function readMainReads(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path.join(q.STATE_DIR, "main-reads.json"), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

// Plans still responsible for: open plans (parked "WAITING on owner" excluded) plus queue problems.
export function openQueue(reviewSince = ""): string[] {
	const open = q
		.activePlans()
		.filter(p => !p.waiting && !q.awaitingMerge(p))
		.map(p => p.file);
	for (const prob of q.queueProblems(undefined, undefined, reviewSince)) open.push(`${prob.where}: ${prob.problem}`);
	const unique: string[] = [];
	for (const item of open) if (!unique.includes(item)) unique.push(item);
	return unique;
}

// Agent names from a ledger line that are alive (RUNNING or WAITING, idle under an hour).
export function liveSubagents(ledgerOut: string): string[] {
	return ledgerOut
		.split("\n")
		.filter(l => !l.startsWith("MAIN ") && /\s(RUNNING|WAITING)\b/.test(l))
		.filter(l => {
			const m = l.match(/idle (\d+)m/);
			return !m || Number(m[1]) < 60;
		})
		.map(l => l.split(/\s+/)[0] ?? "");
}

/**
 * stop: Main may not stop while an open plan is not parked "WAITING on owner" (or the queue has a
 * problem) and no subagent is alive to wake it; an open incident (no plan, no dismissal) blocks
 * the stop regardless of live subagents. Three stop attempts in a row with zero tool calls
 * in between are let through. Returns the next counters in `state`.
 */
export function checkStop(e: StopEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	const state = { callsSinceStop: e.callsSinceStop, idleStops: e.idleStops };
	// 20261028_0900 P2: a reply that offers to plan instead of planning is refused for the offer
	// itself; the two-empty-stops valves below never release this block.
	if (e.reply && new RegExp(cfg.guards.plan_offer, "i").test(e.reply)) {
		log(cfg.paths.guard_log, "BLOCK stop: reply offers to plan instead of planning it");
		return { allow: false, reason: "main-guard: don't offer it — write the plan and index it", state };
	}
	let open: string[];
	try {
		open = openQueue(cfg.review.since);
	} catch (err) {
		log(cfg.paths.guard_log, `BLOCK stop: cannot read queue: ${err}`);
		open = [`queue unreadable (${q.INDEX}): ${err}`];
	}
	const pending = q.cancelPending();
	if (pending && state.idleStops < 2) {
		if (state.callsSinceStop === 0) state.idleStops++;
		state.callsSinceStop = 0;
		log(cfg.paths.guard_log, `BLOCK stop: cancel pending (${pending.words})`);
		return { allow: false, reason: `main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`, state };
	}
	// Same release valve as cancel-pending: an idle Main that cannot act is let out after two
	// empty stop attempts instead of looping forever. Live subagents do not clear this block.
	const incidents = openIncidentList(cfg);
	if (incidents.length && state.idleStops < 2) {
		if (state.callsSinceStop === 0) state.idleStops++;
		state.callsSinceStop = 0;
		const ids = incidents.map(i => i.id).join(", ");
		log(cfg.paths.guard_log, `BLOCK stop: open incidents: ${ids}`);
		return {
			allow: false,
			reason:
				`main-guard: ${incidents.length} open incident(s) with no plan and no dismissal: ${ids}. Plan the fix: ` +
				"`neurastream incident plan <id> <plan.md>` (the plan must contain \"INCIDENT <id>\"), or dismiss it: " +
				'`neurastream incident dismiss <id> --why "<text>"`. The stop stays refused while an incident is open.',
			state,
		};
	}
	if (open.length === 0) return { ...ALLOW, state };
	if (liveSubagents(e.ledgerText).length > 0) {
		log(cfg.paths.guard_log, "ALLOW stop: live subagents");
		return { ...ALLOW, state };
	}
	if (state.callsSinceStop === 0) state.idleStops++;
	else state.idleStops = 0;
	state.callsSinceStop = 0;
	if (state.idleStops >= cfg.guards.idle_stops) {
		log(cfg.paths.guard_log, `ALLOW stop after ${state.idleStops} idle stop attempts; open: ${open.join(" | ")}`);
		return { allow: true, reason: "", state: { callsSinceStop: 0, idleStops: 0 } };
	}
	log(cfg.paths.guard_log, `BLOCK stop; open: ${open.join(" | ")}`);
	return {
		allow: false,
		reason:
			`main-guard: the queue has ${open.length} open item${open.length === 1 ? "" : "s"} and no subagent is ` +
			`running to wake you. Owner rule: keep working while the queue has items. Start the next step (spawn an ` +
			`agent), close a finished plan with queue-close, or, if a plan truly waits on the owner, add a line ` +
			`"WAITING on owner: <what>" to that plan. Open: ${open.join(" | ")}`,
		state,
	};
}
