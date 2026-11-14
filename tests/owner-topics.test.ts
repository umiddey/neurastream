// Topic index core (plan 20261109_2335, P7 a-d, f, i, j, m, n, o, p). Red until
// src/core/owner-topics.ts exists: the import below is what fails. Every model call goes through an
// injected fake `complete`; the omp spawn is a fake spawn. HOME, the clock and the queue state are
// pinned to a sandbox under a tmp dir, so no real home or queue is read.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import {
	appendOwnerLog,
	appendedSinceSpawn,
	markTopicsSpawned,
	ownerBackfillFile,
	ownerLogDir,
	ownerLogFile,
	type LogEntry,
} from "../src/core/owner-log.ts";
import {
	checkSegments,
	newEntries,
	rangeEntries,
	readTopics,
	runTopics,
	topicsDue,
	topicsFile,
} from "../src/core/owner-topics.ts";
import { createOmpAdapter, reset as resetAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { MAIN_ENV } from "../src/adapters/omp/launch.ts";

const TMP = mkdtempSync(join(tmpdir(), "owner-topics-"));
const HOME = join(TMP, "home");
const QUEUE = join(TMP, "queue-state");
const NOW_SEC = 1_795_000_000;
const MODEL = "fake/topic-model";

const homeBefore = process.env.HOME;
const nowBefore = process.env.NEURASTREAM_NOW;
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
process.env.HOME = HOME;
process.env.NEURASTREAM_NOW = String(NOW_SEC);
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (homeBefore === undefined) delete process.env.HOME;
	else process.env.HOME = homeBefore;
	if (nowBefore === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = nowBefore;
	refreshQueuePaths();
});

/** Points the recall dir at this file's sandbox, then throws if it is still elsewhere: a live path is never touched. */
function sandboxed(): void {
	process.env.QUEUE_STATE = QUEUE;
	refreshQueuePaths();
	if (!ownerLogDir().startsWith(TMP)) throw new Error(`refusing to touch ${ownerLogDir()} outside ${TMP}`);
}

// ---- fixtures -------------------------------------------------------------------------------

/** Fixed entry id for index i: base-36 clock digits then fixed hex, so ids sort in index order. */
function idOf(i: number): string {
	return i.toString(36).padStart(9, "0") + (0xabc00000 + i).toString(16);
}

/** Even index = owner, odd = main. Ten minutes apart, oldest first. */
function entryAt(i: number): LogEntry {
	const owner = i % 2 === 0;
	const text = owner
		? `owner note ${i} about the traces series and the zoom index`
		: `main answer ${i} on the traces series and the zoom index`;
	return { id: idOf(i), at: NOW_SEC - (100 - i) * 600, role: owner ? "owner" : "main", text };
}

/** The 70-entry universe; a run's log holds the first 45 (0..44) unless a test says otherwise. */
const ENTRIES = Array.from({ length: 70 }, (_, i) => entryAt(i));

/** A run of `n` invented words, none of which occur in any entry. */
function invented(n: number): string {
	return Array.from({ length: n }, (_, k) => `w${k}`).join(" ");
}

function writeLines(file: string, entries: LogEntry[]): void {
	sandboxed();
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
}

/** Backfill holds 0..19 (older), live log 20..44, so a range can cross from one file to the other. */
function seedLog(count = 45): void {
	const upto = ENTRIES.slice(0, count);
	writeLines(ownerBackfillFile(), upto.slice(0, 20));
	writeLines(ownerLogFile(), upto.slice(20));
}

