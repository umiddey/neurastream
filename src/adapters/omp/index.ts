// omp adapter: one extension translating the harness events the originals used into the core
// guard calls (src/core/guards.ts), plus the auto-close scheduler from main-guard. The harness
// name appears only here; core never imports this file.
//
// Event map (docs/adapter.md, docs/inventory.md):
//   session_start          (main only) auto-close now + every queue.auto_close_min minutes
//   before_agent_start     (main only) checkInject: queue summary + cancel flag, reset counters
//   before_subagent_spawn  allow-list + task-kind gate (the plan gate runs at the task tool call)
//   tool_call              checkTool for everyone: protected files, sub budget/blockers/plan
//                          snapshots, main spawn gates, main edit window
//   tool_result            checkPlanEdit for snapshotted plan writes (applies `restore` itself,
//                          like the original), auto-close after a main push/merge
//   session_stop           checkStop fed with `guards.ledger_command` output
//
// The decision JSON, thresholds and refusal texts come from core; this file only moves shapes.
// Harness payloads are untyped at the boundary: every field read goes through a runtime check.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Decision } from "../../core/adapter.ts";
import { loadConfig, type Config } from "../../core/config.ts";
import { nowSec } from "../../core/clock.ts";
import { runDetectorsGated } from "../../core/incident-detectors.ts";
import { checkInject, checkPlanEdit, checkStop, checkTool, MAIN_PLAN_FILE, recordMainResult, rekeySpawnFile } from "../../core/guards.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import { mainStartText, runDailyCheck } from "../../core/main-start.ts";
import { readBlocks } from "../../core/metrics.ts";
import { buildHandoff, holdsBlock, notePath, noteRequest, OWNER_AWAY, ownerText, relaunchPath, rolloverState, spawnRefusal, type RolloverState } from "../../core/rollover.ts";
import { defaultCompletedResults, defaultRunSource } from "./sessions.ts";
import { packageJsonPath, packageVersion } from "./package-root.ts";
import * as q from "../../core/queue/lib.ts";
// Registers the plugin-command matcher into core's writeTargets (side effect).
import "./package-ops.ts";

/** Subset of the harness extension host the adapter needs. */
export interface ExtensionHost {
	on(event: string, cb: (...args: unknown[]) => unknown): void;
	registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void;
	sendUserMessage(content: string): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "nextTurn" }): void;
}

