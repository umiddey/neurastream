// agent-ledger reads only the sessions inside its window: a session file whose mtime is older than
// `since` is skipped by its mtime, unread. A large old session must not cost the ledger its parse
// time (on the owner's machine: 3721 session files, 12 GB, agent-ledger --hours 12 took 45 s).

import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import { loadConfig } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "ledger-window-"));
// Inherited QUEUE_* (the caller's live session, or an in-process adapter in an earlier test
// file) beats the sandbox config in loadConfig below; save and delete them before it runs;
// afterAll restores them.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

// A throwaway home, as in tests/rollover-omp.test.ts: the live config must not be read here.
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const cfg = loadConfig({ home: join(TMP, "home") });
const SESSIONS = join(TMP, "sessions");
const PROJECT = join(SESSIONS, "-projects");
const TURN = JSON.stringify({
	type: "message",
	timestamp: "2026-10-21T10:00:00",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
		usage: { totalTokens: 10, input: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
	},
});
// Large enough that reading and parsing it costs more than the 1 s budget below on a dev machine.
const LARGE_BYTES = 200 * 1024 * 1024;
const LARGE_BLOCK = Buffer.from(`${TURN}\n`.repeat(1000));

test("listRuns skips a session older than the window without reading it", () => {
	mkdirSync(PROJECT, { recursive: true });
	writeFileSync(join(PROJECT, "recent.jsonl"), `${TURN}\n`);
	const old = join(PROJECT, "old.jsonl");
	const fd = openSync(old, "w");
	for (let written = 0; written < LARGE_BYTES; written += LARGE_BLOCK.length) writeSync(fd, LARGE_BLOCK);
	closeSync(fd);
	const twoDaysAgo = Date.now() / 1000 - 2 * 24 * 3600;
	utimesSync(old, twoDaysAgo, twoDaysAgo);
	const since = Date.now() / 1000 - 12 * 3600;

	const started = performance.now();
	const runs = ompRunSource(SESSIONS, cfg).listRuns(since);
	const elapsedMs = performance.now() - started;

	expect(runs.map(r => r.id)).toEqual(["recent"]);
	expect(elapsedMs).toBeLessThan(1000);
});
