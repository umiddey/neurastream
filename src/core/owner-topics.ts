// The topic index (plan 20261109_2335, P8): a model splits the recall log into consecutive segments of
// entry ids and appends them to owner-topics.jsonl. The log stays the source of truth: a segment only names
// a run of its ids, and topic text never reaches Main's prompt.

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowSec } from "./clock.ts";
import type { Config } from "./config.ts";
import { tryLock } from "./file-lock.ts";
import { appendJsonLines, type LogEntry, ownerLogDir, ownerLogFile, readEntries, readLines } from "./owner-log.ts";
import { loadKnownSecrets, redactSecrets } from "./secret-redact.ts";

export interface CompleteRequest {
	model: string;
	system: string;
	prompt: string;
	maxTokens: number;
	/** Reasoning effort for the model ("" or absent = none). */
	effort?: string;
}

export interface CompleteResult {
	text: string;
	usage: { prompt_tokens: number; completion_tokens: number };
}

export type Complete = (req: CompleteRequest) => Promise<CompleteResult>;

export interface Note {
	id: string;
	text: string;
}

// One segment as the model answers it.
export interface AnswerSegment {
	from: string;
	to: string;
	title: string;
	keywords: string[];
	decisions: Note[];
	questions: Note[];
	names: string[];
	continues: string | null;
}

// A segment as stored. The last segment of a run is open: the next run may re-cut it.
export interface Segment extends AnswerSegment {
	at: number;
	open: boolean;
}

// A window the model could not segment. It keeps its place in the log, so its entries are not retried.
export interface Skipped {
	from: string;
	to: string;
	at: number;
	skipped: true;
	why: string;
}

export type TopicRow = Segment | Skipped;

export interface TopicsRun {
	lines: string[];
	failures: number;
}

interface Tally {
	calls: number;
	tokensIn: number;
	tokensOut: number;
}

// A failure the caller prints: the reason code, and the byte sizes of the request and the answer.
interface Failure {
	reason: string;
	in: number;
	out: number;
}

type Attempt =
	| { kind: "ok" }
	| { kind: "rejected"; reason: string; in: number; out: number }
	| { kind: "error"; reason: string; in: number };

const TOPICS_FILE = "owner-topics.jsonl";
const TOPICS_LOG_FILE = "owner-topics.log";
const LOCK_FILE = "owner-topics.lock";
const WINDOW = 60;
const MAX_TOKENS = 16000;

const SYSTEM = [
	"You split a chronological log of an owner's messages and the assistant's replies into topic segments.",
	"Answer with one JSON object and nothing else. Entries are numbered [1], [2], ...; every id below is an entry number as a string:",
	'{"segments":[{"from":"<entry number>","to":"<entry number>","title":"...","keywords":["..."],"decisions":[{"id":"<entry number>","text":"..."}],"questions":[{"id":"<owner entry number>","text":"..."}],"names":["..."],"continues":null}]}',
	"Rules:",
	"- The segments cover the log in order with no gaps and no overlaps; the last one ends at the last entry.",
	"- from and to are entry numbers from the log. A segment that is not the last has 3 to 60 entries.",
	"- title: at most 10 words. keywords: at most 6 words each. decision text: at most 60 words, and its id is an entry in the segment.",
	"- questions: the owner's open questions, each with the id of an owner entry in the segment.",
	"- Write in your own words. Never copy 8 or more words in a row from the log.",
	"- continues: always null.",
].join("\n");

export function topicsFile(): string {
	return join(ownerLogDir(), TOPICS_FILE);
}

// stdout and stderr of the background `recall topics` run: stats and `topics: fail` lines only.
export function topicsLogFile(): string {
	return join(ownerLogDir(), TOPICS_LOG_FILE);
}

export function topicsDue(count: number, every: number): boolean {
	return count >= every;
}

function isStrings(v: unknown): v is string[] {
	return Array.isArray(v) && v.every(s => typeof s === "string");
}

function isNotes(v: unknown): v is Note[] {
	return (
		Array.isArray(v) &&
		v.every(n => {
			const note = n as Partial<Note> | null;
			return note !== null && typeof note === "object" && typeof note.id === "string" && typeof note.text === "string";
		})
	);
}

function isSegment(r: TopicRow): r is Segment {
	return !("skipped" in r);
}

