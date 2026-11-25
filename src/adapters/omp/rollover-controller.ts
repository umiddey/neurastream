// Session rollover state machine (src/core/rollover.ts): size/version snapshot, note requests,
// relaunch requests, exit-grace fallback timer, and in-process rollover.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../../core/config.ts";
import { mainStateDir } from "../../core/guards.ts";
import { readOwnerAnswers, readOwnerMessages } from "../../core/incidents.ts";
import { mainStartText } from "../../core/main-start.ts";
import * as q from "../../core/queue/lib.ts";
import { buildHandoff, holdsBlock, notePath, noteRequest, OWNER_AWAY, relaunchPath, rolloverState, unansweredOwnerMessages, type RolloverState } from "../../core/rollover.ts";
import { adapterLog, runCliDoctor } from "./launch.ts";
import { packageJsonPath, packageVersion } from "./package-root.ts";
import { ompProviders } from "./providers.ts";
import { defaultCompletedResults, defaultRunSource } from "./sessions.ts";
import { asRecord, asRolloverCtx, asString, isMain, type ExtensionHost, type RolloverCtx } from "./types.ts";

const WAIT_NOTICE_MS = 15 * 60_000;

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

export interface RolloverSnapshot {
	state: RolloverState;
	noteMtimeMs: number | null;
	stale: boolean;
	liveVersion: string | null;
}

export interface RolloverController {
	isRelaunched(): boolean;
	snapshot(c: RolloverCtx): RolloverSnapshot;
	noteRequestFor(c: RolloverCtx, snap: { stale: boolean; liveVersion: string | null }): string;
	requestRelaunch(c: RolloverCtx, note: string, draft?: string): boolean;
	onSizeCheck(kind: "tool_result" | "agent_end", e: unknown, ctx: unknown): void;
	notice(ctx: unknown): string | null;
	clearGrace(): void;
	clearState(): void;
	handleInput(event: unknown, ctx: unknown): { handled: true } | undefined;
	registerCommand(): void;
}

export interface RolloverControllerOptions {
	/** Optional doctor output supplier for `mainStartText` during in-process rollover fallback (default: `runCliDoctor`). */
	doctor?: () => Promise<string> | string;
}

/**
 * Creates the per-adapter session rollover controller handling session size/version checks,
 * handoff note requests, launcher relaunch requests, and exit-grace in-process fallback.
 *
 * Args:
 *     pi (ExtensionHost): Active extension host
 *     getCfg (() => Config): Accessor returning the adapter's current config
 *     opts (RolloverControllerOptions): Optional seams (such as `doctor` for tests)
 *
 * Returns:
 *     RolloverController: Controller bound to this adapter instance
 */
