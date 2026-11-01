// Session rollover, pure core: when Main's session file has grown past `rollover.max_session_mb`,
// Main writes a handoff note first; the owner's next message then opens a fresh session that starts
// from the note plus the generated state. Under `neurastream main` the launcher starts that session
// without waiting for the owner. Decisions only: the adapter reads the file size,
// the jobs and the note mtime, and performs the switch. No harness names here.

import { join } from "node:path";
import { stateDirPath } from "./queue/lib.ts";

export type RolloverState = "below" | "need-note" | "wait-jobs" | "ready";

/** A note counts only if it is at most this old. */
export const MAX_NOTE_AGE_MS = 60 * 60_000;

export interface RolloverInput {
	sessionBytes: number;
	maxMb: number;
	/** Labels of the own async jobs (subagents included) that are still running. */
	runningJobs: readonly string[];
	/** When the session file was first seen at or over the threshold (or stale); null if never. */
	crossedAtMs: number | null;
	/** Mtime of the handoff note; null when the note does not exist. */
	noteMtimeMs: number | null;
	/** The running plugin differs from the installed package (or its version is unreadable). */
	stale: boolean;
	nowMs: number;
}

/**
 * below: under the threshold and not stale. need-note: over the threshold (or stale) with no fresh
 * note (written after the crossing, at most MAX_NOTE_AGE_MS old). wait-jobs: note is fresh but own
 * jobs still run (rolling over would cancel them). ready: the next owner message may roll over.
 * A stale session counts like a crossed size threshold: even a small session rolls over, because
 * the running plugin is not the code the owner installed.
 */
export function rolloverState(p: RolloverInput): RolloverState {
	if (p.sessionBytes < p.maxMb * 1024 * 1024 && !p.stale) return "below";
	const noteFresh =
		p.noteMtimeMs !== null &&
		p.crossedAtMs !== null &&
		p.noteMtimeMs > p.crossedAtMs &&
		p.nowMs - p.noteMtimeMs <= MAX_NOTE_AGE_MS;
	if (!noteFresh) return "need-note";
	return p.runningJobs.length > 0 ? "wait-jobs" : "ready";
}

/**
 * Drain: while a rollover is pending (need-note, wait-jobs or ready) Main must not start new subagents —
 * a rollover would cancel them, or they would outlive the handoff. Ready counts: the rollover follows the
 * next idle, so a spawn now would be aborted. Returns the refusal text, or null when the spawn may proceed.
 */
export function spawnRefusal(state: RolloverState, runningJobs: readonly string[]): string | null {
	if (state !== "need-note" && state !== "wait-jobs" && state !== "ready") return null;
	return `main-guard: rollover pending (${state}); no new subagents until the session rolls over. Running: ${runningJobs.join(", ")}.`;
}

export interface HandoffInput {
	/** Output of main-start (the generated state). */
	generated: string;
	/** Main's handoff note, inserted as written (trailing newlines dropped). */
	note: string;
	previousSessionFile: string;
	/** The owner's message exactly as typed; it is the last thing in the handoff. */
	ownerMessage: string;
}

/** Prefixes of the machine-written messages: the builders write them, ownerText reads them. */
const NOTE_REQUEST_PREFIX = "Session rollover:";
const HANDOFF_PREFIX = "Previous session file:";
const OWNER_MARK = "Owner's message:";

/**
 * The first user message of the new session: header, Main's note, generated state, owner message.
 * Every `(from: \`cmd\`)` in the note is listed under "## Numbers to re-run" right after it — re-run
 * these before repeating any number. No numbers, no section.
 */
export function buildHandoff(p: HandoffInput): string {
	const note = p.note.trimEnd();
	const numbers = [...note.matchAll(/\(from: `([^`]+)`\)/g)].map((m) => m[1]);
	return [
		`${HANDOFF_PREFIX} ${p.previousSessionFile}. Its full history stays there; this session continues from the handoff below.`,
		"",
		"## Main's handoff note (verbatim)",
		note,
		...(numbers.length > 0
			? ["", "## Numbers to re-run", "re-run these before repeating any number", ...numbers.map((c) => `- \`${c}\``)]
			: []),
		"",
		"## Generated state (main-start)",
		p.generated.trimEnd(),
		"",
		OWNER_MARK,
		p.ownerMessage,
	].join("\n");
}

/**
 * The owner's own words in a user prompt, or undefined for a machine prompt: a guard continuation, the
 * rollover note request, or a handoff without its owner marker. A handoff yields only its owner message.
 */
export function ownerText(prompt: string): string | undefined {
	const t = prompt.trimStart();
	if (t.startsWith("main-guard:") || t.startsWith(NOTE_REQUEST_PREFIX)) return undefined;
	if (t.startsWith(HANDOFF_PREFIX)) {
		const at = prompt.lastIndexOf(OWNER_MARK);
		return at < 0 ? undefined : prompt.slice(at + OWNER_MARK.length).trim();
	}
	return prompt;
}

/** The owner-holds part of the generated state: each WAITING on owner line verbatim, or none. */
export function holdsBlock(holds: readonly string[]): string {
	return ["=== owner holds (plans' WAITING on owner lines)", ...(holds.length > 0 ? holds : ["none"]), ""].join("\n");
}

/**
 * The launcher's owner-away text: the handoff's owner message when the owner typed nothing during the
 * rollover. The adapter's in-process fallback carries the same text, so it lives here, harness-free.
 */
export const OWNER_AWAY =
	"Owner away (automatic rollover). Continue the work in the note and the queue; the owner reads results later.";

/** The one-time note instruction for Main's next turn. `reason` (a stale install) names both versions and replaces the size line. */
export function noteRequest(path: string, reason = ""): string {
	return [
		reason
			? `${NOTE_REQUEST_PREFIX} a new neurastream version is installed (${reason}).`
			: `${NOTE_REQUEST_PREFIX} this session has grown past rollover.max_session_mb.`,
		`Write a handoff note to ${path} (overwrite it). Cover the work in progress and its state, the decisions made and why, the next step, and the files involved.`,
		"Do not list holds or owner blockers in the note; they come from the plans' WAITING on owner lines.",
		"Do not state which agents or providers are rate-limited or free; that comes from agent-ledger --cap.",
		"As soon as this note is written and none of its own jobs are running, this session restarts into a fresh one that starts from this note verbatim plus the generated main-start state.",
	].join("\n");
}

/** Where Main writes the handoff note for one session. */
export function notePath(sessionId: string, stateDir = stateDirPath()): string {
	return join(stateDir, "rollover", `${sessionId}.md`);
}

/** The launcher's relaunch request file: written by the harness just before it exits under `neurastream main`. */
export function relaunchPath(stateDir = stateDirPath()): string {
	return join(stateDir, "rollover", "relaunch.json");
}