function parseRow(line: string): TopicRow | undefined {
	let v: Partial<Segment & Skipped> | null;
	try {
		v = JSON.parse(line) as Partial<Segment & Skipped> | null;
	} catch {
		return undefined;
	}
	if (v === null || typeof v !== "object" || typeof v.from !== "string" || typeof v.to !== "string") return undefined;
	if (typeof v.at !== "number") return undefined;
	if (v.skipped === true) {
		return { from: v.from, to: v.to, at: v.at, skipped: true, why: typeof v.why === "string" ? v.why : "" };
	}
	if (
		typeof v.title !== "string" ||
		typeof v.open !== "boolean" ||
		!isStrings(v.keywords) ||
		!isNotes(v.decisions) ||
		!isNotes(v.questions) ||
		!isStrings(v.names) ||
		!(v.continues === null || typeof v.continues === "string")
	) {
		return undefined;
	}
	return {
		from: v.from,
		to: v.to,
		at: v.at,
		open: v.open,
		title: v.title,
		keywords: v.keywords,
		decisions: v.decisions,
		questions: v.questions,
		names: v.names,
		continues: v.continues,
	};
}

// The index as a reader sees it: file order, where a line replaces every earlier line that reaches into its
// ids (a re-cut of the open segment, or the closed copy that --close writes). Unparsable lines are skipped.
function effectiveRows(): TopicRow[] {
	const out: TopicRow[] = [];
	for (const line of [...readLines(topicsFile())].toReversed()) {
		const row = parseRow(line);
		if (row === undefined) continue;
		while (out.length > 0 && out.at(-1)!.to >= row.from) out.pop();
		out.push(row);
	}
	return out;
}

export function readTopics(): Segment[] {
	return effectiveRows().filter(isSegment);
}

// The id the next window starts after: the last segment that is closed, or a skipped window.
function afterClosed(rows: TopicRow[]): string | undefined {
	let to: string | undefined;
	for (const r of rows) if (!(isSegment(r) && r.open)) to = r.to;
	return to;
}

function wordCount(s: string): number {
	return s.trim().split(/\s+/).filter(w => w !== "").length;
}

// The 8-word runs of a text, lowercased, with punctuation dropped: what the copy check compares.
function gramsOf(text: string): string[] {
	const ws = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w !== "");
	const out: string[] = [];
	for (let i = 0; i + 8 <= ws.length; i++) out.push(ws.slice(i, i + 8).join(" "));
	return out;
}

// An earlier row as the checks read it: a closed segment, an open one, or a skipped window.
type Earlier = { from: string; to: string; open?: boolean; skipped?: boolean };

// Checks an answer against the window it segments. Returns null, or one message "name: detail" where name
// `entries` is the window, oldest first; `earlier` is the rows before it, the last one ending where it starts.
export function checkSegments(
	segments: readonly AnswerSegment[],
	entries: readonly LogEntry[],
	earlier: readonly Earlier[],
): string | null {
	if (segments.length === 0) return "reach: no segments";
	const index = new Map(entries.map((e, i) => [e.id, i]));
	const seen = new Set<string>();
	const last = earlier.at(-1);
	const start = last === undefined ? 0 : (index.get(last.to) ?? -1) + 1;
	for (const e of entries) for (const g of gramsOf(e.text)) seen.add(g);

	let prevFrom = -1;
	let prevTo = -1;
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i]!;
		const fi = index.get(s.from);
		const ti = index.get(s.to);
		if (fi === undefined) return `id: ${s.from} not in log`;
		if (ti === undefined) return `id: ${s.to} not in log`;
		if (fi > ti) return `order: segment ${s.from}..${s.to} ends before it starts`;
		if (i === 0) {
			if (fi > start) return `gap: entries before ${s.from} are not covered`;
			if (fi < start) return `overlap: segment ${s.from} starts inside an earlier one`;
		} else if (fi < prevFrom) {
			return `order: segment ${s.from} is out of log order`;
		} else if (fi <= prevTo) {
			return `overlap: segment ${s.from} starts inside the previous one`;
		} else if (fi > prevTo + 1) {
			return `gap: entries after ${segments[i - 1]!.to} are not covered`;
		}
		const count = ti - fi + 1;
		if (i < segments.length - 1 && count < 3) return `short: segment ${s.from}..${s.to} has fewer than 3 entries`;
		if (count > 60) return `long: segment ${s.from}..${s.to} has more than 60 entries`;
		if (wordCount(s.title) > 10) return "title: over 10 words";
		for (const k of s.keywords) if (wordCount(k) > 6) return "keyword: over 6 words";
		for (const d of s.decisions) {
			if (wordCount(d.text) > 60) return "decision: over 60 words";
			const di = index.get(d.id);
			if (di === undefined || di < fi || di > ti) return `decision: id ${d.id} is outside its segment`;
		}
		for (const q of s.questions) {
			const qi = index.get(q.id);
			if (qi === undefined || qi < fi || qi > ti || entries[qi]!.role !== "owner") {
				return `question: id ${q.id} is not an owner entry in its segment`;
			}
		}
		for (const text of [s.title, ...s.decisions.map(d => d.text), ...s.questions.map(q => q.text)]) {
			if (gramsOf(text).some(g => seen.has(g))) return "copy: 8 words copied in a row from an entry";
		}
		if (s.continues !== null && !earlier.some(e => e.open !== true && e.skipped !== true && e.from === s.continues)) {
			return `continues: ${s.continues} is not an earlier closed segment`;
		}
		prevFrom = fi;
		prevTo = ti;
	}
	if (index.get(segments.at(-1)!.to) !== entries.length - 1) return "reach: segments stop before the last entry";
	return null;
}

