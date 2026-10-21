// Session rollover, pure core: when Main's session file has grown past `rollover.max_session_mb`,
// Main writes a handoff note first; the owner's next message then opens a fresh session that
// starts from the note plus the generated state. Decisions only: the adapter reads the file size,
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
	/** When the session file was first seen at or over the threshold; null if never. */
	crossedAtMs: number | null;
	/** Mtime of the handoff note; null when the note does not exist. */
	noteMtimeMs: number | null;
	nowMs: number;
}

/**
 * below: under the threshold. need-note: over it and no fresh note (written after the crossing,
 * at most MAX_NOTE_AGE_MS old). wait-jobs: note is fresh but own jobs still run (rolling over
 * would cancel them). ready: the next owner message may roll over.
 */
export function rolloverState(p: RolloverInput): RolloverState {
	if (p.sessionBytes < p.maxMb * 1024 * 1024) return "below";
	const noteFresh =
		p.noteMtimeMs !== null &&
		p.crossedAtMs !== null &&
		p.noteMtimeMs > p.crossedAtMs &&
		p.nowMs - p.noteMtimeMs <= MAX_NOTE_AGE_MS;
	if (!noteFresh) return "need-note";
	return p.runningJobs.length > 0 ? "wait-jobs" : "ready";
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

/** The first user message of the new session: header, Main's note, generated state, owner message. */
export function buildHandoff(p: HandoffInput): string {
	return [
		`Previous session file: ${p.previousSessionFile}. Its full history stays there; this session continues from the handoff below.`,
		"",
		"## Main's handoff note (verbatim)",
		p.note.trimEnd(),
		"",
		"## Generated state (main-start)",
		p.generated.trimEnd(),
		"",
		"Owner's message:",
		p.ownerMessage,
	].join("\n");
}

/** Where Main writes the handoff note for one session. */
export function notePath(sessionId: string, stateDir = stateDirPath()): string {
	return join(stateDir, "rollover", `${sessionId}.md`);
}
