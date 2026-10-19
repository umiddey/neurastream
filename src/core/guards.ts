// Guard rules, ported from the original main-guard and plan-guard extensions as pure decision
// functions on one event + config. No harness here: an adapter (or `neurastream guard <event>
// --json`) maps its own events onto these, applies `restore`, and feeds back the counters the
// decision returns in `state`.
//
// Callers must first map config into the queue paths (applyQueueEnv): the queue library resolves
// INDEX.md, blockers, state, subagents, cancelled and unlock from those env vars.
//
// Ported rules (owner 2026-10-15..17):
//   - protected guard files, unlockable by the owner for `guards.unlock_minutes`
//   - subs: no queue-close/queue-cancel, call budget 90/100, plan edits only inside "## Progress",
//     blocker execution, invalid plans refuse
//   - main: 5 project-file changes per `main_window_min` window (owner message resets), spawn
//     gate (allow-list, task-only, open plan, new Progress since last run), bypass launches go
//     through the same plan gate, cancel-pending blocks spawns and stops, keep-working stop rule

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Decision, InjectEvent, PlanEditEvent, SpawnEvent, StopEvent, ToolEvent } from "./adapter.ts";
import type { Config } from "./config.ts";
import * as q from "./queue/lib.ts";
import type { Plan } from "./queue/lib.ts";

const ALLOW: Decision = { allow: true, reason: "" };

function deny(reason: string): Decision {
	return { allow: false, reason };
}

