// @ts-nocheck
// main-guard: deterministic enforcement of owner rules for the MAIN session (model: ../queue/lib.ts).
//
// 1. Queue in context: at every user prompt the queue summary (indexes, plans, statuses, problems) is
//    injected, so Main always starts from INDEX.md without having to remember to read it.
// 2. Edit limit (owner 2026-10-15: 5 per 15 minutes, every user prompt also resets): Main may change non-text project files at most
//    LIMIT times per window, so it never implements itself. The window starts at the first counted change
//    and the count resets WINDOW_MIN minutes later (works overnight with no user prompts). Counted: write/
//    edit/ast_edit on a project file, and bash/eval commands that write a project file (lib.ts
//    writeTargets), relative paths resolved against the cwd. Free: every read and search, git landing
//    commands, any .md/.txt file, and Main's orchestration files (repo INDEX.md, open plan files and
//    their blocker scripts, gf-testbed, archive).
// 3. Spawns: only agents listed under "## Allowed" in notes/subagents.md (before_subagent_spawn, every
//    spawn kind). Implementers only through the `task` tool, and only when the brief names the absolute
//    path of an open, valid plan that is not parked, not complete, and whose "## Progress" changed since
//    the previous spawn on it (the last run left its trail). No spawn at all while a plan says complete
//    or cancelled and is still indexed for another reason than "awaiting merge" (done check green, branch
//    not on main yet: a normal state since 2026-10-17): close it first (`queue-close`). Cat Jam (`opencode run` in bash) obeys the
//    same plan rule.
// 4. Keep working: Main may not stop while an open plan is not parked with "WAITING on owner" (or the
//    queue has a problem) and no subagent is alive to wake it. Spin guard: 3 stop attempts in a row
//    with zero tool calls in between are let through (and logged).
// 5. Auto-close: every plan Main marked "Status: complete" gets a background `queue-close` at session
//    start, at every user prompt, every 15 minutes and after each push/merge by Main. Results land in
//    ~/.local/state/queue/close-*.log and in the queue summary.
//
// Env overrides (for tests only): MAIN_GUARD_LIMIT, MAIN_GUARD_WINDOW_MIN, MAIN_GUARD_ROOTS (comma list), QUEUE_INDEX,
// QUEUE_STATE, QUEUE_SUBAGENTS, MAIN_GUARD_LEDGER (command printing agent-ledger output), MAIN_GUARD_LOG.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	activePlans,
	allowedAgents,
	awaitingMerge,
	CANCEL_PENDING,
	CANCEL_WORDS,
	cancelledMatches,
	cancelledProblem,
	cancelPending,
	closeLog,
	INDEX,
	isOrchestrationPath,
	progressBody,
	queueProblems,
	queueSummary,
	sha,
	STATE_DIR,
	SUBAGENTS_MD,
	writeTargets,
} from "../queue/lib.ts";

const QUEUE_CLOSE = process.env.QUEUE_CLOSE_BIN ?? `${os.homedir()}/.local/bin/queue-close`;
const AUTO_CLOSE_MIN = 15;

// Owner message that may call work off (owner 2026-10-16: "don't do X" must hold even if no plan
// exists yet). Flag it; until Main records it with queue-cancel, no spawn and no stop.
export const CANCEL_TODO =
	'the owner\'s message may call work off. Record it first: an indexed plan → `queue-cancel <plan> "<owner words>"`; ' +
	'work with no plan (yet) → `queue-cancel --never "<what must not be done>" "<owner words>" [--repo <repo>]`; ' +
	'nothing was called off → `queue-cancel --not-a-cancel "<why>"`.';
export function flagCancel(prompt: string): string {
	const m = prompt.match(CANCEL_WORDS);
	if (!m) return "";
	const at = m.index ?? 0;
	const words = prompt.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, " ").trim();
	const prev = cancelPending();
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(CANCEL_PENDING, JSON.stringify({ at: new Date().toISOString(), words: prev ? `${prev.words} … ${words}` : words }));
	} catch (err) {
		log(`cannot write ${CANCEL_PENDING}: ${err}`);
	}
	log(`cancel flagged: ${words}`);
	return `\nmain-guard: ${CANCEL_TODO} Flagged: "${words}"`;
}

