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
import { basename, dirname, join } from "node:path";
import type { Decision } from "../../core/adapter.ts";
import { chatGo, chatTier, type Tier } from "../../core/autonomy.ts";
import { loadConfig, type Config } from "../../core/config.ts";
import { nowSec, strftime } from "../../core/clock.ts";
import { runDetectors, runDetectorsGated, type DetectorInput } from "../../core/incident-detectors.ts";
import { checkInject, checkPlanEdit, checkStop, checkTool, findingsValue, MAIN_PLAN_FILE, newProgressEntries, planReadNote, recordMainResult, revertMainEdit, rekeySpawnFile } from "../../core/guards.ts";
import { rateLimitWait } from "../../core/rate-limit.ts";
import { notifyProviders, postReply } from "../../core/notify.ts";
import { loadKnownSecrets, redactSecrets, redactSummary } from "../../core/secret-redact.ts";
import { inboxPath } from "../../core/owner-ui.ts";
import { realTailscale } from "../../core/tailscale.ts";
import { actionsRules, ownedRepoOf, suspiciousActions, unreportedFindings } from "../../core/trace-actions.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import { mainStartText, runDailyCheck } from "../../core/main-start.ts";
import { readBlocks } from "../../core/metrics.ts";
import { buildHandoff, holdsBlock, notePath, noteRequest, OWNER_AWAY, ownerText, relaunchPath, rolloverState, spawnRefusal, type RolloverState } from "../../core/rollover.ts";
import { defaultCompletedResults, defaultRunSource, runIdOf } from "./sessions.ts";
import { adapterLog } from "./launch.ts";
import { parseTraceFile } from "./traces.ts";
import { packageJsonPath, packageVersion } from "./package-root.ts";
import * as q from "../../core/queue/lib.ts";
import { annotateResetTimes } from "../../core/reset-time.ts";
// Registers the plugin-command matcher into core's writeTargets (side effect).
import "./package-ops.ts";