// The answer's shape, checked field by field: the model's text is not trusted to carry the named type.
function shape(value: unknown): AnswerSegment[] | undefined {
	const raw = (value as { segments?: unknown } | null)?.segments;
	if (!Array.isArray(raw)) return undefined;
	const out: AnswerSegment[] = [];
	for (const item of raw) {
		const s = item as Partial<AnswerSegment> | null;
		if (
			s === null ||
			typeof s !== "object" ||
			typeof s.from !== "string" ||
			typeof s.to !== "string" ||
			typeof s.title !== "string" ||
			!isStrings(s.keywords) ||
			!isNotes(s.decisions) ||
			!isNotes(s.questions) ||
			!isStrings(s.names) ||
			!(s.continues === null || typeof s.continues === "string")
		) {
			return undefined;
		}
		out.push({
			from: s.from,
			to: s.to,
			title: s.title,
			keywords: s.keywords,
			decisions: s.decisions,
			questions: s.questions,
			names: s.names,
			continues: s.continues,
		});
	}
	return out;
}

type Parsed = { segments: AnswerSegment[] } | { reason: string };

function parseAnswer(text: string, window: readonly LogEntry[], earlier: readonly Earlier[]): Parsed {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { reason: "bad-json" };
	}
	const shaped = shape(value);
	if (shaped === undefined) return { reason: "check:shape" };
	// The model sees entry numbers; a number the window has becomes its stored id, anything else is checked as is.
	const idOf = (label: string): string => (/^[1-9]\d*$/.test(label) ? (window[Number(label) - 1]?.id ?? label) : label);
	const segments = shaped.map(s => ({
		...s,
		from: idOf(s.from),
		to: idOf(s.to),
		decisions: s.decisions.map(d => ({ ...d, id: idOf(d.id) })),
		questions: s.questions.map(q => ({ ...q, id: idOf(q.id) })),
	}));
	// The model cuts short greeting stretches that the 3-entry rule forbids: a short non-last segment folds into the next.
	const pos = new Map(window.map((e, i) => [e.id, i]));
	const folded: AnswerSegment[] = [];
	let carry: AnswerSegment | undefined;
	for (const [i, s] of segments.entries()) {
		const cur = carry
			? {
					...s,
					from: carry.from,
					keywords: [...carry.keywords, ...s.keywords],
					decisions: [...carry.decisions, ...s.decisions],
					questions: [...carry.questions, ...s.questions],
					names: [...carry.names, ...s.names],
				}
			: s;
		const a = pos.get(cur.from);
		const b = pos.get(cur.to);
		carry = i < segments.length - 1 && a !== undefined && b !== undefined && b >= a && b - a + 1 < 3 ? cur : undefined;
		if (carry === undefined) folded.push(cur);
	}
	// A note whose id points outside its segment (or a question not on an owner entry) is dropped, not the window.
	const clean = folded.map(s => {
		const a = pos.get(s.from) ?? -1;
		const b = pos.get(s.to) ?? -1;
		const inside = (id: string): boolean => (pos.get(id) ?? -1) >= a && (pos.get(id) ?? -1) <= b && pos.has(id);
		return {
			...s,
			decisions: s.decisions.filter(d => inside(d.id)),
			questions: s.questions.filter(q => inside(q.id) && window[pos.get(q.id)!]!.role === "owner"),
		};
	});
	const err = checkSegments(clean, window, earlier);
	return err === null ? { segments: clean } : { reason: `check:${err.slice(0, err.indexOf(":"))}` };
}

// A model error keeps its reason code; a timeout is named TimeoutError by the caller's spawn.
function failureReason(err: unknown): string {
	if (err instanceof Error && err.name === "TimeoutError") return "timeout";
	const reason = (err as { reason?: unknown } | null)?.reason;
	return typeof reason === "string" && reason !== "" ? reason : "model-error";
}

