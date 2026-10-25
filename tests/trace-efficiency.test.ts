// Waste counters (src/core/trace-efficiency.ts, plan 20261024_0304 P1): what makes a tool call
// wasted — an identical re-read, a repeat of a failed command, a failed edit, a repeated guard
// block, idle polling. The tests build TraceEvents inline the way the omp adapter parses them
// (callId pairs a toolCall with its toolResult), exactly the way the trace-actions tests do;
// the rule inputs are the same shape efficiencyRules(cfg) maps from config.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "../src/core/adapter.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";
import { efficiencyRules, runEfficiency, type EfficiencyRules } from "../src/core/trace-efficiency.ts";

function rules(over: Partial<EfficiencyRules> = {}): EfficiencyRules {
	return {
		read_tools: ["read"],
		shell_tools: ["bash"],
		write_tools: ["edit", "write"],
		repeat_read_min: 3,
		guard_prefixes: ["plan-guard:", "main-guard:"],
		poll_pattern: "^\\s*(sleep\\s+\\d|ps\\b|pgrep\\b)",
		...over,
	};
}

let clock = 1000;
let callSeq = 0;
function call(tool: string, args: Record<string, unknown>, callId?: string): TraceEvent {
	const id = callId ?? `tc-${++callSeq}`;
	return { kind: "toolCall", ts: ++clock, runId: "r1", tool, args, callId: id };
}
function result(tool: string, opts: { callId?: string; isError?: boolean; text?: string } = {}): TraceEvent {
	return {
		kind: "toolResult",
		ts: ++clock,
		runId: "r1",
		tool,
		callId: opts.callId ?? `tc-${callSeq}`,
		isError: opts.isError === true,
		text: opts.text ?? "",
	};
}

const readArgs = { path: "src/core/config.ts" };

describe("repeat-read", () => {
	test("the Nth identical read with no write between counts, the earlier ones do not", () => {
		const ev = [
			call("read", readArgs),
			result("read", { callId: undefined }),
			call("read", readArgs),
			result("read"),
			call("read", readArgs),
			result("read"),
			call("read", readArgs),
			result("read"),
		];
		const e = runEfficiency(ev, rules());
		expect(e.calls).toBe(4);
		expect(e.wasted).toBe(2);
		expect(e.byRule["repeat-read"]).toBe(2);
		expect(e.steps).toEqual([
			{ index: 2, rule: "repeat-read" },
			{ index: 3, rule: "repeat-read" },
		]);
		expect(e.wastePct).toBeCloseTo(0.5);
	});

	test("a re-read after an edit is not waste; reads below the minimum are not waste", () => {
		const afterEdit = [call("read", readArgs), result("read"), call("edit", { path: "src/x.ts" }), result("edit"), call("read", readArgs), result("read")];
		const e = runEfficiency(afterEdit, rules());
		expect(e.wasted).toBe(0);
		expect(e.byRule["repeat-read"]).toBe(0);
		const belowMin = runEfficiency([call("read", readArgs), result("read"), call("read", readArgs), result("read")], rules());
		expect(belowMin.wasted).toBe(0);
	});

	test("reads with different args never chain, and min comes from the rules", () => {
		const ev = [call("read", { path: "a.ts" }), result("read"), call("read", { path: "b.ts" }), result("read")];
		expect(runEfficiency(ev, rules()).wasted).toBe(0);
		const min2 = runEfficiency([call("read", readArgs), result("read"), call("read", readArgs), result("read")], rules({ repeat_read_min: 2 }));
		expect(min2.wasted).toBe(1);
		expect(min2.steps).toEqual([{ index: 1, rule: "repeat-read" }]);
	});
});