// Background queue-close for every plan Main marked complete (owner 2026-10-15: a reviewed, landed plan
// leaves the indexes without anyone remembering). queue-close checks everything itself (done check
// first, cached per state, then landed) and holds a per-plan lock, so an early or duplicate attempt is harmless.
// Returns the plans an attempt was started for.
export function autoClose(): string[] {
	const started: string[] = [];
	let plans = [];
	try {
		plans = activePlans().filter(p => (p.status === "complete" || p.status === "cancelled") && !p.errors.length);
	} catch {
		return started;
	}
	mkdirSync(STATE_DIR, { recursive: true });
	for (const p of plans) {
		try {
			const out = openSync(closeLog(p.file), "a");
			appendFileSync(closeLog(p.file), `--- ${new Date().toISOString()} auto-close attempt\n`);
			const child = spawn(QUEUE_CLOSE, [p.file], { detached: true, stdio: ["ignore", out, out], env: process.env });
			child.unref();
			started.push(p.file);
		} catch (err) {
			log(`auto-close: could not start for ${p.file}: ${err}`);
		}
	}
	if (started.length) log(`auto-close started: ${started.join(", ")}`);
	return started;
}

const HOME = os.homedir();
const LIMIT = Number(process.env.MAIN_GUARD_LIMIT ?? 5);
const WINDOW_MIN = Number(process.env.MAIN_GUARD_WINDOW_MIN ?? 15);
// Text files never count (owner 2026-10-15: "only ... anything apart from .md or .txt").
const FREE_EXT = /\.(md|txt)$/i;
const ROOTS = (process.env.MAIN_GUARD_ROOTS ?? `${HOME}/Work/,${HOME}/projects/`)
	.split(",")
	.map(s => s.trim())
	.filter(Boolean);
// Orchestration space inside the roots: briefs, reports, archives, the heavy-run lock script.
const FREE = [`${HOME}/Work/gf-testbed/`, `${HOME}/Work/archive/`, `${HOME}/Work/heavy-run.sh`];
const LEDGER = process.env.MAIN_GUARD_LEDGER ?? "agent-ledger --hours 12";
const LOG = process.env.MAIN_GUARD_LOG ?? `${HOME}/.local/state/main-guard.log`;
const SPAWNS = path.join(STATE_DIR, "spawns.json");

function log(line: string) {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

function isProjectPath(p: string, plans = activePlans()): boolean {
	return (
		ROOTS.some(r => p.startsWith(r) && p.length > r.length) &&
		!FREE.some(f => p.startsWith(f) || `${p}/` === f) &&
		!isOrchestrationPath(p, plans)
	);
}

// Project files this call would change; empty = the call does not count toward the limit.
// Only real write targets count (lib.ts writeTargets): reads, git landing commands (commit, push,
// merge, pull, rebase, cherry-pick, worktree) and paths merely mentioned in a body or command are free.
export function changedProjectFiles(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const plans = activePlans();
	return writeTargets(toolName, input ?? {}, cwd).filter(p => !FREE_EXT.test(p) && isProjectPath(p, plans));
}

function readSpawns(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(SPAWNS, "utf8"));
	} catch {
		return {};
	}
}

function recordSpawns(files: string[]) {
	const s = readSpawns();
	for (const f of files) {
		try {
			s[f] = sha(progressBody(readFileSync(f, "utf8")));
		} catch {}
	}
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(SPAWNS, JSON.stringify(s, null, 1));
}

// Plans an implementer brief may run on; returns [reason, null] or [null, plan files].
export function planGate(text: string, label: string): [string | null, string[]] {
	const plans = activePlans();
	const unclosed = plans.filter(p => (p.status === "complete" || p.status === "cancelled") && !awaitingMerge(p));
	if (unclosed.length)
		return [`${label}: ${unclosed.map(p => `${p.file} (${p.status})`).join(", ")} is still indexed. Verify it and run \`queue-close <plan>\` before any new spawn.`, []];
	const named = plans.filter(p => text.includes(p.file));
	if (!named.length)
		return [`${label}: an implementer needs an open plan. Name the plan's absolute path in the brief; the plan must be listed in <repo>/INDEX.md and the repo in ${INDEX}.`, []];
	const spawns = readSpawns();
	for (const p of named) {
		if (p.errors.length) return [`${label}: plan ${p.file} is not ready (${p.errors.join("; ")}).`, []];
		if (p.waiting) return [`${label}: plan ${p.file} is parked "WAITING on owner".`, []];
		if (p.status !== "open") return [`${label}: plan ${p.file} says "Status: ${p.status}".`, []];
		const cancelled = cancelledMatches(p);
		if (cancelled.length) return [`${label}: plan ${p.file} ${cancelledProblem(p, cancelled[0])}`, []];
		const before = spawns[p.file];
		if (before && before === sha(progressBody(p.text)))
			return [`${label}: plan ${p.file} has no new "## Progress" entry since the last agent ran on it. Write that run's progress (from its report) into the plan first.`, []];
	}
	return [null, named.map(p => p.file)];
}