function sandboxConfig(topicsModel: string, topicsEvery = 30): Config {
	mkdirSync(QUEUE, { recursive: true });
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  queue_index: "${join(TMP, "INDEX.md")}"
  queue_state: "${QUEUE}"
  guard_log: "${join(TMP, "guard.log")}"
  plan_guard_log: "${join(TMP, "plan-guard.log")}"
rollover:
  enabled: false
recall:
  topics_model: "${topicsModel}"
  topics_every: ${topicsEvery}
`,
	);
	const cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	return cfg;
}

beforeEach(() => {
	sandboxed();
	sandboxConfig(MODEL);
	rmSync(ownerLogDir(), { recursive: true, force: true });
	markTopicsSpawned();
	seedLog();
});

// ---- fake model and answers ----------------------------------------------------------------

interface Req {
	model: string;
	system: string;
	prompt: string;
	maxTokens: number;
}
type Complete = (req: Req) => Promise<{ text: string; usage: { prompt_tokens: number; completion_tokens: number } }>;

/** A fake `complete` that answers from a script, one answer per call (the last repeats). */
function fakeComplete(answers: string[]): { complete: Complete; calls: Req[] } {
	const calls: Req[] = [];
	const complete: Complete = async (req) => {
		calls.push(req);
		const text = answers[Math.min(calls.length, answers.length) - 1] ?? "";
		return { text, usage: { prompt_tokens: 100, completion_tokens: 20 } };
	};
	return { complete, calls };
}

/** A fake `complete` whose gateway call errors. */
const failingComplete: Complete = async () => {
	throw new Error("gateway refused");
};

/** A fake `complete` whose gateway call times out. */
const timeoutComplete: Complete = async () => {
	const err = new Error("timed out");
	err.name = "TimeoutError";
	throw err;
};

interface SegIn {
	from: string;
	to: string;
	title: string;
	keywords: string[];
	decisions: { id: string; text: string }[];
	questions: { id: string; text: string }[];
	names: string[];
	continues: string | null;
}

/** A segment over indices from..to (inclusive), with the shared title and keyword. */
function seg(from: number, to: number, over: Partial<SegIn> = {}): SegIn {
	return {
		from: idOf(from),
		to: idOf(to),
		title: "Traces series ship order",
		keywords: ["traces series"],
		decisions: [],
		questions: [],
		names: [],
		continues: null,
		...over,
	};
}

/** The good answer for the 45-entry log: three segments, the last one left open by the run. */
function goodSegments(): SegIn[] {
	return [
		seg(0, 14, { decisions: [{ id: idOf(3), text: "ship the traces series first" }] }),
		seg(15, 29, { questions: [{ id: idOf(16), text: "is the zoom index ready" }] }),
		seg(30, 44),
	];
}

function answer(segments: unknown[]): string {
	return JSON.stringify({ segments });
}

function fileLines(): Record<string, unknown>[] {
	return readFileSync(topicsFile(), "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function readTopicsSafe(): unknown[] {
	try {
		return readTopics();
	} catch {
		return [];
	}
}

function modeOf(file: string): number {
	return statSync(file).mode & 0o777;
}

// ---- (a) answer -> lines ------------------------------------------------------------------

describe("topic answer becomes index lines", () => {
	test("a 45-entry log with a good answer appends one line per segment with the envelope fields", async () => {
		const cfg = sandboxConfig(MODEL);
		const g = goodSegments();
		const fc = fakeComplete([answer([{ ...g[0]!, bogus: "dropped" }, g[1], g[2]])]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(1);
		const lines = fileLines();
		expect(lines).toHaveLength(3);
		const first = lines[0]!;
		expect(Object.keys(first).toSorted()).toEqual(
			["at", "continues", "decisions", "from", "keywords", "names", "open", "questions", "title", "to"].toSorted(),
		);
		expect(first.from).toBe(idOf(0));
		expect(first.to).toBe(idOf(14));
		expect(first.open).toBe(false);
		expect(first.at).toEqual(expect.any(Number));
		expect(first.decisions).toEqual([{ id: idOf(3), text: "ship the traces series first" }]);
		expect(lines[2]!.open).toBe(true);
		expect(lines[2]!.to).toBe(idOf(44));
	});

	test("readTopics returns the effective index in order", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, fakeComplete([answer(goodSegments())]).complete, { close: false });
		const topics = readTopics();
		expect(topics.map((t) => [t.from, t.to])).toEqual([
			[idOf(0), idOf(14)],
			[idOf(15), idOf(29)],
			[idOf(30), idOf(44)],
		]);
	});
});

// ---- (b) checks ---------------------------------------------------------------------------

describe("checkSegments rejects each malformed answer", () => {
	const base = ENTRIES.slice(0, 45);

	test.each<[string, SegIn[]]>([
		["a gap", [seg(0, 4), seg(6, 14)]],
		["an overlap", [seg(0, 5), seg(5, 14)]],
		["ids out of log order", [seg(5, 14), seg(0, 4)]],
		["an id not in the log", [{ ...seg(0, 14), from: "NOT-AN-ID" }]],
		["a segment under 3 entries that is not last", [seg(0, 1), seg(2, 14)]],
		["more than 60 words", [seg(0, 14, { decisions: [{ id: idOf(3), text: invented(61) }] })]],
		["a title over 10 words", [seg(0, 14, { title: invented(11) })]],
		["a keyword over 6 words", [seg(0, 14, { keywords: ["a b c d e f g"] })]],
		["a decision id outside its segment", [seg(0, 14, { decisions: [{ id: idOf(20), text: "x" }] })]],
		["a question id on a main entry", [seg(0, 14, { questions: [{ id: idOf(3), text: "why" }] })]],
		["8 words copied in a row from an entry", [seg(0, 14, { title: "note 2 about the traces series and the" })]],
		["continues that is not a closed from", [seg(0, 14, { continues: idOf(7) })]],
	])("%s is an error", (_name, segments) => {
		expect(checkSegments(segments, base, [])).toEqual(expect.any(String));
	});

	test("more than 60 entries in one segment is an error", () => {
		expect(checkSegments([seg(0, 64)], ENTRIES, [])).toEqual(expect.any(String));
	});

	test("a continues that is the from of an earlier closed segment passes", () => {
		const earlier = [{ from: idOf(0), to: idOf(4) }];
		expect(checkSegments([seg(5, 14, { continues: idOf(0) })], base.slice(0, 15), earlier)).toBeNull();
	});

	test("the good answer passes", () => {
		expect(checkSegments(goodSegments(), base, [])).toBeNull();
	});
});

describe("a failed check gets one retry, then a skipped line", () => {
	const bad: [string, SegIn[]][] = [
		["a gap", [seg(0, 4), seg(6, 14), seg(15, 29), seg(30, 44)]],
		["an overlap", [seg(0, 15), seg(15, 29), seg(30, 44)]],
	];

	test("a segment under 3 entries that is not last folds into the next, with one call", async () => {
		const cfg = sandboxConfig(MODEL);
		const fc = fakeComplete([answer([seg(0, 1), seg(2, 29), seg(30, 44)])]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(1);
		expect(readTopics().map((t) => [t.from, t.to])).toEqual([
			[idOf(0), idOf(29)],
			[idOf(30), idOf(44)],
		]);
	});

	test("a question id on a main entry is dropped, the segment is kept, with one call", async () => {
		const cfg = sandboxConfig(MODEL);
		const fc = fakeComplete([
			answer([seg(0, 14, { questions: [{ id: idOf(3), text: "why" }] }), seg(15, 29), seg(30, 44)]),
		]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(1);
		const topics = readTopics();
		expect(topics).toHaveLength(3);
		expect(topics[0]!.questions).toEqual([]);
	});

	test.each(bad)("%s: retry carries the error, the good retry is appended", async (_name, segments) => {
		const cfg = sandboxConfig(MODEL);
		const fc = fakeComplete([answer(segments), answer(goodSegments())]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(2);
		expect(fc.calls[1]!.prompt).not.toBe(fc.calls[0]!.prompt);
		expect(fileLines()).toHaveLength(3);
	});

	test("two failures append one skipped line over the window's new entries", async () => {
		const cfg = sandboxConfig(MODEL);
		const fc = fakeComplete(["not json", "not json"]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(2);
		const lines = fileLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual({
			from: idOf(0),
			to: idOf(44),
			at: expect.any(Number),
			skipped: true,
			why: expect.any(String),
		});
	});

	test("a skipped line is a closing boundary: the next run starts after its to", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, fakeComplete(["not json", "not json"]).complete, { close: false });
		writeLines(ownerLogFile(), ENTRIES.slice(20, 50));
		const next = fakeComplete([answer([seg(45, 49)])]);
		await runTopics(cfg, next.complete, { close: false });
		expect(next.calls).toHaveLength(1);
		expect(next.calls[0]!.prompt).toContain("[1] (");
		expect(next.calls[0]!.prompt).toContain("[5] (");
		expect(next.calls[0]!.prompt).not.toContain("[6] (");
	});

	test("a model that answers with the prompt's entry numbers gets them stored as entry ids", async () => {
		const cfg = sandboxConfig(MODEL);
		const numbered = [
			seg(0, 14, { from: "1", to: "15", decisions: [{ id: "4", text: "ship the traces series first" }] }),
			seg(15, 29, { from: "16", to: "30", questions: [{ id: "17", text: "is the zoom index ready" }] }),
			seg(30, 44, { from: "31", to: "45" }),
		];
		await runTopics(cfg, fakeComplete([answer(numbered)]).complete, { close: false });
		const topics = readTopics();
		expect(topics.map((t) => [t.from, t.to])).toEqual([
			[idOf(0), idOf(14)],
			[idOf(15), idOf(29)],
			[idOf(30), idOf(44)],
		]);
		expect(topics[0]!.decisions[0]!.id).toBe(idOf(3));
		expect(topics[1]!.questions[0]!.id).toBe(idOf(16));
	});
});

// ---- (c) re-cut, (d) close ----------------------------------------------------------------

describe("re-cut and close", () => {
	test("a second run re-sends the open last segment and the new entries; the effective index has no gap or overlap", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, fakeComplete([answer(goodSegments())]).complete, { close: false });
		writeLines(ownerLogFile(), ENTRIES.slice(20, 55));
		const fc = fakeComplete([answer([seg(30, 40), seg(41, 54)])]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(1);
		expect(fc.calls[0]!.prompt).toContain("[1] (");
		expect(fc.calls[0]!.prompt).toContain("[25] (");
		expect(fc.calls[0]!.prompt).not.toContain("[26] (");
		const topics = readTopics();
		expect(topics.map((t) => [t.from, t.to])).toEqual([
			[idOf(0), idOf(14)],
			[idOf(15), idOf(29)],
			[idOf(30), idOf(40)],
			[idOf(41), idOf(54)],
		]);
	});

	test("close appends a closed copy of the open line with no model call, and the next run does not re-send it", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, fakeComplete([answer(goodSegments())]).complete, { close: false });
		const closer = fakeComplete([]);
		await runTopics(cfg, closer.complete, { close: true });
		expect(closer.calls).toHaveLength(0);
		const last = readTopics().at(-1)!;
		expect(last).toMatchObject({ from: idOf(30), to: idOf(44), open: false });

		writeLines(ownerLogFile(), ENTRIES.slice(20, 50));
		const next = fakeComplete([answer([seg(45, 49)])]);
		await runTopics(cfg, next.complete, { close: false });
		expect(next.calls[0]!.prompt).toContain("[5] (");
		expect(next.calls[0]!.prompt).not.toContain("[6] (");
	});
});

// ---- (e) errors append nothing -------------------------------------------------------------

describe("errors append nothing", () => {
	test("a model error appends nothing", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, failingComplete, { close: false });
		expect(readTopicsSafe()).toEqual([]);
	});

	test("a timeout appends nothing", async () => {
		const cfg = sandboxConfig(MODEL);
		await runTopics(cfg, timeoutComplete, { close: false });
		expect(readTopicsSafe()).toEqual([]);
	});

	test("topics_model empty means off: no call, no lines", async () => {
		const cfg = sandboxConfig("");
		const fc = fakeComplete([answer(goodSegments())]);
		await runTopics(cfg, fc.complete, { close: false });
		expect(fc.calls).toHaveLength(0);
		expect(readTopicsSafe()).toEqual([]);
	});
});

// ---- (f) secrets never reach the index ----------------------------------------------------

describe("planted secrets", () => {
	test("an sk-ant token in a fake answer never reaches owner-topics.jsonl", async () => {
		const cfg = sandboxConfig(MODEL);
		const token = `sk-ant-api03-${"A".repeat(40)}`;
		const g = goodSegments();
		await runTopics(cfg, fakeComplete([answer([{ ...g[0]!, title: `leak ${token}` }, g[1], g[2]])]).complete, {
			close: false,
		});
		const raw = readFileSync(topicsFile(), "utf8");
		expect(raw).not.toContain(token);
		expect(raw).not.toContain("sk-ant-api03-");
	});
});

// ---- (m) modes ----------------------------------------------------------------------------

describe("modes", () => {
	test("after a run the recall dir is 0700 and the topics file is 0600, also when they pre-existed looser", async () => {
		sandboxed();
		const cfg = sandboxConfig(MODEL);
		mkdirSync(ownerLogDir(), { recursive: true });
		chmodSync(ownerLogDir(), 0o755);
		writeFileSync(topicsFile(), "", { mode: 0o644 });
		chmodSync(topicsFile(), 0o644);
		await runTopics(cfg, fakeComplete([answer(goodSegments())]).complete, { close: false });
		expect(modeOf(ownerLogDir())).toBe(0o700);
		expect(modeOf(topicsFile())).toBe(0o600);
	});
});

// ---- (n) order, (o) boundary ---------------------------------------------------------------

describe("ranges and windows", () => {
	test("newEntries and rangeEntries are oldest first across backfill and live log", () => {
		expect(newEntries().map((e) => e.id)).toEqual(ENTRIES.slice(0, 45).map((e) => e.id));
		expect(rangeEntries(idOf(15), idOf(25)).map((e) => e.id)).toEqual(ENTRIES.slice(15, 26).map((e) => e.id));
	});

	test("newEntries is exclusive of its id; rangeEntries is inclusive at both ends", () => {
		expect(newEntries(idOf(40)).map((e) => e.id)).toEqual([idOf(41), idOf(42), idOf(43), idOf(44)]);
		expect(rangeEntries(idOf(30), idOf(30)).map((e) => e.id)).toEqual([idOf(30)]);
	});

	test("consecutive windows cover each entry once", () => {
		const windows = [rangeEntries(idOf(0), idOf(14)), rangeEntries(idOf(15), idOf(29)), newEntries(idOf(29))];
		const ids = windows.flatMap((w) => w.map((e) => e.id));
		expect(ids).toEqual(ENTRIES.slice(0, 45).map((e) => e.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

// ---- (p) fresh machine --------------------------------------------------------------------

describe("fresh machine", () => {
	test("no recall dir and no log: the run creates the dir at 0700 and does not throw", async () => {
		sandboxed();
		const cfg = sandboxConfig(MODEL);
		rmSync(ownerLogDir(), { recursive: true, force: true });
		const fc = fakeComplete([answer(goodSegments())]);
		await expect(runTopics(cfg, fc.complete, { close: false })).resolves.toBeDefined();
		expect(fc.calls).toHaveLength(0);
		expect(modeOf(ownerLogDir())).toBe(0o700);
	});
});

// ---- (i) trigger and (j) isolation, through the adapter with a fake host -------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Spawn {
	args: string[];
	env: NodeJS.ProcessEnv;
}

function fakeHost(): {
	host: ExtensionHost;
	events: () => string[];
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
	sent: string[];
} {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const host: ExtensionHost = {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb as Handler]);
		},
		registerCommand() {},
		sendUserMessage(content) {
			sent.push(typeof content === "string" ? content : JSON.stringify(content));
		},
		sendMessage(message) {
			sent.push(message.content);
		},
	};
	return {
		host,
		events: () => [...handlers.keys()],
		sent,
		async emit(event, payload, ctx) {
			const results = await Promise.all((handlers.get(event) ?? []).map((cb) => cb(payload, ctx)));
			return results.filter((r) => r !== undefined);
		},
	};
}

function mainCtx(spawns: Spawn[]): Record<string, unknown> {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		spawnTopics(args: string[], env: NodeJS.ProcessEnv) {
			spawns.push({ args, env });
		},
	};
}

function turnEndPayload(text: string): unknown {
	return { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] };
}

describe("trigger and isolation", () => {
	test("topicsDue is true only at count >= every", () => {
		expect(topicsDue(4, 5)).toBe(false);
		expect(topicsDue(5, 5)).toBe(true);
		expect(topicsDue(6, 5)).toBe(true);
	});

	test("a Main turn end that reaches topics_every spawns one detached recall topics child, resets the count, and returns", async () => {
		sandboxConfig(MODEL, 5);
		resetAdapter();
		markTopicsSpawned();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const spawns: Spawn[] = [];
		for (let k = 0; k < 5; k++) appendOwnerLog("main", `main line ${k}`);
		expect(appendedSinceSpawn()).toBe(5);
		process.env[MAIN_ENV] = "1";
		try {
			await f.emit("agent_end", turnEndPayload("done"), mainCtx(spawns));
		} finally {
			delete process.env[MAIN_ENV];
		}
		expect(spawns).toHaveLength(1);
		expect(spawns[0]!.args).toEqual(["recall", "topics"]);
		expect(spawns[0]!.env[MAIN_ENV]).toBeUndefined();
		expect(appendedSinceSpawn()).toBe(0);
	});

	test("below topics_every: a turn end spawns nothing and keeps the count", async () => {
		sandboxConfig(MODEL, 5);
		resetAdapter();
		markTopicsSpawned();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const spawns: Spawn[] = [];
		for (let k = 0; k < 4; k++) appendOwnerLog("main", `main line ${k}`);
		await f.emit("agent_end", turnEndPayload("done"), mainCtx(spawns));
		expect(spawns).toHaveLength(0);
		expect(appendedSinceSpawn()).toBe(4);
	});

	test("topics_model empty: a due turn end and a shutdown spawn nothing and keep the count", async () => {
		sandboxConfig("", 5);
		resetAdapter();
		markTopicsSpawned();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const spawns: Spawn[] = [];
		for (let k = 0; k < 5; k++) appendOwnerLog("main", `main line ${k}`);
		await f.emit("agent_end", turnEndPayload("done"), mainCtx(spawns));
		await f.emit("session_shutdown", {}, mainCtx(spawns));
		expect(spawns).toHaveLength(0);
		expect(appendedSinceSpawn()).toBe(5);
	});

	test("a sub session spawns nothing, due or not, on turn end or shutdown", async () => {
		sandboxConfig(MODEL, 5);
		resetAdapter();
		markTopicsSpawned();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const spawns: Spawn[] = [];
		const sub = {
			agent: { kind: "sub", id: "sub-1" },
			spawnTopics(args: string[], env: NodeJS.ProcessEnv) {
				spawns.push({ args, env });
			},
		};
		for (let k = 0; k < 5; k++) appendOwnerLog("main", `main line ${k}`);
		await f.emit("agent_end", turnEndPayload("done"), sub);
		await f.emit("session_shutdown", {}, sub);
		expect(spawns).toHaveLength(0);
		expect(appendedSinceSpawn()).toBe(5);
	});

	test("a Main session_shutdown spawns recall topics --close with MAIN_ENV dropped", async () => {
		sandboxConfig(MODEL, 5);
		resetAdapter();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const spawns: Spawn[] = [];
		process.env[MAIN_ENV] = "1";
		try {
			await f.emit("session_shutdown", {}, mainCtx(spawns));
		} finally {
			delete process.env[MAIN_ENV];
		}
		expect(spawns.map((s) => s.args)).toEqual([["recall", "topics", "--close"]]);
		expect(spawns[0]!.env[MAIN_ENV]).toBeUndefined();
	});

	test("a distinctive topic title never reaches Main's rules or any injected text", async () => {
		const cfg = sandboxConfig(MODEL);
		const marker = "ZQXV distinctive heading";
		const g = goodSegments();
		await runTopics(cfg, fakeComplete([answer([{ ...g[0]!, title: marker }, g[1], g[2]])]).complete, {
			close: false,
		});
		resetAdapter();
		const f = fakeHost();
		createOmpAdapter(f.host, loadConfig({ home: HOME, env: {} }));
		const results = await Promise.all(f.events().map((event) => f.emit(event, turnEndPayload("hello"), mainCtx([]))));
		expect(JSON.stringify(results)).not.toContain("ZQXV");
		expect(f.sent.join("\n")).not.toContain("ZQXV");
	});
});
