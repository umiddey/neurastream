// Session rollover, pure core: the state machine (below / need-note / wait-jobs / ready), the
// handoff text layout, the note path, and the rollover config keys. No harness imports here.

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/core/config.ts";
import { buildHandoff, holdsBlock, MAX_NOTE_AGE_MS, noteRequest, notePath, ownerText, rolloverState, spawnRefusal } from "../src/core/rollover.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerCorrection } from "../src/core/incident-detectors.ts";

const MB = 1024 * 1024;
const CROSSED = 1_000_000;

function input(over: Partial<Parameters<typeof rolloverState>[0]> = {}) {
	return {
		sessionBytes: 10 * MB,
		maxMb: 10,
		runningJobs: [] as string[],
		crossedAtMs: CROSSED,
		noteMtimeMs: null as number | null,
		stale: false,
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

	test("a small session that is not stale stays below", () => {
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1 }))).toBe("below");
	});

	test("a small but stale session asks for the note", () => {
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1, stale: true, crossedAtMs: null }))).toBe("need-note");
	});

	test("a stale session with a fresh note and running jobs waits for the jobs", () => {
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1, stale: true, noteMtimeMs: CROSSED + 1, runningJobs: ["sub-1"] }))).toBe("wait-jobs");
	});

	test("a stale session with a fresh note and no jobs is ready", () => {
		expect(rolloverState(input({ sessionBytes: 10 * MB - 1, stale: true, noteMtimeMs: CROSSED + 1 }))).toBe("ready");
	});
});