// Reason to refuse a `task` call, or null; `files` receives the plans to record.
export function spawnProblem(input: Record<string, unknown>, files: string[] = []): string | null {
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const context = String(input?.context ?? "");
	const allowed = allowedAgents();
	for (const t of tasks) {
		const agent = String(t?.agent ?? "task");
		const label = String(t?.name ?? agent);
		if (!allowed.has(agent)) return `${label}: agent "${agent}" is not in "## Allowed" of ${SUBAGENTS_MD} (no expensive or unpinned models).`;
		const [why, named] = planGate(`${context}\n${String(t?.task ?? "")}`, label);
		if (why) return why;
		files.push(...named);
	}
	return null;
}

// Cat Jam and any other OpenCode run go around omp's guards, so they need an open plan too.
export function opencodeProblem(command: string, files: string[] = []): string | null {
	if (!/\bopencode\b[^\n;|&]*\brun\b/.test(command)) return null;
	const [why, named] = planGate(command, "opencode run");
	files.push(...named);
	return why;
}

export function openQueue(): string[] {
	const open = activePlans()
		.filter(p => !p.waiting && !awaitingMerge(p))
		.map(p => p.file);
	for (const q of queueProblems()) open.push(`${q.where}: ${q.problem}`);
	return [...new Set(open)];
}

export function liveSubagents(ledgerOut: string): string[] {
	return ledgerOut
		.split("\n")
		.filter(l => !l.startsWith("MAIN ") && /\s(RUNNING|WAITING)\b/.test(l))
		.filter(l => {
			const m = l.match(/idle (\d+)m/);
			return !m || Number(m[1]) < 60;
		})
		.map(l => l.split(/\s+/)[0]);
}

