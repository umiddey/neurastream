// P7 (plan 20261109_2335): the topic layer through `recall` (search, topics run, --close, stats).
// Red until src/core/owner-topics.ts and the topics branch of src/cli/recall.ts exist: the imports
// below are what fail. No live model: `omp` on PATH is a stub script in a tmp bin dir, and it is
// only reached through the `complete` path (ompComplete). HOME, the clock and the queue state are a
// sandbox under a tmp dir.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { ownerBackfillFile, ownerLogDir, ownerLogFile, type LogEntry } from "../src/core/owner-log.ts";
import { topicsFile } from "../src/core/owner-topics.ts";
import { tryLock } from "../src/core/file-lock.ts";
import { recallCli } from "../src/cli/recall.ts";

const TMP = mkdtempSync(join(tmpdir(), "recall-topics-cli-"));
const HOME = join(TMP, "home");
const QUEUE = join(TMP, "queue-state");
const BIN = join(TMP, "bin");
const NOW_SEC = 1_795_000_000;
const MODEL = "fake/topic-model";
const MARKER = "ZQXM distinctive heading";
const SECRET = `sk-ant-api03-${"B".repeat(40)}`;

const homeBefore = process.env.HOME;
const nowBefore = process.env.NEURASTREAM_NOW;
const pathBefore = process.env.PATH;
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
process.env.HOME = HOME;
process.env.NEURASTREAM_NOW = String(NOW_SEC);
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

