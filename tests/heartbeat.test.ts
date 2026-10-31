// P1 (plan 20261027_1430): every scheduled job writes a heartbeat on success and on crash.
// These tests use only a temp paths.queue_state dir — no real home, network or service manager.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { beat, readBeats, withHeartbeat } from "../src/core/heartbeat.ts";
import { run } from "../src/cli/dispatch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempHome(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `heartbeat-${label}-`));
	DIRS.push(dir);
	return dir;
}

test("a job that throws still leaves ok:false with the first error line", () => {
	const cfg = loadConfig({ home: tempHome("throw"), env: {} });
	expect(() => withHeartbeat(cfg, "throwy-job", () => { throw new Error("boom\nsecond line"); })).toThrow("boom");
	const beats = readBeats(cfg);
	expect(beats["throwy-job"].ok).toBe(false);
	expect(beats["throwy-job"].detail).toBe("boom");
});

test("detail is cut to 200 chars", () => {
	const cfg = loadConfig({ home: tempHome("trunc"), env: {} });
	const long = "x".repeat(300);
	beat(cfg, "long-detail", { ok: false, detail: long });
	const beats = readBeats(cfg);
	expect(beats["long-detail"].detail).toHaveLength(200);
});

test("the hidden heartbeat CLI writes ok:false with --fail", async () => {
	const home = tempHome("cli");
	const savedHome = process.env.HOME;
	const savedQueueState = process.env.QUEUE_STATE;
	process.env.HOME = home;
	// Bun's homedir() ignores a changed HOME (reads passwd), so dispatch's loadConfig() would
	// beat into the real queue_state: point QUEUE_STATE at the temp home instead — applyEnv
	// reads process.env directly, which overrides both the file and the expanded default.
	process.env.QUEUE_STATE = join(home, ".local", "state", "queue");
	try {
		const code = await run("heartbeat", ["test-job", "--fail", "error text"]);
		expect(code).toBe(0);
		const cfg = loadConfig({ home, env: {} });
		const beats = readBeats(cfg);
		expect(beats["test-job"].ok).toBe(false);
		expect(beats["test-job"].detail).toBe("error text");
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedQueueState === undefined) delete process.env.QUEUE_STATE;
		else process.env.QUEUE_STATE = savedQueueState;
	}
});

test("an unwritable heartbeat dir does not change the job's exit code", () => {
	const cfg = loadConfig({ home: tempHome("unwritable"), env: {} });
	// Place a file where the heartbeats dir should be, so mkdirSync/writeFileSync fail.
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	writeFileSync(join(cfg.paths.queue_state, "heartbeats"), "not a directory");
	// Job succeeds → exit 0 preserved despite the unwritable dir.
	expect(withHeartbeat(cfg, "ok-job", () => 0)).toBe(0);
	// Job fails → exit 1 preserved.
	expect(withHeartbeat(cfg, "fail-job", () => 1)).toBe(1);
	// No heartbeats were written because the dir is unwritable.
	expect(readBeats(cfg)).toEqual({});
});