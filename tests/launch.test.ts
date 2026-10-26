// The launcher (`neurastream main`) runs the harness in a loop: a relaunch request from a ready
// session starts a fresh run whose only argument is the handoff. A fake harness script stands in
// for omp; the real omp is never run. Sandbox home, like tests/rollover-omp.test.ts.

import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LaunchOptions } from "../src/core/adapter.ts";
import { carriedArgs, runMainLauncher } from "../src/adapters/omp/launch.ts";
import { loadConfig } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-launch-"));
// applyQueueEnv() writes QUEUE_* into process.env; save what the parent exported and restore it.
const QUEUE_ENV_BEFORE = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, QUEUE_ENV_BEFORE);
	rmSync(TMP, { recursive: true, force: true });
});

// loadConfig lets env beat the config file, and a live omp session exports QUEUE_STATE (the real
// state dir). Load with an empty env so only the sandbox home decides the paths.
const cfg = loadConfig({ home: join(TMP, "home"), env: {} });
applyQueueEnv(cfg); // relaunchPath() and notePath() resolve into the sandbox state dir
const SESSION_ID = "sess-launch";
const SESSION_FILE = join(TMP, "prev.jsonl");
const NOTE = notePath(SESSION_ID);

// First run: writes the note and the relaunch request (optionally with an old mtime) and exits 0.
// Second run: exits 7, so the launcher's exit code must be the second run's.
const FAKE = join(TMP, "fake-omp");
writeFileSync(
	FAKE,
	`#!/usr/bin/env bun
import { appendFileSync, existsSync, utimesSync, writeFileSync } from "node:fs";
const env = process.env;
appendFileSync(env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), flag: env.NEURASTREAM_MAIN_LAUNCHER }) + "\\n");
const second = existsSync(env.FAKE_MARK);
if (!second) {
	writeFileSync(env.FAKE_MARK, "");
	writeFileSync(env.FAKE_NOTE, env.FAKE_NOTE_TEXT);
	writeFileSync(env.FAKE_RELAUNCH, JSON.stringify({ previousSessionFile: env.FAKE_PREV, notePath: env.FAKE_NOTE, draft: env.FAKE_DRAFT ?? "half typed" }));
	if (env.FAKE_STALE === "1") utimesSync(env.FAKE_RELAUNCH, 1, 1);
}
process.exit(second ? 7 : 0);
`,
);
chmodSync(FAKE, 0o755);

interface Run {
	argv: string[];
	flag: string | undefined;
}

let caseNo = 0;

