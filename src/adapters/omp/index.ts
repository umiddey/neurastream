// omp adapter: one extension translating the harness events the originals used into the core
// guard calls (src/core/guards.ts), plus the auto-close scheduler from main-guard. The harness
// name appears only here and in herdr-agent-state.ts; core never imports this file.
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
import { appendFileSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Decision } from "../../core/adapter.ts";
import { loadConfig, type Config } from "../../core/config.ts";
import { checkInject, checkPlanEdit, checkStop, checkTool, MAIN_PLAN_FILE, recordMainResult } from "../../core/guards.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import { mainStartText } from "../../core/main-start.ts";
import { buildHandoff, holdsBlock, notePath, noteRequest, relaunchPath, type RolloverState, rolloverState } from "../../core/rollover.ts";
import * as q from "../../core/queue/lib.ts";
// Registers the plugin-command matcher into core's writeTargets (side effect).
import "./package-ops.ts";

/** Subset of the harness extension host the adapter needs (pi.on; herdr also uses pi.events). */
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

function adapterLog(cfg: Config, line: string): void {
	try {
		appendFileSync(cfg.paths.guard_log, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

// Background queue-close for every plan Main marked complete (owner 2026-10-15). Ported from the
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

	pi.on("tool_result", (event, ctx) => {
		onSizeCheck(event, ctx);
		const e = asRecord(event);
		const c = asCtx(ctx);
		const id = asString(e.toolCallId);
		const snap = pending.get(id);
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
		return undefined;
	});

	pi.on("session_stop", (_e, ctx) => {
		const c = asCtx(ctx);
		if (c.hasAgent && c.kind !== "main") return;
		const d = checkStop({ agent: "main", callsSinceStop, idleStops, ledgerText: ledgerText(cfg) }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? 0;
		idleStops = d.state?.idleStops ?? idleStops;
		return d.allow ? undefined : { decision: "block", reason: d.reason };
	});

	// Session rollover (src/core/rollover.ts). Main's session size decides when a handoff note is
	// asked for at turn end (a sendMessage that triggers Main's next turn). The owner's next message
	// then starts a fresh session from that note; under `neurastream main` the launcher starts it at
	// once. The size is re-read at every turn end and tool result; the note request goes out once per session file.
	let crossed: { file: string; atMs: number } | null = null;
	let asked: string | null = null;
	let waitNoticeMs = 0;

	const stateOf = (c: RolloverCtx): RolloverState => {
		const nowMs = Date.now();
		const bytes = sizeOf(c.sessionFile);
		const maxMb = cfg.rollover.max_session_mb;
		if (bytes < maxMb * 1024 * 1024) crossed = null;
		else if (crossed?.file !== c.sessionFile) crossed = { file: c.sessionFile, atMs: nowMs };
		return rolloverState({
			sessionBytes: bytes,
			maxMb,
			runningJobs: c.runningJobs(),
			crossedAtMs: crossed?.atMs ?? null,
			noteMtimeMs: mtimeOf(notePath(c.sessionId)),
			nowMs,
		});
	};

	let relaunched = false;
	// The launcher restarts omp: the request file carries the note and the editor draft, and omp
	// shuts down only after the file is written. A failed write keeps the session running.
	const requestRelaunch = (c: RolloverCtx, note: string): void => {
		try {
			mkdirSync(dirname(relaunchPath()), { recursive: true });
			writeFileSync(
				relaunchPath(),
				`${JSON.stringify({ previousSessionFile: c.sessionFile, notePath: note, draft: c.draft() })}\n`,
			);
		} catch (err) {
			adapterLog(cfg, `rollover: relaunch request not written: ${String(err)}`);
			return;
		}
		relaunched = true;
		adapterLog(cfg, `rollover: relaunch requested from ${c.sessionFile}`);
		c.shutdown();
	};

	const onSizeCheck = (_e: unknown, ctx: unknown): void => {
		const c = asRolloverCtx(ctx);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return;
		const state = stateOf(c);
		if (state === "need-note" && asked !== c.sessionFile) {
			asked = c.sessionFile;
			pi.sendMessage(
				{ customType: "main-guard.rollover", content: noteRequest(notePath(c.sessionId), process.env.NEURASTREAM_MAIN_LAUNCHER === "1"), display: false },
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} else if (state === "ready" && process.env.NEURASTREAM_MAIN_LAUNCHER === "1" && !relaunched) {
			requestRelaunch(c, notePath(c.sessionId));
		}
	};
	pi.on("agent_end", onSizeCheck);

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
		const state = stateOf(c);
		if (state === "wait-jobs" && Date.now() - waitNoticeMs >= WAIT_NOTICE_MS) {
			waitNoticeMs = Date.now();
			const jobs = c.runningJobs().join(", ");
			return `Session rollover: the handoff note is ready, but own jobs are still running (${jobs}). A rollover would cancel them, so the owner's messages stay in this session until they finish.`;
		}
		return null;
	};

	// A plain interactive message in the ready state becomes the owner's first message of the new session.
	pi.on("input", (event, ctx) => {
		const e = asRecord(event);
		const c = asRolloverCtx(ctx);
		const text = asString(e.text);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return undefined;
		if (asString(e.source) !== "interactive" || text === "" || text.startsWith("/")) return undefined;
		if (stateOf(c) !== "ready") return undefined;
		return { text: `/main-rollover ${text}` };
	});

	pi.registerCommand("main-rollover", {
		description: "Start a fresh session from Main's handoff note; the rest of the message is the owner's first message",
		handler: async (args: unknown, ctx: unknown) => {
			const c = asRolloverCtx(ctx);
			if (!c) return;
			const path = notePath(c.sessionId);
			const state = stateOf(c);
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
			c.notify("main-rollover: collecting main-start state for the handoff (this can take a minute)…");
			const generated = [await mainStartText([], cfg, { inheritStdin: false }), holdsBlock(q.ownerHolds())].join("\n");
			const handoff = buildHandoff({
				generated,
				note: readFileSync(path, "utf8"),
				previousSessionFile: c.sessionFile,
				ownerMessage: asString(args),
			});
			adapterLog(cfg, `rollover: new session from ${c.sessionFile}; note ${path}`);
			await c.waitForIdle();
			const r = asRecord(await c.newSession({ parentSession: c.sessionFile }));
			if (r.cancelled === true) return;
			pi.sendUserMessage(handoff);
		},
	});
}

/** package.json omp.extensions entry. */
export default function ompExtension(pi: ExtensionHost): void {
	createOmpAdapter(pi, loadConfig());
}
