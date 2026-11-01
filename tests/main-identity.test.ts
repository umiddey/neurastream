// Main identity (plan 20261027_1300_multi_main P2): `neurastream main --name <id>` strips the flag
// before the harness sees it, sets NEURASTREAM_MAIN_ID for the child, refuses a second launcher with
// the same id (flock running.lock) and accepts it once the holder is gone; per-Main state lives
// under <queue_state>/mains/<id>/, and the pre-multi-main top-level files move there once. Fake
// harness stands in for omp; sandbox home, like tests/launch.test.ts.

import { afterAll, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { mainId, mainStateDir, log, readWindow, writeWindow } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";
import { runMainLauncher, stripNameFlag } from "../src/adapters/omp/launch.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-main-id-"));
// applyQueueEnv() writes QUEUE_* into process.env; save what the parent exported and restore it.
const QUEUE_ENV_BEFORE = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
const MAIN_ID_BEFORE = process.env.NEURASTREAM_MAIN_ID;
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, QUEUE_ENV_BEFORE);
	if (MAIN_ID_BEFORE === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = MAIN_ID_BEFORE;
	rmSync(TMP, { recursive: true, force: true });
});

// loadConfig lets env beat the config file; load with an empty env so only the sandbox home
// decides the paths, then mirror them into the env like the launcher does.
const cfg = loadConfig({ home: join(TMP, "home"), env: {} });
applyQueueEnv(cfg);
const STATE = cfg.paths.queue_state;
// A second sandbox state for the legacy-move tests: the tests above already created mains/<id>
// dirs in STATE, and the one-time move only fires while mains/main/ does not exist yet.
const cfgLegacy = loadConfig({ home: join(TMP, "home-legacy"), env: {} });
const LEGACY = cfgLegacy.paths.queue_state;

// The fake harness logs the argv it was given plus the id env, and never relaunches.
const FAKE = join(TMP, "fake-omp");
writeFileSync(
	FAKE,
	`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
try {
	appendFileSync(process.env.FAKE_LOG ?? "/dev/null", JSON.stringify({ argv: process.argv.slice(2), id: process.env.NEURASTREAM_MAIN_ID }) + "\\n");
} catch {}
process.exit(0);
`,
);
chmodSync(FAKE, 0o755);

test("stripNameFlag removes --name <id> and --name=<id>, keeps everything else", () => {
	expect(stripNameFlag(["--name", "a", "--model", "m", "hi"])).toEqual({ args: ["--model", "m", "hi"], name: "a" });
	expect(stripNameFlag(["--name=a", "--model", "m"])).toEqual({ args: ["--model", "m"], name: "a" });
	expect(stripNameFlag(["--model", "m", "hi"])).toEqual({ args: ["--model", "m", "hi"], name: undefined });
});

test("a bare --name with no value falls back instead of eating the next flag (I-20261031-225)", () => {
	expect(stripNameFlag(["--name"])).toEqual({ args: [], name: undefined });
	expect(stripNameFlag(["--name", "--model", "m", "hi"])).toEqual({ args: ["--model", "m", "hi"], name: undefined });
});

test("mainId defaults to main and falls back to main on a bogus env value", () => {
	delete process.env.NEURASTREAM_MAIN_ID;
	expect(mainId()).toBe("main");
	process.env.NEURASTREAM_MAIN_ID = "Not_Valid";
	expect(mainId()).toBe("main");
	process.env.NEURASTREAM_MAIN_ID = "alpha-1";
	expect(mainId()).toBe("alpha-1");
});

test("two ids keep separate edit windows under mains/<id>/", () => {
	process.env.NEURASTREAM_MAIN_ID = "a";
	expect(mainStateDir(cfg)).toBe(join(STATE, "mains", "a"));
	writeWindow({ used: [], windowStart: 0, mainCalls: 2 });
	expect(readWindow().mainCalls).toBe(2);
	process.env.NEURASTREAM_MAIN_ID = "b";
	expect(readWindow().mainCalls).toBe(0);
	writeWindow({ used: [], windowStart: 0, mainCalls: 7 });
	process.env.NEURASTREAM_MAIN_ID = "a";
	expect(readWindow().mainCalls).toBe(2);
	expect(existsSync(join(STATE, "mains", "a", "edit-window.json"))).toBe(true);
	expect(existsSync(join(STATE, "mains", "b", "edit-window.json"))).toBe(true);
	expect(existsSync(join(STATE, "edit-window.json"))).toBe(false);
});

test("rollover note and relaunch request live in the Main's own dir", () => {
	delete process.env.NEURASTREAM_MAIN_ID;
	expect(notePath("s1")).toBe(join(STATE, "mains", "main", "rollover", "s1.md"));
	expect(relaunchPath()).toBe(join(STATE, "mains", "main", "rollover", "relaunch.json"));
	process.env.NEURASTREAM_MAIN_ID = "a";
	expect(notePath("s1")).toBe(join(STATE, "mains", "a", "rollover", "s1.md"));
	expect(relaunchPath()).toBe(join(STATE, "mains", "a", "rollover", "relaunch.json"));
});