/** A fresh case dir; clears the note and the relaunch request the previous case left behind. */
function newCase(): string {
	caseNo++;
	const dir = join(TMP, `case-${caseNo}`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(dirname(relaunchPath()), { recursive: true });
	rmSync(relaunchPath(), { force: true });
	rmSync(NOTE, { force: true });
	return dir;
}

async function launch(args: string[], dir: string, extra: Record<string, string> = {}, opts: Partial<LaunchOptions> = {}): Promise<number> {
	const keys: Record<string, string> = {
		FAKE_LOG: join(dir, "runs.log"),
		FAKE_MARK: join(dir, "mark"),
		FAKE_NOTE: NOTE,
		FAKE_NOTE_TEXT: "Note: continue the parser work; the next step is the tests.",
		FAKE_RELAUNCH: relaunchPath(),
		FAKE_PREV: SESSION_FILE,
		...extra,
	};
	const saved = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]]));
	Object.assign(process.env, keys);
	try {
		return await runMainLauncher(args, cfg, { harness: FAKE, ...opts });
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

function runsOf(dir: string): Run[] {
	const text = readFileSync(join(dir, "runs.log"), "utf8").trim();
	return text === "" ? [] : text.split("\n").map(line => JSON.parse(line) as Run);
}

test("the sandbox config keeps the note and the relaunch request under TMP, whatever QUEUE_* the parent env holds", () => {
	expect(NOTE.startsWith(TMP)).toBe(true);
	expect(relaunchPath().startsWith(TMP)).toBe(true);
});

test("carriedArgs drops the first message and session-picking flags, keeps the rest", () => {
	expect(carriedArgs(["--session-dir", "/s", "-r", "/s/a.jsonl", "--model", "haiku", "continue"])).toEqual([
		"--session-dir",
		"/s",
		"--model",
		"haiku",
	]);
});

test("carriedArgs keeps --flag=value as one argument", () => {
	expect(carriedArgs(["--model=haiku", "--no-lsp", "hi"])).toEqual(["--model=haiku", "--no-lsp"]);
});

test("carriedArgs drops -c and keeps the next flag with its value", () => {
	expect(carriedArgs(["-c", "--thinking", "high"])).toEqual(["--thinking", "high"]);
});

test("carriedArgs: -r takes a value only when the next argument is not a flag", () => {
	expect(carriedArgs(["-r", "--model", "x"])).toEqual(["--model", "x"]);
});

test("carriedArgs: everything after a bare -- is positional", () => {
	expect(carriedArgs(["--", "--model"])).toEqual([]);
});

test("a relaunch request starts a second run: the owner's flags, then the handoff", async () => {
	const dir = newCase();
	const code = await launch(["--model", "m", "-r", "old", "hi"], dir);
	const runs = runsOf(dir);
	expect(runs.length).toBe(2);
	expect(runs.map(r => r.flag)).toEqual(["1", "1"]);
	expect(runs[0]?.argv).toEqual(["--model", "m", "-r", "old", "hi"]);
	expect(runs[1]?.argv.slice(0, 2)).toEqual(["--model", "m"]);
	expect(runs[1]?.argv.length).toBe(3);
	const handoff = runs[1]?.argv[2] ?? "";
	expect(handoff).toContain("Note: continue the parser work");
	expect(handoff).toContain("Owner away");
	expect(handoff).toContain("Owner's messages during the rollover (and any unsent draft): half typed");
	expect(handoff).toContain(SESSION_FILE);
	expect(code).toBe(7);
	expect(existsSync(relaunchPath())).toBe(false);
}, 60_000);

test("owner messages typed during a pending relaunch all reach the second run, in order", async () => {
	const dir = newCase();
	const code = await launch([], dir, { FAKE_DRAFT: "first\nsecond" });
	const runs = runsOf(dir);
	expect(runs.length).toBe(2);
	const handoff = runs[1]?.argv.at(-1) ?? "";
	expect(handoff).toContain("Owner's messages during the rollover (and any unsent draft): first\nsecond");
	expect(code).toBe(7);
}, 60_000);

test("a stale relaunch.json (mtime before the run started) does not relaunch", async () => {
	const dir = newCase();
	const code = await launch([], dir, { FAKE_STALE: "1" });
	expect(runsOf(dir).length).toBe(1);
	expect(code).toBe(0);
}, 60_000);

test("no relaunch.json: the launcher exits with the child's code after one run", async () => {
	const dir = newCase();
	writeFileSync(join(dir, "mark"), ""); // the first run is already marked: it writes nothing
	const code = await launch([], dir);
	expect(runsOf(dir).length).toBe(1);
	expect(code).toBe(7);
});

test("a handoff over 100000 bytes goes to a file and the argument points at it", async () => {
	const dir = newCase();
	const code = await launch([], dir, { FAKE_NOTE_TEXT: "n".repeat(120_000) });
	const runs = runsOf(dir);
	expect(runs.length).toBe(2);
	const arg = runs[1]?.argv[0] ?? "";
	const file = join(dirname(NOTE), `${basename(NOTE, ".md")}.handoff.md`);
	expect(arg).toBe(`Read ${file} first: it is the handoff from your previous session (too long for one message).`);
	expect(readFileSync(file, "utf8").length).toBeGreaterThan(100_000);
	expect(code).toBe(7);
}, 60_000);

test("a main-start failure does not stop the relaunch: the note still reaches the second run", async () => {
	const dir = newCase();
	const code = await launch([], dir, {}, {
		mainStart: async () => {
			throw new Error("ENOENT: no such file or directory, open '/proc/loadavg'");
		},
	});
	const runs = runsOf(dir);
	expect(runs.length).toBe(2);
	const handoff = runs[1]?.argv.at(-1) ?? "";
	expect(handoff).toContain("Note: continue the parser work");
	expect(handoff).toContain("main-start failed during the rollover (ENOENT: no such file or directory, open '/proc/loadavg'); run main-start yourself.");
	expect(code).toBe(7);
	expect(readFileSync(cfg.paths.guard_log, "utf8")).toContain("rollover: main-start failed: ENOENT");
}, 60_000);

const HANDOFF_LINE = "neurastream: starting a new session from the handoff (collecting state, about a minute)…";

/** A gated main-start: `entered` resolves when the launcher is inside nextMessage, `release` lets it finish. */
function gatedMainStart(): { mainStart: LaunchOptions["mainStart"]; entered: Promise<void>; release: () => void } {
	const { promise: entered, resolve: seen } = Promise.withResolvers<void>();
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	const mainStart: LaunchOptions["mainStart"] = async () => {
		seen();
		await gate;
		return "=== gated generated state";
	};
	return { mainStart, entered, release };
}

test("the launcher says what it is doing before building the handoff", async () => {
	const dir = newCase();
	const errs = spyOn(console, "error");
	let lines: string[] = [];
	let code: number;
	try {
		code = await launch(["--model", "m", "hi"], dir);
		lines = errs.mock.calls.map(call => call.map(String).join(" "));
	} finally {
		errs.mockRestore();
	}
	expect(code).toBe(7);
	expect(lines.filter(l => l.includes(HANDOFF_LINE))).toHaveLength(1);
}, 60_000);

test("a kill during main-start leaves the request: it is removed only after the message is built", async () => {
	const dir = newCase();
	const { mainStart, entered, release } = gatedMainStart();
	const run = launch([], dir, {}, { mainStart });
	await entered;
	// The live incident: a kill while main-start collects state must not cost the owner's messages.
	expect(existsSync(relaunchPath())).toBe(true);
	release();
	expect(await run).toBe(7);
	expect(existsSync(relaunchPath())).toBe(false);
}, 60_000);

test("the handover path also keeps the request until the message is built", async () => {
	const dir = newCase();
	mkdirSync(dirname(relaunchPath()), { recursive: true });
	writeFileSync(NOTE, "Note: continue the parser work; the next step is the tests.");
	writeFileSync(relaunchPath(), JSON.stringify({ previousSessionFile: SESSION_FILE, notePath: NOTE, draft: "d" }));
	writeFileSync(join(dir, "mark"), ""); // the run itself writes no new request
	const { mainStart, entered, release } = gatedMainStart();
	const before = process.env.NEURASTREAM_RELAUNCH_SINCE;
	process.env.NEURASTREAM_RELAUNCH_SINCE = String(Date.now() - 60_000);
	const run = launch([], dir, {}, { mainStart }).finally(() => {
		if (before === undefined) delete process.env.NEURASTREAM_RELAUNCH_SINCE;
		else process.env.NEURASTREAM_RELAUNCH_SINCE = before;
	});
	await entered;
	expect(existsSync(relaunchPath())).toBe(true);
	release();
	expect(await run).toBe(7);
	expect(existsSync(relaunchPath())).toBe(false);
}, 60_000);

test("a fresh launcher with no message continues an interrupted rollover from the request", async () => {
	const dir = newCase();
	mkdirSync(dirname(NOTE), { recursive: true });
	writeFileSync(NOTE, "Note: continue the parser work; the next step is the tests.");
	writeFileSync(relaunchPath(), JSON.stringify({ previousSessionFile: SESSION_FILE, notePath: NOTE, draft: "typed earlier" }));
	writeFileSync(join(dir, "mark"), ""); // the run itself writes no new request
	const errs = spyOn(console, "error");
	let lines: string[] = [];
	let code: number;
	try {
		code = await launch(["--model", "m"], dir);
		lines = errs.mock.calls.map(call => call.map(String).join(" "));
	} finally {
		errs.mockRestore();
	}
	const runs = runsOf(dir);
	expect(runs.length).toBe(1);
	expect(runs[0]?.flag).toBe("1");
	expect(runs[0]?.argv[0]).toBe("--model");
	const message = String(runs[0]?.argv.at(-1));
	expect(message).toContain("Note: continue the parser work");
	expect(message).toContain("Owner's messages during the rollover (and any unsent draft): typed earlier");
	expect(lines.some(l => l.includes(`neurastream: continuing the interrupted rollover from ${SESSION_FILE}`))).toBe(true);
	expect(lines.filter(l => l.includes(HANDOFF_LINE))).toHaveLength(1);
	expect(existsSync(relaunchPath())).toBe(false);
	expect(code).toBe(7);
}, 60_000);

test("an interrupted rollover older than an hour is left alone: the run starts plain", async () => {
	const dir = newCase();
	mkdirSync(dirname(NOTE), { recursive: true });
	writeFileSync(NOTE, "Note: stale");
	writeFileSync(relaunchPath(), JSON.stringify({ previousSessionFile: SESSION_FILE, notePath: NOTE, draft: "" }));
	const old = (Date.now() - 2 * 3_600_000) / 1000;
	utimesSync(relaunchPath(), old, old);
	writeFileSync(join(dir, "mark"), "");
	const code = await launch([], dir);
	expect(runsOf(dir)[0]?.argv).toEqual([]);
	expect(existsSync(relaunchPath())).toBe(true);
	expect(code).toBe(7);
}, 60_000);

test("an unreadable interrupted request is left alone: the run starts plain", async () => {
	const dir = newCase();
	writeFileSync(relaunchPath(), "{not json");
	writeFileSync(join(dir, "mark"), "");
	const code = await launch([], dir);
	expect(runsOf(dir)[0]?.argv).toEqual([]);
	expect(existsSync(relaunchPath())).toBe(true);
	expect(code).toBe(7);
});

test("a fresh launcher with a positional message does not continue an interrupted rollover", async () => {
	const dir = newCase();
	mkdirSync(dirname(NOTE), { recursive: true });
	writeFileSync(NOTE, "Note: x");
	writeFileSync(relaunchPath(), JSON.stringify({ previousSessionFile: SESSION_FILE, notePath: NOTE, draft: "" }));
	// Older than the run's start: the in-loop read must not pick it up and consume it.
	const past = (Date.now() - 5_000) / 1000;
	utimesSync(relaunchPath(), past, past);
	writeFileSync(join(dir, "mark"), "");
	const code = await launch(["hello"], dir);
	expect(runsOf(dir)[0]?.argv).toEqual(["hello"]);
	expect(existsSync(relaunchPath())).toBe(true);
	expect(code).toBe(7);
}, 60_000);