function windowPrompt(window: readonly LogEntry[]): string {
	return ["Log entries, oldest first:", ...window.map((e, i) => `[${i + 1}] (${e.role}) ${e.text}`)].join("\n");
}

// Redacts the model's text before it is written: the configured known secrets and extra patterns.
function appendSegments(cfg: Config, segments: readonly AnswerSegment[]): void {
	const known = loadKnownSecrets(cfg);
	const clean = (text: string): string => redactSecrets(text, known, cfg.secrets.extra_patterns).text;
	const at = nowSec();
	const rows: Segment[] = segments.map((s, i) => ({
		from: s.from,
		to: s.to,
		at,
		open: i === segments.length - 1,
		title: clean(s.title),
		keywords: s.keywords.map(clean),
		decisions: s.decisions.map(d => ({ id: d.id, text: clean(d.text) })),
		questions: s.questions.map(q => ({ id: q.id, text: clean(q.text) })),
		names: s.names.map(clean),
		continues: s.continues,
	}));
	appendJsonLines(topicsFile(), rows);
}

// One model call on the window. On a good answer the segments are appended; otherwise nothing is written.
async function attemptOnce(
	cfg: Config,
	complete: Complete,
	window: readonly LogEntry[],
	request: string,
	earlier: readonly Earlier[],
	tally: Tally,
): Promise<Attempt> {
	tally.calls++;
	let answer: CompleteResult;
	try {
		answer = await complete({
			model: cfg.recall.topics_model,
			system: SYSTEM,
			prompt: request,
			maxTokens: MAX_TOKENS,
			effort: cfg.recall.topics_effort,
		});
	} catch (err) {
		return { kind: "error", reason: failureReason(err), in: Buffer.byteLength(request) };
	}
	tally.tokensIn += answer.usage.prompt_tokens;
	tally.tokensOut += answer.usage.completion_tokens;
	const parsed = parseAnswer(answer.text, window, earlier);
	if ("segments" in parsed) {
		appendSegments(cfg, parsed.segments);
		return { kind: "ok" };
	}
	return { kind: "rejected", reason: parsed.reason, in: Buffer.byteLength(request), out: Buffer.byteLength(answer.text) };
}

// Segments one window and appends the result. A window whose answer is rejected twice is kept as one skipped
// line, so the next run starts after it. A model error is not retried and appends nothing.
async function segmentWindow(
	cfg: Config,
	complete: Complete,
	window: readonly LogEntry[],
	rows: TopicRow[],
	tally: Tally,
): Promise<Failure | undefined> {
	const earlier = rows.filter(r => !(isSegment(r) && r.open));
	const prompt = windowPrompt(window);
	const first = await attemptOnce(cfg, complete, window, prompt, earlier, tally);
	if (first.kind === "ok") return undefined;
	if (first.kind === "error") return { reason: first.reason, in: first.in, out: 0 };
	const retry = `${prompt}\n\nYour answer was rejected (${first.reason}). Answer again with only the JSON object, following every rule.`;
	const second = await attemptOnce(cfg, complete, window, retry, earlier, tally);
	if (second.kind === "ok") return undefined;
	if (second.kind === "error") return { reason: second.reason, in: second.in, out: 0 };
	appendJsonLines(topicsFile(), [
		{ from: window[0]!.id, to: window.at(-1)!.id, at: nowSec(), skipped: true, why: second.reason },
	]);
	return { reason: second.reason, in: second.in, out: second.out };
}

// `--close`: the open segment becomes closed (a copy with open:false), so the next window starts after it.
function closeOpen(): void {
	const last = effectiveRows().at(-1);
	if (last !== undefined && isSegment(last) && last.open) appendJsonLines(topicsFile(), [{ ...last, open: false }]);
}

function oldestFirst(): LogEntry[] {
	return [...readEntries()].toReversed();
}

// The entries after `afterId`, oldest first. No id means every entry.
export function newEntries(afterId?: string): LogEntry[] {
	const all = oldestFirst();
	if (afterId === undefined) return all;
	const i = all.findIndex(e => e.id === afterId);
	return i < 0 ? all : all.slice(i + 1);
}

// The entries from `from` to `to`, both inclusive, oldest first. Empty when either id is missing.
export function rangeEntries(from: string, to: string): LogEntry[] {
	const all = oldestFirst();
	const a = all.findIndex(e => e.id === from);
	const b = all.findIndex(e => e.id === to);
	return a < 0 || b < 0 || b < a ? [] : all.slice(a, b + 1);
}

