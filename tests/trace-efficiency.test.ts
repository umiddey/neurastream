// Waste counters (src/core/trace-efficiency.ts, plan 20261024_0304 P1): what makes a tool call
// wasted — an identical re-read, a repeat of a failed command, a failed edit, a repeated guard
// block, idle polling. The tests build TraceEvents inline the way the omp adapter parses them
// (callId pairs a toolCall with its toolResult), exactly the way the trace-actions tests do;
// the rule inputs are the same shape efficiencyRules(cfg) maps from config.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { TraceEvent } from "../src/core/adapter.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";
import { efficiencyRules, runEfficiency, type EfficiencyRules } from "../src/core/trace-efficiency.ts";
import { runTraces } from "../src/cli/traces.ts";

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

// Review fix (Main 2026-10-25 09:58): an earlier rule counting the call must not stop the other
// rules' state from updating — only the counted rule is first-wins.
describe("rule state updates even when an earlier rule counted the call", () => {
	test("a call that is repeat-fail AND a poll still advances the poll run, so the next poll counts", () => {
		const ev = [
			call("bash", { command: "sleep 30" }),
			result("bash", { isError: true }),
			call("bash", { command: "ls" }),
			result("bash"),
			call("bash", { command: "sleep 30" }),
			result("bash", { isError: true }),
			call("bash", { command: "ps aux" }),
			result("bash"),
		];
		const e = runEfficiency(ev, rules());
		expect(e.calls).toBe(4);
		expect(e.wasted).toBe(2);
		expect(e.byRule["repeat-fail"]).toBe(1);
		expect(e.byRule["poll"]).toBe(1);
		expect(e.steps).toEqual([
			{ index: 2, rule: "repeat-fail" },
			{ index: 3, rule: "poll" },
		]);
	});

	test("a repeat-read whose result carries a guard block still records the block's first line", () => {
		const block = "main-guard: no pushing without the owner";
		const ev = [
			call("read", readArgs),
			result("read"),
			call("read", readArgs),
			result("read"),
			call("read", readArgs),
			result("read", { text: `${block}\ndetail` }),
			call("bash", { command: "git push" }),
			result("bash", { text: `${block}\ndetail` }),
		];
		const e = runEfficiency(ev, rules());
		expect(e.wasted).toBe(2);
		expect(e.byRule["repeat-read"]).toBe(1);
		expect(e.byRule["guard-repeat"]).toBe(1);
		expect(e.steps).toEqual([
			{ index: 2, rule: "repeat-read" },
			{ index: 3, rule: "guard-repeat" },
		]);
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

// ---- P2: `traces efficiency` CLI + agent-score wiring ----

const FIX = join(dirname(dirname(import.meta.path)), "tests", "fixtures", "traces");
const P2HOME = mkdtempSync(join(tmpdir(), "ns-eff-cli-"));
const P2SESSIONS = join(P2HOME, ".omp/agent/sessions/eff-proj");
const P2ROOTS = [P2HOME];

afterAll(() => {
	for (const r of P2ROOTS) rmSync(r, { recursive: true, force: true });
});

mkdirSync(join(P2HOME, ".config/neurastream"), { recursive: true });
mkdirSync(P2SESSIONS, { recursive: true });
writeFileSync(join(P2HOME, ".config/neurastream/config.yml"), `paths:\n  home: "${P2HOME}"\n`);
// Real layout: sessions/<project>/<dated main>.jsonl -> run ids MAIN 11-00-00 / MAIN 11-10-00.
writeFileSync(join(P2SESSIONS, "2026-10-25T11-00-00-000Z_eff-red.jsonl"), readFileSync(join(FIX, "efficiency-red.jsonl"), "utf8"));
writeFileSync(join(P2SESSIONS, "2026-10-25T11-10-00-000Z_eff-clean.jsonl"), readFileSync(join(FIX, "actions-benign.jsonl"), "utf8"));

describe("traces efficiency CLI", () => {
	test("one line per run with calls, wasted, pct, then a count per waste rule", async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["efficiency", "MAIN 11-00-00"], { home: P2HOME });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		expect(logs[0]).toBe("MAIN 11-00-00: 10 calls, 5 wasted (50%)");
		expect(logs.slice(1)).toEqual([
			"  repeat-read: 1",
			"  repeat-fail: 1",
			"  failed-edit: 1",
			"  guard-repeat: 1",
			"  poll: 1",
		]);
	});

	test("a clean run prints the no-waste line; --json prints report records", async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["efficiency", "--since", "24h", "--json"], { home: P2HOME });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		const reports = JSON.parse(logs.join("\n")) as { runId: string; calls: number; wasted: number; wastePct: number; byRule: Record<string, number>; steps: { index: number; rule: string }[] }[];
		expect(reports.map((r) => r.runId).sort()).toEqual(["MAIN 11-00-00", "MAIN 11-10-00"]);
		const red = reports.find((r) => r.runId === "MAIN 11-00-00")!;
		expect(red).toEqual({ runId: "MAIN 11-00-00", calls: 10, wasted: 5, wastePct: 0.5, byRule: { "repeat-read": 1, "repeat-fail": 1, "failed-edit": 1, "guard-repeat": 1, poll: 1 }, steps: [{ index: 2, rule: "repeat-read" }, { index: 4, rule: "repeat-fail" }, { index: 5, rule: "failed-edit" }, { index: 7, rule: "guard-repeat" }, { index: 9, rule: "poll" }] });
		expect(reports.find((r) => r.runId === "MAIN 11-10-00")).toEqual({
			runId: "MAIN 11-10-00", calls: 2, wasted: 0, wastePct: 0, byRule: { "repeat-read": 0, "repeat-fail": 0, "failed-edit": 0, "guard-repeat": 0, poll: 0 }, steps: [],
		});
	});

	test("selector rules match the other subcommands; unknown run refused", async () => {
		expect(await runTraces(["efficiency", "MAIN 11-00-00", "--since", "24h"], { home: P2HOME })).toBe(2);
		expect(await runTraces(["nope"], { home: P2HOME })).toBe(2);
		expect(await runTraces(["efficiency", "no-such-run"], { home: P2HOME })).toBe(1);
	});
});

