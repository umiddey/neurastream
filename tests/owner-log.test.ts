// P1 (plan 20261109_2335, owner-log): the recall log's write path, ids, redaction, failure
// isolation, file modes and the backfill from session files. Red until src/core/owner-log.ts
// exists: the import below is what fails. Every path is a sandbox under a tmp dir; HOME and the
// clock are pinned, so no real home, queue or session is read.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { checkInject } from "../src/core/guards.ts";
import { ownerMessagesFile } from "../src/core/incidents.ts";
import { createOmpAdapter, reset as resetAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import {
	appendOwnerLog,
	backfillOwnerLog,
	newEntryId,
	ownerBackfillFile,
	ownerLogDir,
	ownerLogFile,
	readLines,
} from "../src/core/owner-log.ts";

const TMP = mkdtempSync(join(tmpdir(), "owner-log-"));
const HOME = join(TMP, "home");
const QUEUE = join(TMP, "queue-state");
const SESSIONS = join(TMP, "sessions");
const NOW_SEC = 1762000000;
const NOW_MS = NOW_SEC * 1000;
const ID_RE = /^[0-9a-z]{9}[0-9a-f]{8}$/;
const FIXED_BYTES = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
// The injected byte source for the same-id test: always the same four bytes.
const fixedBytes = (): Uint8Array => FIXED_BYTES;

// The sandbox wins over the caller's shell: HOME and the clock are pinned, and QUEUE_* is put back
// at the end (applyQueueEnv sets every QUEUE_* path).
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
});