describe("spawnRefusal", () => {
	test("a pending rollover refuses the spawn and names the running jobs", () => {
		expect(spawnRefusal("need-note", [])).toBe(
			"main-guard: rollover pending (need-note); no new subagents until the session rolls over. Running: .",
		);
		expect(spawnRefusal("wait-jobs", ["sub-1", "sub-2"])).toBe(
			"main-guard: rollover pending (wait-jobs); no new subagents until the session rolls over. Running: sub-1, sub-2.",
		);
	});

	test("below allows the spawn; ready refuses it, since the rollover follows the next idle (e)", () => {
		expect(spawnRefusal("below", ["sub-1"])).toBe(null);
		expect(spawnRefusal("ready", [])).toBe(
			"main-guard: rollover pending (ready); no new subagents until the session rolls over. Running: .",
		);
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

describe("holdsBlock", () => {
	test("lists the WAITING on owner lines verbatim under the holds header", () => {
		const lines = ["/p/a.md: WAITING on owner: hold A", "/p/b.md: WAITING on owner: hold B"];
		expect(holdsBlock(lines)).toBe(["=== owner holds (plans' WAITING on owner lines)", ...lines, ""].join("\n"));
	});

	test("says none when no plan waits on the owner", () => {
		expect(holdsBlock([])).toBe(["=== owner holds (plans' WAITING on owner lines)", "none", ""].join("\n"));
	});

	test("the handoff's generated state carries the same WAITING lines", () => {
		const lines = ["/p/a.md: WAITING on owner: hold A"];
		const text = buildHandoff({ generated: holdsBlock(lines), note: "n", previousSessionFile: "/p", ownerMessage: "m" });
		expect(text).toContain(`## Generated state (main-start)\n=== owner holds (plans' WAITING on owner lines)\n${lines[0]}\n`);
	});
});

describe("noteRequest", () => {
	test("asks for the note at the path and forbids listing holds in it", () => {
		const text = noteRequest("/s/n.md");
		expect(text).toContain("Write a handoff note to /s/n.md (overwrite it).");
		expect(text).toContain("Do not list holds or owner blockers in the note; they come from the plans' WAITING on owner lines.");
	});
	test("the note says it starts a relaunch instead of waiting for the owner", () => {
		const text = noteRequest("/s/n.md");
		expect(text).toContain("As soon as this note is written and none of its own jobs are running, this session restarts into a fresh one that starts from this note verbatim plus the generated main-start state.");
	});
	test("a stale install names both versions and does not claim the size limit", () => {
		const text = noteRequest("/s/n.md", "neurastream on disk is 0.2.0, this session runs 0.1.13");
		expect(text).toContain("Session rollover: a new neurastream version is installed (neurastream on disk is 0.2.0, this session runs 0.1.13).");
		expect(text).not.toContain("max_session_mb");
		expect(text).toContain("Write a handoff note to /s/n.md (overwrite it).");
	});
	test("without a reason the size limit is the stated cause", () => {
		expect(noteRequest("/s/n.md")).toContain("Session rollover: this session has grown past rollover.max_session_mb.");
	});
});

describe("notePath", () => {
	test("lives under <stateDir>/rollover/<sessionId>.md", () => {
		expect(notePath("abc-123", "/state")).toBe(join("/state", "rollover", "abc-123.md"));
	});
});

describe("rollover config", () => {
	test("defaults: enabled, 5 MB", () => {
		const cfg = loadConfig({ file: "/tmp/neurastream-home-rollover/missing.yml", home: "/tmp/neurastream-home-rollover", env: {} });
		expect(cfg.rollover.enabled).toBe(true);
		expect(cfg.rollover.max_session_mb).toBe(5);
		expect(cfg.rollover.exit_grace_s).toBe(20);
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

	test("exit_grace_s must be positive", () => {
		const dir = mkdtempSync(join(tmpdir(), "neurastream-rollover-cfg-"));
		try {
			const file = join(dir, "config.yml");
			writeFileSync(file, "rollover:\n  exit_grace_s: 0\n");
			expect(() => loadConfig({ file, home: dir, env: {} })).toThrow("rollover.exit_grace_s must be > 0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// P2 (I-20261023-14, I-20261023-11): machine prompts are not owner corrections.
describe("ownerText", () => {
	const PATTERNS = loadConfig({ home: join(tmpdir(), "nsar-owner-text-none"), env: {} }).metrics.correction_patterns.map(p => new RegExp(p, "i"));
	const NOW = Date.parse("2026-10-23T10:00:00Z");
	const handoff = (note: string, owner: string) =>
		buildHandoff({ generated: "=== generated state", note, previousSessionFile: "/x/previous.jsonl", ownerMessage: owner });

	test("the rollover note request gives no D4 finding and is not an owner message", () => {
		const note = noteRequest("/x/rollover/s.md", "neurastream on disk is 0.1.21, this session runs 0.1.19");
		expect(ownerText(note)).toBeUndefined();
		expect(ownerCorrection(note, PATTERNS, NOW)).toBeNull();
	});

	test("a handoff whose note has 'no' and 'stop' but whose owner message is 'continue' is not a correction", () => {
		const text = ownerText(handoff("Do not stop; no holds.", "continue"));
		expect(text).toBe("continue");
		expect(ownerCorrection(text ?? "", PATTERNS, NOW)).toBeNull();
	});

	test("a handoff whose owner message is a correction still yields one", () => {
		expect(ownerCorrection(ownerText(handoff("Do not stop; no holds.", "no, that is wrong")) ?? "", PATTERNS, NOW)).not.toBeNull();
	});

	test("a plain owner message is returned unchanged and still counts", () => {
		expect(ownerText("stop that")).toBe("stop that");
		expect(ownerCorrection(ownerText("stop that") ?? "", PATTERNS, NOW)).not.toBeNull();
	});

	test("a main-guard continuation is not an owner message", () => {
		expect(ownerText("main-guard: the queue still has a ticked phase; continue.")).toBeUndefined();
	});

	test("the owner message is taken after the last 'Owner's message:' marker, even if the owner typed the marker", () => {
		expect(ownerText(handoff("Do not stop.", "Owner's message: no"))).toBe("no");
	});
});