// ---- P2: agent-score records and ranks waste ----

function scoreRun(h: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_") && !k.startsWith("NEURASTREAM_")));
	const r = spawnSync("bun", [join(dirname(dirname(import.meta.path)), "src/cli/main.ts"), "agent-score", ...args], {
		env: { ...clean, HOME: h },
		encoding: "utf8",
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scoreEvents(h: string): Record<string, unknown>[] {
	return readFileSync(join(h, ".local/state/agent-score/events.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function initScoreRepo(repo: string): string {
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]): void => {
		const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`);
	};
	git(["init", "-b", "main"]);
	git(["config", "user.email", "t@example.com"]);
	git(["config", "user.name", "t"]);
	writeFileSync(join(repo, "a.txt"), "a\n");
	git(["add", "a.txt"]);
	git(["commit", "-m", "init"]);
	return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
}

/** A subagent session whose trace shows one wasted call: a failed command rerun unchanged. */
function wasteSession(): string {
	const line = (o: object): string => JSON.stringify({ type: "message", timestamp: "2026-10-25T12:00:00.000Z", ...o });
	return [
		line({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "bun test" } }] } }),
		line({ message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "3 fail" }] } }),
		line({ message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "bun test" } }] } }),
		line({ message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "12 pass" }] } }),
	].join("\n");
}

describe("agent-score records waste on scored events", () => {
	test("accept with a fixture trace stores calls, wasted and waste_pct on the event", () => {
		const h = mkdtempSync(join(tmpdir(), "ns-eff-score-"));
		P2ROOTS.push(h);
		const sessions = join(h, ".omp/agent/sessions/proj/sub");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "EffWorker.jsonl"), wasteSession());
		const plan = join(h, "plan.md");
		writeFileSync(plan, "- [ ] P1 waste counters difficulty: 2\n");
		const repo = join(h, "repo");
		const sha = initScoreRepo(repo);
		const r = scoreRun(h, ["accept", "EffWorker", "--plan", plan, "--phase", "P1", "--commits", sha, "--repo", repo, "--branch", "main"]);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const ev = scoreEvents(h).at(-1)!;
		expect(ev.type).toBe("accept");
		expect(ev.calls).toBe(2);
		expect(ev.wasted).toBe(1);
		expect(ev.waste_pct).toBeCloseTo(0.5);
	});

	test("accept with no trace writes the event without any waste keys", () => {
		const h = mkdtempSync(join(tmpdir(), "ns-eff-score-"));
		P2ROOTS.push(h);
		mkdirSync(join(h, ".omp/agent/sessions/proj"), { recursive: true });
		writeFileSync(join(h, ".omp/agent/sessions/proj/NoTraceWorker.jsonl"), `${JSON.stringify({ message: { role: "user", content: "go" } })}\n`);
		const plan = join(h, "plan.md");
		writeFileSync(plan, "- [ ] P1 waste counters difficulty: 2\n");
		const repo = join(h, "repo");
		const sha = initScoreRepo(repo);
		const r = scoreRun(h, ["accept", "NoTraceWorker", "--plan", plan, "--phase", "P1", "--commits", sha, "--repo", repo, "--branch", "main"]);
		expect(r.code).toBe(0);
		const ev = scoreEvents(h).at(-1)!;
		expect(ev.type).toBe("accept");
		expect(Object.keys(ev)).not.toContain("calls");
		expect(Object.keys(ev)).not.toContain("wasted");
		expect(Object.keys(ev)).not.toContain("waste_pct");
	});

	test("board shows Calls/acc and Waste columns, dash when no event carries calls", () => {
		const h = mkdtempSync(join(tmpdir(), "ns-eff-board-"));
		P2ROOTS.push(h);
		const dir = join(h, ".local/state/agent-score");
		mkdirSync(dir, { recursive: true });
		const ts = Date.now() / 1000;
		const line = (o: Record<string, unknown>): string => JSON.stringify({ ts, ...o });
		writeFileSync(
			join(dir, "events.jsonl"),
			[
				line({ type: "accept", agent: "WorkerW", model: "mw", plan: "p.md", phase: "P1", weight: 2, weight_src: "plan", repo: "/x", branch: "main", commits: ["a"], rework: false, note: "", calls: 6, wasted: 3, waste_pct: 0.5 }),
				line({ type: "accept", agent: "WorkerC", model: "mc", plan: "p.md", phase: "P1", weight: 1, weight_src: "plan", repo: "/x", branch: "main", commits: ["b"], rework: false, note: "" }),
			].join("\n") + "\n",
		);
		const r = scoreRun(h, ["board", "--days", "3"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("| Calls/acc | Waste |");
		expect(r.stdout).toMatch(/\| mw \|.*\| 6\.0 \| 50% \|/);
		expect(r.stdout).toMatch(/\| mc \|.*\| - \| - \|/);
	});

	test("score.waste_weight 0 vs 1 changes the order of two fixture models", () => {
		const h = mkdtempSync(join(tmpdir(), "ns-eff-rank-"));
		P2ROOTS.push(h);
		const sessions = join(h, ".omp/agent/sessions/proj/sub");
		mkdirSync(sessions, { recursive: true });
		mkdirSync(join(h, ".local/state/agent-score"), { recursive: true });
		// Wa: ppd 4 with 90% waste; Wb: ppd 2 with no waste. weight 0: Wa first; weight 1: Wb first.
		const sub = (model: string): string =>
			JSON.stringify({ message: { role: "assistant", model, provider: "anthropic", usage: { totalTokens: 10, cacheRead: 0, cost: { total: 1 } }, stopReason: "end_turn", content: [{ type: "text", text: "done" }] } });
		writeFileSync(join(sessions, "Wa.jsonl"), sub("ma") + "\n");
		writeFileSync(join(sessions, "Wb.jsonl"), sub("mb") + "\n");
		const ts = Date.now() / 1000;
		const line = (o: Record<string, unknown>): string => JSON.stringify({ ts, ...o });
		writeFileSync(
			join(h, ".local/state/agent-score/events.jsonl"),
			[
				line({ type: "accept", agent: "Wa", model: "anthropic/ma", plan: "p.md", phase: "P1", weight: 4, weight_src: "plan", repo: "/x", branch: "main", commits: ["a"], rework: false, note: "", calls: 10, wasted: 9, waste_pct: 0.9 }),
				line({ type: "accept", agent: "Wb", model: "anthropic/mb", plan: "p.md", phase: "P1", weight: 2, weight_src: "plan", repo: "/x", branch: "main", commits: ["b"], rework: false, note: "", calls: 4, wasted: 0, waste_pct: 0 }),
			].join("\n") + "\n",
		);
		const zero = scoreRun(h, ["board", "--days", "3"]);
		expect(zero.code).toBe(0);
		expect(zero.stdout).toMatch(/\| 1 \| anthropic\/ma \|/);
		expect(zero.stdout).toMatch(/\| 2 \| anthropic\/mb \|/);
		mkdirSync(join(h, ".config/neurastream"), { recursive: true });
		writeFileSync(join(h, ".config/neurastream/config.yml"), "score:\n  waste_weight: 1\n");
		const one = scoreRun(h, ["board", "--days", "3"]);
		expect(one.code).toBe(0);
		expect(one.stdout).toMatch(/\| 1 \| anthropic\/mb \|/);
		expect(one.stdout).toMatch(/\| 2 \| anthropic\/ma \|/);
	});

	test("score.waste_weight outside [0,1] is refused", () => {
		const h = mkdtempSync(join(tmpdir(), "ns-eff-weight-"));
		P2ROOTS.push(h);
		mkdirSync(join(h, ".config/neurastream"), { recursive: true });
		writeFileSync(join(h, ".config/neurastream/config.yml"), "score:\n  waste_weight: 1.5\n");
		const r = scoreRun(h, ["board", "--days", "3"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("waste_weight");
	});
});
