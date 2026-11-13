// `neurastream recall`: searches the owner's messages and Main's answers (the recall log, see
// core/owner-log.ts) and shows an entry with the entry it pairs with. Read-only.

import { getAdapter } from "../adapters/index.ts";
import { nowSec } from "../core/clock.ts";
import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import { helpDoc, printText } from "../core/help.ts";
import { backfillOwnerLog, type LogEntry, searchEntries, showEntries } from "../core/owner-log.ts";
import { applyQueueEnv } from "../core/queue/env.ts";

const USAGE = "usage: neurastream recall <words>... [--since 7d|12h|YYYY-MM-DD] [--limit N] [--json]\n       neurastream recall --show <id> [--json]";
const BACKFILL_USAGE = "usage: neurastream recall backfill [--since 7d|12h|YYYY-MM-DD]";
const DEFAULT_LIMIT = 20;
const PREVIEW_CHARS = 160;
const HOUR = 3600;
const DAY = 86400;

interface Opts {
	words: string[];
	show?: string;
	sinceSec?: number;
	limit: number;
	json: boolean;
}

// The earliest epoch second a --since value admits: a relative 7d or 12h, or a date.
function sinceAt(text: string, now: number): number | undefined {
	const m = /^(\d+)([hd])$/.exec(text);
	if (m) return now - Number(m[1]) * (m[2] === "d" ? DAY : HOUR);
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms / 1000;
}

// A usage problem comes back as its message; the caller prints it with USAGE.
function parseArgs(args: string[]): Opts | string {
	const opts: Opts = { words: [], limit: DEFAULT_LIMIT, json: false };
	let since: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--json") {
			opts.json = true;
		} else if (a === "--show" || a === "--since" || a === "--limit") {
			const v = args[++i];
			if (v === undefined) return `${a} needs a value`;
			if (a === "--show") {
				opts.show = v;
			} else if (a === "--since") {
				since = v;
			} else {
				const n = Number(v);
				if (!Number.isInteger(n) || n < 1) return "--limit needs a whole number of 1 or more";
				opts.limit = n;
			}
		} else if (a.startsWith("--")) {
			return `unknown flag ${a}`;
		} else {
			opts.words.push(a);
		}
	}
	if (since !== undefined) {
		opts.sinceSec = sinceAt(since, nowSec());
		if (opts.sinceSec === undefined) return `--since takes 7d, 12h or a date (YYYY-MM-DD), not ${since}`;
	}
	return opts;
}

// Times are shown in UTC, minute precision.
function stamp(at: number): string {
	return new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function jsonLine(e: LogEntry): string {
	return JSON.stringify({ at: e.at, id: e.id, role: e.role, text: e.text });
}

// `recall backfill [--since ...]`: writes the session files' owner prompts and Main replies to the backfill
// file, once. Reads the session files only; no model call.
function backfillCli(args: string[], cfg: Config): number {
	let since = 0;
	if (args.length > 0) {
		const value = args[1];
		if (args.length !== 2 || args[0] !== "--since" || value === undefined) {
			console.error(BACKFILL_USAGE);
			return 2;
		}
		const at = sinceAt(value, nowSec());
		if (at === undefined) {
			console.error(`--since takes 7d, 12h or a date (YYYY-MM-DD), not ${value}\n${BACKFILL_USAGE}`);
			return 2;
		}
		since = at;
	}
	const written = backfillOwnerLog(cfg, getAdapter(cfg).ownerTurns(cfg, since));
	console.log(`backfill: ${written} entries`);
	return 0;
}

export function recallCli(args: string[], cfg: Config): number {
	if (args.includes("--help") || args.includes("-h")) {
		printText(helpDoc("recall"));
		return 0;
	}
	// The log paths follow the queue state directory, so the config's queue env is applied first.
	applyQueueEnv(cfg);
	if (args[0] === "backfill") return backfillCli(args.slice(1), cfg);
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		console.error(`${parsed}\n${USAGE}`);
		return 2;
	}
	if (parsed.show !== undefined) {
		const pair = showEntries(parsed.show);
		if (pair === undefined) {
			console.error(`no entry with id ${parsed.show}`);
			return 2;
		}
		for (const e of pair) {
			console.log(parsed.json ? jsonLine(e) : `${e.id}  ${stamp(e.at)}  ${e.role}\n${e.text}\n`);
		}
		return 0;
	}
	if (parsed.words.length === 0) {
		console.error(USAGE);
		return 2;
	}
	const hits = searchEntries({ words: parsed.words, sinceSec: parsed.sinceSec, limit: parsed.limit });
	if (hits.length === 0) {
		console.log("no match");
		return 1;
	}
	for (const e of hits) {
		console.log(parsed.json ? jsonLine(e) : `${e.id}  ${stamp(e.at)}  ${e.role}  ${preview(e.text)}`);
	}
	return 0;
}

export function runRecall(args: string[]): number {
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	return recallCli(args, cfg);
}