/** A clean sandbox: empty queue state and sessions root, a config written to HOME, queue env applied. */
function freshSandbox(extra = ""): Config {
	rmSync(QUEUE, { recursive: true, force: true });
	rmSync(SESSIONS, { recursive: true, force: true });
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
adapter:
  sessions: "${SESSIONS}"
rollover:
  enabled: false
${extra}`,
	);
	const cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
	return cfg;
}

/** Parsed JSON lines of a file; [] when it does not exist. */
function lines(file: string): Record<string, unknown>[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line !== "")
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

const mode = (path: string): number => statSync(path).mode & 0o777;

/** A deterministic byte source: a fixed-seed LCG, so id tests cannot flake. */
function seededBytes(seed: number): (n: number) => Uint8Array {
	let s = seed >>> 0;
	return n => {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			out[i] = s >>> 24;
		}
		return out;
	};
}

/** Fill the live log with n owner lines (the 10,000-line case). */
function fillLog(n: number): void {
	mkdirSync(ownerLogDir(), { recursive: true });
	const body = Array.from({ length: n }, (_, i) =>
		JSON.stringify({ id: newEntryId(NOW_MS + i), at: NOW_SEC + i, role: "owner", text: `line ${i}` }),
	).join("\n");
	writeFileSync(ownerLogFile(), `${body}\n`);
}

type Handler = (event: unknown, ctx: unknown) => unknown;
const MAIN_CTX = { agent: { kind: "main" } };

/** The omp adapter over a fake host that keeps every handler per event, in registration order. */
function ompHost(cfg: Config): { fire: (name: string, event: unknown) => void } {
	resetAdapter();
	const handlers = new Map<string, Handler[]>();
	const host = {
		on: (name: string, cb: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), cb]);
		},
	};
	createOmpAdapter(host as unknown as ExtensionHost, cfg);
	return {
		fire: (name, event) => {
			for (const cb of handlers.get(name) ?? []) cb(event, MAIN_CTX);
		},
	};
}

/** A Main turn that ends with a plain text reply: the event the adapter's session_stop reads. */
function stopEvent(text: string): unknown {
	return { last_assistant_message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } };
}

// ---- (a) write path, ids, size and order ----

test("(a) an owner inject appends one line: id, timestamp, role owner and the text", () => {
	const cfg = freshSandbox();
	checkInject({ agent: "main", inject: "The owner wants the traces series first" }, cfg);
	const rows = lines(ownerLogFile());
	expect(rows.length).toBe(1);
	expect(rows).toMatchObject([{ role: "owner", text: "The owner wants the traces series first" }]);
	expect(String(rows[0]?.id)).toMatch(ID_RE);
	expect(typeof rows[0]?.at).toBe("number");
});

test("(a) a Main turn end appends one line with role main", () => {
	const cfg = freshSandbox();
	ompHost(cfg).fire("session_stop", stopEvent("Done: the traces series ships first."));
	const rows = lines(ownerLogFile());
	expect(rows.length).toBe(1);
	expect(rows).toMatchObject([{ role: "main", text: "Done: the traces series ships first." }]);
	expect(String(rows[0]?.id)).toMatch(ID_RE);
});

test("(a) 1,000 appends under one frozen millisecond give 1,000 distinct ids", () => {
	freshSandbox();
	const rand = seededBytes(7);
	const ids = new Set<string>();
	for (let i = 0; i < 1000; i++) ids.add(appendOwnerLog("owner", `message ${i}`, { atMs: NOW_MS, rand }));
	expect(ids.size).toBe(1000);
	expect(lines(ownerLogFile()).length).toBe(1000);
});

test("(a) one append to a 10,000-line log adds exactly one line and leaves the earlier bytes identical", () => {
	freshSandbox();
	fillLog(10000);
	const before = readFileSync(ownerLogFile());
	appendOwnerLog("owner", "one more", { atMs: NOW_MS + 100000, rand: seededBytes(9) });
	const after = readFileSync(ownerLogFile());
	expect(after.length).toBeGreaterThan(before.length);
	expect(Buffer.compare(after.subarray(0, before.length), before)).toBe(0);
	expect(lines(ownerLogFile()).length).toBe(10001);
});

test("(a) the same frozen clock and stubbed bytes give the same id whether the log is empty or has 10,000 lines", () => {
	freshSandbox();
	const empty = appendOwnerLog("owner", "first", { atMs: NOW_MS, rand: fixedBytes });
	rmSync(ownerLogFile(), { force: true });
	fillLog(10000);
	const full = appendOwnerLog("owner", "first", { atMs: NOW_MS, rand: fixedBytes });
	expect(full).toBe(empty);
	expect(full).toMatch(ID_RE);
});

test("(a) a rollover handoff logs only the owner's part of the prompt", () => {
	const cfg = freshSandbox();
	checkInject(
		{
			agent: "main",
			inject: "Previous session file: /tmp/old-session.jsonl\nA long handoff body that is not the owner's.\nOwner's message: please ship the traces series",
		},
		cfg,
	);
	expect(lines(ownerLogFile())).toMatchObject([{ role: "owner", text: "please ship the traces series" }]);
});

test("(a) owner text that starts with < is logged as sent", () => {
	const cfg = freshSandbox();
	checkInject({ agent: "main", inject: "<b>keep this</b>" }, cfg);
	expect(lines(ownerLogFile())).toMatchObject([{ role: "owner", text: "<b>keep this</b>" }]);
});

// ---- (b) prompts that are not owner prose ----

test("(b) main-guard, system-notice and task-result prompts append nothing", () => {
	const cfg = freshSandbox();
	checkInject({ agent: "main", inject: "main-guard: continue the plan" }, cfg);
	checkInject({ agent: "main", inject: "<system-notice> harness notice" }, cfg);
	checkInject({ agent: "main", inject: "<task-result id=1>done</task-result>" }, cfg);
	expect(lines(ownerLogFile())).toEqual([]);
});

// ---- (c) the owner-messages store is untouched ----

test("(c) after 60 owner messages the log holds 60 and owner-messages.jsonl holds only the newest 50", () => {
	const cfg = freshSandbox();
	for (let i = 0; i < 60; i++) checkInject({ agent: "main", inject: `owner message ${i}` }, cfg);
	expect(lines(ownerLogFile()).length).toBe(60);
	const store = lines(ownerMessagesFile());
	expect(store.length).toBe(50);
	expect(store[0]).toMatchObject({ text: "owner message 10" });
	expect(store[49]).toMatchObject({ text: "owner message 59" });
	for (const row of store) {
		expect(row).not.toHaveProperty("role");
		expect(row).not.toHaveProperty("id");
	}
});

// ---- (d) secrets never reach the log ----

test("(d) planted secrets never reach the log, with secrets.redact on or off", () => {
	const SK = `sk-ant-api03-${"AbCd0123".repeat(5)}`;
	const NPM = "npm_SandboxTokenValue0123456789ab";
	writeFileSync(join(HOME, ".npmrc"), `//registry.npmjs.org/:_authToken=${NPM}\n`);
	const extra = `secrets:
  extra_patterns:
    - type: sandbox
      regex: "SANDBOX-EXTRA-[0-9]+"
`;
	for (const redact of [true, false]) {
		const cfg = freshSandbox(extra.replace("secrets:\n", `secrets:\n  redact: ${redact}\n`));
		checkInject({ agent: "main", inject: `token ${SK} and ${NPM} and SANDBOX-EXTRA-42` }, cfg);
		const raw = readFileSync(ownerLogFile(), "utf8");
		expect(lines(ownerLogFile()).length).toBe(1);
		expect(raw).not.toContain(SK);
		expect(raw).not.toContain(NPM);
		expect(raw).not.toContain("SANDBOX-EXTRA-42");
	}
});

