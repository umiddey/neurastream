// The launcher (`neurastream main`) runs the harness in a loop: a relaunch request from a ready
// session starts a fresh run whose only argument is the handoff. A fake harness script stands in
// for omp; the real omp is never run. Sandbox home, like tests/rollover-omp.test.ts.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

async function launch(args: string[], dir: string, extra: Record<string, string> = {}): Promise<number> {
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
		return await runMainLauncher(args, cfg, { harness: FAKE });
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
	expect(handoff).toContain("Owner's unsent draft: half typed");
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
	expect(handoff).toContain("Owner's unsent draft: first\nsecond");
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
