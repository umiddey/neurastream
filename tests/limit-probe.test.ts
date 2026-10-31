// Plan 20261027_1500 P2: the probe loop. An unnamed limit is probed every probe_interval_s
// (never sooner); a named reset is trusted and not probed before it; a successful probe resumes;
// max_probes failures give up. runProbe is sync, single-flight via tryLock, and runs the
// configured probe command with the model shell-quoted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { onLimited, onProbe, runProbe, type ProbeRunner, type ProbeStep, type ProbeTiming } from "../src/core/limit-probe.ts";
import { tryLock } from "../src/core/file-lock.ts";

const NOW = 1_769_322_469_000;
const REAL_429 =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}} retry-after-ms=731000';
const T: ProbeTiming = { probe_interval_s: 300, max_probes: 3, slack_s: 15 };

interface RunCall {
	file: string;
	args: string[];
	opts: { timeout: number };
}

function fakeRun(status: number | null, stderr = "", error?: Error): { run: ProbeRunner; calls: RunCall[] } {
	const calls: RunCall[] = [];
	const run: ProbeRunner = (file, args, opts) => {
		calls.push({ file, args, opts });
		return { status, stderr, error };
	};
	return { run, calls };
}

describe("onLimited", () => {
	test("an unnamed limit schedules the first probe one probe_interval later", () => {
		const s = onLimited(null, null, "429 slow down", NOW, "model-a", T);
		expect(s.since).toBe(NOW);
		expect(s.model).toBe("model-a");
		expect(s.reset_named).toBe(false);
		expect(s.next_probe_at).toBe(NOW + 300_000);
		expect(s.back_at).toBeNull();
		expect(s.probes).toBe(0);
		expect(s.last_error).toBe("429 slow down");
	});

	test("a named reset is trusted: no probe before the reset plus slack", () => {
		const named = NOW + 731_000;
		const s = onLimited(null, named, REAL_429, NOW, "model-a", T);
		expect(s.reset_named).toBe(true);
		expect(s.back_at).toBe(named + 15_000);
		expect(s.next_probe_at).toBe(named + 15_000);
	});
});

describe("onProbe", () => {
	test("a failed probe is retried one probe_interval later, and never sooner", () => {
		const s0 = onLimited(null, null, "429", NOW, "model-a", T);
		const r = onProbe(s0, false, "still 429", NOW + 300_000, T);
		expect(r.outcome).toEqual({ kind: "again", at: NOW + 600_000 });
		expect(r.state.probes).toBe(1);
		expect(r.state.next_probe_at).toBe(NOW + 600_000);
	});

	test("a successful probe resumes", () => {
		const s0 = onLimited(null, null, "429", NOW, "model-a", T);
		const r = onProbe(s0, true, "", NOW + 300_000, T);
		expect(r.outcome).toEqual({ kind: "resume" });
	});

	test("after max_probes failures the episode gives up", () => {
		let s = onLimited(null, null, "429", NOW, "model-a", T);
		let t = NOW;
		let last: ProbeStep | null = null;
		for (let i = 0; i < T.max_probes; i++) {
			t += 300_000;
			last = onProbe(s, false, "429", t, T);
			s = last.state;
		}
		expect(last!.outcome).toEqual({ kind: "give_up" });
		expect(last!.state.probes).toBe(T.max_probes);
	});
});

describe("runProbe", () => {
	let dir: string;
	let cfg: Config;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nlp-probe-"));
		cfg = loadConfig({ home: "/nonexistent-limit-probe-home" });
		cfg.paths.queue_state = dir;
		cfg.guards.rate_limit.probe_cmd = "omp -p --no-extensions --no-session --model {model} 'reply ok'";
		cfg.guards.rate_limit.probe_timeout_s = 90;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("the probe runs the configured command through sh with the model shell-quoted, under a timeout", () => {
		const { run, calls } = fakeRun(0);
		runProbe(cfg, "it's-m", run);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.file).toBe("sh");
		expect(calls[0]!.args).toEqual(["-c", "omp -p --no-extensions --no-session --model 'it'\\''s-m' 'reply ok'"]);
		expect(calls[0]!.opts.timeout).toBe(90_000);
	});

	test("exit 0 is ok", () => {
		const { run } = fakeRun(0);
		expect(runProbe(cfg, "model-a", run)).toEqual({ ok: true, exitCode: 0, stderr: "" });
	});

	test("a non-zero exit is not ok, and only the first 200 chars of stderr are kept", () => {
		const { run } = fakeRun(1, "e".repeat(500));
		const r = runProbe(cfg, "model-a", run);
		expect(r).not.toBe("busy");
		if (r === "busy") return;
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.length).toBe(200);
	});

	test("a timed-out probe (no status, error set) is not ok", () => {
		const { run } = fakeRun(null, "", new Error("ETIMEDOUT"));
		const r = runProbe(cfg, "model-a", run);
		expect(r).not.toBe("busy");
		if (r === "busy") return;
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBeNull();
	});

	test("a second probe while one holds the lock is busy and runs nothing", () => {
		const held = tryLock(join(dir, "main-limit.lock"));
		expect(held).not.toBeNull();
		const { run, calls } = fakeRun(0);
		expect(runProbe(cfg, "model-a", run)).toBe("busy");
		expect(calls).toHaveLength(0);
		held!.release();
	});

	test("the lock is released after a probe, so the next probe runs", () => {
		const { run, calls } = fakeRun(0);
		runProbe(cfg, "model-a", run);
		runProbe(cfg, "model-a", run);
		expect(calls).toHaveLength(2);
	});
});