/** The parts of a harness call context the handlers look at. */
interface HostCtx {
	hasAgent: boolean;
	kind?: string;
	id?: string;
	cwd?: string;
	setInterval?: (cb: () => void, ms: number) => unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asCtx(v: unknown): HostCtx {
	const r = asRecord(v);
	// The agent envelope only ever carries kind/id strings (original extensions read just those);
	// cast fixes the envelope, every field below is checked before use.
	const agent = r.agent as { kind?: unknown; id?: unknown } | null | undefined;
	const out: HostCtx = { hasAgent: agent !== null && agent !== undefined };
	if (agent) {
		if (typeof agent.kind === "string") out.kind = agent.kind;
		if (typeof agent.id === "string") out.id = agent.id;
	}
	if (typeof r.cwd === "string") out.cwd = r.cwd;
	// Harness-injected timer with the original main-guard signature (ctx.setInterval).
	const interval = r.setInterval as ((cb: () => void, ms: number) => unknown) | undefined;
	if (typeof interval === "function") out.setInterval = interval;
	return out;
}

/** Map a core decision onto the extension return shapes. */
export function toExtensionResult(d: Decision): Record<string, unknown> {
	if (!d.allow) return { block: true, reason: d.reason, decision: "block" };
	if (d.inject) return { additionalContext: d.inject };
	return {};
}

// A push or merge by Main may have landed a completed plan: try closing right away.
const PUSH_MERGE = /\bgit\b[^\n;|&]*\bpush\b|\b(glab\s+mr|gh\s+pr)\s+merge\b/;

// The installed package and its version: see ./package-root.ts.

export function adapterLog(cfg: Config, line: string): void {
	try {
		appendFileSync(cfg.paths.guard_log, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

/**
 * Real-time incident detectors (plan 20261022_2330 P3) at Main's prompt and after each Main bash
 * result, plus the once-per-day metrics check (P4, retried until it marks the day). The cheap
 * detectors (D2 bash, D4 prompt) run on every call; D1/D3 and their inputs — Main's session
 * file, the ledger runs, both guard logs — are gathered behind the scan interval
 * (incidents.scan_interval_sec, see runDetectorsGated). Best effort: a failed check is logged,
 * never thrown.
 */
function mainDetectors(cfg: Config, extra: { prompt?: string; bash?: { command: string; output: string } }): void {
	try {
		runDetectorsGated(cfg, extra, () => ({
			results: defaultCompletedResults(cfg),
			runs: defaultRunSource(cfg).listRuns(nowSec() - 2 * 86400),
			blocks: readBlocks(cfg),
		}));
		runDailyCheck(cfg, defaultRunSource(cfg), nowSec());
	} catch (err) {
		adapterLog(cfg, `incident detectors failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Background queue-close for every plan Main marked complete. Ported from the
// original autoClose: same filter, same "--- auto-close attempt" log line, detached child with
// stdio on the per-plan close log. QUEUE_CLOSE_BIN overrides the binary (tests); without it the
// package's own executable bin/queue-close runs (its `#!/usr/bin/env bun` shebang picks bun).
// Never process.execPath: inside the harness that is the harness binary itself, so the child was
// a new agent session that loaded this plugin and auto-closed again — a process fork bomb
// (2026-10-21 OOMs, ~175 processes).
function closeChildArgs(plan: string): [string, string[]] {
	const bin = process.env.QUEUE_CLOSE_BIN;
	if (bin) return [bin, [plan]];
	return [join(import.meta.dir, "..", "..", "..", "bin", "queue-close"), [plan]];
}

export function autoClose(cfg: Config): string[] {
	const started: string[] = [];
	let plans: q.Plan[];
	try {
		plans = q.activePlans().filter(p => (p.status === "complete" || p.status === "cancelled") && !p.errors.length);
	} catch {
		return started;
	}
	try {
		mkdirSync(q.stateDirPath(), { recursive: true });
	} catch {}
	for (const p of plans) {
		try {
			const outFile = q.closeLog(p.file);
			appendFileSync(outFile, `--- ${new Date().toISOString()} auto-close attempt\n`);
			const out = openSync(outFile, "a");
			const [bin, args] = closeChildArgs(p.file);
			const child = spawn(bin, args, { detached: true, stdio: ["ignore", out, out], env: process.env });
			child.unref();
			started.push(p.file);
		} catch (err) {
			adapterLog(cfg, `auto-close: could not start for ${p.file}: ${err}`);
		}
	}
	if (started.length) adapterLog(cfg, `auto-close started: ${started.join(", ")}`);
	return started;
}

// Main's stop gate needs the ledger output (original: `agent-ledger --hours 12` through bash -lc,
// errors folded into empty output).
function ledgerText(cfg: Config): string {
	try {
		return execFileSync("bash", ["-lc", cfg.guards.ledger_command], { encoding: "utf8", timeout: 20000 });
	} catch (err) {
		if (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string") return err.stdout;
		return "";
	}
}

// Plan files a subagent write/edit may touch: snapshot before the call so tool_result can verify
// and restore (the original snapshotted inside checkCall; core returns pure decisions now).
function snapshotPlans(tool: string, input: Record<string, unknown>, cwd: string, snap: Map<string, string>, main: boolean): void {
	if (tool !== "write" && tool !== "edit") return;
	const plans = q.activePlans();
	for (const p of q.writeTargets(tool, input, cwd)) {
		if (snap.has(p)) continue;
		if (main) {
			// Main's own plan text is checked too; a plan that did not exist yet snapshots as "".
			if (!MAIN_PLAN_FILE.test(p)) continue;
			try {
				snap.set(p, readFileSync(p, "utf8"));
			} catch {
				snap.set(p, "");
			}
			continue;
		}
		if (!q.isOrchestrationPath(p, plans) || !q.planAt(p, plans)) continue;
		try {
			snap.set(p, readFileSync(p, "utf8"));
		} catch {}
	}
}

// Session rollover helpers: the harness context read through runtime checks, and the file size and
// mtime reads. The decisions are in src/core/rollover.ts.
const WAIT_NOTICE_MS = 15 * 60_000;

interface RolloverCtx {
	sessionId: string;
	sessionFile: string;
	runningJobs(): string[];
	waitForIdle(): unknown;
	newSession(opts: { parentSession: string }): unknown;
	notify(message: string): void;
	draft(): string;
	shutdown(): void;
}

/** Call a method on a harness object by name; undefined when it is not a function. */
function call(obj: Record<string, unknown>, key: string, args: unknown[] = []): unknown {
	const fn = obj[key];
	return typeof fn === "function" ? Reflect.apply(fn, obj, args) : undefined;
}

function asRolloverCtx(v: unknown): RolloverCtx | null {
	const r = asRecord(v);
	const sm = asRecord(r.sessionManager);
	const sessionId = call(sm, "getSessionId");
	const sessionFile = call(sm, "getSessionFile");
	if (typeof sessionId !== "string" || typeof sessionFile !== "string") return null;
	return {
		sessionId,
		sessionFile,
		runningJobs: () => {
			const running = asRecord(call(r, "getAsyncJobSnapshot")).running;
			return Array.isArray(running) ? running.map(j => asString(asRecord(j).label, "job")) : [];
		},
		waitForIdle: () => call(r, "waitForIdle"),
		newSession: opts => call(r, "newSession", [opts]),
		notify: message => call(asRecord(r.ui), "notify", [message]),
		draft: () => {
			const text = call(asRecord(r.ui), "getEditorText");
			return typeof text === "string" ? text : "";
		},
		shutdown: () => {
			call(r, "shutdown");
		},
	};
}

function isMain(ctx: unknown): boolean {
	const c = asCtx(ctx);
	return !c.hasAgent || c.kind === "main";
}

function mtimeOf(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

function sizeOf(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Register the guard handlers on one extension host. `cfg` is injectable for tests. */
export function createOmpAdapter(pi: ExtensionHost, cfg: Config): void {
	// The queue library resolves its paths from env snapshots; point them at this config first.
	applyQueueEnv(cfg);

	let callsSinceStop = 0;
	let idleStops = 0;
	let timer: unknown;
	const calls = new Map<string, number>(); // subagent call budget, by agent id
	const pending = new Map<string, Map<string, string>>(); // toolCallId -> plan snapshots

	pi.on("session_start", (_e, ctx) => {
		const c = asCtx(ctx);
		// Original: proceed only when no agent is set or it is the main session.
		if (c.hasAgent && c.kind !== "main") return;
		autoClose(cfg);
		if (timer) return;
		const every = cfg.queue.auto_close_min * 60_000;
		const t: unknown = c.setInterval
			? c.setInterval(() => autoClose(cfg), every)
			: setInterval(() => autoClose(cfg), every);
		if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
		timer = t;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (asCtx(ctx).kind !== "main") return;
		const d = checkInject({ inject: asString(asRecord(event).prompt), agent: "main" }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? callsSinceStop;
		idleStops = d.state?.idleStops ?? idleStops;
		const notice = rolloverNotice(ctx);
		// A turn the harness starts from the guard's own stop continuation is not an owner
		// message: D4 (owner-correction) only sees real prompts; D1/D3 run either way.
		const prompt = asString(asRecord(event).prompt);
		// Machine prompts (guard continuation, rollover note request, handoff note) are not owner messages.
		mainDetectors(cfg, { prompt: ownerText(prompt) });
		return {
			message: {
				customType: "main-guard.queue",
				content: [d.inject, notice].filter(Boolean).join("\n\n"),
				display: false,
			},
		};
	});

	// The spawn event carries no brief, so the plan gate runs at the task tool call (original
	// behaviour); here only the allow-list and the task-only rule apply, with the original texts.
	pi.on("before_subagent_spawn", (event, ctx) => {
		if (asCtx(ctx).kind === "sub") return;
		const agent = asString(asRecord(event).agent);
		const kind = asString(asRecord(event).invocationKind);
		if (!q.allowedAgents().has(agent))
			return { block: true, reason: `main-guard: agent "${agent}" is not in "## Allowed" of ${q.SUBAGENTS_MD}.` };
		if (kind !== "task")
			return { block: true, reason: "main-guard: spawn implementers with the task tool (the plan gate checks its brief)." };
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const c = asCtx(ctx);
		const e = asRecord(event);
		const tool = asString(e.toolName);
		const input = asRecord(e.input);
		const isSub = c.kind === "sub";
		const agent: "main" | "sub" = isSub ? "sub" : "main";
		const id = c.id ?? "main";
		let n = 0;
		if (isSub && !cfg.guards.skip_tools.includes(tool)) n = (calls.get(id) ?? 0) + 1;
		if (isSub) calls.set(id, n);
		if (!isSub) callsSinceStop++;
		const cwd = c.cwd ?? process.cwd();
		const snap = new Map<string, string>();
		snapshotPlans(tool, input, cwd, snap, !isSub);
		// Drain (src/core/rollover.ts): while a rollover is pending no new subagent starts; the
		// running ones finish first. Subagents' own tool calls are unaffected.
		if (!isSub && tool === "task" && cfg.rollover.enabled) {
			const rc = asRolloverCtx(ctx);
			if (rc) {
				const why = spawnRefusal(rolloverSnapshot(rc).state, rc.runningJobs());
				if (why) {
					const tasks = Array.isArray(input.tasks) ? input.tasks : [];
					adapterLog(cfg, `BLOCK spawn ${String(asRecord(tasks[0]).agent ?? "task")}: rollover pending`);
					return { block: true, reason: why };
				}
			}
		}
		const d = checkTool(
			{ tool, input, cwd, agent, agentId: id, calls: n - 1, paths: [], writes: [], command: asString(input.command) },
			cfg,
		);
		if (!d.allow) return { block: true, reason: d.reason };
		if (snap.size) pending.set(asString(e.toolCallId), snap);
		// The originals return nothing on a clean call; only warn injects carry an object.
		const out = toExtensionResult(d);
		return Object.keys(out).length > 0 ? out : undefined;
	});

	// Main ticked a phase: keep the newest Progress entries in the plan and move older ones to its archive.
	const trimProgress = (file: string): string | undefined => {
		const t = q.trimPlanProgress(file, cfg.queue.progress_keep);
		if (!t) return undefined;
		rekeySpawnFile(file, t.before, t.after);
		return `plan-guard: moved ${t.count} older Progress entries to ${t.archive}; re-read the plan before editing it again.`;
	};

	pi.on("tool_result", (event, ctx) => {
		onSizeCheck("tool_result", event, ctx);
		const e = asRecord(event);
		const c = asCtx(ctx);
		const id = asString(e.toolCallId);
		const snap = pending.get(id);
		const notes: string[] = [];
		if (snap) {
			pending.delete(id);
			for (const [file, before] of snap) {
				let after = before;
				try {
					after = readFileSync(file, "utf8");
				} catch {}
				const d = checkPlanEdit({ path: file, before, after, agent: c.kind === "sub" ? "sub" : "main" }, cfg);
				if (!d.allow && d.restore) {
					try {
						if (d.restore.text === null) rmSync(d.restore.path, { force: true });
						else writeFileSync(d.restore.path, d.restore.text);
					} catch {}
					return { isError: true, content: [{ type: "text", text: d.reason }] };
				}
				if (d.allow && (!c.hasAgent || c.kind === "main") && q.doneCount(after) > q.doneCount(before) && q.planAt(file, q.activePlans())) {
					const note = trimProgress(file);
					if (note) notes.push(note);
				}
			}
		}
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash" && !e.isError) {
			if (PUSH_MERGE.test(asString(asRecord(e.input).command))) autoClose(cfg);
		}
		if ((!c.hasAgent || c.kind === "main") && !e.isError) {
			const content = Array.isArray(e.content) ? e.content : [];
			const text = content.map(p => asString(asRecord(p).text)).join("\n");
			recordMainResult(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), text);
		}
		// Real-time detectors after each Main bash result, crashes included (D2 wants the stack).
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash") {
			const content = Array.isArray(e.content) ? e.content : [];
			mainDetectors(cfg, {
				bash: { command: asString(asRecord(e.input).command), output: content.map(p => asString(asRecord(p).text)).join("\n") },
			});
		}
		if (notes.length) return { content: [...(Array.isArray(e.content) ? e.content : []), ...notes.map(text => ({ type: "text", text }))] };
		return undefined;
	});

	pi.on("session_stop", (_e, ctx) => {
		const c = asCtx(ctx);
		if (c.hasAgent && c.kind !== "main") return;
		// A relaunch is requested: omp shuts down at the next idle, so the stop must not be continued.
		if (relaunched) return undefined;
		// A pending rollover decides the stop and checkStop is not consulted: its queue, incident and cancel
		// blocks would hold Main at a wait the new session raises again through main-start, and its "spawn an
		// agent" text is refused while the rollover is pending.
		const rc = cfg.rollover.enabled ? asRolloverCtx(ctx) : null;
		if (rc) {
			const snap = rolloverSnapshot(rc);
			if (snap.state === "need-note") {
				adapterLog(cfg, "BLOCK stop: rollover need-note");
				return { decision: "block", reason: noteRequestFor(rc, snap) };
			}
			if (snap.state === "ready" || snap.state === "wait-jobs") {
				adapterLog(cfg, `ALLOW stop: rollover ${snap.state}`);
				// Under the launcher a ready rollover starts now; plain omp waits for the owner's next message.
				if (snap.state === "ready" && process.env.NEURASTREAM_MAIN_LAUNCHER === "1") requestRelaunch(rc, notePath(rc.sessionId));
				return undefined;
			}
		}
		const d = checkStop({ agent: "main", callsSinceStop, idleStops, ledgerText: ledgerText(cfg) }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? 0;
		idleStops = d.state?.idleStops ?? idleStops;
		return d.allow ? undefined : { decision: "block", reason: d.reason };
	});

	// Session rollover (src/core/rollover.ts). Main's session size decides when a handoff note is
	// asked for at turn end (a sendMessage that triggers Main's next turn). The owner's next message
	// then starts a fresh session from that note; under `neurastream main` the launcher starts it at
	// once. The size and the installed version are re-read at every turn end and tool result; the
	// note request goes out once per session file and note state.
	// The version this process loaded at start: the plugin code that is actually running.
	const loadedVersion = packageVersion(packageJsonPath());
	let crossed: { file: string; atMs: number } | null = null;
	// The note request already sent, keyed by session file + note mtime at send time ("none" when
	// no note exists): a note that expires while jobs run falls back to need-note with a key no
	// request was sent for, so it gets exactly one new request and never a loop.
	let asked: string | null = null;
	let waitNoticeMs = 0;

	const rolloverSnapshot = (c: RolloverCtx): { state: RolloverState; noteMtimeMs: number | null; stale: boolean; liveVersion: string | null } => {
		const nowMs = Date.now();
		const bytes = sizeOf(c.sessionFile);
		const maxMb = cfg.rollover.max_session_mb;
		const noteMtimeMs = mtimeOf(notePath(c.sessionId));
		const liveVersion = packageVersion(packageJsonPath());
		const stale = liveVersion === null || loadedVersion === null || liveVersion !== loadedVersion;
		if (stale) {
			// Note freshness is measured against the crossing: a stale session counts as crossed
			// from the first check that saw it, whatever its size.
			if (crossed?.file !== c.sessionFile) crossed = { file: c.sessionFile, atMs: nowMs };
		} else if (bytes < maxMb * 1024 * 1024) crossed = null;
		else if (crossed?.file !== c.sessionFile) crossed = { file: c.sessionFile, atMs: nowMs };
		return {
			state: rolloverState({
				sessionBytes: bytes,
				maxMb,
				runningJobs: c.runningJobs(),
				crossedAtMs: crossed?.atMs ?? null,
				noteMtimeMs,
				nowMs,
				stale,
			}),
			noteMtimeMs,
			stale,
			liveVersion,
		};
	};

	// The note request for a state. A stale install names both versions in place of the size line.
	const noteRequestFor = (c: RolloverCtx, snap: { stale: boolean; liveVersion: string | null }): string => {
		const reason = snap.stale ? `neurastream on disk is ${snap.liveVersion ?? "unknown"}, this session runs ${loadedVersion ?? "unknown"}` : undefined;
		return noteRequest(notePath(c.sessionId), process.env.NEURASTREAM_MAIN_LAUNCHER === "1", reason);
	};

	let relaunched = false;
	// omp 18.11.1 defers an extension shutdown: it re-checks only when shutdown() is called again or
	// an owner submission finishes, so a refused exit once left a dead UI that swallowed every owner
	// message (I-20261024-4). One unref'd timer per request: if omp still has not exited
	// rollover.exit_grace_s after the request, the adapter rolls over in-process. The timer keeps its
	// own clearer: session_shutdown cancels the fallback when omp really exits.
	let clearGrace: (() => void) | null = null;
	const armGraceTimer = (c: RolloverCtx): void => {
		clearGrace?.();
		const t = setTimeout(() => {
			clearGrace = null;
			exitGraceElapsed(c);
		}, cfg.rollover.exit_grace_s * 1000);
		if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
		clearGrace = () => {
			clearTimeout(t);
			clearGrace = null;
		};
	};

	// One /main-rollover at a time: while one waits for idle, a second call adds its text to the owner message.
	let flight: string[] | null = null;

	// The one in-process rollover, shared by /main-rollover and the exit-grace fallback: gather the
	// generated state, wait for idle, then start a fresh session whose first message is the handoff.
	// A state change during the wait sends the owner's text to this session as an ordinary message.
	const rolloverInProcess = async (c: RolloverCtx, owner: string[], notice: string): Promise<void> => {
		const previous = c.sessionFile;
		const path = notePath(c.sessionId);
		flight = owner;
		try {
			c.notify(notice);
			const generated = [
				await mainStartText([], cfg, { inheritStdin: false }, { source: defaultRunSource(cfg), results: defaultCompletedResults(cfg) }),
				holdsBlock(q.ownerHolds()),
			].join("\n");
			const note = readFileSync(path, "utf8");
			adapterLog(cfg, `rollover: new session from ${previous}; note ${path}`);
			await c.waitForIdle();
			const again = rolloverSnapshot(c).state;
			if (relaunched || again !== "ready") {
				c.notify(`main-rollover: the state changed while waiting for idle (${relaunched ? "relaunch requested" : again}); no new session.`);
				// The owner's text is not lost: it goes to this session as an ordinary message.
				const pending = owner.filter(s => s !== "").join("\n");
				if (pending !== "") pi.sendUserMessage(pending);
				return;
			}
			const r = asRecord(await c.newSession({ parentSession: previous }));
			if (r.cancelled === true) return;
			// Read after the await: owner messages that arrived during newSession are part of the handoff.
			const handoff = buildHandoff({
				generated,
				note,
				previousSessionFile: previous,
				ownerMessage: owner.filter(s => s !== "").join("\n"),
			});
			pi.sendUserMessage(handoff);
		} finally {
			flight = null;
		}
	};

	// The launcher restarts omp: the request file carries the note and the editor draft, and omp
	// shuts down only after the file is written. A failed write keeps the session running.
	// Returns whether the request was written.
	const requestRelaunch = (c: RolloverCtx, note: string, draft = c.draft()): boolean => {
		try {
			mkdirSync(dirname(relaunchPath()), { recursive: true });
			writeFileSync(relaunchPath(), `${JSON.stringify({ previousSessionFile: c.sessionFile, notePath: note, draft })}\n`);
		} catch (err) {
			adapterLog(cfg, `rollover: relaunch request not written: ${String(err)}`);
			return false;
		}
		relaunched = true;
		adapterLog(cfg, `rollover: relaunch requested from ${c.sessionFile}`);
		c.shutdown();
		armGraceTimer(c);
		return true;
	};

	// An owner message typed while the relaunch is pending joins the request's draft, in order; the
	// launcher's handoff carries it. The rewrite is atomic, so the launcher never reads a partial file.
	const appendToRelaunch = (text: string): boolean => {
		try {
			const req = asRecord(JSON.parse(readFileSync(relaunchPath(), "utf8")));
			const draft = [asString(req.draft), text].filter(s => s !== "").join("\n");
			const tmp = `${relaunchPath()}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ ...req, draft })}\n`);
			renameSync(tmp, relaunchPath());
			return true;
		} catch (err) {
			adapterLog(cfg, `rollover: owner message not added to the relaunch request: ${String(err)}`);
			return false;
		}
	};

	// The grace elapsed without a session_shutdown: omp refused the exit. Read the request's draft,
	// drop the request and roll over here, so the owner's messages reach a live session instead of a
	// dead UI. The owner-away text stands in when nothing was typed.
	const exitGraceElapsed = (c: RolloverCtx): void => {
		adapterLog(cfg, `rollover: omp did not exit within ${cfg.rollover.exit_grace_s}s; rolling over in-process`);
		let draft = "";
		try {
			draft = asString(asRecord(JSON.parse(readFileSync(relaunchPath(), "utf8"))).draft);
		} catch {}
		rmSync(relaunchPath(), { force: true });
		relaunched = false;
		rolloverInProcess(c, [draft.trim() === "" ? OWNER_AWAY : draft], "rollover: omp did not restart; continuing in a new session here").catch((err: unknown) => {
			adapterLog(cfg, `rollover: in-process rollover failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	const onSizeCheck = (kind: "tool_result" | "agent_end", e: unknown, ctx: unknown): void => {
		const c = asRolloverCtx(ctx);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return;
		const snap = rolloverSnapshot(c);
		const key = `${c.sessionFile}:${snap.noteMtimeMs ?? "none"}`;
		// A terminal run end: omp 18.11.1 sets willContinue on a non-terminal agent_end.
		const terminal = kind === "agent_end" && asRecord(e).willContinue !== true;
		if (snap.state === "need-note" && asked !== key) {
			asked = key;
			pi.sendMessage(
				{ customType: "main-guard.rollover", content: noteRequestFor(c, snap), display: false },
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} else if (terminal && snap.state === "ready" && process.env.NEURASTREAM_MAIN_LAUNCHER === "1" && !relaunched && flight === null) {
			// flight !== null: an in-process rollover (fallback or /main-rollover) owns this session's end.
			requestRelaunch(c, notePath(c.sessionId));
		} else if (terminal && relaunched) {
			// A tool result mid-run never restarts the session (I-20261024-4), and omp's interactive
			// mode re-runs its deferred exit check only when shutdown() is called again: re-arm at
			// every later terminal run end instead of waiting for an owner message.
			c.shutdown();
		}
	};
	pi.on("agent_end", (e, ctx) => onSizeCheck("agent_end", e, ctx));

	// omp is really shutting down: the exit-grace fallback must not fire.
	pi.on("session_shutdown", () => clearGrace?.());

	// Compaction keeps the owner's holds true: a summary may state a hold only as a plans' WAITING on owner line says it.
	pi.on("session.compacting", (_e, ctx) => {
		if (!isMain(ctx)) return undefined;
		const holds = q.ownerHolds();
		return {
			context: [
				"Owner holds/blockers: only plans' WAITING on owner lines are real:",
				...(holds.length > 0 ? holds : ["none"]),
				"Any other hold, 'needs the owner' or 'paused' claim carried in this summary is unverified: re-read the plan before repeating it to the owner.",
			],
		};
	});

	/** Wait-jobs notice for Main's next turn, throttled; null otherwise. The note request goes out at turn end. */
	const rolloverNotice = (ctx: unknown): string | null => {
		const c = asRolloverCtx(ctx);
		if (!cfg.rollover.enabled || !c) return null;
		const state = rolloverSnapshot(c).state;
		if (state === "wait-jobs" && Date.now() - waitNoticeMs >= WAIT_NOTICE_MS) {
			waitNoticeMs = Date.now();
			const jobs = c.runningJobs().join(", ");
			return `Session rollover: the handoff note is ready, but own jobs are still running (${jobs}). A rollover would cancel them, so the owner's messages stay in this session until they finish.`;
		}
		return null;
	};

	// Chat unlock (guards.chat_unlock): the owner's whole message "unlock"/"unlock N"/"lock" moves
	// the guard unlock file (src/core/queue/lib.ts chatUnlock). Only prompts the owner really typed
	// count: the local terminal (input event, source "interactive") and collab guest prompts from
	// write peers. This handler is registered BEFORE the rollover input handler below, so the unlock
	// wins while a rollover is ready or in flight (emitInput short-circuits on { handled: true }).
	const notifyUnlock = (ctx: unknown, r: { command?: "unlock" | "lock"; minutes?: number }): void => {
		const c = asRolloverCtx(ctx);
		if (!c) return;
		if (r.command === "unlock" && r.minutes !== undefined) {
			const until = new Date(Date.now() + r.minutes * 60_000).toLocaleTimeString();
			c.notify(`guard unlocked for ${r.minutes} min (until ${until})`);
		} else if (r.command === "lock") {
			c.notify("guard locked again");
		}
	};
	pi.on("input", (event, ctx) => {
		if (!cfg.guards.chat_unlock || !isMain(ctx)) return undefined;
		const e = asRecord(event);
		if (asString(e.source) !== "interactive") return undefined;
		const r = q.chatUnlock(asString(e.text), cfg, "interactive");
		if (!r.applied) return undefined;
		notifyUnlock(ctx, r);
		return { handled: true };
	});
	// A collab guest prompt (collab/host.ts #handlePrompt, write peers only) is NOT an input event:
	// it is session.promptCustomMessage({ customType: "collab-prompt", details: { from },
	// attribution: "user" }), which lands in the agent context — the adapter sees it on the
	// "context" event (types.ts ContextEvent, the messages about to go to the LLM). The message
	// stays in the transcript, so later LLM calls replay it: a seen key (timestamp + text) is acted
	// on once, and a resumed session replaying old prompts is stopped by the age limit.
	const seenChatPrompts = new Set<string>();
	const CHAT_PROMPT_MAX_AGE_MS = 10 * 60_000;
	pi.on("context", (event, ctx) => {
		if (!cfg.guards.chat_unlock || !isMain(ctx)) return undefined;
		const messages = asRecord(event).messages;
		if (!Array.isArray(messages)) return undefined;
		for (const raw of messages) {
			const m = asRecord(raw);
			if (m.role !== "custom" || m.customType !== "collab-prompt" || m.attribution !== "user") continue;
			const from = asString(asRecord(m.details).from);
			if (from === "") continue;
			const text =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content.map(c => asString(asRecord(c).text)).join("")
						: "";
			const timestamp = typeof m.timestamp === "number" ? m.timestamp : 0;
			if (Date.now() - timestamp > CHAT_PROMPT_MAX_AGE_MS) continue;
			const key = `${timestamp}:${text}`;
			if (seenChatPrompts.has(key)) continue;
			seenChatPrompts.add(key);
			const r = q.chatUnlock(text, cfg, `collab:${from}`);
			if (r.applied) notifyUnlock(ctx, r);
		}
		return undefined;
	});

	// Under the launcher the relaunch is the only rollover path: a plain interactive message in the ready
	// state requests it, and every such message joins the pending request's draft, in order. Plain omp keeps
	// `/main-rollover <text>`: the message becomes the owner's first message of the new session.
	pi.on("input", (event, ctx) => {
		const e = asRecord(event);
		const c = asRolloverCtx(ctx);
		const text = asString(e.text);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return undefined;
		if (asString(e.source) !== "interactive" || text === "" || text.startsWith("/")) return undefined;
		if (process.env.NEURASTREAM_MAIN_LAUNCHER === "1") {
			if (!relaunched) {
				if (rolloverSnapshot(c).state !== "ready") return undefined;
				// The message is the request's first owner text, so the editor draft is not carried.
				if (!requestRelaunch(c, notePath(c.sessionId), "")) return undefined;
			}
			if (appendToRelaunch(text)) c.notify("rollover in progress: your message goes to the new session");
			else c.notify("rollover in progress: your message could not be saved and was not sent; send it again after the rollover");
			// omp re-checks its deferred exit only when shutdown() is called again: re-arm per message.
			c.shutdown();
			return { handled: true };
		}
		if (rolloverSnapshot(c).state !== "ready") return undefined;
		return { text: `/main-rollover ${text}` };
	});

	// One /main-rollover at a time: while one waits for idle, a second call adds its text to the owner message.
	pi.registerCommand("main-rollover", {
		description: "Start a fresh session from Main's handoff note; the rest of the message is the owner's first message",
		handler: async (args: unknown, ctx: unknown) => {
			const c = asRolloverCtx(ctx);
			if (!c) return;
			const text = asString(args);
			if (process.env.NEURASTREAM_MAIN_LAUNCHER === "1") {
				c.notify("main-rollover: under neurastream main the rollover starts from your next message, not from this command.");
				return;
			}
			if (flight) {
				flight.push(text);
				c.notify("main-rollover: a rollover is already in progress; your message is added to its handoff.");
				return;
			}
			const path = notePath(c.sessionId);
			const state = rolloverSnapshot(c).state;
			if (state === "below") {
				c.notify("main-rollover: this session is below rollover.max_session_mb; nothing to roll over.");
				return;
			}
			if (state === "need-note") {
				c.notify(`main-rollover: no fresh handoff note at ${path}; Main must write it first.`);
				return;
			}
			if (state === "wait-jobs") {
				c.notify(`main-rollover: own jobs are still running (${c.runningJobs().join(", ")}); a rollover would cancel them.`);
				return;
			}
			await rolloverInProcess(c, [text], "main-rollover: collecting main-start state for the handoff (this can take a minute)…");
		},
	});
}

/** package.json omp.extensions entry. */
export default function ompExtension(pi: ExtensionHost): void {
	createOmpAdapter(pi, loadConfig());
}