beforeAll(() => {
	mkdirSync(BIN, { recursive: true });
	// Stub `omp`: reads the one request line, logs it when FAKE_OMP_CALLS is set, then answers the
	// gateway protocol with FAKE_OMP_ANSWER (or "not json" in bad mode, or exits 3 in exit mode).
	writeFileSync(
		join(BIN, "omp"),
		`#!${process.execPath}
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
if (process.env.FAKE_OMP_CALLS) fs.appendFileSync(process.env.FAKE_OMP_CALLS, input);
const mode = process.env.FAKE_OMP_MODE ?? "ok";
if (mode === "exit") process.exit(3);
const content = mode === "bad" ? "not json" : (process.env.FAKE_OMP_ANSWER ?? "");
const body = { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
process.stdout.write(JSON.stringify({ ready: true, protocol: 1 }) + "\\n" + JSON.stringify({ id: 1, status: 200, body }) + "\\n");
`,
	);
	chmodSync(join(BIN, "omp"), 0o755);
	process.env.PATH = `${BIN}:${pathBefore ?? ""}`;
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	process.env.PATH = pathBefore;
	for (const k of ["FAKE_OMP_MODE", "FAKE_OMP_ANSWER", "FAKE_OMP_CALLS"]) delete process.env[k];
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (homeBefore === undefined) delete process.env.HOME;
	else process.env.HOME = homeBefore;
	if (nowBefore === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = nowBefore;
});

// ---- fixtures ------------------------------------------------------------------------------

function idOf(i: number): string {
	return i.toString(36).padStart(9, "0") + (0xabc00000 + i).toString(16);
}

function entryAt(i: number, text?: string): LogEntry {
	const owner = i % 2 === 0;
	return {
		id: idOf(i),
		at: NOW_SEC - (100 - i) * 600,
		role: owner ? "owner" : "main",
		text: text ?? (owner ? `owner note ${i} about the traces series and the zoom index` : `main answer ${i} on the traces series and the zoom index`),
	};
}

const ENTRIES = Array.from({ length: 70 }, (_, i) => entryAt(i));

function writeLines(file: string, entries: LogEntry[]): void {
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
}

/** Backfill 0..19, live log 20..44 (45 entries), unless `entries` is given. */
function seedLog(entries: LogEntry[] = ENTRIES.slice(0, 45)): void {
	rmSync(ownerLogDir(), { recursive: true, force: true });
	writeLines(ownerBackfillFile(), entries.slice(0, 20));
	writeLines(ownerLogFile(), entries.slice(20));
}

function cfgWith(topicsModel: string, topicsEvery = 30): Config {
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

interface SegOut {
	from: string;
	to: string;
	at: number;
	open: boolean;
	title: string;
	keywords: string[];
	decisions: { id: string; text: string }[];
	questions: { id: string; text: string }[];
	names: string[];
	continues: string | null;
}

function topicLine(from: number, to: number, over: Partial<SegOut> = {}): SegOut {
	return {
		from: idOf(from),
		to: idOf(to),
		at: NOW_SEC,
		open: false,
		title: "Traces series ship order",
		keywords: ["traces series"],
		decisions: [{ id: idOf(3), text: "ship the traces series first" }],
		questions: [],
		names: [],
		continues: null,
		...over,
	};
}

function writeTopics(lines: (SegOut | string)[]): void {
	mkdirSync(ownerLogDir(), { recursive: true, mode: 0o700 });
	writeFileSync(topicsFile(), lines.map((l) => (typeof l === "string" ? `${l}\n` : `${JSON.stringify(l)}\n`)).join(""), { mode: 0o600 });
}

// ---- running the CLI in-process, with console output captured -------------------------------

async function runAsync(args: string[], cfg: Config): Promise<{ code: number; out: string }> {
	const seen: string[] = [];
	const sink = (...parts: unknown[]): void => {
		seen.push(parts.map(String).join(" "));
	};
	const log = console.log;
	const err = console.error;
	console.log = sink;
	console.error = sink;
	try {
		const code = await recallCli(args, cfg);
		return { code, out: seen.join("\n") };
	} finally {
		console.log = log;
		console.error = err;
	}
}

function callCount(file: string): number {
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0).length : 0;
}

const STATS = /segments \d+ .*entries .*mean .*median .*p90 .*min .*max .*per day .*lag .*p90 .*tokens .*calls .*skipped/;

// ---- (e) lock, off ---------------------------------------------------------------------------

test("a held lock: topics exits 0 with the lock message and calls nothing", async () => {
	seedLog();
	const cfg = cfgWith(MODEL);
	const calls = join(TMP, "calls-lock.txt");
	process.env.FAKE_OMP_CALLS = calls;
	process.env.FAKE_OMP_ANSWER = JSON.stringify({ segments: [topicLine(0, 44)] });
	const held = tryLock(join(ownerLogDir(), "owner-topics.lock"));
	expect(held).not.toBeNull();
	try {
		const r = await runAsync(["topics"], cfg);
		expect(r.code).toBe(0);
		expect(r.out).toContain("topics: another run holds the lock");
		expect(callCount(calls)).toBe(0);
	} finally {
		held!.release();
		delete process.env.FAKE_OMP_CALLS;
		delete process.env.FAKE_OMP_ANSWER;
	}
});

test("a --close that finds the lock held exits 0 and changes nothing", async () => {
	seedLog();
	writeTopics([topicLine(0, 44, { open: true })]);
	const before = readFileSync(topicsFile(), "utf8");
	const held = tryLock(join(ownerLogDir(), "owner-topics.lock"));
	expect(held).not.toBeNull();
	try {
		const r = await runAsync(["topics", "--close"], cfgWith(MODEL));
		expect(r.code).toBe(0);
		expect(readFileSync(topicsFile(), "utf8")).toBe(before);
	} finally {
		held!.release();
	}
});

test("topics_model empty: topics exits 0 with `topics: off` and calls nothing", async () => {
	seedLog();
	const calls = join(TMP, "calls-off.txt");
	process.env.FAKE_OMP_CALLS = calls;
	try {
		const r = await runAsync(["topics"], cfgWith(""));
		expect(r.code).toBe(0);
		expect(r.out).toContain("topics: off");
		expect(callCount(calls)).toBe(0);
	} finally {
		delete process.env.FAKE_OMP_CALLS;
	}
});

// ---- (g) search with topics ------------------------------------------------------------------

test("with no topics file, and with a file holding only one broken line, search output is byte-identical", async () => {
	seedLog();
	const cfg = cfgWith(MODEL);
	rmSync(topicsFile(), { force: true });
	const none = await runAsync(["traces"], cfg);
	writeTopics(["this is not json {"]);
	const broken = await runAsync(["traces"], cfg);
	expect(broken.out).toBe(none.out);
});

test("one valid topic lists its segment first, with the range and the title", async () => {
	seedLog();
	writeTopics(["this is not json {", topicLine(0, 14)]);
	const r = await runAsync(["traces"], cfgWith(MODEL));
	expect(r.code).toBe(0);
	const first = r.out.split("\n")[0] ?? "";
	expect(first).toContain(`${idOf(0)}..${idOf(14)}`);
	expect(first).toContain("Traces series ship order");
});

test("a skipped stretch is still found by its raw words", async () => {
	seedLog();
	writeTopics([topicLine(0, 14), { from: idOf(15), to: idOf(29), at: NOW_SEC, skipped: true, why: "two failures" }]);
	const r = await runAsync(["zoom"], cfgWith(MODEL));
	expect(r.out).toContain("owner note 16");
});

test("--show a range prints every entry in it whole", async () => {
	seedLog();
	writeTopics([topicLine(15, 29)]);
	const r = await runAsync(["--show", `${idOf(15)}..${idOf(20)}`], cfgWith(MODEL));
	expect(r.code).toBe(0);
	for (let i = 15; i <= 20; i++) expect(r.out).toContain(ENTRIES[i]!.text);
	expect(r.out).not.toContain(ENTRIES[21]!.text);
});

test("--json rows carry kind topic or entry", async () => {
	seedLog();
	writeTopics([topicLine(0, 14)]);
	const r = await runAsync(["traces", "--json"], cfgWith(MODEL));
	const rows = r.out
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => JSON.parse(l) as { kind: string });
	expect(rows.some((row) => row.kind === "topic")).toBe(true);
	expect(rows.some((row) => row.kind === "entry")).toBe(true);
	expect(rows.every((row) => row.kind === "topic" || row.kind === "entry")).toBe(true);
});