export function createRolloverController(pi: ExtensionHost, getCfg: () => Config, opts: RolloverControllerOptions = {}): RolloverController {
	const doctor = opts.doctor ?? runCliDoctor;
	// The version this process loaded at start: the plugin code that is actually running.
	const loadedVersion = packageVersion(packageJsonPath());
	let crossed: { file: string; atMs: number } | null = null;
	// The note request already sent, keyed by session file + note mtime at send time ("none" when
	// no note exists): a note that expires while jobs run falls back to need-note with a key no
	// request was sent for, so it gets exactly one new request and never a loop.
	let asked: string | null = null;
	let waitNoticeMs = 0;

	const snapshot = (c: RolloverCtx): RolloverSnapshot => {
		const cfg = getCfg();
		const nowMs = Date.now();
		const bytes = sizeOf(c.sessionFile);
		const maxMb = cfg.rollover.max_session_mb;
		const noteMtimeMs = mtimeOf(notePath(c.sessionId, mainStateDir(cfg)));
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
		const cfg = getCfg();
		const reason = snap.stale ? `neurastream on disk is ${snap.liveVersion ?? "unknown"}, this session runs ${loadedVersion ?? "unknown"}` : undefined;
		return noteRequest(notePath(c.sessionId, mainStateDir(cfg)), reason);
	};

	let relaunched = false;
	// omp 18.11.1 defers an extension shutdown: it re-checks only when shutdown() is called again or
	// an owner submission finishes, so a refused exit once left a dead UI that swallowed every owner
	// message (I-20261024-4). One unref'd timer per request: if omp still has not exited
	// rollover.exit_grace_s after the request, the adapter rolls over in-process. The timer keeps its
	// own clearer: session_shutdown cancels the fallback when omp really exits.
	let clearGraceFn: (() => void) | null = null;
	// One in-process rollover at a time: while it waits for idle, the size check must not start
	// a relaunch over it.
	let flight: string[] | null = null;

	// The one in-process rollover, the exit-grace fallback: gather the generated state, wait for
	// idle, then start a fresh session whose first message is the handoff. A state change during
	// the wait sends the owner's text to this session as an ordinary message.
	const rolloverInProcess = async (c: RolloverCtx, owner: string[], noticeText: string): Promise<void> => {
		const cfg = getCfg();
		const previous = c.sessionFile;
		const path = notePath(c.sessionId, mainStateDir(cfg));
		flight = owner;
		try {
			c.notify(noticeText);
			const generated = [
				await mainStartText([], cfg, { inheritStdin: false }, { source: defaultRunSource(cfg), results: defaultCompletedResults(cfg), providers: ompProviders(cfg), doctor }),
				holdsBlock(q.ownerHolds(cfg.paths)),
			].join("\n");
			const note = readFileSync(path, "utf8");
			adapterLog(cfg, `rollover: new session from ${previous}; note ${path}`);
			await c.waitForIdle();
			const again = snapshot(c).state;
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
				unanswered: unansweredOwnerMessages(readOwnerMessages(cfg.paths), readOwnerAnswers(cfg.paths)),
			});
			pi.sendUserMessage(handoff);
		} finally {
			flight = null;
		}
	};

	// The grace elapsed without a session_shutdown: omp refused the exit. Read the request's draft,
	// drop the request and roll over here, so the owner's messages reach a live session instead of a
	// dead UI. The owner-away text stands in when nothing was typed.
	const exitGraceElapsed = (c: RolloverCtx): void => {
		const cfg = getCfg();
		adapterLog(cfg, `rollover: omp did not exit within ${cfg.rollover.exit_grace_s}s; rolling over in-process`);
		const reqFile = relaunchPath(mainStateDir(cfg));
		let draft = "";
		try {
			draft = asString(asRecord(JSON.parse(readFileSync(reqFile, "utf8"))).draft);
		} catch {}
		rmSync(reqFile, { force: true });
		relaunched = false;
		rolloverInProcess(c, [draft.trim() === "" ? OWNER_AWAY : draft], "rollover: omp did not restart; continuing in a new session here").catch((err: unknown) => {
			adapterLog(cfg, `rollover: in-process rollover failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};

	const armGraceTimer = (c: RolloverCtx): void => {
		const cfg = getCfg();
		clearGraceFn?.();
		const t = setTimeout(() => {
			clearGraceFn = null;
			exitGraceElapsed(c);
		}, cfg.rollover.exit_grace_s * 1000);
		if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
		clearGraceFn = () => {
			clearTimeout(t);
			clearGraceFn = null;
		};
	};

	// The launcher restarts omp: the request file carries the note and the editor draft, and omp
	// shuts down only after the file is written. A failed write keeps the session running.
	// Returns whether the request was written.
	const requestRelaunch = (c: RolloverCtx, note: string, draft = c.draft()): boolean => {
		const cfg = getCfg();
		const reqFile = relaunchPath(mainStateDir(cfg));
		try {
			mkdirSync(dirname(reqFile), { recursive: true });
			writeFileSync(reqFile, `${JSON.stringify({ previousSessionFile: c.sessionFile, notePath: note, draft })}\n`);
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
		const cfg = getCfg();
		const reqFile = relaunchPath(mainStateDir(cfg));
		try {
			const req = asRecord(JSON.parse(readFileSync(reqFile, "utf8")));
			const draft = [asString(req.draft), text].filter(s => s !== "").join("\n");
			const tmp = `${reqFile}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ ...req, draft })}\n`);
			renameSync(tmp, reqFile);
			return true;
		} catch (err) {
			adapterLog(cfg, `rollover: owner message not added to the relaunch request: ${String(err)}`);
			return false;
		}
	};

	const onSizeCheck = (kind: "tool_result" | "agent_end", e: unknown, ctx: unknown): void => {
		const cfg = getCfg();
		const c = asRolloverCtx(ctx);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return;
		const snap = snapshot(c);
		const key = `${c.sessionFile}:${snap.noteMtimeMs ?? "none"}`;
		// A terminal run end: omp 18.11.1 sets willContinue on a non-terminal agent_end.
		const terminal = kind === "agent_end" && asRecord(e).willContinue !== true;
		if (snap.state === "need-note" && asked !== key) {
			asked = key;
			pi.sendMessage(
				{ customType: "main-guard.rollover", content: noteRequestFor(c, snap), display: false },
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} else if (terminal && snap.state === "ready" && !relaunched && flight === null) {
			// flight !== null: an in-process rollover (the fallback) owns this session's end.
			requestRelaunch(c, notePath(c.sessionId, mainStateDir(cfg)));
		} else if (terminal && relaunched) {
			// A tool result mid-run never restarts the session (I-20261024-4), and omp's interactive
			// mode re-runs its deferred exit check only when shutdown() is called again: re-arm at
			// every later terminal run end instead of waiting for an owner message.
			c.shutdown();
		}
	};

	/** Wait-jobs notice for Main's next turn, throttled; null otherwise. The note request goes out at turn end. */
	const notice = (ctx: unknown): string | null => {
		const cfg = getCfg();
		const c = asRolloverCtx(ctx);
		if (!cfg.rollover.enabled || !c) return null;
		const state = snapshot(c).state;
		if (state === "wait-jobs" && Date.now() - waitNoticeMs >= WAIT_NOTICE_MS) {
			waitNoticeMs = Date.now();
			const jobs = c.runningJobs().join(", ");
			return `Session rollover: the handoff note is ready, but own jobs are still running (${jobs}). A rollover would cancel them, so the owner's messages stay in this session until they finish.`;
		}
		return null;
	};

	// The relaunch is the only rollover path: a plain interactive message in the ready state
	// requests it, and every such message joins the pending request's draft, in order.
	const handleInput = (event: unknown, ctx: unknown): { handled: true } | undefined => {
		const cfg = getCfg();
		const e = asRecord(event);
		const c = asRolloverCtx(ctx);
		const text = asString(e.text);
		if (!cfg.rollover.enabled || !c || !isMain(ctx)) return undefined;
		if (asString(e.source) !== "interactive" || text === "" || text.startsWith("/")) return undefined;
		if (!relaunched) {
			if (snapshot(c).state !== "ready") return undefined;
			// The message is the request's first owner text, so the editor draft is not carried.
			if (!requestRelaunch(c, notePath(c.sessionId, mainStateDir(cfg)), "")) return undefined;
		}
		if (appendToRelaunch(text)) c.notify("rollover in progress: your message goes to the new session");
		else c.notify("rollover in progress: your message could not be saved and was not sent; send it again after the rollover");
		// omp re-checks its deferred exit only when shutdown() is called again: re-arm per message.
		c.shutdown();
		return { handled: true };
	};

	// The rollover starts on its own (size + idle), and the owner's next message joins the
	// pending relaunch; the command only says so.
	const registerCommand = (): void => {
		pi.registerCommand("main-rollover", {
			description: "Start a fresh session from Main's handoff note; the rest of the message is the owner's first message",
			handler: async (_args: unknown, ctx: unknown) => {
				const c = asRolloverCtx(ctx);
				if (!c) return;
				c.notify("main-rollover: under neurastream main the rollover starts from your next message, not from this command.");
			},
		});
	};

	return {
		isRelaunched: () => relaunched,
		snapshot,
		noteRequestFor,
		requestRelaunch,
		onSizeCheck,
		notice,
		clearGrace: () => {
			clearGraceFn?.();
		},
		clearState: () => {
			clearGraceFn?.();
			relaunched = false;
			flight = null;
		},
		handleInput,
		registerCommand,
	};
}