export default function mainGuard(pi) {
	let used: string[] = [];
	let windowStart = 0;
	let callsSinceStop = 0;
	let idleStops = 0;
	let timer = null;

	// Overnight trigger: no prompts arrive, so retry closing every AUTO_CLOSE_MIN minutes.
	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent && ctx.agent.kind !== "main") return;
		autoClose();
		if (timer) return;
		const every = AUTO_CLOSE_MIN * 60_000;
		timer = typeof ctx.setInterval === "function" ? ctx.setInterval(() => autoClose(), every) : setInterval(() => autoClose(), every);
		if (timer?.unref) timer.unref();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind !== "main") return;
		used = [];
		idleStops = 0;
		autoClose();
		let summary: string;
		try {
			summary = queueSummary();
		} catch (err) {
			summary = `Queue unreadable (${INDEX}): ${err}`;
		}
		const cancel = flagCancel(String(event?.prompt ?? ""));
		return {
			message: {
				customType: "main-guard.queue",
				content: `${summary}\n(main-guard: read ${INDEX} and the listed repo INDEX.md files are summarised above; work the open plans, close finished ones with queue-close.)${cancel}`,
				display: false,
			},
		};
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const allowed = allowedAgents();
		if (!allowed.has(event.agent)) {
			log(`BLOCK spawn agent=${event.agent}: not allowed`);
			return { block: true, reason: `main-guard: agent "${event.agent}" is not in "## Allowed" of ${SUBAGENTS_MD}.` };
		}
		if (event.invocationKind !== "task") {
			log(`BLOCK spawn agent=${event.agent}: via ${event.invocationKind}`);
			return { block: true, reason: "main-guard: spawn implementers with the task tool (the plan gate checks its brief)." };
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent?.kind !== "main") return;
		callsSinceStop++;
		const input = event.input ?? {};
		if (event.toolName === "task") {
			const pending = cancelPending();
			if (pending) {
				log(`BLOCK spawn: cancel pending (${pending.words})`);
				return { block: true, reason: `main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"` };
			}
			const files: string[] = [];
			const why = spawnProblem(input, files);
			if (why) {
				log(`BLOCK spawn: ${why}`);
				return { block: true, reason: `main-guard: ${why}` };
			}
			recordSpawns(files);
			return;
		}
		if (event.toolName === "bash") {
			const files: string[] = [];
			const command = String(input.command ?? "");
			const pending = /\bopencode\b[^\n]*\brun\b/.test(command) ? cancelPending() : null;
			if (pending) {
				log(`BLOCK opencode: cancel pending (${pending.words})`);
				return { block: true, reason: `main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"` };
			}
			const why = opencodeProblem(command, files);
			if (why) {
				log(`BLOCK opencode: ${why}`);
				return { block: true, reason: `main-guard: ${why}` };
			}
			if (files.length) recordSpawns(files);
		}
		const files = changedProjectFiles(event.toolName, input, ctx.cwd ?? process.cwd());
		if (!files.length) return;
		const now = Date.now();
		if (used.length && now - windowStart >= WINDOW_MIN * 60_000) used = [];
		if (used.length >= LIMIT) {
			const mins = Math.ceil((windowStart + WINDOW_MIN * 60_000 - now) / 60_000);
			log(`BLOCK tool=${event.toolName} after ${used.length} edits: ${files.join(",")}`);
			return {
				block: true,
				reason:
					`main-guard: Main already changed project files ${used.length} times in this ${WINDOW_MIN}-minute window ` +
					`(owner limit ${LIMIT}; resets in ${mins} min). Main writes plans, not code: put the work in a plan ` +
					`(listed in <repo>/INDEX.md, phase-0 blockers first) and spawn an implementer. Changes so far: ${used.join(", ")}`,
			};
		}
		if (!used.length) windowStart = now;
		used.push(`${event.toolName}:${files[0]}`);
		const left = LIMIT - used.length;
		if (left <= 2)
			return { additionalContext: `main-guard: ${left} project-file change(s) left in this ${WINDOW_MIN}-minute window; then delegate.` };
	});

	// A push or merge by Main may have landed a completed plan: try closing right away.
	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent?.kind !== "main" || event.toolName !== "bash" || event.isError) return;
		if (/\bgit\b[^\n;|&]*\bpush\b|\b(glab\s+mr|gh\s+pr)\s+merge\b/.test(String(event.input?.command ?? ""))) autoClose();
	});

	pi.on("session_stop", async (_e, ctx) => {
		log(`stop event kind=${ctx.agent?.kind ?? "?"} callsSinceStop=${callsSinceStop}`);
		if (ctx.agent && ctx.agent.kind !== "main") return;
		let open: string[] = [];
		try {
			open = openQueue();
		} catch (err) {
			log(`BLOCK stop: cannot read queue: ${err}`);
			open = [`queue unreadable (${INDEX}): ${err}`];
		}
		const pending = cancelPending();
		if (pending && idleStops < 2) {
			if (callsSinceStop === 0) idleStops++;
			callsSinceStop = 0;
			log(`BLOCK stop: cancel pending (${pending.words})`);
			return { decision: "block", reason: `main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"` };
		}
		if (open.length === 0) return;
		let live: string[] = [];
		try {
			live = liveSubagents(execFileSync("bash", ["-lc", LEDGER], { encoding: "utf8", timeout: 20000 }));
		} catch (err) {
			live = liveSubagents(String(err?.stdout ?? ""));
		}
		if (live.length > 0) {
			log(`ALLOW stop: live subagents ${live.join(",")}`);
			return;
		}
		if (callsSinceStop === 0) idleStops++;
		else idleStops = 0;
		callsSinceStop = 0;
		if (idleStops >= 3) {
			log(`ALLOW stop after ${idleStops} idle stop attempts; open: ${open.join(" | ")}`);
			idleStops = 0;
			return;
		}
		log(`BLOCK stop; open: ${open.join(" | ")}`);
		return {
			decision: "block",
			reason:
				`main-guard: the queue has ${open.length} open item${open.length === 1 ? "" : "s"} and no subagent is ` +
				`running to wake you. Owner rule: keep working while the queue has items. Start the next step (spawn an ` +
				`agent), close a finished plan with queue-close, or, if a plan truly waits on the owner, add a line ` +
				`"WAITING on owner: <what>" to that plan. Open: ${open.join(" | ")}`,
		};
	});
}