// ---- (e) failure isolation ----

test("(e) an unwritable log dir does not throw from the inject or the turn end", () => {
	const cfg = freshSandbox();
	// A regular file where the recall dir should be: every mkdir/append under it fails.
	writeFileSync(ownerLogDir(), "not a directory");
	expect(() => checkInject({ agent: "main", inject: "owner text" }, cfg)).not.toThrow();
	expect(() => ompHost(cfg).fire("session_stop", stopEvent("reply text"))).not.toThrow();
});

test("(e) an unwritable owner-messages.jsonl still lets the owner and Main entries reach the log", () => {
	const cfg = freshSandbox();
	// A directory where the store file should be: the store write fails, the log must not.
	mkdirSync(ownerMessagesFile(), { recursive: true });
	expect(() => checkInject({ agent: "main", inject: "owner text kept" }, cfg)).not.toThrow();
	ompHost(cfg).fire("session_stop", stopEvent("main reply kept"));
	expect(lines(ownerLogFile())).toMatchObject([
		{ role: "owner", text: "owner text kept" },
		{ role: "main", text: "main reply kept" },
	]);
});

// ---- (f) reading: readLines walks backwards across buffers ----

test("(f) readLines yields lines newest first across the 64 KiB buffer, a longer-than-buffer line, and an unterminated last line", () => {
	freshSandbox();
	mkdirSync(ownerLogDir(), { recursive: true });
	const file = join(ownerLogDir(), "reader.jsonl");
	const many = Array.from({ length: 3000 }, (_, i) => `row ${i} ${"p".repeat(40)}`);
	const all = [...many.slice(0, 1500), "b".repeat(70 * 1024), ...many.slice(1500)];
	writeFileSync(file, `${all.join("\n")}\nlast without newline`);
	expect([...readLines(file)]).toEqual(["last without newline", ...all.toReversed()]);
	expect([...readLines(join(ownerLogDir(), "missing.jsonl"))]).toEqual([]);
});

// ---- (i) backfill from the session files ----

/** One session-file line: a user prompt, or an assistant reply that ended on stop. */
function turn(ts: string, role: "user" | "assistant", text: string): string {
	const message = role === "assistant" ? { role, stopReason: "stop", content: [{ type: "text", text }] } : { role, content: text };
	return JSON.stringify({ type: "message", timestamp: ts, message });
}