function log(file: string, line: string): void {
	try {
		appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

// Owner message that may call work off (owner 2026-10-16: "don't do X" must hold even if no plan
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

function readWindow(): EditWindow {
	try {
		const w = JSON.parse(readFileSync(windowFile(), "utf8")) as EditWindow;
		if (Array.isArray(w.used) && typeof w.windowStart === "number") return w;
	} catch {}
	return { used: [], windowStart: 0 };
}

function writeWindow(w: EditWindow): void {
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

/** Remember the "## Progress" hash of the plans an agent was just spawned on. */
export function recordSpawns(files: string[]): void {
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
	}
	return null;
}

// Text files never count (owner 2026-10-15: "only ... anything apart from .md or .txt").
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

// Plans an implementer brief may run on; returns [reason, null] or [null, plan files].
export function planGate(text: string, label: string): [string | null, string[]] {
	const plans = q.activePlans();
	const unclosed = plans.filter(p => (p.status === "complete" || p.status === "cancelled") && !q.awaitingMerge(p));
	if (unclosed.length)
		return [
			`${label}: ${unclosed.map(p => `${p.file} (${p.status})`).join(", ")} is still indexed. Verify it and run \`queue-close <plan>\` before any new spawn.`,
			[],
		];
	const named = plans.filter(p => text.includes(p.file));
	if (!named.length)
		return [
			`${label}: an implementer needs an open plan. Name the plan's absolute path in the brief; the plan must be listed in <repo>/INDEX.md and the repo in ${q.INDEX}.`,
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
	}
	return [null, named.map(p => p.file)];
}

/** Reason to refuse a `task` brief, or null; `files` receives the plans to record. */
export function spawnProblem(input: Record<string, unknown>, files: string[] = []): string | null {
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const context = String(input?.context ?? "");
	const allowed = q.allowedAgents();
	for (const t of tasks) {
		const agent = String(t?.agent ?? "task");
		const label = String(t?.name ?? agent);
		if (!allowed.has(agent)) return `${label}: agent "${agent}" is not in "## Allowed" of ${q.SUBAGENTS_MD} (no expensive or unpinned models).`;
		const [why, named] = planGate(`${context}\n${String(t?.task ?? "")}`, label);
		if (why) return why;
		files.push(...named);
	}
	return null;
}

function runBlockers(plan: Plan, hit: string[], e: ToolEvent, cfg: Config): string | null {
	for (const b of plan.blockers) {
		try {
			execFileSync(b.script, b.args, {
				input: JSON.stringify({ tool: e.tool, input: e.input, cwd: e.cwd, agent: e.agent, repo: plan.repo, plan: plan.file, paths: hit }),
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

// Subagent half of a tool call (the original plan-guard checkCall without the main return).
function subRules(e: ToolEvent, input: Record<string, unknown>, paths: string[], writes: string[], cfg: Config): string | null {
	// Closing and cancelling are Main's decisions (owner 2026-10-15/16).
	if (cfg.guards.shell_tools.includes(e.tool) && /\bqueue-(?:close|cancel)\b/.test(JSON.stringify(input)))
		return 'queue-close and queue-cancel are Main\'s; report in your plan\'s "## Progress" instead.';
	const plans = q.activePlans();
	if (e.calls >= cfg.guards.sub_max_calls) {
		const planEdit = (e.tool === "write" || e.tool === "edit") && writes.length > 0 && writes.every(p => q.planAt(p, plans));
		const planRead = cfg.guards.read_tools.includes(e.tool) && paths.length > 0 && paths.every(p => q.planAt(p, plans));
		if (!planEdit && !planRead)
			return `call budget spent (${e.calls}/${cfg.guards.sub_max_calls}). Only reading and editing your plan's "## Progress" is allowed now: write what you did, what is verified, what is next, then end your run.`;
	}
	if (!plans.length || !paths.length) return null;
	for (const p of writes) {
		if (!q.isOrchestrationPath(p, plans)) continue;
		if (!q.planAt(p, plans)) return `${p} belongs to Main (repo index / blocker script); read it, never change it. Report instead.`;
		if (e.tool !== "write" && e.tool !== "edit")
			return `${p} is a plan file: change its "## Progress" section only with the edit or write tool.`;
	}
	for (const plan of plans) {
		const hit = paths.filter(p => !q.isOrchestrationPath(p, plans) && q.planCovers(plan, p));
		if (!hit.length) continue;
		if (plan.errors.length) return `plan ${plan.file} is invalid (${plan.errors.join("; ")}). Stop and report to Main.`;
		const why = runBlockers(plan, hit, e, cfg);
		if (why) return why;
	}
	return null;
}

// Main's edit limit: window starts at the first counted change, resets after main_window_min
// minutes and at every owner message. State lives in the queue state dir so one-shot CLI
// processes share the window (the original kept it in extension memory for one session).
function editWindow(e: ToolEvent, input: Record<string, unknown>, cfg: Config): Decision {
	const files = changedProjectFiles(e.tool, input, e.cwd, cfg);
	if (!files.length) return ALLOW;
	const now = Date.now();
	const w = readWindow();
	if (w.used.length && now - w.windowStart >= cfg.guards.main_window_min * 60_000) w.used = [];
	if (w.used.length >= cfg.guards.main_edit_limit) {
		const mins = Math.ceil((w.windowStart + cfg.guards.main_window_min * 60_000 - now) / 60_000);
		log(cfg.paths.guard_log, `BLOCK tool=${e.tool} after ${w.used.length} edits: ${files.join(",")}`);
		return deny(
			`main-guard: Main already changed project files ${w.used.length} times in this ${cfg.guards.main_window_min}-minute window ` +
				`(owner limit ${cfg.guards.main_edit_limit}; resets in ${mins} min). Main writes plans, not code: put the work in a plan ` +
				`(listed in <repo>/INDEX.md, phase-0 blockers first) and spawn an implementer. Changes so far: ${w.used.join(", ")}`,
		);
	}
	if (!w.used.length) w.windowStart = now;
	w.used.push(`${e.tool}:${files[0]!}`);
	writeWindow(w);
	const left = cfg.guards.main_edit_limit - w.used.length;
	if (left <= 2)
		return {
			allow: true,
			reason: "",
			inject: `main-guard: ${left} project-file change(s) left in this ${cfg.guards.main_window_min}-minute window; then delegate.`,
		};
	return ALLOW;
}

function mainTool(e: ToolEvent, input: Record<string, unknown>, cfg: Config): Decision {
	if (e.tool === "task") {
		const pending = q.cancelPending();
		if (pending) {
			log(cfg.paths.guard_log, `BLOCK spawn: cancel pending (${pending.words})`);
			return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`);
		}
		const files: string[] = [];
		const why = spawnProblem(input, files);
		if (why) {
			log(cfg.paths.guard_log, `BLOCK spawn: ${why}`);
			return deny(`main-guard: ${why}`);
		}
		recordSpawns(files);
		return ALLOW;
	}
	if (cfg.guards.shell_tools.includes(e.tool)) {
		const command = String(input?.command ?? input?.code ?? "");
		for (const entry of cfg.guards.bypass_spawn) {
			if (!bypassRegExp(entry).test(command)) continue;
			const pending = q.cancelPending();
			if (pending) {
				log(cfg.paths.guard_log, `BLOCK bypass launch: cancel pending (${pending.words})`);
				return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`);
			}
			const [why, named] = planGate(command, entry);
			if (why) {
				log(cfg.paths.guard_log, `BLOCK bypass launch: ${why}`);
				return deny(`main-guard: ${why}`);
			}
			if (named.length) recordSpawns(named);
		}
	}
	return editWindow(e, input, cfg);
}

/**
 * pre-tool: plan-guard checkCall for subs (protected files, budget, plan-edit rules, blockers)
 * plus, for Main, the spawn gates and the project-file edit window.
 */
export function checkTool(e: ToolEvent, cfg: Config): Decision {
	if (cfg.guards.skip_tools.includes(e.tool)) return ALLOW;
	const input = e.input ?? {};
	// The caller may know paths the text search cannot see (structured edits); union, never shrink.
	const paths: string[] = [];
	for (const p of [...(e.paths ?? []), ...q.touchedPaths(e.tool, input, e.cwd)]) if (!paths.includes(p)) paths.push(p);
	const writes: string[] = [];
	for (const p of [...(e.writes ?? []), ...q.writeTargets(e.tool, input, e.cwd)]) if (!writes.includes(p)) writes.push(p);
	const hit = protectedHit(writes, cfg);
	if (hit && !unlocked(cfg)) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} protected: ${hit}`);
		return deny(
			`plan-guard: ${hit} is a protected guard file. Only the owner changes it (unlock: \`touch ${q.UNLOCK}\` in a terminal, valid ${cfg.guards.unlock_minutes} min).`,
		);
	}
	if (e.agent === "main") return mainTool(e, input, cfg);
	const why = subRules(e, input, paths, writes, cfg);
	if (why) {
		log(cfg.paths.plan_guard_log, `BLOCK sub:${e.agentId} tool=${e.tool} ${why}`);
		return deny(`plan-guard: ${why}`);
	}
	const n = e.calls + 1;
	if (n >= cfg.guards.sub_warn_calls && n < cfg.guards.sub_max_calls)
		return {
			allow: true,
			reason: "",
			inject: `plan-guard: call ${n}/${cfg.guards.sub_max_calls}. Update your plan's "## Progress" now (done, verified, next); at ${cfg.guards.sub_max_calls} only that edit is allowed.`,
		};
	return ALLOW;
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
	const [why, named] = planGate(e.brief, e.agent);
	if (why) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${why}`);
		return deny(`main-guard: ${why}`);
	}
	recordSpawns(named);
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
 * prompt/owner message: inject the queue summary, flag cancel wording, reset Main's edit window
 * and the stop counters (the original resets them at every user message).
 */
export function checkInject(e: InjectEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	writeWindow({ used: [], windowStart: 0 });
	let summary: string;
	try {
		summary = q.queueSummary();
	} catch (err) {
		summary = `Queue unreadable (${q.INDEX}): ${err}`;
	}
	const cancel = flagCancel(e.inject, cfg);
	return {
		allow: true,
		reason: "",
		inject: `${summary}\n(main-guard: read ${q.INDEX} and the listed repo INDEX.md files are summarised above; work the open plans, close finished ones with queue-close.)${cancel}`,
		state: { callsSinceStop: 0, idleStops: 0 },
	};
}

// Lines only Main may write: the status, owner parking, owner cancellation, cancelled-list clearance.
function mainOnlyLines(text: string): string {
	return text
		.split("\n")
		.filter(l => /^\s*(?:[-*]\s+)?(Status:|WAITING on owner:|Cancelled by owner:|False positive:)/.test(l))
		.join("\n");
}

/**
 * plan-edit: after a subagent changed a plan, everything outside "## Progress" and every
 * Main-only line must be unchanged; `restore` hands back the untouched text for the caller to
 * write (the original restored the file itself before reporting).
 */
export function checkPlanEdit(e: PlanEditEvent, cfg: Config): Decision {
	if (e.agent === "main") return ALLOW;
	if (q.outsideProgress(e.after) !== q.outsideProgress(e.before) || mainOnlyLines(e.after) !== mainOnlyLines(e.before)) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path}`);
		return {
			allow: false,
			reason: `plan-guard: you changed ${e.path} outside your progress entries (only "## Progress" entries are yours; the "Status:", "WAITING on owner:", "Cancelled by owner:" and "False positive:" lines are Main's, it marks a plan complete after reviewing your work). The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	return ALLOW;
}

// Plans still responsible for: open plans (parked "WAITING on owner" excluded) plus queue problems.
export function openQueue(): string[] {
	const open = q
		.activePlans()
		.filter(p => !p.waiting && !q.awaitingMerge(p))
		.map(p => p.file);
	for (const prob of q.queueProblems()) open.push(`${prob.where}: ${prob.problem}`);
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
 * problem) and no subagent is alive to wake it. Three stop attempts in a row with zero tool calls
 * in between are let through. Returns the next counters in `state`.
 */
export function checkStop(e: StopEvent, cfg: Config): Decision {
	if (e.agent !== "main") return ALLOW;
	const state = { callsSinceStop: e.callsSinceStop, idleStops: e.idleStops };
	let open: string[];
	try {
		open = openQueue();
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