/** Subset of the harness extension host the adapter needs. */
export interface ExtensionHost {
	on(event: string, cb: (...args: unknown[]) => unknown): void;
	registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void;
	sendUserMessage(content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): void;
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

/** The last assistant message of an omp event's `messages` array, as the adapter needs it: its
 *  joined text-block text and the shape that tells a real hand-back from a mid-run continuation
 *  (plan 20261025_0130). omp sends the reply in `session_stop.last_assistant_message` (falling
 *  back to the last assistant entry of `messages`) and in `agent_end.messages`; reading the
 *  session file instead lags a whole turn because session_stop fires BEFORE agent_end. */
interface EventReply {
	text: string;
	stopReason: string | null;
	toolCalls: number;
	/** The provider's error text on a turn that ended on one (`429 … retry-after-ms=…`); null otherwise. */
	errorMessage: string | null;
}

function lastAssistantIn(messages: unknown): EventReply | null {
	const arr = Array.isArray(messages) ? messages : [];
	for (let i = arr.length - 1; i >= 0; i--) {
		const m = asRecord(arr[i]);
		if (m.role !== "assistant") continue;
		const content = Array.isArray(m.content) ? m.content : [];
		const text = content
			.filter(c => asRecord(c).type === "text")
			.map(c => asString(asRecord(c).text))
			.join("\n")
			.trim();
		return {
			text,
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			toolCalls: content.filter(c => asRecord(c).type === "toolCall").length,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
		};
	}
	return null;
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

export { adapterLog };

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

/**
 * D6 + D7 over a subagent's own trace, right after an allowed Progress edit (plan
 * 20261024_0301 P6): the sub's session file (its harness session manager hands it out) is
 * parsed as the run's trace, every high suspicious action folds as a D6 incident, and when the
 * new Progress bullet claims `Findings: none` the cross-product reads hidden behind that claim
 * fold as D7 (`unreported-finding`) with the agent-score penalty — the bullet is the claim
 * source the owner named, so it replaces the final-text check. The newest added bullet decides
 * (Progress runs newest-first). Best effort: a failure is logged, never thrown — a broken
 * detector must not break the verified edit.
 */
function subActionDetectors(cfg: Config, ctx: unknown, planFile: string, before: string, after: string): void {
	try {
		const entries = newProgressEntries(before, after);
		if (entries.length === 0) return;
		const sessionFile = call(asRecord(asRecord(ctx).sessionManager), "getSessionFile");
		if (typeof sessionFile !== "string" || sessionFile === "") return;
		const events = parseTraceFile(sessionFile, runIdOf(sessionFile));
		const rules = actionsRules(cfg);
		const input: DetectorInput = { actions: suspiciousActions(events, rules) };
		if (/^none\.?$/i.test(findingsValue(entries[0]!) ?? "")) {
			// The plan's repo spelled like its owned_repos entry: a checkout named "pm-mr196" is "pm",
			// so the run's reads of its own repo never count as another product's.
			const repoDir = q.planRepo(planFile);
			input.unreported = unreportedFindings(events, rules, {
				repo: ownedRepoOf(`${repoDir}/`, rules.owned_repos) ?? basename(repoDir),
				plan: planFile,
				claimedNone: true,
			});
		}
		runDetectors(cfg, input);
	} catch (err) {
		adapterLog(cfg, `sub action detectors failed: ${err instanceof Error ? err.message : String(err)}`);
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

// Secrets never reach the model, the chat or the session log (plan 20261025_2204): every tool
// result of every agent — Main and subs both fire tool_result — is redacted here before the rest of
// the handler, the model, the chat and the session file see it. The rewritten content goes back
// with one line naming what was hidden; a clean result keeps its original shape and returns nothing.
function redactToolResult(content: unknown[], cfg: Config): { content: unknown[]; note: string } {
	if (!cfg.secrets.redact || content.length === 0) return { content, note: "" };
	const known = loadKnownSecrets(cfg);
	const hits = new Map<string, number>();
	let changed = false;
	const out = content.map(part => {
		const p = asRecord(part);
		if (p.type !== "text" || typeof p.text !== "string" || p.text === "") return part;
		const r = redactSecrets(p.text, known, cfg.secrets.extra_patterns);
		if (r.hits.length === 0) return part;
		changed = true;
		for (const hit of r.hits) hits.set(hit.type, (hits.get(hit.type) ?? 0) + hit.count);
		return { ...p, text: r.text };
	});
	if (!changed) return { content, note: "" };
	return { content: out, note: redactSummary([...hits].map(([type, count]) => ({ type, count }))) };
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

// ---- owner inbox delivery (plan 20261024_2230 P3b) ----
// The phone page appends answers to <queue_state>/owner-inbox.jsonl — a protected state file, so
// no agent can forge an owner answer (guards refuse the write). Main's session delivers each
// record once as a user message (pi.sendUserMessage, no options: idle → a new turn, streaming →
// the steer queue), at turn end and on a 15 s timer while idle. The consumed-row count lives in
// <queue_state>/owner-inbox.cursor; subagent sessions never deliver and never move it.

/** Idle-poll interval for the owner inbox. */
export const OWNER_INBOX_POLL_MS = 15_000;

/** The delivered cursor: how many owner-inbox rows Main's session has consumed. */
export function ownerInboxCursorPath(): string {
	return `${q.stateDirPath()}/owner-inbox.cursor`;
}

function readOwnerInboxCursor(): number {
	try {
		const n = Number(readFileSync(ownerInboxCursorPath(), "utf8").trim());
		return Number.isInteger(n) && n >= 0 ? n : 0;
	} catch {
		return 0;
	}
}

function writeOwnerInboxCursor(n: number): void {
	try {
		mkdirSync(q.stateDirPath(), { recursive: true });
		writeFileSync(ownerInboxCursorPath(), `${n}\n`);
	} catch {}
}

/** The user message one inbox record becomes, or null when the record is not one Main can act on.
 * Records without `kind` are page answers (the original shape). */
export function ownerInboxMessage(rec: Record<string, unknown>): string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] | null {
	const kind = rec.kind === undefined ? "answer" : asString(rec.kind);
	const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
	switch (kind) {
		case "answer": {
			const plan = asString(rec.plan);
			const question = asString(rec.question);
			const answer = asString(rec.answer);
			if (!plan || !question || !answer) return null;
			return `Owner answered on the phone page — ${basename(plan)}: ${question} → ${answer}`;
		}
		case "unlock": {
			const minutes = num(rec.minutes);
			const until = num(rec.until);
			if (minutes === null || until === null) return null;
			return `Owner unlocked the guards from the phone page for ${minutes} min (until ${strftime(until, "%H:%M")}). Do the step that waited on the unlock now.`;
		}
		case "lock":
			return "Owner locked the guards from the phone page.";
		case "reorder": {
			const plan = asString(rec.plan);
			const from = num(rec.from);
			const to = num(rec.to);
			if (!plan || from === null || to === null) return null;
			return `Owner moved ${basename(plan)} from #${from} to #${to} on the phone page; INDEX.md has the new order — work by it.`;
		}
		case "message": {
			const ts = num(rec.ts);
			const id = asString(rec.id);
			if (ts === null || !/^[0-9]+-[0-9a-f]{6}$/.test(id)) return null;
			const at = strftime(ts, "%H:%M");
			const dir = join(q.stateDirPath(), "owner-messages", id);
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(readFileSync(join(dir, "message.json"), "utf8")) as Record<string, unknown>;
			} catch {
				return [{ type: "text", text: `Owner sent a message from the phone page at ${at}; it expired (12 h) before delivery.` }];
			}
			const text = asString(message.text);
			const names = Array.isArray(message.images) ? message.images.filter((name): name is string => typeof name === "string" && /^[1-4]\.(png|jpg|gif|webp)$/.test(name)) : [];
			const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
			const paths = names.map(name => join(dir, name));
			parts.push({
				type: "text",
				text: `Owner message from the phone page (${at}): ${text}${paths.length ? `\nImages:\n${paths.map(path => `- ${path}`).join("\n")}` : ""}`,
			});
			for (const name of names) {
				const ext = name.slice(name.lastIndexOf(".") + 1);
				const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
				try {
					parts.push({ type: "image", data: readFileSync(join(dir, name)).toString("base64"), mimeType });
				} catch {
					return [{ type: "text", text: `Owner sent a message from the phone page at ${at}; it expired (12 h) before delivery.` }];
				}
			}
			return parts;
		}
		default:
			return null;
	}
}

/** The JSONL rows after `cursor` (a row count), as records, plus the new cursor. A torn last row
 * (a page write that has not landed completely) stays unconsumed; a malformed complete row is
 * consumed but skipped, so one bad line cannot wedge delivery. */
export function pendingInboxRecords(text: string, cursor: number): { records: Record<string, unknown>[]; next: number } {
	const endsClean = text === "" || text.endsWith("\n");
	const rows = text.split("\n");
	if (rows.length && rows[rows.length - 1] === "") rows.pop();
	const records: Record<string, unknown>[] = [];
	let next = Math.min(cursor, rows.length);
	for (let i = cursor; i < rows.length; i++) {
		const torn = i === rows.length - 1 && !endsClean;
		try {
			const rec: unknown = JSON.parse((rows[i] ?? "").trim());
			if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) records.push(rec as Record<string, unknown>);
		} catch {}
		if (!torn) next = i + 1;
	}
	return { records, next };
}

/** Deliver every inbox row past the cursor once, as a user message to Main; then store the cursor.
 * Synchronous, so the turn-end path and the idle timer cannot interleave. */
export function deliverOwnerInbox(pi: ExtensionHost, cfg: Config): void {
	let text: string;
	try {
		text = readFileSync(inboxPath(), "utf8");
	} catch {
		return; // no inbox yet: nothing to deliver
	}
	const cursor = readOwnerInboxCursor();
	const { records, next } = pendingInboxRecords(text, cursor);
	if (next === cursor) return;
	let delivered = 0;
	for (const rec of records) {
		const msg = ownerInboxMessage(rec);
		if (msg === null) continue;
		pi.sendUserMessage(msg);
		delivered++;
	}
	writeOwnerInboxCursor(next);
	adapterLog(cfg, `owner inbox: delivered ${delivered} answer(s) (cursor ${cursor} → ${next})`);
}

/** Register the guard handlers on one extension host. `cfg` is injectable for tests. */
export function createOmpAdapter(pi: ExtensionHost, cfg: Config): void {
	// The queue library resolves its paths from env snapshots; point them at this config first.
	applyQueueEnv(cfg);

	let callsSinceStop = 0;
	let idleStops = 0;
	let timer: unknown;
	let inboxTimer: unknown;
	const calls = new Map<string, number>(); // subagent call budget, by agent id
	const pending = new Map<string, Map<string, string>>(); // toolCallId -> plan snapshots
	// Chat notify (plans 20261024_2155, 20261025_0130): the text a hand-back already posted
	// (attempted) — one post per distinct text, never a retry loop. The reply itself comes from
	// the stop/agent_end event, never the session file (session_stop fires BEFORE agent_end, and
	// omp skips it entirely while an async job is pending, so a file read lags a whole turn).
	let postedReply: string | null = null;
	// Set by every session_stop path that returns block; the willContinue agent_end that omp then
	// emits (sessionStopWillContinue) consumes it and posts nothing — a blocked stop's reply is a
	// mid-work report, never a hand-back.
	let stopBlocked = false;
	// Rate-limit wait-it-out (plan 20261025_0640): consecutive turn ends on a provider rate limit
	// form one episode. Named provider retry-after values remain authoritative; otherwise the
	// attempt doubles the default wait. The owner chat is told once per episode, and ONE timer
	// gives Main a new turn when the wait is over; a new Main turn before expiry takes over and
	// cancels it. Inputs that do not start a turn leave it armed. Any turn that ends without a
	// limit resets the episode and disarms it.
	let rateAttempt = 0;
	let rateTimer: NodeJS.Timeout | null = null;
	const rateClock = (ms: number): string => strftime(ms / 1000, "%H:%M");
	const clearRateTimer = (): void => {
		if (rateTimer !== null) {
			clearTimeout(rateTimer);
			rateTimer = null;
		}
	};
	const disarmRateEpisode = (): void => {
		clearRateTimer();
		rateAttempt = 0;
	};
	// The one resume: replacing any armed timer, exactly one new user message when the wait is over.
	const armRateResume = (untilMs: number): void => {
		clearRateTimer();
		rateTimer = setTimeout(() => {
			rateTimer = null;
			pi.sendUserMessage(`main-guard: the provider rate limit is over (waited until ${rateClock(untilMs)}). Continue the queue where you stopped.`);
			adapterLog(cfg, `RATE-LIMIT resume: new turn sent (waited until ${rateClock(untilMs)})`);
		}, untilMs - Date.now());
	};
	// A turn that ended on a rate limit: log, tell the owner once per episode, arm the resume.
	const onRateLimitedStop = (untilMs: number, waitMs: number): void => {
		rateAttempt++;
		const at = rateClock(untilMs);
		adapterLog(cfg, `RATE-LIMIT stop: resume at ${at} (${Math.round(waitMs / 1000)}s, attempt ${rateAttempt})`);
		if (rateAttempt === 1) {
			adapterLog(cfg, "notify: posted (rate-limit)");
			void postReply(`⏳ Main is rate limited by its provider until ${at} (local); it resumes on its own.`, cfg).then(results => {
				for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
			});
		}
		armRateResume(untilMs);
	};
	// The rate-limit decision for one turn end, from the event's own last assistant message.
	const rateLimitOf = (reply: EventReply | null): { untilMs: number; waitMs: number } | null =>
		rateLimitWait(reply?.stopReason ?? null, reply?.errorMessage ?? null, Date.now(), cfg.guards.rate_limit, rateAttempt + 1);
	// One guard-log line per notify decision: `notify: posted|skipped (<why>)`. Fire-and-forget:
	// the decision never awaits the post; a failed or slow post logs one line and never blocks
	// or retries.
	const notifyHandback = (reply: EventReply | null, why: string): void => {
		if (!reply || !reply.text) {
			adapterLog(cfg, `notify: skipped (no reply text, ${why})`);
			return;
		}
		if (reply.text === postedReply) {
			adapterLog(cfg, `notify: skipped (duplicate, ${why})`);
			return;
		}
		postedReply = reply.text;
		adapterLog(cfg, `notify: posted (${why})`);
		void postReply(reply.text, cfg).then(results => {
			for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
		});
	};

	// "Needs you" pings (P3b): the owner learns on Discord that a decision or an unlock is his —
	// deterministic, no model call, Main session only, the same webhook path, fire-and-forget, one
	// guard-log line per decision (`notify: needs-you posted|skipped (<why>)`).
	const needsYouPost = (text: string, why: string): void => {
		if (notifyProviders(cfg).length === 0) {
			adapterLog(cfg, `notify: needs-you skipped (notify off, ${why})`);
			return;
		}
		adapterLog(cfg, `notify: needs-you posted (${why})`);
		void postReply(text, cfg).then(results => {
			for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
		});
	};
	// The phone-page link only when the page is on and this machine's MagicDNS name is known;
	// computed at most once per process (tailscale status is a subprocess call).
	let phonePageSuffix: string | null = null;
	const phonePage = (): string => {
		if (!cfg.ui.enabled) return "";
		if (phonePageSuffix === null) {
			const dns = realTailscale.dnsName();
			phonePageSuffix = dns ? ` Answer on the phone page: http://${dns}:${cfg.ui.port}` : "";
		}
		return phonePageSuffix;
	};
	// WAITING: every Main turn end asks whether an open plan now waits on the owner (the same
	// source the owner page lists). Keys are `plan file|waiting line`, remembered in
	// <queue_state>/notify-waiting.json; a key whose line is gone is dropped, so the same question
	// asked again later posts again. No waiting plans: no decision, no log line.
	const waitingKeysFile = join(cfg.paths.queue_state, "notify-waiting.json");
	const notifyWaitingPlans = (): void => {
		const waiting = q.activePlans(cfg.paths.queue_index).filter(p => p.waiting && p.status === "open" && p.waitingLine);
		let stored: string[] = [];
		try {
			const parsed: unknown = JSON.parse(readFileSync(waitingKeysFile, "utf8"));
			if (Array.isArray(parsed)) stored = parsed.filter((k): k is string => typeof k === "string");
		} catch {}
		// Persist after reading: a key whose WAITING line is gone is dropped, so the same question
		// asked again later posts again. No waiting plans: the set prunes to empty, no decision,
		// no line.
		const current: string[] = [];
		const fresh: typeof waiting = [];
		for (const p of waiting) {
			const key = `${p.file}|${p.waitingLine}`;
			current.push(key);
			if (!stored.includes(key)) fresh.push(p);
		}
		try {
			mkdirSync(cfg.paths.queue_state, { recursive: true });
			writeFileSync(waitingKeysFile, JSON.stringify(current));
		} catch {}
		if (current.length === 0) return;
		if (fresh.length === 0) {
			adapterLog(cfg, "notify: needs-you skipped (no new waiting lines)");
			return;
		}
		const lines = fresh.map(p => {
			const title = p.text.match(/^# (.+)$/m)?.[1] ?? basename(p.file);
			return `- ${title}: ${p.waitingLine}`;
		});
		needsYouPost(`🔔 Needs you (${fresh.length}):\n${lines.join("\n")}${phonePage()}`, `waiting: ${fresh.length} plans`);
	};
	// UNLOCK: a protected-file refusal of a Main tool call means Main sits blocked until the owner
	// unlocks — ping, at most once per 30 min.
	let unlockPingMs = -Infinity;
	const notifyUnlockNeeded = (reason: string): void => {
		if (Date.now() - unlockPingMs < 30 * 60_000) {
			adapterLog(cfg, "notify: needs-you skipped (unlock ping sent recently)");
			return;
		}
		unlockPingMs = Date.now();
		const target = basename(asString(reason.match(/plan-guard: (.+) is a protected guard file/)?.[1] ?? "guard file"));
		needsYouPost(
			`🔓 Main needs an unlock to continue (${target}). Tap "unlock ${cfg.guards.unlock_minutes}" on the phone page.`,
			"protected-file refusal",
		);
	};

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
		// The owner-inbox poll (P3b): Main's session only — this handler returned for every other.
		const it: unknown = c.setInterval
			? c.setInterval(() => deliverOwnerInbox(pi, cfg), OWNER_INBOX_POLL_MS)
			: setInterval(() => deliverOwnerInbox(pi, cfg), OWNER_INBOX_POLL_MS);
		if (it && typeof it === "object" && "unref" in it && typeof it.unref === "function") it.unref();
		inboxTimer = it;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (asCtx(ctx).kind !== "main") return;
		if (rateTimer !== null) {
			clearRateTimer();
			adapterLog(cfg, "RATE-LIMIT resume cancelled: owner message");
		}
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
		// running ones finish first. Subagents' own tool calls are unaffected. Main's task calls
		// also carry the running job labels for the priority gate (20261025_0215 P2).
		let runningJobs: string[] | undefined;
		if (!isSub && tool === "task") {
			const rc = asRolloverCtx(ctx);
			runningJobs = rc?.runningJobs();
			if (cfg.rollover.enabled && rc) {
				const why = spawnRefusal(rolloverSnapshot(rc).state, runningJobs ?? []);
				if (why) {
					const tasks = Array.isArray(input.tasks) ? input.tasks : [];
					adapterLog(cfg, `BLOCK spawn ${String(asRecord(tasks[0]).agent ?? "task")}: rollover pending`);
					return { block: true, reason: why };
				}
			}
		}
		const d = checkTool(
			{ tool, input, cwd, agent, agentId: id, calls: n - 1, paths: [], writes: [], command: asString(input.command), runningJobs },
			cfg,
		);
		if (!d.allow) {
			// P3b: Main refused on a protected guard file sits blocked until the owner unlocks.
			if (!isSub && d.reason.includes("is a protected guard file. Only the owner changes it")) notifyUnlockNeeded(d.reason);
			return { block: true, reason: d.reason };
		}
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
		// Redact first: everything below (plan checks, detectors, the returned content, the model,
		// the chat and the session log) then works on text that holds markers, never values.
		const redacted = redactToolResult(Array.isArray(e.content) ? e.content : [], cfg);
		const content = redacted.content;
		const notes: string[] = redacted.note ? [redacted.note] : [];
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
					revertMainEdit(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), cfg);
					return { isError: true, content: [{ type: "text", text: d.reason }] };
				}
				// Plan-guard auto-listing (I-20261025-208): the allowed edit's file is amended to name
				// the cited files Main did read; the note tells Main what moved into the list.
				if (d.allow && d.rewrite) {
					try {
						writeFileSync(d.rewrite.path, d.rewrite.text);
					} catch {}
					if (d.note) notes.push(d.note);
				}
				if (d.allow && (!c.hasAgent || c.kind === "main") && q.doneCount(after) > q.doneCount(before) && q.planAt(file, q.activePlans())) {
					const note = trimProgress(file);
					if (note) notes.push(note);
				}
				// Live D6+D7 over the sub's own session as soon as it reports into the plan (P6).
				if (d.allow && c.kind === "sub") subActionDetectors(cfg, ctx, file, before, after);
			}
		}
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash" && !e.isError) {
			if (PUSH_MERGE.test(asString(asRecord(e.input).command))) autoClose(cfg);
		}
		if ((!c.hasAgent || c.kind === "main") && !e.isError) {
			const text = content.map(p => asString(asRecord(p).text)).join("\n");
			recordMainResult(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), text);
			// After the reads are recorded: a fresh hit clears its own warning, a stale list warns
			// before Main drafts an edit the plan-read guard would refuse (I-20261025-208 P3).
			const readNote = planReadNote(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), text, cfg);
			if (readNote) notes.push(readNote);
		}
		if ((!c.hasAgent || c.kind === "main") && e.isError) {
			revertMainEdit(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), cfg);
		}
		// Real-time detectors after each Main bash result, crashes included (D2 wants the stack).
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash") {
			mainDetectors(cfg, {
				bash: { command: asString(asRecord(e.input).command), output: content.map(p => asString(asRecord(p).text)).join("\n") },
			});
		}
		if (notes.length) return { content: [...content, ...notes.map(text => ({ type: "text", text }))] };
		return undefined;
	});

	pi.on("session_stop", (e, ctx) => {
		const c = asCtx(ctx);
		if (c.hasAgent && c.kind !== "main") return;
		// A relaunch is requested: omp shuts down at the next idle, so the stop must not be continued.
		if (relaunched) {
			adapterLog(cfg, "notify: skipped (relaunch requested)");
			return undefined;
		}
		// The stop hands the turn back to the owner: post the stop event's own final reply, once
		// per distinct text. The reply comes from the event (last_assistant_message, falling back
		// to the last assistant entry of messages), never the session file: omp fires session_stop
		// BEFORE agent_end, so a file read would lag a whole turn.
		const stopMsg = asRecord(e).last_assistant_message;
		const reply = stopMsg ? lastAssistantIn([stopMsg]) : lastAssistantIn(asRecord(e).messages);
		// A turn that ended on a provider rate limit waits it out (plan 20261025_0640): ALLOW before
		// the rollover and queue decisions — any block here would re-ask straight into the limit —
		// and without touching the idle-stop counters: checkStop is not consulted.
		const rl = rateLimitOf(reply);
		if (rl) {
			onRateLimitedStop(rl.untilMs, rl.waitMs);
			return undefined;
		}
		// Any turn that ends without a rate limit ends the episode and disarms its resume timer.
		disarmRateEpisode();
		// A pending rollover decides the stop and checkStop is not consulted: its queue, incident and cancel
		// blocks would hold Main at a wait the new session raises again through main-start, and its "spawn an
		// agent" text is refused while the rollover is pending.
		const rc = cfg.rollover.enabled ? asRolloverCtx(ctx) : null;
		if (rc) {
			const snap = rolloverSnapshot(rc);
			if (snap.state === "need-note") {
				adapterLog(cfg, "BLOCK stop: rollover need-note");
				notifyHandback(reply, "blocked session_stop");
				stopBlocked = true;
				return { decision: "block", reason: noteRequestFor(rc, snap) };
			}
			if (snap.state === "ready" || snap.state === "wait-jobs") {
				adapterLog(cfg, `ALLOW stop: rollover ${snap.state}`);
				// Under the launcher a ready rollover starts now (not a hand-back to the owner);
				// plain omp waits for the owner's next message.
				const handsToOwner = !(snap.state === "ready" && process.env.NEURASTREAM_MAIN_LAUNCHER === "1" && requestRelaunch(rc, notePath(rc.sessionId)));
				if (handsToOwner) notifyHandback(reply, "allowed session_stop");
				else adapterLog(cfg, "notify: skipped (relaunch requested)");
				return undefined;
			}
		}
		const d = checkStop({ agent: "main", callsSinceStop, idleStops, ledgerText: ledgerText(cfg) }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? 0;
		idleStops = d.state?.idleStops ?? idleStops;
		if (d.allow) {
			notifyHandback(reply, "allowed session_stop");
			return undefined;
		}
		notifyHandback(reply, "blocked session_stop");
		stopBlocked = true;
		return { decision: "block", reason: d.reason };
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
	// Hand-back without a session_stop (plan 20261025_0130): while an async job is pending omp
	// fires agent_end with willContinue:true and SKIPS session_stop — this deferred hand-back
	// posts from the event's own messages. omp also sets willContinue after a BLOCKED stop
	// (sessionStopWillContinue) and for todo/plan-mode/rewind continuations, so a post here needs
	// both: no blocked stop just decided (the flag), and an async job really pending. A terminal
	// end (willContinue unset) is not a hand-back: the session_stop that follows it decides. A
	// mid-run continuation — tool calls, or a non-"stop" reason such as an auto-retry — posts
	// nothing.
	pi.on("agent_end", (e, ctx) => {
		if (!isMain(ctx)) return;
		if (asRecord(e).willContinue !== true) return;
		if (stopBlocked) {
			stopBlocked = false;
			adapterLog(cfg, "notify: skipped (stop blocked, agent_end)");
			return;
		}
		const reply = lastAssistantIn(asRecord(e).messages);
		// The same rate-limit check as session_stop (plan 20261025_0640): a rate-limited deferred
		// hand-back arms the resume timer instead of logging "no reply text" — its reply carries an
		// error, no text. A mid-run continuation (tool calls, auto-retry) is not a turn end: the
		// episode state stays as it is.
		const rl = rateLimitOf(reply);
		if (rl) {
			onRateLimitedStop(rl.untilMs, rl.waitMs);
			return;
		}
		const jobCount = asRolloverCtx(ctx)?.runningJobs().length ?? 0;
		if (jobCount === 0) {
			adapterLog(cfg, "notify: skipped (no pending job, agent_end)");
			return;
		}
		if (!reply || !reply.text) {
			// A turn that ended on some other no-text outcome is a turn end without a rate limit.
			disarmRateEpisode();
			adapterLog(cfg, "notify: skipped (no reply text, agent_end hand-back)");
			return;
		}
		if (reply.stopReason !== "stop" || reply.toolCalls > 0) {
			adapterLog(
				cfg,
				`notify: skipped (mid-run: stop reason ${reply.stopReason ?? "unknown"}${reply.toolCalls > 0 ? ` + ${reply.toolCalls} tool call(s)` : ""}, agent_end hand-back)`,
			);
			return;
		}
		// A real hand-back: the turn ended without a rate limit — the episode is over.
		disarmRateEpisode();
		notifyHandback(reply, "agent_end hand-back");
	});
	// Turn end: page answers that arrived during the turn go out (P3b), then open plans that now
	// WAIT on the owner ping Discord (P3b). Main only.
	pi.on("agent_end", (_e, ctx) => {
		if (!isMain(ctx)) return;
		deliverOwnerInbox(pi, cfg);
		notifyWaitingPlans();
	});

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

	// Chat unlock + autonomy tiers (guards.chat_unlock): the owner's whole message "unlock"/
	// "unlock N"/"lock" moves the guard unlock file, "tier <name>" sets the autonomy tier and the
	// approve phrase (autonomy.go_phrase, default "go push") approves one strict landing
	// (src/core/queue/lib.ts chatUnlock, src/core/autonomy.ts
	// chatTier/chatGo). Only prompts the owner really typed
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
	// The tier switch and the one-shot `go` travel the same two owner paths and answer the same way.
	const notifyTier = (ctx: unknown, r: { tier?: Tier }): void => {
		const c = asRolloverCtx(ctx);
		if (!c || r.tier === undefined) return;
		c.notify(`tier now ${r.tier}`);
	};
	const notifyGo = (ctx: unknown, r: { minutes?: number }): void => {
		const c = asRolloverCtx(ctx);
		if (!c || r.minutes === undefined) return;
		c.notify(`${cfg.autonomy.go_phrase}: one push/merge approved for ${r.minutes} min`);
	};
	pi.on("input", (event, ctx) => {
		if (!cfg.guards.chat_unlock || !isMain(ctx)) return undefined;
		const e = asRecord(event);
		if (asString(e.source) !== "interactive") return undefined;
		const text = asString(e.text);
		const t = chatTier(text, cfg, "interactive");
		if (t.applied) {
			notifyTier(ctx, t);
			return { handled: true };
		}
		const g = chatGo(text, cfg, "interactive");
		if (g.applied) {
			notifyGo(ctx, g);
			return { handled: true };
		}
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
		if (!isMain(ctx)) return undefined;
		const messages = asRecord(event).messages;
		if (!Array.isArray(messages)) return undefined;
		if (cfg.guards.chat_unlock) {
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
				if (r.applied) {
					notifyUnlock(ctx, r);
					continue;
				}
				const t = chatTier(text, cfg, `collab:${from}`);
				if (t.applied) {
					notifyTier(ctx, t);
					continue;
				}
				const g = chatGo(text, cfg, `collab:${from}`);
				if (g.applied) notifyGo(ctx, g);
			}
		}
		const rule = { pattern: cfg.quota.reset_pattern, zone: cfg.quota.reset_tz };
		let changed = false;
		const mapped = messages.map(raw => {
			const message = asRecord(raw);
			if (typeof message.content === "string") {
				const content = annotateResetTimes(message.content, rule);
				if (content === message.content) return raw;
				changed = true;
				return { ...message, content };
			}
			if (!Array.isArray(message.content)) return raw;
			let contentChanged = false;
			const content = message.content.map(part => {
				const block = asRecord(part);
				if (typeof block.text !== "string") return part;
				const text = annotateResetTimes(block.text, rule);
				if (text === block.text) return part;
				contentChanged = true;
				return { ...block, text };
			});
			if (!contentChanged) return raw;
			changed = true;
			return { ...message, content };
		});
		return changed ? { messages: mapped } : undefined;
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