test("(i) backfill keeps owner prose and final replies of Main, in time order, and nothing else", () => {
	const SK = `sk-ant-api03-${"ZyXw9876".repeat(5)}`;
	const cfg = freshSandbox();
	const PROJ = join(SESSIONS, "-proj");
	mkdirSync(join(PROJ, "sub-session"), { recursive: true });
	// Depth 1: two Main sessions. The first holds the guard prompts that must be skipped.
	writeFileSync(
		join(PROJ, "main-a.jsonl"),
		[
			turn("2025-10-01T10:00:00Z", "user", "ship the traces series"),
			turn("2025-10-01T10:00:05Z", "assistant", "Shipped the traces series."),
			turn("2025-10-01T10:01:00Z", "user", "main-guard: continuation"),
			turn("2025-10-01T10:02:00Z", "user", "<system-notice> harness notice"),
			turn("2025-10-01T10:03:00Z", "user", "<b>keep this</b>"),
			turn("2025-10-01T10:04:00Z", "user", `token ${SK} for the deploy`),
		].join("\n") + "\n",
	);
	// The second session ends with a line the writer had not finished: it must be skipped.
	writeFileSync(
		join(PROJ, "main-b.jsonl"),
		[
			turn("2025-10-01T10:06:00Z", "user", "second session owner"),
			turn("2025-10-01T10:06:05Z", "assistant", "second answer"),
			turn("2025-10-01T10:11:00Z", "user", "after the live entry"),
		].join("\n") +
			'\n{"type":"message","timestamp":"2025-10-01T10:07:0',
	);
	// Depth 2: a subagent session. It adds nothing.
	writeFileSync(
		join(PROJ, "sub-session", "sub.jsonl"),
		[turn("2025-10-01T10:07:00Z", "user", "sub task"), turn("2025-10-01T10:07:05Z", "assistant", "sub answer")].join("\n") + "\n",
	);
	// The live log's first entry is at 10:10: backfill takes only what is before it.
	mkdirSync(ownerLogDir(), { recursive: true });
	const LIVE_AT = Date.parse("2025-10-01T10:10:00Z") / 1000;
	writeFileSync(ownerLogFile(), `${JSON.stringify({ id: "00000000a00000001", at: LIVE_AT, role: "owner", text: "live" })}\n`);

	expect(backfillOwnerLog(cfg)).toBe(6);
	const rows = lines(ownerBackfillFile());
	expect(rows.length).toBe(6);
	expect(rows[0]).toMatchObject({ role: "owner", text: "ship the traces series" });
	expect(rows[1]).toMatchObject({ role: "main", text: "Shipped the traces series." });
	expect(rows[2]).toMatchObject({ role: "owner", text: "<b>keep this</b>" });
	expect(rows[3]).toMatchObject({ role: "owner" });
	expect(rows[4]).toMatchObject({ role: "owner", text: "second session owner" });
	expect(rows[5]).toMatchObject({ role: "main", text: "second answer" });
	expect(readFileSync(ownerBackfillFile(), "utf8")).not.toContain(SK);
});

test("(i) a second backfill run adds nothing", () => {
	const cfg = freshSandbox();
	const PROJ = join(SESSIONS, "-proj");
	mkdirSync(PROJ, { recursive: true });
	writeFileSync(join(PROJ, "main-a.jsonl"), `${turn("2025-10-01T10:00:00Z", "user", "ship the traces series")}\n`);
	expect(backfillOwnerLog(cfg)).toBe(1);
	expect(backfillOwnerLog(cfg)).toBe(0);
	expect(lines(ownerBackfillFile()).length).toBe(1);
});

// ---- (j) file modes ----

test("(j) the recall dir is 0700 and both log files are 0600, also when they pre-exist looser", () => {
	const cfg = freshSandbox();
	mkdirSync(ownerLogDir(), { recursive: true });
	chmodSync(ownerLogDir(), 0o755);
	writeFileSync(ownerLogFile(), "");
	chmodSync(ownerLogFile(), 0o644);
	writeFileSync(ownerBackfillFile(), "");
	chmodSync(ownerBackfillFile(), 0o644);
	appendOwnerLog("owner", "mode check", { atMs: NOW_MS, rand: seededBytes(3) });
	backfillOwnerLog(cfg);
	expect(mode(ownerLogDir())).toBe(0o700);
	expect(mode(ownerLogFile())).toBe(0o600);
	expect(mode(ownerBackfillFile())).toBe(0o600);
});