// Topics whose text holds every word (case-insensitive, any order), in file order.
export function searchTopics(query: readonly string[]): Segment[] {
	const want = query.map(w => w.toLowerCase());
	return readTopics().filter(s => {
		const hay = [s.title, ...s.keywords, ...s.decisions.map(d => d.text), ...s.questions.map(q => q.text), ...s.names]
			.join(" ")
			.toLowerCase();
		return want.every(w => hay.includes(w));
	});
}

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function spread(values: number[]): { mean: number; median: number; p90: number; min: number; max: number } {
	const sorted = values.toSorted((a, b) => a - b);
	if (sorted.length === 0) return { mean: 0, median: 0, p90: 0, min: 0, max: 0 };
	return {
		mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
		median: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		min: sorted[0]!,
		max: sorted.at(-1)!,
	};
}

// The ids of the live log file (not the backfill): a segment's lag is measured only where its `to` is live.
function liveIds(): Set<string> {
	const ids = new Set<string>();
	for (const line of readLines(ownerLogFile())) {
		try {
			const e = JSON.parse(line) as Partial<LogEntry>;
			if (typeof e.id === "string") ids.add(e.id);
		} catch {
			// A torn line is skipped, as the reader skips it.
		}
	}
	return ids;
}

// The one stats line every run ends with. Counts come from the index as it stands; tokens and calls are
// this run's. Lag is the age, in hours, of each segment's `to` entry, for the segments whose `to` is live.
function statsLine(tally: Tally): string {
	const rows = effectiveRows();
	const segments = rows.filter(isSegment);
	const skipped = rows.length - segments.length;
	const all = oldestFirst();
	const byId = new Map(all.map((e, index) => [e.id, { index, at: e.at }]));
	const counts = segments.flatMap(s => {
		const a = byId.get(s.from);
		const b = byId.get(s.to);
		return a !== undefined && b !== undefined && b.index >= a.index ? [b.index - a.index + 1] : [];
	});
	const live = liveIds();
	const lags = segments.flatMap(s => {
		const b = byId.get(s.to);
		return b !== undefined && live.has(s.to) ? [(nowSec() - b.at) / 3600] : [];
	});
	const perTopic = spread(counts);
	const days = all.length > 0 ? (all.at(-1)!.at - all[0]!.at) / 86400 : 0;
	const perDay = segments.length / Math.max(1, days);
	const lag = spread(lags);
	const lagText = lags.length === 0 ? "lag n/a" : `lag median ${lag.median.toFixed(1)}h p90 ${lag.p90.toFixed(1)}h`;
	const entries = counts.reduce((a, b) => a + b, 0);
	return `topics: segments ${segments.length} | entries ${entries} | entries per topic mean ${perTopic.mean.toFixed(1)} median ${perTopic.median} p90 ${perTopic.p90} min ${perTopic.min} max ${perTopic.max} | segments per day ${perDay.toFixed(1)} | ${lagText} | tokens in ${tally.tokensIn} out ${tally.tokensOut} | calls ${tally.calls} | skipped ${skipped}`;
}

// One topic run under the lock: segments the next window of new entries, then prints the stats line. With
// `close`, closes the open segment instead (no model call). Model errors append nothing; the caller prints
// the lines and exits by `failures`.
export async function runTopics(cfg: Config, complete: Complete, opts: { close: boolean }): Promise<TopicsRun> {
	if (!opts.close && cfg.recall.topics_model === "") return { lines: ["topics: off"], failures: 0 };
	const dir = ownerLogDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const lock = tryLock(join(dir, LOCK_FILE));
	chmodSync(join(dir, LOCK_FILE), 0o600);
	if (lock === null) return { lines: ["topics: another run holds the lock"], failures: 0 };
	try {
		const tally: Tally = { calls: 0, tokensIn: 0, tokensOut: 0 };
		if (opts.close) {
			closeOpen();
			return { lines: [statsLine(tally)], failures: 0 };
		}
		const rows = effectiveRows();
		const window = newEntries(afterClosed(rows)).slice(0, WINDOW);
		if (window.length === 0) return { lines: [statsLine(tally)], failures: 0 };
		const failed = await segmentWindow(cfg, complete, window, rows, tally);
		const lines = failed
			? [`topics: fail ${window[0]!.id}..${window.at(-1)!.id} ${failed.reason} in=${failed.in} out=${failed.out}`]
			: [];
		lines.push(statsLine(tally));
		return { lines, failures: failed ? 1 : 0 };
	} finally {
		lock.release();
	}
}
