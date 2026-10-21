// Session rollover, pure core: the state machine (below / need-note / wait-jobs / ready), the
// handoff text layout, the note path, and the rollover config keys. No harness imports here.

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/core/config.ts";
import { buildHandoff, MAX_NOTE_AGE_MS, notePath, rolloverState } from "../src/core/rollover.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MB = 1024 * 1024;
const CROSSED = 1_000_000;

function input(over: Partial<Parameters<typeof rolloverState>[0]> = {}) {
	return {
		sessionBytes: 10 * MB,
		maxMb: 10,
		runningJobs: [] as string[],
		crossedAtMs: CROSSED,
		noteMtimeMs: null as number | null,
		nowMs: CROSSED + 1_000,
		...over,
	};
}

describe("rolloverState", () => {
	test("below the threshold nothing happens, even with a note", () => {
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1, crossedAtMs: null }))).toBe("below");
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1, noteMtimeMs: CROSSED + 1 }))).toBe("below");
	});

	test("at the threshold without a note asks for the note", () => {
		expect(rolloverState(input())).toBe("need-note");
	});

	test("over the threshold but never recorded as crossed asks for the note", () => {
		expect(rolloverState(input({ crossedAtMs: null, noteMtimeMs: CROSSED + 1 }))).toBe("need-note");
	});

	test("a note written before the threshold was first crossed does not count", () => {
		expect(rolloverState(input({ noteMtimeMs: CROSSED - 5_000 }))).toBe("need-note");
	});

	test("a note older than the maximum age does not count", () => {
		const nowMs = CROSSED + MAX_NOTE_AGE_MS + 1_000;
		expect(rolloverState(input({ noteMtimeMs: CROSSED + 1, nowMs }))).toBe("need-note");
	});

	test("a note exactly at the maximum age still counts", () => {
		const nowMs = CROSSED + MAX_NOTE_AGE_MS;
		expect(rolloverState(input({ noteMtimeMs: CROSSED + 1, nowMs }))).toBe("ready");
	});

	test("a valid note with running jobs waits for the jobs", () => {
		expect(rolloverState(input({ noteMtimeMs: CROSSED + 1, runningJobs: ["sub-1"] }))).toBe("wait-jobs");
	});

	test("a valid note with no running jobs is ready", () => {
		expect(rolloverState(input({ noteMtimeMs: CROSSED + 1 }))).toBe("ready");
	});

	test("the max age is 60 minutes", () => {
		expect(MAX_NOTE_AGE_MS).toBe(60 * 60_000);
	});
});

describe("buildHandoff", () => {
	test("exact layout: header, Main's note, generated state, owner message", () => {
		const text = buildHandoff({
			generated: "=== machine\nOK\n",
			note: "## In progress\nwriting the test\n\n",
			previousSessionFile: "/s/old.jsonl",
			ownerMessage: "  continue please\n",
		});
		expect(text).toBe(
			[
				"Previous session file: /s/old.jsonl. Its full history stays there; this session continues from the handoff below.",
				"",
				"## Main's handoff note (verbatim)",
				"## In progress",
				"writing the test",
				"",
				"## Generated state (main-start)",
				"=== machine",
				"OK",
				"",
				"Owner's message:",
				"  continue please\n",
			].join("\n"),
		);
	});

	test("the owner's message reaches the handoff unchanged", () => {
		const message = "/main-rollover is not the text; keep `this` * exactly";
		const text = buildHandoff({ generated: "g", note: "n", previousSessionFile: "/p", ownerMessage: message });
		expect(text.endsWith(`Owner's message:\n${message}`)).toBe(true);
	});
});

describe("notePath", () => {
	test("lives under <stateDir>/rollover/<sessionId>.md", () => {
		expect(notePath("abc-123", "/state")).toBe(join("/state", "rollover", "abc-123.md"));
	});
});

describe("rollover config", () => {
	test("defaults: enabled, 10 MB", () => {
		const cfg = loadConfig({ file: "/tmp/neurastream-home-rollover/missing.yml", home: "/tmp/neurastream-home-rollover", env: {} });
		expect(cfg.rollover.enabled).toBe(true);
		expect(cfg.rollover.max_session_mb).toBe(10);
	});

	test("overrides come from config.yml", () => {
		const dir = mkdtempSync(join(tmpdir(), "neurastream-rollover-cfg-"));
		try {
			const file = join(dir, "config.yml");
			writeFileSync(file, "rollover:\n  enabled: false\n  max_session_mb: 0.05\n");
			const cfg = loadConfig({ file, home: dir, env: {} });
			expect(cfg.rollover.enabled).toBe(false);
			expect(cfg.rollover.max_session_mb).toBe(0.05);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("max_session_mb must be positive", () => {
		const dir = mkdtempSync(join(tmpdir(), "neurastream-rollover-cfg-"));
		try {
			const file = join(dir, "config.yml");
			writeFileSync(file, "rollover:\n  max_session_mb: 0\n");
			expect(() => loadConfig({ file, home: dir, env: {} })).toThrow("rollover.max_session_mb must be > 0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