describe("repeat-fail", () => {
	test("every repeat of a failed command counts until a write happens", () => {
		const ev = [
			call("bash", { command: "bun test" }),
			result("bash", { isError: true, text: "3 fail" }),
			call("bash", { command: "bun test" }),
			result("bash", { isError: true, text: "3 fail" }),
			call("bash", { command: "bun test" }),
			result("bash", { text: "12 pass" }),
			call("edit", { path: "src/x.ts" }),
			result("edit"),
			call("bash", { command: "bun test" }),
			result("bash", { text: "12 pass" }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(2);
		expect(e.byRule["repeat-fail"]).toBe(2);
		expect(e.steps).toEqual([
			{ index: 1, rule: "repeat-fail" },
			{ index: 2, rule: "repeat-fail" },
		]);
	});

	test("a passing repeat of a command is not waste; a rerun after a fix-write is not waste", () => {
		const passing = [call("bash", { command: "bun test" }), result("bash", { text: "12 pass" }), call("bash", { command: "bun test" }), result("bash", { text: "12 pass" })];
		expect(runEfficiency(passing, rules()).wasted).toBe(0);
		const afterFix = [
			call("bash", { command: "bun test" }),
			result("bash", { isError: true }),
			call("edit", { path: "src/x.ts" }),
			result("edit"),
			call("bash", { command: "bun test" }),
			result("bash", { text: "12 pass" }),
		];
		expect(runEfficiency(afterFix, rules()).wasted).toBe(0);
	});

	test("only the same command string repeats; different commands do not chain", () => {
		const ev = [
			call("bash", { command: "bun test" }),
			result("bash", { isError: true }),
			call("bash", { command: "bun run typecheck" }),
			result("bash", { isError: true }),
			call("bash", { command: "bun test" }),
			result("bash", { isError: true }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.byRule["repeat-fail"]).toBe(1);
	});
});

describe("failed-edit", () => {
	test("a write tool call whose result is an error counts once", () => {
		const ev = [call("edit", { path: "src/x.ts" }), result("edit", { isError: true, text: "refused" }), call("edit", { path: "src/y.ts" }), result("edit", { text: "ok" })];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(1);
		expect(e.byRule["failed-edit"]).toBe(1);
		expect(e.steps).toEqual([{ index: 0, rule: "failed-edit" }]);
	});
});

describe("guard-repeat", () => {
	test("the first block is free, every repeat of the same first line counts", () => {
		const ev = [
			call("bash", { command: "git push" }),
			result("bash", { isError: true, text: "plan-guard: never push\nsee blockers" }),
			call("bash", { command: "git push origin main" }),
			result("bash", { isError: true, text: "plan-guard: never push\nsee blockers" }),
			call("bash", { command: "git tag v1" }),
			result("bash", { isError: true, text: "main-guard: tagging is the owner's move" }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(1);
		expect(e.byRule["guard-repeat"]).toBe(1);
		expect(e.steps).toEqual([{ index: 1, rule: "guard-repeat" }]);
	});

	test("a different block first line is not a repeat", () => {
		const ev = [
			call("bash", { command: "a" }),
			result("bash", { text: "plan-guard: reason one" }),
			call("bash", { command: "b" }),
			result("bash", { text: "plan-guard: reason two" }),
		];
		expect(runEfficiency(ev, rules()).wasted).toBe(0);
	});

	test("text that merely contains a prefix mid-text is not a guard block", () => {
		const ev = [
			call("bash", { command: "a" }),
			result("bash", { text: "output\nplan-guard: quoted later" }),
			call("bash", { command: "b" }),
			result("bash", { text: "output\nplan-guard: quoted later" }),
		];
		expect(runEfficiency(ev, rules()).wasted).toBe(0);
	});
});

describe("poll", () => {
	test("an unbroken run of poll calls wastes every one after the first", () => {
		const ev = [
			call("bash", { command: "sleep 30" }),
			result("bash"),
			call("bash", { command: "ps aux" }),
			result("bash"),
			call("bash", { command: "pgrep -f ui" }),
			result("bash"),
		];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(2);
		expect(e.byRule["poll"]).toBe(2);
		expect(e.steps).toEqual([
			{ index: 1, rule: "poll" },
			{ index: 2, rule: "poll" },
		]);
	});

	test("any other call breaks the run; the pattern comes from the rules", () => {
		const broken = [
			call("bash", { command: "sleep 30" }),
			result("bash"),
			call("read", readArgs),
			result("read"),
			call("bash", { command: "sleep 30" }),
			result("bash"),
		];
		expect(runEfficiency(broken, rules()).byRule["poll"]).toBe(0);
		const custom = [call("bash", { command: "wait" }), result("bash"), call("bash", { command: "wait" }), result("bash")];
		expect(runEfficiency(custom, rules({ poll_pattern: "^wait$" })).byRule["poll"]).toBe(1);
	});
});

describe("the once-per-call rule and the empty run", () => {
	test("a call that hits several rules counts once, first rule in order wins", () => {
		const block = "plan-guard: stop writing outside the plan";
		const ev = [
			call("read", readArgs),
			result("read"),
			call("read", readArgs),
			result("read"),
			call("read", readArgs, "tc-3"),
			result("read", { callId: "tc-3", text: `${block}\nmore` }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(1);
		expect(e.byRule).toEqual({ "repeat-read": 1, "repeat-fail": 0, "failed-edit": 0, "guard-repeat": 0, poll: 0 });
	});

	test("a failed edit that also got a guard block counts as failed-edit (rule order)", () => {
		const ev = [call("edit", { path: "src/x.ts" }), result("edit", { isError: true, text: "plan-guard: protected file" })];
		const e = runEfficiency(ev, rules());
		expect(e.byRule["failed-edit"]).toBe(1);
		expect(e.byRule["guard-repeat"]).toBe(0);
	});

	test("no tool calls: everything zero, pct zero", () => {
		const e = runEfficiency(
			[
				{ kind: "assistantText", ts: 1, runId: "r1", text: "thinking" },
				{ kind: "usage", ts: 2, runId: "r1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 } },
			],
			rules(),
		);
		expect(e.calls).toBe(0);
		expect(e.wasted).toBe(0);
		expect(e.wastePct).toBe(0);
		expect(e.steps).toEqual([]);
	});
});

describe("callId pairing", () => {
	test("two parallel calls whose results arrive in order pair to the right calls", () => {
		const ev = [
			call("edit", { path: "a.ts" }, "tc-1"),
			call("edit", { path: "b.ts" }, "tc-2"),
			result("edit", { callId: "tc-2", isError: true, text: "refused b" }),
			result("edit", { callId: "tc-1", text: "ok a" }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.calls).toBe(2);
		expect(e.byRule["failed-edit"]).toBe(1);
		expect(e.steps).toEqual([{ index: 1, rule: "failed-edit" }]);
	});

	test("a result with an unknown callId pairs to nothing and cannot make a call wasted", () => {
		const ev = [call("edit", { path: "a.ts" }, "tc-1"), result("edit", { callId: "tc-9", isError: true })];
		expect(runEfficiency(ev, rules()).wasted).toBe(0);
	});
});

describe("efficiencyRules maps the config", () => {
	const home = mkdtempSync(join(tmpdir(), "ns-eff-cfg-"));
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(join(home, ".config/neurastream/config.yml"), "traces:\n  efficiency:\n    repeat_read_min: 4\n");

	test("guard tool lists and the traces.efficiency values flow through", () => {
		const cfg = loadConfig({ home, env: {} });
		const r = efficiencyRules(cfg);
		expect(r.read_tools).toEqual(cfg.guards.read_tools);
		expect(r.shell_tools).toEqual(cfg.guards.shell_tools);
		expect(r.write_tools).toEqual(cfg.guards.write_tools);
		expect(r.repeat_read_min).toBe(4);
		expect(r.guard_prefixes).toEqual(["plan-guard:", "main-guard:"]);
		expect(new RegExp(r.poll_pattern).test("  sleep 5")).toBe(true);
	});

	test("check rejects a min below 2, a broken regex and empty guard prefixes", () => {
		expect(() => loadConfig({ home, env: {}, }) ).not.toThrow();
		const bad = (extra: string): string => {
			const h = mkdtempSync(join(tmpdir(), "ns-eff-bad-"));
			mkdirSync(join(h, ".config/neurastream"), { recursive: true });
			writeFileSync(join(h, ".config/neurastream/config.yml"), `traces:\n  efficiency:\n${extra}`);
			try {
				loadConfig({ home: h, env: {} });
			} catch (err) {
				if (err instanceof ConfigError) return err.message;
				throw err;
			}
			return "";
		};
		expect(bad("    repeat_read_min: 1\n")).toContain("repeat_read_min");
		expect(bad("    poll_pattern: \"(\"\n")).toContain("poll_pattern");
		expect(bad("    guard_prefixes: [\"\"]\n")).toContain("guard_prefixes");
	});
});