// ---- (h) stats line, (m) failures, (p) fresh, (q) internal -----------------------------------

test("a topics run ends with the stats line and calls the stub once per window", async () => {
	seedLog();
	const calls = join(TMP, "calls-ok.txt");
	process.env.FAKE_OMP_CALLS = calls;
	process.env.FAKE_OMP_ANSWER = JSON.stringify({
		segments: [topicLine(0, 14), topicLine(15, 29), topicLine(30, 44, { open: true })],
	});
	try {
		const r = await runAsync(["topics"], cfgWith(MODEL));
		expect(r.code).toBe(0);
		expect(r.out.split("\n").at(-1)).toMatch(STATS);
		expect(callCount(calls)).toBe(1);
	} finally {
		delete process.env.FAKE_OMP_CALLS;
		delete process.env.FAKE_OMP_ANSWER;
	}
});

test("a backfill-only log reports lag n/a on the stats line", async () => {
	seedLog(ENTRIES.slice(0, 20));
	process.env.FAKE_OMP_ANSWER = JSON.stringify({ segments: [topicLine(0, 14), topicLine(15, 19, { open: true })] });
	try {
		const r = await runAsync(["topics"], cfgWith(MODEL));
		expect(r.out.split("\n").at(-1)).toContain("lag n/a");
	} finally {
		delete process.env.FAKE_OMP_ANSWER;
	}
});

test("a run whose answers fail writes only `topics: fail` lines, with no marker, secret or request text", async () => {
	seedLog(ENTRIES.slice(0, 45).map((e, i) => (i === 3 ? entryAt(3, `${MARKER} ${SECRET}`) : e)));
	process.env.FAKE_OMP_ANSWER = `not json ${MARKER} ${SECRET}`;
	try {
		const r = await runAsync(["topics"], cfgWith(MODEL));
		const lines = r.out.split("\n").filter((l) => l !== "");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line).toMatch(/^topics: /);
		expect(lines.some((l) => /^topics: fail \S+\.\.\S+ \S+ in=\d+ out=\d+$/.test(l))).toBe(true);
		expect(r.out).not.toContain(MARKER);
		expect(r.out).not.toContain(SECRET);
	} finally {
		delete process.env.FAKE_OMP_ANSWER;
	}
});

test("a run on a fresh machine (no recall dir, no log) exits 0 with no ENOENT and makes a 0700 dir", async () => {
	rmSync(ownerLogDir(), { recursive: true, force: true });
	rmSync(ownerBackfillFile(), { force: true });
	rmSync(ownerLogFile(), { force: true });
	const r = await runAsync(["topics"], cfgWith(MODEL));
	expect(r.code).toBe(0);
	expect(r.out).not.toContain("ENOENT");
	expect(statSync(ownerLogDir()).mode & 0o777).toBe(0o700);
});

test("a topics path that is a directory reports the reason code `internal` and not the message", async () => {
	seedLog();
	rmSync(topicsFile(), { force: true });
	mkdirSync(topicsFile(), { recursive: true });
	process.env.FAKE_OMP_ANSWER = JSON.stringify({ segments: [topicLine(0, 44, { open: true })] });
	try {
		const r = await runAsync(["topics"], cfgWith(MODEL));
		expect(r.out).toContain("internal");
		expect(r.out).not.toContain("EISDIR");
		expect(r.out).not.toContain("owner-topics.jsonl");
	} finally {
		delete process.env.FAKE_OMP_ANSWER;
		rmSync(topicsFile(), { recursive: true, force: true });
	}
});
