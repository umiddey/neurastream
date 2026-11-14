// The recall log (plan 20261109_2335, P2): one JSON line per owner message and per Main answer,
// kept in <state>/recall/owner-log.jsonl. The inject path and the turn end write it; `neurastream
// recall` reads it through readLines, which walks the file backwards in 64 KiB blocks so a search
// over a long log never loads it whole. The backfill file (P3) is read after the live log.

import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { nowSec } from "./clock.ts";
import type { Config } from "./config.ts";
import { ownerMessagesFile } from "./incidents.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";
import type { OwnerTurn } from "./adapter.ts";
import { isOwnerProse } from "./guards.ts";
import { ownerText } from "./rollover.ts";

export type LogRole = "owner" | "main";

export interface LogEntry {
	id: string;
	at: number;
	role: LogRole;
	text: string;
}

export function ownerLogDir(): string {
	return join(dirname(ownerMessagesFile()), "recall");
}

export function ownerLogFile(): string {
	return join(ownerLogDir(), "owner-log.jsonl");
}

export function ownerBackfillFile(): string {
	return join(ownerLogDir(), "owner-log.backfill.jsonl");
}

// Ids sort by time: nine base-36 digits of the millisecond clock, then eight hex digits of
// randomness, so two entries written in the same millisecond collide with probability 2^-32.
export function newEntryId(atMs: number, rand: (n: number) => Uint8Array = randomBytes): string {
	return atMs.toString(36).padStart(9, "0") + Buffer.from(rand(4)).toString("hex");
}

// The one writer: the recall dir is 0700 and the file 0600, also when they pre-exist looser.
export function appendJsonLines(file: string, rows: readonly object[]): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
	chmodSync(file, 0o600);
}

// Entries appended in this process since the last topics spawn. The turn-end trigger reads it.
let appendedCount = 0;

export function appendedSinceSpawn(): number {
	return appendedCount;
}

export function markTopicsSpawned(): void {
	appendedCount = 0;
}

export function appendOwnerLog(
	role: LogRole,
	text: string,
	opts: { atMs?: number; rand?: (n: number) => Uint8Array } = {},
): string {
	const atMs = opts.atMs ?? nowSec() * 1000;
	const entry: LogEntry = { id: newEntryId(atMs, opts.rand), at: Math.floor(atMs / 1000), role, text };
	appendJsonLines(ownerLogFile(), [entry]);
	appendedCount++;
	return entry.id;
}

// Redacts the text (the configured known secrets and extra patterns) before it is written. Throws
// on a failed write; the callers decide where that is logged.
export function recordOwnerLog(cfg: Config, role: LogRole, text: string): void {
	const clean = redactSecrets(text, loadKnownSecrets(cfg), cfg.secrets.extra_patterns).text;
	appendOwnerLog(role, clean);
}

// The first (newest) or last (oldest) parsable entry of one log file; undefined when it has none.
function logEdge(file: string, newest: boolean): LogEntry | undefined {
	let edge: LogEntry | undefined;
	for (const line of readLines(file)) {
		const entry = parseEntry(line);
		if (entry === undefined) continue;
		edge = entry;
		if (newest) break;
	}
	return edge;
}

// Writes the session files' owner prompts and Main replies to the backfill file, once. A turn is kept
// only strictly between the newest backfill entry and the oldest live entry, so a rerun adds nothing and
// the live log is never touched. Owner prompts pass the live path's gates (owner prose, then the owner's
// part of a handoff or unanswered prompt). Returns the number of entries written.
export function backfillOwnerLog(cfg: Config, turns: Iterable<OwnerTurn>): number {
	const kept: OwnerTurn[] = [];
	for (const turn of turns) {
		if (turn.role === "main") {
			kept.push(turn);
		} else if (isOwnerProse(turn.text)) {
			const owner = ownerText(turn.text);
			if (owner !== undefined) kept.push({ at: turn.at, role: "owner", text: owner });
		}
	}
	kept.sort((a, b) => a.at - b.at);
	const newest = logEdge(ownerBackfillFile(), true);
	const oldest = logEdge(ownerLogFile(), false);
	const known = loadKnownSecrets(cfg);
	const rows: LogEntry[] = [];
	for (const turn of kept) {
		if (newest !== undefined && turn.at <= newest.at) continue;
		if (oldest !== undefined && turn.at >= oldest.at) continue;
		const clean = redactSecrets(turn.text, known, cfg.secrets.extra_patterns).text;
		rows.push({ id: newEntryId(turn.at * 1000), at: turn.at, role: turn.role, text: clean });
	}
	if (rows.length > 0) appendJsonLines(ownerBackfillFile(), rows);
	return rows.length;
}

const BLOCK = 64 * 1024;
const LF = 0x0a;

// The file's lines, newest first. A missing file yields nothing; empty lines are skipped.
export function* readLines(file: string): Generator<string> {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return;
	}
	try {
		let pos = fstatSync(fd).size;
		let pending = Buffer.alloc(0);
		while (pos > 0) {
			const n = Math.min(BLOCK, pos);
			pos -= n;
			const block = Buffer.alloc(n);
			readSync(fd, block, 0, n, pos);
			const data = pending.length > 0 ? Buffer.concat([block, pending]) : block;
			let end = data.length;
			let nl = data.lastIndexOf(LF);
			while (nl >= 0) {
				if (end > nl + 1) yield data.toString("utf8", nl + 1, end);
				end = nl;
				nl = end > 0 ? data.lastIndexOf(LF, end - 1) : -1;
			}
			// What is left precedes the block's first newline: the head of a line that starts earlier.
			pending = data.subarray(0, end);
		}
		if (pending.length > 0) yield pending.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function parseEntry(line: string): LogEntry | undefined {
	try {
		return JSON.parse(line) as LogEntry;
	} catch {
		// A torn last line (the writer was killed mid-append) is skipped, not fatal to a search.
		return undefined;
	}
}

// Every entry, newest first: the live log, then the backfill (older by construction).
export function* readEntries(): Generator<LogEntry> {
	for (const file of [ownerLogFile(), ownerBackfillFile()]) {
		for (const line of readLines(file)) {
			const entry = parseEntry(line);
			if (entry !== undefined) yield entry;
		}
	}
}

export interface SearchOpts {
	words: string[];
	sinceSec?: number;
	limit: number;
}

// Entries whose text contains every word (case-insensitive, any order), newest first.
export function searchEntries(opts: SearchOpts): LogEntry[] {
	const words = opts.words.map((w) => w.toLowerCase());
	const out: LogEntry[] = [];
	for (const e of readEntries()) {
		if (opts.sinceSec !== undefined && e.at < opts.sinceSec) continue;
		const text = e.text.toLowerCase();
		if (!words.every((w) => text.includes(w))) continue;
		out.push(e);
		if (out.length >= opts.limit) break;
	}
	return out;
}

// The entry with this id plus the entry it pairs with, in chronological order: an owner message
// with the nearest newer Main answer, a Main answer with the nearest older owner message. Undefined
// when no entry has the id. One streaming pass, newest first.
export function showEntries(id: string): LogEntry[] | undefined {
	let target: LogEntry | undefined;
	let newerMain: LogEntry | undefined;
	for (const e of readEntries()) {
		if (target === undefined) {
			if (e.id === id) {
				target = e;
				if (e.role === "owner") return newerMain ? [e, newerMain] : [e];
			} else if (e.role === "main") {
				newerMain = e;
			}
			continue;
		}
		if (e.role === "owner") return [e, target];
	}
	return target ? [target] : undefined;
}
