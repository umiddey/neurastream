// Real-time incident detectors (src/core/incident-detectors.ts, plan P3): one positive and one
// negative fixture per detector, plus dedupe across repeated runs. The D1 fixture is the trimmed
// real line that caught the ledger lying about a completed agent (omp Main session, 2026-10-22).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run, TraceEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { readIncidents } from "../src/core/incidents.ts";
import {
	blockLoop,
	blockThenBypass,
	ledgerContradictions,
	ownerCorrection,
	runDetectors,
	runDetectorsGated,
	toolBins,
	toolCrash,
	type TaskResult,
} from "../src/core/incident-detectors.ts";
import { completedResults } from "../src/adapters/omp/sessions.ts";

const REPO = dirname(dirname(import.meta.path));
const TMP = mkdtempSync(join(tmpdir(), "nsar-detectors-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function cfg(): Config {
	const home = join(TMP, `home-${++n}`);
	const queueState = join(home, ".local/state/queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  queue_state: "${queueState}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
`,
	);
	return loadConfig({ home, env: {} });
}

const NOW = 1_760_000_000;

function run(id: string, status: Run["status"], lastWriteAt = NOW - 60): Run {
	return {
		id,
		kind: "sub",
		model: "test/model",
		calls: 3,
		tokens: 100,
		cacheRead: 90,
		cost: 0.01,
		inputTokens: 10,
		prefillTokens: 0,
		status,
		statusDetail: status.toUpperCase(),
		startedAt: NOW - 7200,
		lastWriteAt,
		endedAt: null,
		messages: [],
		scoreModel: "test/model",
		scoreCost: 0,
		scoreHours: 0,
		scoreRunning: false,
		scoreSurvived: false,
		scoreEnd: "",
	};
}

// The trimmed real line: Main's session announced the agent completed; the ledger kept it RUNNING.
const FIXTURE_LINE = JSON.parse(readFileSync(join(REPO, "tests/fixtures/incidents/async-result-line.json"), "utf8")) as Record<string, unknown>;
// Same story through Main's wait tool (P3 fix B): the wait result text holds the task-result.
const WAIT_LINE = JSON.parse(readFileSync(join(REPO, "tests/fixtures/incidents/wait-toolresult-line.json"), "utf8")) as Record<string, unknown>;
const fixtureResults = (ts: number): TaskResult[] => [{ agent: "AmiiirP9RunGlm", ts }];

test("D1 fixture parses: the async-result line names the agent and a timestamp", () => {
	const results = completedResults(`${JSON.stringify(FIXTURE_LINE)}\n`);
	expect(results).toEqual([{ agent: "AmiiirP9RunGlm", ts: expect.any(Number) }]);
	expect(Number.isFinite(results[0]!.ts)).toBe(true);
	// A non-async line and one without a readable timestamp are skipped.
	const partial = JSON.stringify({ ...FIXTURE_LINE, timestamp: "nope" });
	expect(completedResults(`${partial}\n${JSON.stringify({ type: "message" })}\n`)).toEqual([]);
});

test("D1 fixture parses: a wait toolResult naming a completed agent counts too", () => {
	const results = completedResults(`${JSON.stringify(WAIT_LINE)}\n`);
	expect(results).toEqual([{ agent: "NsRolloverDrainGlm", ts: expect.any(Number) }]);
	// A wait result with no completed task-result inside, and one without a readable timestamp, are skipped.
	const plain = {
		...WAIT_LINE,
		message: { ...(WAIT_LINE.message as Record<string, unknown>), content: [{ type: "text", text: "## Completed (0)\n\nnothing yet" }] },
	};
	const noTs = { ...WAIT_LINE, timestamp: "nope" };
	expect(completedResults(`${JSON.stringify(plain)}\n${JSON.stringify(noTs)}\n`)).toEqual([]);
});

test("D1 through wait results: the ledger contradicts an agent finished via wait", () => {
	const c = cfg();
	const wait = completedResults(`${JSON.stringify(WAIT_LINE)}\n`);
	expect(wait).toHaveLength(1);
	// The fixture's real timestamp is fixed; look 10 minutes after it, past the 3-minute grace.
	const seen = runDetectors(c, { results: wait, runs: [run("NsRolloverDrainGlm", "running")] }, wait[0]!.ts + 600);
	expect(seen).toHaveLength(1);
	expect(readIncidents(c)[0]).toMatchObject({ source: "realtime", kind: "ledger-contradiction" });
});

test("D1 positive: the ledger still shows the agent RUNNING past the grace", () => {
	const c = cfg();
	const found = ledgerContradictions(fixtureResults(NOW - 600), [run("AmiiirP9RunGlm", "running")], NOW, 3);
	expect(found).toHaveLength(1);
	expect(found[0]!.kind).toBe("ledger-contradiction");
	expect(found[0]!.fingerprint).toBe("ledger-contradiction:AmiiirP9RunGlm");
	const seen = runDetectors(c, { results: fixtureResults(NOW - 600), runs: [run("AmiiirP9RunGlm", "running")] }, NOW);
	expect(seen).toHaveLength(1);
	expect(readIncidents(c)[0]).toMatchObject({ source: "realtime", kind: "ledger-contradiction", count: 1 });
});

test("D1 negative: done in the ledger, inside the grace, or no ledger row at all", () => {
	expect(ledgerContradictions(fixtureResults(NOW - 600), [run("AmiiirP9RunGlm", "done")], NOW, 3)).toEqual([]);
	expect(ledgerContradictions(fixtureResults(NOW - 60), [run("AmiiirP9RunGlm", "running")], NOW, 3)).toEqual([]);
	expect(ledgerContradictions(fixtureResults(NOW - 600), [run("OtherAgent", "running")], NOW, 3)).toEqual([]);
	expect(ledgerContradictions(fixtureResults(NOW - 600), [], NOW, 3)).toEqual([]);
});

test("D2 positive: a neurastream bin whose output has a stack frame from the package", () => {
	const output = [
		"traceback-ish noise",
		"1 | agent-ledger --cap",
		"      at rowLine (/home/x/.bun/install/global/node_modules/neurastream/src/core/agent-ledger.ts:21:9)",
	].join("\n");
	const f = toolCrash("agent-ledger --cap", output, ["neurastream", "agent-ledger"]);
	expect(f).toMatchObject({ kind: "tool-crash" });
	expect(f!.fingerprint!.startsWith("tool-crash:agent-ledger:")).toBe(true);
	expect(f!.summary).toContain("agent-ledger crashed");
	expect(toolBins().length).toBeGreaterThan(0);
	const c = cfg();
	runDetectors(c, { bash: { command: "agent-ledger --cap", output } }, NOW);
	expect(readIncidents(c)[0]).toMatchObject({ source: "realtime", kind: "tool-crash" });
});

test("D2 positive: 'internal error' counts even without a frame", () => {
	const f = toolCrash("queue-check --priority-ids", "queue-check: internal error: ledger closed\n", ["queue-check"]);
	expect(f).toMatchObject({ kind: "tool-crash" });
	expect(f!.fingerprint).toBe("tool-crash:queue-check:queue-check: internal error: ledger closed");
});

test("D2 negative: not our bin, or a clean tool failure", () => {
	const output = "      at rowLine (/home/x/neurastream/src/core/agent-ledger.ts:21:9)";
	expect(toolCrash("cat notes.txt", output, ["agent-ledger"])).toBeNull();
	expect(toolCrash("agent-ledger --cap", "agent-ledger: unknown flag --cap\n", ["agent-ledger"])).toBeNull();
	// A name that merely contains a bin name is not the bin.
	expect(toolCrash("cat agent-ledger-notes.txt", "internal error", ["agent-ledger"])).toBeNull();
});

const REASON = "stop: plan not parked";

function blockLines(count: number, at: number, step: number): string {
	return Array.from({ length: count }, (_, i) => `${new Date((at - i * step) * 1000).toISOString()} BLOCK ${REASON}`).join("\n");
}

test("D3 positive: the same reason 20× inside the hour; the runner records it", () => {
	const blocks = blockLines(20, NOW, 60)
		.split("\n")
		.map(l => {
			const m = /^(\S+) BLOCK (.*)$/.exec(l)!;
			return { ts: Date.parse(m[1]!) / 1000, reason: m[2]! };
		});
	const found = blockLoop(blocks, NOW, 20);
	expect(found).toHaveLength(1);
	expect(found[0]!.fingerprint).toBe(`block-loop:${REASON}`);
	expect(found[0]!.summary).toContain("20×");
	const c = cfg();
	runDetectors(c, { blocks }, NOW);
	expect(readIncidents(c)[0]).toMatchObject({ source: "realtime", kind: "block-loop" });
});

test("D3 negative: 19× or spread over two hours is no loop", () => {
	const nineteen = blockLines(19, NOW, 60)
		.split("\n")
		.map(l => {
			const m = /^(\S+) BLOCK (.*)$/.exec(l)!;
			return { ts: Date.parse(m[1]!) / 1000, reason: m[2]! };
		});
	expect(blockLoop(nineteen, NOW, 20)).toEqual([]);
	const spread = blockLines(20, NOW, 400)
		.split("\n")
		.map(l => {
			const m = /^(\S+) BLOCK (.*)$/.exec(l)!;
			return { ts: Date.parse(m[1]!) / 1000, reason: m[2]! };
		});
	expect(blockLoop(spread, NOW, 20)).toEqual([]);
});

const PATTERNS = [/no/, /wrong/, /why did/, /stop/].map(p => new RegExp(p.source, "i"));

test("D4 positive: a correcting owner message becomes an incident with its first 200 chars", () => {
	const text = "Stop — this is wrong, why did you touch the branch? ".repeat(6);
	const f = ownerCorrection(text, PATTERNS, NOW);
	expect(f).toMatchObject({ kind: "owner-correction" });
	expect(f!.summary.length).toBe(200);
	expect(f!.fingerprint).toMatch(/^owner-correction:\d{8}$/);
	const c = cfg();
	runDetectors(c, { prompt: text }, NOW);
	expect(readIncidents(c)[0]).toMatchObject({ source: "realtime", kind: "owner-correction" });
});

test("D4 negative: a plain message matches no pattern; continuations are not owner messages", () => {
	expect(ownerCorrection("please continue with the plan and report back", PATTERNS, NOW)).toBeNull();
	expect(ownerCorrection("   ", PATTERNS, NOW)).toBeNull();
});

test("dedupe across repeated runs: the same sighting updates count and lastSeen, no new record", () => {
	const c = cfg();
	const input = { results: fixtureResults(NOW - 600), runs: [run("AmiiirP9RunGlm", "running")] };
	const first = runDetectors(c, input, NOW);
	const second = runDetectors(c, input, NOW + 120);
	expect(first).toHaveLength(1);
	expect(second).toHaveLength(1);
	expect(second[0]!.id).toBe(first[0]!.id);
	expect(second[0]!.count).toBe(2);
	expect(second[0]!.lastSeen).toBe(NOW + 120);
	expect(readIncidents(c)).toHaveLength(1);
});

test("a failed detector is logged, never thrown: a failing gather does not break the cheap detectors", () => {
	const c = cfg();
	const seen = runDetectorsGated(
		c,
		{ bash: { command: "neurastream metrics report", output: "at neurastream (/x/report.ts:1:1)" } },
		() => {
			throw new Error("unreadable guard log");
		},
		NOW,
	);
	expect(seen.map(i => i.kind)).toEqual(["tool-crash"]);
	expect(readIncidents(c).map(i => i.kind)).toEqual(["tool-crash"]);
});

test("scan gate: two calls inside the interval gather the expensive inputs once", () => {
	const c = cfg();
	let gathers = 0;
	const gather = () => {
		gathers += 1;
		return { results: [], runs: [], blocks: [] };
	};
	runDetectorsGated(c, { prompt: "all quiet" }, gather, NOW);
	runDetectorsGated(c, { prompt: "still quiet" }, gather, NOW + c.incidents.scan_interval_sec - 1);
	expect(gathers).toBe(1);
});

test("scan gate: past the interval the inputs are gathered again; cheap detectors run either way", () => {
	const c = cfg();
	let gathers = 0;
	const gather = () => {
		gathers += 1;
		return { results: [], runs: [], blocks: [] };
	};
	const cheap = { bash: { command: "neurastream doctor", output: "internal error\nat neurastream (x.ts:1:1)" } };
	const first = runDetectorsGated(c, cheap, gather, NOW);
	expect(first.map(i => i.kind)).toEqual(["tool-crash"]);
	const second = runDetectorsGated(c, cheap, gather, NOW + c.incidents.scan_interval_sec);
	expect(gathers).toBe(2);
	expect(second.map(i => i.kind)).toEqual(["tool-crash"]);
	expect(second[0]!.count).toBe(2);
});

// ---- D8: a guard block the same action got past ----

const BLOCK_TEXT = "main-guard: eval reads a protected page path; run the page through the plan's task instead";
const BLOCKED_CODE = 'await fs.readFile("/work/app/pages/index.tsx", "utf8")';
const BYPASS_CODE = 'await fs.readFile("/work/app/" + "pa" + "ges/index.tsx", "utf8")';

function evalCall(callId: string, ts: number, code: string, text: string, isError: boolean): TraceEvent[] {
	return [
		{ kind: "toolCall", ts, runId: "MAIN", tool: "eval", args: { code }, callId },
		{ kind: "toolResult", ts: ts + 1, runId: "MAIN", tool: "eval", callId, isError, text },
	];
}

test("D8 block-then-bypass: the 2026-10-27 pair is one finding", () => {
	const events = [...evalCall("c1", 1000, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", 1060, BYPASS_CODE, "ok", false)];
	const found = blockThenBypass(events, 600, 0.6);
	expect(found.length).toBe(1);
	expect(found[0]!.kind).toBe("block-then-bypass");
	expect(found[0]!.summary.startsWith("possible guard false positive: main-guard:")).toBe(true);
});

test("D8 block-then-bypass: a different action after a block is not a bypass", () => {
	const events = [...evalCall("c1", 1000, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", 1060, 'await db.query("select 1")', "ok", false)];
	expect(blockThenBypass(events, 600, 0.6)).toEqual([]);
});

test("D8 block-then-bypass: a repeat outside the window is not a bypass", () => {
	const events = [...evalCall("c1", 1000, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", 1700, BYPASS_CODE, "ok", false)];
	expect(blockThenBypass(events, 600, 0.6)).toEqual([]);
});

test("D8 block-then-bypass: args below the similarity threshold are not a bypass", () => {
	const events = [...evalCall("c1", 1000, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", 1060, BYPASS_CODE, "ok", false)];
	expect(blockThenBypass(events, 600, 0.9)).toEqual([]);
});

test("D8 frontier: a block at or before the scanned frontier is not reported again", () => {
	const events = [...evalCall("c1", 1000, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", 1060, BYPASS_CODE, "ok", false)];
	expect(blockThenBypass(events, 600, 0.6, 1061)).toEqual([]);
	expect(blockThenBypass(events, 600, 0.6, 999)).toHaveLength(1);
});

test("D8 frontier: the next scan over the same session does not re-raise the pair", () => {
	const c = cfg();
	const events = [...evalCall("c1", NOW, BLOCKED_CODE, BLOCK_TEXT, true), ...evalCall("c2", NOW + 60, BYPASS_CODE, "ok", false)];
	const gather = () => ({ results: [], runs: [], blocks: [], mainEvents: events });
	const first = runDetectorsGated(c, {}, gather, NOW);
	expect(first.find(i => i.kind === "block-then-bypass")).toBeDefined();
	const second = runDetectorsGated(c, {}, gather, NOW + c.incidents.scan_interval_sec);
	expect(second.find(i => i.kind === "block-then-bypass")).toBeUndefined();
	expect(readIncidents(c).find(i => i.kind === "block-then-bypass")!.count).toBe(1);
});
