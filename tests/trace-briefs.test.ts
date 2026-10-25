import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTraces } from "../src/cli/traces.ts";
import { spawnBriefs, spawnBriefsIn } from "../src/adapters/omp/traces.ts";
import type { TraceEvent, TraceSource } from "../src/core/adapter.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";
import { type BriefFeatures, type BriefRow, type BriefRules, briefFeatures, briefReport, briefRows } from "../src/core/trace-briefs.ts";
import { efficiencyRules } from "../src/core/trace-efficiency.ts";

const FIX = join(import.meta.dir, "fixtures/traces");
const TMP: string[] = [];

afterEach(() => {
	for (const d of TMP.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RULES: BriefRules = {
	verify_pattern: "\\bbun test\\b",
	phase_pattern: "\\bP\\d+\\b",
	plan_pattern: "docs/plans/\\S+\\.md",
};

/** Main session with a refused and a successful spawn of NsBriefA, B and C, and a refused-only D; NsBriefA runs three reads, NsBriefC one clean command, NsBriefB has no trace. */
function sandbox(): { H: string; sessions: string } {
	const H = mkdtempSync(join(tmpdir(), "ns-briefs-"));
	TMP.push(H);
	mkdirSync(join(H, ".config/neurastream"), { recursive: true });
	writeFileSync(join(H, ".config/neurastream/config.yml"), `paths:\n  home: "${H}"\n`);
	const proj = join(H, ".omp/agent/sessions/briefs-proj");
	const sub = join(proj, "2026-10-25T12-00-00-000Z_briefs-parent");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(proj, "2026-10-25T12-00-00-000Z_briefs-main.jsonl"), readFileSync(join(FIX, "briefs-main.jsonl"), "utf8"));
	writeFileSync(join(sub, "NsBriefA.jsonl"), readFileSync(join(FIX, "briefs-sub-a.jsonl"), "utf8"));
	writeFileSync(join(sub, "NsBriefC.jsonl"), readFileSync(join(FIX, "briefs-sub-c.jsonl"), "utf8"));
	return { H, sessions: join(H, ".omp/agent/sessions") };
}

function call(callId: string, tool: string, args: Record<string, unknown>): TraceEvent {
	return { kind: "toolCall", ts: 1, runId: "x", tool, args, callId };
}

function result(callId: string, text: string, isError = false): TraceEvent {
	return { kind: "toolResult", ts: 2, runId: "x", callId, tool: "read", isError, text };
}

function feat(p: Partial<BriefFeatures> = {}): BriefFeatures {
	return { chars: 100, fileLines: false, verify: false, budget: false, acceptance: 0, phase: false, plan: false, ...p };
}

function row(p: Partial<BriefFeatures>, waste: number | null, accepted: boolean): BriefRow {
	return {
		agent: "x",
		ts: null,
		features: feat(p),
		calls: waste === null ? 0 : 10,
		wasted: waste === null ? 0 : Math.round(waste * 10),
		waste_pct: waste,
		accepted,
	};
}

describe("spawnBriefs (omp adapter)", () => {
	test("keeps each successful spawn once, skips refused ones, joins shared context ahead of task text", () => {
		const { sessions } = sandbox();
		const briefs = spawnBriefs(sessions, "MAIN 12-00-00");
		expect(briefs.map((b) => b.agent)).toEqual(["NsBriefA", "NsBriefB", "NsBriefC"]);
		const a = briefs.find((b) => b.agent === "NsBriefA");
		expect(a?.brief.startsWith("# Goal\nship P1\nPhase: P1\nWorktree: /tmp/wt-briefs\n\nBuild the join in src/core/guards.ts:206.")).toBe(true);
		expect(a?.brief).toContain("# Goal\nship P1");
		const c = briefs.find((b) => b.agent === "NsBriefC");
		expect(c?.brief).toContain("Call budget: 40");
	});
	test("a 3-line shared context ahead of a task ending in Acceptance counts only the task's two acceptance lines", () => {
		const H = mkdtempSync(join(tmpdir(), "ns-briefs-join-"));
		TMP.push(H);
		const file = join(H, "2026-10-25T13-00-00-000Z_join-main.jsonl");
		const context = "Plan: docs/plans/20261025_join.md\nPhase: P3c\nWorktree: /tmp/wt-join";
		const task = "Build the join.\nRun bun test tests/trace-briefs.test.ts.\n# Acceptance\n- join rows\n- features";
		const lines = [
			{ type: "session", timestamp: "2026-10-25T13:00:00.000Z", id: "join-main" },
			{ type: "message", timestamp: "2026-10-25T13:00:01.000Z", message: { role: "assistant", model: "m1", provider: "p1", content: [{ type: "toolCall", id: "t1", name: "task", arguments: { i: "spawn A", context, tasks: [{ name: "NsJoinA", agent: "explore", task }] } }] } },
			{ type: "message", timestamp: "2026-10-25T13:00:02.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "task", isError: false, content: [{ type: "text", text: "Spawned agent `NsJoinA` (job `NsJoinA`)." }] } },
		];
		writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		const briefs = spawnBriefsIn(file, "MAIN 13-00-00");
		expect(briefs.map((b) => b.agent)).toEqual(["NsJoinA"]);
		expect(briefFeatures(briefs[0]?.brief ?? "", RULES).acceptance).toBe(2);
	});

	test("phase_pattern default: sub-phases name a phase, a word that merely contains P<digits> does not", () => {
		const { H } = sandbox();
		const rules: BriefRules = { ...RULES, phase_pattern: loadConfig({ home: H }).traces.briefs.phase_pattern };
		for (const t of ["Phase: P3c", "P10"]) expect(briefFeatures(t, rules).phase).toBe(true);
		for (const t of ["PR 12", "MP3"]) expect(briefFeatures(t, rules).phase).toBe(false);
	});
});

describe("briefFeatures", () => {
	test("reads the five presence features and counts acceptance lines under each heading", () => {
		const text =
			"Build the join in src/core/guards.ts:206.\nRun bun test tests/trace-briefs.test.ts.\nPhase P1.\n# Acceptance\n- join rows\n- features\n\n# Goal\nship P1\n# Acceptance\n- tests green\n- docs updated";
		const f = briefFeatures(text, RULES);
		expect(f.chars).toBe(text.length);
		expect(f.fileLines).toBe(true);
		expect(f.verify).toBe(true);
		expect(f.budget).toBe(false);
		expect(f.acceptance).toBe(4);
		expect(f.phase).toBe(true);
		expect(f.plan).toBe(false);
	});

	test("budget is true only when a Call budget line is present", () => {
		expect(briefFeatures("Do plain work.\nCall budget: 40", RULES).budget).toBe(true);
		expect(briefFeatures("Do plain work with no budget line", RULES).budget).toBe(false);
	});

	test("plan and phase follow the configured patterns", () => {
		const f = briefFeatures("Write docs/plans/20261024_0305_x.md", RULES);
		expect(f.plan).toBe(true);
		expect(f.phase).toBe(false);
		expect(f.fileLines).toBe(false);
		expect(f.verify).toBe(false);
	});
});

describe("briefRows join", () => {
	test("one row per spawned agent with its waste from the agent's own trace and its accept state", async () => {
		const { H, sessions } = sandbox();
		const cfg = loadConfig({ home: H });
		const briefs = spawnBriefs(sessions, "MAIN 12-00-00");
		const traces: TraceSource = {
			events: (runId: string): TraceEvent[] => {
				if (runId === "NsBriefA") {
					return [
						call("r1", "read", { path: "src/a.ts" }), result("r1", "ok"),
						call("r2", "read", { path: "src/a.ts" }), result("r2", "ok"),
						call("r3", "read", { path: "src/a.ts" }), result("r3", "ok"),
					];
				}
				if (runId === "NsBriefC") return [call("b1", "bash", { command: "bun test" }), result("b1", " 3 pass / 0 fail")];
				return [];
			},
		};
		const scores = [
			{ type: "accept", agent: "NsBriefA" },
			{ type: "diagnose", agent: "NsBriefC" },
		];
		const rows = briefRows(briefs, traces, scores, { brief: RULES, efficiency: efficiencyRules(cfg) });
		expect(rows.map((r) => r.agent)).toEqual(["NsBriefA", "NsBriefB", "NsBriefC"]);
		const [a, b, c] = rows;
		expect(a?.calls).toBe(3);
		expect(a?.wasted).toBe(1);
		expect(a?.waste_pct).toBeCloseTo(1 / 3);
		expect(a?.accepted).toBe(true);
		expect(a?.features.acceptance).toBe(2);
		// no trace: waste is unknown ("-" in the CLI), not zero
		expect(b?.waste_pct).toBeNull();
		expect(b?.accepted).toBe(false);
		expect(c?.waste_pct).toBe(0);
		expect(c?.accepted).toBe(true);
		expect(c?.features.budget).toBe(true);
	});
});

describe("briefReport (P2)", () => {
	test("exact means per feature side, and n below min_n is reported as null", () => {
		const rows = [
			row({ fileLines: true }, 0.1, true),
			row({ fileLines: true }, 0.3, true),
			row({ fileLines: true }, 0.2, false),
			row({ fileLines: true }, 0.4, false),
			row({ fileLines: true }, 0.5, true),
			row({}, 0.6, false),
			row({}, 0.8, false),
		];
		const rep = briefReport(rows, { min_n: 5, char_buckets: [1500, 4000] });
		const fl = rep.features.find((f) => f.feature === "fileLines");
		expect(fl?.with.n).toBe(5);
		expect(fl?.with.waste).toBeCloseTo(0.3);
		expect(fl?.with.accept).toBeCloseTo(0.6);
		expect(fl?.without.n).toBe(2);
		expect(fl?.without.wasteN).toBe(2);
		expect(fl?.without.waste).toBeNull();
		expect(fl?.without.accept).toBeNull();
	});

	test("char buckets split rows by the configured boundaries", () => {
		const rows = [
			row({ chars: 1000 }, 0.1, true),
			row({ chars: 2000 }, 0.1, true),
			row({ chars: 2000 }, 0.1, true),
			row({ chars: 5000 }, 0.1, true),
			row({ chars: 5000 }, 0.1, true),
			row({ chars: 5000 }, 0.1, true),
		];
		const rep = briefReport(rows, { min_n: 5, char_buckets: [1500, 4000] });
		expect(rep.buckets.map((b) => b.label)).toEqual(["<1500", "1500-3999", ">=4000"]);
		expect(rep.buckets.map((b) => b.stat.n)).toEqual([1, 2, 3]);
		expect(rep.buckets.every((b) => b.stat.accept === null)).toBe(true);
	});
});

describe("traces.briefs config", () => {
	test("defaults are char_buckets [1500, 4000] and min_n 5; bad values are rejected", () => {
		const H = mkdtempSync(join(tmpdir(), "ns-briefs-cfg-"));
		TMP.push(H);
		mkdirSync(join(H, ".config/neurastream"), { recursive: true });
		const file = join(H, ".config/neurastream/config.yml");
		const cfg = loadConfig({ home: H });
		expect(cfg.traces.briefs.char_buckets).toEqual([1500, 4000]);
		expect(cfg.traces.briefs.min_n).toBe(5);
		expect(cfg.traces.briefs.verify_pattern).not.toBe("");
		writeFileSync(file, "traces:\n  briefs:\n    min_n: 0\n");
		expect(() => loadConfig({ home: H })).toThrow(ConfigError);
		writeFileSync(file, "traces:\n  briefs:\n    char_buckets: [4000, 1500]\n");
		expect(() => loadConfig({ home: H })).toThrow(ConfigError);
		writeFileSync(file, "traces:\n  briefs:\n    phase_pattern: '('\n");
		expect(() => loadConfig({ home: H })).toThrow(ConfigError);
	});
});

describe("traces briefs CLI", () => {
	test("prints one row per spawn; --json carries features and lengths, never brief text", async () => {
		const { H } = sandbox();
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["briefs", "--since", "30d"], { home: H });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		const text = logs.join("\n");
		expect(text).toContain("NsBriefA");
		expect(text).toContain("NsBriefB");
		expect(text).toContain("NsBriefC");
		expect(text).not.toContain("NsBriefD");

		logs.length = 0;
		console.log = (line: string) => logs.push(line);
		try {
			rc = await runTraces(["briefs", "--since", "30d", "--json"], { home: H });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		const out = logs.join("\n");
		for (const leak of ["Build the join", "Call budget", "second wave", "# Goal", "bun test tests", "Write docs/plans"]) {
			expect(out).not.toContain(leak);
		}
		const rows = JSON.parse(out) as BriefRow[];
		expect(rows.map((r) => r.agent).sort()).toEqual(["NsBriefA", "NsBriefB", "NsBriefC"]);
	});

	test("--report marks sides with n below min_n as too small", async () => {
		const { H } = sandbox();
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["briefs", "--since", "30d", "--report"], { home: H });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		expect(logs.join("\n")).toContain("n too small");
	});
});