test("the pre-multi-main top-level files move into mains/main once", () => {
	mkdirSync(join(LEGACY, "rollover"), { recursive: true });
	writeFileSync(join(LEGACY, "edit-window.json"), JSON.stringify({ used: ["edit:x"], windowStart: 1, mainCalls: 3 }));
	writeFileSync(join(LEGACY, "rollover", "old.md"), "note");
	delete process.env.NEURASTREAM_MAIN_ID; // id main
	const dir = mainStateDir(cfgLegacy);
	expect(dir).toBe(join(LEGACY, "mains", "main"));
	expect(existsSync(join(LEGACY, "edit-window.json"))).toBe(false);
	expect(existsSync(join(LEGACY, "rollover"))).toBe(false);
	expect(readFileSync(join(dir, "edit-window.json"), "utf8")).toContain("edit:x");
	expect(readFileSync(join(dir, "rollover", "old.md"), "utf8")).toBe("note");
	// Idempotent: the moved-in files are the live ones; a second call moves nothing.
	mainStateDir(cfgLegacy);
	writeFileSync(join(dir, "edit-window.json"), JSON.stringify({ used: [], windowStart: 0, mainCalls: 0 }));
	expect(existsSync(join(LEGACY, "edit-window.json"))).toBe(false);
	expect(readFileSync(join(dir, "edit-window.json"), "utf8")).not.toContain("edit:x");
});

test("a non-main id does not move the legacy files", () => {
	mkdirSync(join(LEGACY, "rollover"), { recursive: true });
	writeFileSync(join(LEGACY, "edit-window.json"), "{}");
	writeFileSync(join(LEGACY, "rollover", "keep.md"), "note");
	process.env.NEURASTREAM_MAIN_ID = "b";
	expect(mainStateDir(cfgLegacy)).toBe(join(LEGACY, "mains", "b"));
	expect(existsSync(join(LEGACY, "edit-window.json"))).toBe(true);
	expect(existsSync(join(LEGACY, "rollover", "keep.md"))).toBe(true);
	expect(existsSync(join(LEGACY, "mains", "b", "edit-window.json"))).toBe(false);
});

test("guard log lines carry the [id] prefix", () => {
	const file = join(TMP, "guard.log");
	process.env.NEURASTREAM_MAIN_ID = "a";
	log(file, "BLOCK test");
	process.env.NEURASTREAM_MAIN_ID = "b";
	log(file, "ALLOW other");
	expect(readFileSync(file, "utf8")).toMatch(/\[a\] BLOCK test/);
	expect(readFileSync(file, "utf8")).toMatch(/\[b\] ALLOW other/);
});

test("a bad id exits 2 before the harness runs", async () => {
	const runsLog = join(TMP, "case-bad", "runs.log");
	mkdirSync(dirname(runsLog), { recursive: true });
	process.env.FAKE_LOG = runsLog;
	const errs = spyOn(console, "error");
	const code = await runMainLauncher(["--name", "Bad_ID", "hi"], cfg, { harness: FAKE });
	const code2 = await runMainLauncher(["--name=bad.id"], cfg, { harness: FAKE });
	const lines = errs.mock.calls.map(call => call.map(String).join(" ")).join("\n");
	errs.mockRestore();
	delete process.env.FAKE_LOG;
	expect(code).toBe(2);
	expect(code2).toBe(2);
	expect(lines).toContain("must match [a-z0-9-]{1,24}");
	expect(existsSync(runsLog)).toBe(false);
});

test("the launcher strips --name from the harness args and sets the id env", async () => {
	const dir = join(TMP, "case-strip");
	mkdirSync(dir, { recursive: true });
	const runsLog = join(dir, "runs.log");
	process.env.FAKE_LOG = runsLog;
	expect(await runMainLauncher(["--name", "strip1", "--model", "m", "hi"], cfg, { harness: FAKE })).toBe(0);
	expect(JSON.parse(readFileSync(runsLog, "utf8"))).toEqual({ argv: ["--model", "m", "hi"], id: "strip1" });
	rmSync(runsLog);
	expect(await runMainLauncher(["--name=strip2", "--model=m"], cfg, { harness: FAKE })).toBe(0);
	expect(JSON.parse(readFileSync(runsLog, "utf8"))).toEqual({ argv: ["--model=m"], id: "strip2" });
	delete process.env.FAKE_LOG;
}, 30_000);

test("a second launcher with the same id refuses while the first holds the lock, then is accepted", async () => {
	const dir = join(TMP, "case-lock");
	mkdirSync(dir, { recursive: true });
	// A spawned process holds tryLock like a live launcher would: it takes the lock, prints ready
	// on stdout, and releases when a line arrives on stdin (event-driven, no polling).
	const holder = join(STATE, "mains", "locktest", "running.lock");
	mkdirSync(dirname(holder), { recursive: true });
	const script = [
		`import { tryLock } from ${JSON.stringify(join(import.meta.dir, "../src/core/file-lock.ts"))};`,
		`const l = tryLock(${JSON.stringify(holder)});`,
		`if (!l) process.exit(3);`,
		`process.stdout.write("ready\\n");`,
		`await new Promise(resolve => process.stdin.once("data", resolve));`,
		`l.release();`,
	].join("\n");
	const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
	const [chunk] = (await once(child.stdout, "data")) as [Buffer];
	expect(chunk.toString()).toBe("ready\n");

	// Same id while the holder lives: refused, the harness never runs.
	const runsLog = join(dir, "runs.log");
	process.env.FAKE_LOG = runsLog;
	const errs = spyOn(console, "error");
	const code = await runMainLauncher(["--name", "locktest", "hi"], cfg, { harness: FAKE });
	const lines = errs.mock.calls.map(call => call.map(String).join(" ")).join("\n");
	errs.mockRestore();
	expect(code).toBe(1);
	expect(lines).toContain("Main locktest is already running");
	expect(existsSync(runsLog)).toBe(false);

	// Holder gone: the same id starts, and the child sees its id env.
	child.stdin.write("stop\n");
	child.stdin.end();
	await once(child, "exit");
	expect(await runMainLauncher(["--name", "locktest", "hi"], cfg, { harness: FAKE })).toBe(0);
	expect(JSON.parse(readFileSync(runsLog, "utf8"))).toEqual({ argv: ["hi"], id: "locktest" });
	delete process.env.FAKE_LOG;
}, 30_000);
