// Rule levels (plan 20261110_1746 P1): one JSON file under the queue state dir, already
// protected, so agents cannot write it. `block` is today's behaviour, `tell` is a log line
// with no incident, `off` is dropped. A missing file is empty (every rule blocks). A file
// that cannot be parsed is corrupt in memory only: every level still reads as block, and
// nothing here logs — the daily step and the rules command each write that one line.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";

export type Level = "block" | "tell" | "off";

export interface RuleEntry {
	level: Level;
	prev?: Level;
	date: string;
	/** Set by a probation raise; the daily step clears it when that window is judged. */
	probation?: true;
	/** Epoch seconds. While this is in the future the daily step does not move the rule. */
	held_until?: number;
}

export interface RuleLevels {
	/** UTC day of the last step that moved a level. The undo's anchor. */
	date?: string;
	/** UTC day of the last daily scan, moved or not. The one-step-per-day gate. */
	checked?: string;
	rules: Record<string, RuleEntry>;
	tuner?: { bar: number };
	/** In memory only. Never written. A corrupt file reads as block and is not overwritten. */
	corrupt?: true;
}

/** Kinds the tuner must never drop: watcher liveness and the undo's own evidence. */
export const PINNED = ["release-regression", "beat-failed", "beat-stale"] as const;

/** Detector and watcher kinds the tuner may step. Everything else is never scored. */
export const TUNABLE = [
	"ledger-contradiction",
	"tool-crash",
	"block-loop",
	"owner-correction",
	"claim-unbacked",
	"suspicious-action",
	"block-then-bypass",
	"unreported-finding",
	"beat-failed",
	"beat-stale",
	"unit-failed",
	"ci-red-main",
	"ci-red-mr",
] as const;

const LEVELS: readonly Level[] = ["block", "tell", "off"];

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is Level {
	return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function entryOf(value: unknown): RuleEntry | null {
	if (!isObj(value) || !isLevel(value.level) || typeof value.date !== "string") return null;
	if ("prev" in value && !isLevel(value.prev)) return null;
	if ("probation" in value && value.probation !== true) return null;
	if ("held_until" in value && (typeof value.held_until !== "number" || !Number.isFinite(value.held_until))) return null;
	const entry: RuleEntry = { level: value.level, date: value.date };
	if (isLevel(value.prev)) entry.prev = value.prev;
	if (value.probation === true) entry.probation = true;
	if (typeof value.held_until === "number") entry.held_until = value.held_until;
	return entry;
}

function parsed(value: unknown): RuleLevels | null {
	if (!isObj(value) || !isObj(value.rules)) return null;
	if ("date" in value && typeof value.date !== "string") return null;
	if ("checked" in value && typeof value.checked !== "string") return null;
	if ("tuner" in value && (!isObj(value.tuner) || typeof value.tuner.bar !== "number" || !Number.isFinite(value.tuner.bar))) return null;
	const rules: Record<string, RuleEntry> = {};
	for (const id of Object.keys(value.rules)) {
		const entry = entryOf(value.rules[id]);
		if (!entry) return null;
		rules[id] = entry;
	}
	const levels: RuleLevels = { rules };
	if (typeof value.date === "string") levels.date = value.date;
	if (typeof value.checked === "string") levels.checked = value.checked;
	if (isObj(value.tuner) && typeof value.tuner.bar === "number") levels.tuner = { bar: value.tuner.bar };
	return levels;
}

/** Missing file = empty. Unreadable or invalid JSON = corrupt, and the file is left as it is. */
export function readLevels(cfg: Config): RuleLevels {
	const path = join(cfg.paths.queue_state, "rule-levels.json");
	if (!existsSync(path)) return { rules: {} };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { rules: {}, corrupt: true };
	}
	try {
		const levels = parsed(JSON.parse(text));
		return levels ?? { rules: {}, corrupt: true };
	} catch {
		return { rules: {}, corrupt: true };
	}
}

/**
 * The only read path. Absent, corrupt, pinned, or an inherited name (`constructor`,
 * `__proto__`) is block. Callers must not index `levels.rules` themselves.
 */
export function levelFor(levels: RuleLevels, id: string): Level {
	if ((PINNED as readonly string[]).includes(id)) return "block";
	if (levels.corrupt) return "block";
	if (!Object.hasOwn(levels.rules, id)) return "block";
	const entry = levels.rules[id];
	return entry && isLevel(entry.level) ? entry.level : "block";
}

/** Temp file in the same directory, then rename, so a reader never sees a half-written file. */
export function atomicWrite(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** Writes the levels file. The in-memory `corrupt` flag is never stored. */
export function writeLevels(cfg: Config, levels: RuleLevels): void {
	const path = join(cfg.paths.queue_state, "rule-levels.json");
	mkdirSync(dirname(path), { recursive: true });
	const stored: Omit<RuleLevels, "corrupt"> = { rules: levels.rules };
	if (levels.date !== undefined) stored.date = levels.date;
	if (levels.checked !== undefined) stored.checked = levels.checked;
	if (levels.tuner !== undefined) stored.tuner = levels.tuner;
	atomicWrite(path, `${JSON.stringify(stored)}\n`);
}
