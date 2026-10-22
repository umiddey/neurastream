// agent-ledger --cap does not count an agent whose session has not been written for
// ledger.idle_not_live_min minutes: its parent session is gone, so it holds no provider slot.

import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLedger } from "../src/core/agent-ledger.ts";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { loadConfig } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "ledger-not-live-"));

// A throwaway home, as in tests/rollover-omp.test.ts: the live config must not be read here.
// Inherited QUEUE_* (the caller's live session) beats the sandbox config, so save and delete
// them before loadConfig; afterAll restores them.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const cfg = loadConfig({ home: join(TMP, "home") });

// nowSec() reads NEURASTREAM_NOW, so idle minutes are exact.
const NOW = 1760000000;
const savedNow = process.env.NEURASTREAM_NOW;
process.env.NEURASTREAM_NOW = String(NOW);

// agentLedger runs queue-check for the priority check: an empty stub keeps it quiet.
const bin = join(TMP, "home", ".local", "bin");
mkdirSync(bin, { recursive: true });
const queueCheck = join(bin, "queue-check");
writeFileSync(queueCheck, "#!/bin/sh\nexit 0\n");
chmodSync(queueCheck, 0o755);

afterAll(() => {
	if (savedNow === undefined) delete process.env.NEURASTREAM_NOW;
	else process.env.NEURASTREAM_NOW = savedNow;
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

function sub(id: string, idleMin: number, statusDetail: string): Run {
	const lastWriteAt = NOW - idleMin * 60;
	return {
		id,
		kind: "sub",
		model: "zai/glm-5",
		calls: 3,
		tokens: 1000,
		cacheRead: 0,
		cost: 0.1,
		inputTokens: 0,
		status: "running",
		statusDetail,
		startedAt: lastWriteAt - 600,
		lastWriteAt,
		endedAt: null,
		messages: [],
		scoreModel: "zai/glm-5",
		scoreCost: 0.1,
		scoreHours: 0.2,
		scoreRunning: true,
		scoreSurvived: false,
		scoreEnd: "running",
	};
}

const source = (rows: Run[]): RunSource => ({ listRuns: () => rows, mainSession: () => null });

// agentLedger writes its report to stdout; capture it.
function ledger(args: string[], rows: Run[]): { code: number; out: string } {
	let out = "";
	const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out += String(chunk);
		return true;
	});
	try {
		const code = agentLedger(args, cfg, source(rows));
		return { code, out };
	} finally {
		spy.mockRestore();
	}
}

test("--cap leaves out two agents idle 120 min; the fresh one takes the only zai slot", () => {
	const rows = [
		sub("NsOldA", 120, "RUNNING (idle 120m)"),
		sub("NsOldB", 120, "RUNNING (idle 120m)"),
		sub("NsFresh", 2, "RUNNING"),
	];
	const { code, out } = ledger(["--cap", "--provider", "zai", "--slots", "1"], rows);
	expect(out).toContain("planned provider: zai, current=1, slots=1, allowed=True");
	expect(out).toContain("NOT LIVE (no write for ≥ 60m, not counted): NsOldA, NsOldB");
	expect(out).not.toContain("FULL");
	expect(code).toBe(0);
});

test("--cap is FULL when all three zai agents were written in the last 2 min", () => {
	const rows = [sub("NsFreshA", 2, "RUNNING"), sub("NsFreshB", 2, "RUNNING"), sub("NsFreshC", 2, "RUNNING")];
	const { code, out } = ledger(["--cap", "--provider", "zai", "--slots", "1"], rows);
	expect(out).toContain("FULL zai: NsFreshA, NsFreshB, NsFreshC");
	expect(out).toContain("planned provider: zai, current=3, slots=1, allowed=False");
	expect(out).not.toContain("NOT LIVE");
	expect(code).toBe(1);
});
