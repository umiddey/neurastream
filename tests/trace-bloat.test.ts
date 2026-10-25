// Prompt bloat (src/core/trace-bloat.ts, plan 20261024_0303 P1): how many tokens each model
// call had to read before it wrote, and when a run flags prompt-bloat. The bloat-run fixture
// carries the two look-alikes that are NOT model calls — a periodic model_usage accounting
// snapshot and a toolResult message that happens to carry usage — plus one assistant message
// with two content parts, which is one call, not two.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTraceFile } from "../src/adapters/omp/traces.ts";
import { parseTs } from "../src/adapters/omp/sessions.ts";
import type { TraceEvent } from "../src/core/adapter.ts";
import { loadConfig, ConfigError, TEMPLATE_PATH } from "../src/core/config.ts";
import { bloatRules, bloatFindings, callSizes, type BloatRules } from "../src/core/trace-bloat.ts";

const REPO = dirname(dirname(import.meta.path));
const FIX = join(REPO, "tests", "fixtures", "traces");
const TMP = mkdtempSync(join(tmpdir(), "ns-trace-bloat-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

/** A usage block whose prompt (input + cacheRead + cacheWrite) is exactly `prompt`. */
function usage(prompt: number) {
	return { input: prompt - 1000, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: prompt + 10, cost: 0.001 };
}

function called(prompt: number, model = "test-model", over: Partial<TraceEvent> = {}): TraceEvent {
	return { kind: "toolCall", ts: null, runId: "r1", tool: "bash", args: {}, model, usage: usage(prompt), ...over };
}

const DEFAULTS: BloatRules = { first_call_max: 150000, ratio_of_limit: 0.8, context_limits: {} };

describe("callSizes (P1)", () => {
	test("one row per model call in order; accounting and toolResult usage are not calls", () => {
		const rows = callSizes(parseTraceFile(join(FIX, "bloat-run.jsonl"), "bloat-run"));
		expect(rows).toHaveLength(8);
		expect(rows[0]).toEqual({ ts: parseTs("2026-10-24T10:00:01.000Z"), model: "test-model", prompt: 40000 });
		// call 2 is one assistant message with a text part and a toolCall part: one row
		expect(rows[1]).toEqual({ ts: parseTs("2026-10-24T10:00:02.000Z"), model: "test-model", prompt: 40000 });
		expect(rows[6]!.prompt).toBe(85000);
		expect(rows[7]!.prompt).toBe(20000);
		// neither the 9,999,999-token model_usage snapshot nor the toolResult usage may appear
		expect(rows.every((r) => r.prompt !== 9999999)).toBe(true);
	});

	test("calls without usage, and non-call events, produce no rows", () => {
		const rows = callSizes([
			{ kind: "modelChange", ts: null, runId: "r1", model: "test-model" },
			{ kind: "toolCall", ts: null, runId: "r1", tool: "bash", args: {} },
			{ kind: "toolResult", ts: null, runId: "r1", tool: "bash", isError: false, text: "ok", usage: usage(5000) },
			called(7000, "test-model", { responseId: "r9" }),
		]);
		expect(rows).toEqual([{ ts: null, model: "test-model", prompt: 7000 }]);
	});

	test("parts of one message fold even when the line carries no responseId", () => {
		const shared = { ts: 42, runId: "r1", model: "test-model", usage: usage(9000) };
		const rows = callSizes([
			{ kind: "assistantText", ...shared, text: "working" },
			{ kind: "toolCall", ...shared, tool: "bash", args: {} },
			{ kind: "assistantText", ...shared, text: "" },
		]);
		expect(rows).toEqual([{ ts: 42, model: "test-model", prompt: 9000 }]);
	});
});

describe("bloatFindings (P1)", () => {
	test("a 1.17M-token first call is flagged; evidence stays under the cap", () => {
		const found = bloatFindings([called(1172629)], DEFAULTS);
		expect(found).toHaveLength(1);
		expect(found[0]!.kind).toBe("prompt-bloat");
		expect(found[0]!.fingerprint).toBe("prompt-bloat:r1:first");
		expect(found[0]!.summary).toContain("1172629");
		expect(found[0]!.summary).toContain("150000");
		expect(found[0]!.evidence?.length ?? 0).toBeLessThanOrEqual(160);
	});

	test("a 40k-token first call is not flagged", () => {
		expect(bloatFindings([called(40000)], DEFAULTS)).toEqual([]);
	});

	test("a call over ratio × its model's limit is flagged with that call's index", () => {
		const rules: BloatRules = { first_call_max: 150000, ratio_of_limit: 0.8, context_limits: { "test-model": 100000 } };
		const found = bloatFindings(parseTraceFile(join(FIX, "bloat-run.jsonl"), "bloat-run"), rules);
		expect(found).toHaveLength(1);
		expect(found[0]!.kind).toBe("prompt-bloat");
		expect(found[0]!.fingerprint).toBe("prompt-bloat:bloat-run:7:test-model");
		expect(found[0]!.summary).toContain("call 7");
		expect(found[0]!.summary).toContain("85000");
		expect(found[0]!.summary).toContain("100000");
		expect(found[0]!.evidence?.length ?? 0).toBeLessThanOrEqual(160);
	});

	test("a model without a context_limits entry is not limit-checked", () => {
		const rules: BloatRules = { first_call_max: 20000000, ratio_of_limit: 0.8, context_limits: { other: 100000 } };
		expect(bloatFindings([called(10000000)], rules)).toEqual([]);
	});

	test("a provider-prefixed model matches a bare-model entry", () => {
		const rules: BloatRules = { first_call_max: 150000, ratio_of_limit: 0.8, context_limits: { "test-model": 100000 } };
		const found = bloatFindings([called(90000, "prov/test-model")], rules);
		expect(found).toHaveLength(1);
		expect(found[0]!.fingerprint).toBe("prompt-bloat:r1:1:prov/test-model");
	});

	test("the first call can trip both rules; findings keep rule order", () => {
		const rules: BloatRules = { first_call_max: 150000, ratio_of_limit: 0.8, context_limits: { "test-model": 100000 } };
		const found = bloatFindings([called(200000)], rules);
		expect(found.map((f) => f.fingerprint)).toEqual(["prompt-bloat:r1:first", "prompt-bloat:r1:1:test-model"]);
	});

	test("the ratio boundary is exclusive: exactly at the budget is not bloat", () => {
		const rules: BloatRules = { first_call_max: 150000, ratio_of_limit: 0.8, context_limits: { "test-model": 100000 } };
		expect(bloatFindings([called(80000)], rules)).toEqual([]);
		expect(bloatFindings([called(80001)], rules)).toHaveLength(1);
	});

	test("a run with no model calls is not judged; evidence goes through the mask", () => {
		expect(bloatFindings([], DEFAULTS)).toEqual([]);
		const found = bloatFindings([called(200000, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")], DEFAULTS);
		expect(found[0]!.evidence).toContain("[masked]");
	});
});

describe("config (P1)", () => {
	test("the template ships the planned defaults", () => {
		const cfg = loadConfig({ home: join(TMP, "cfg-def"), env: {} });
		expect(cfg.traces.bloat).toEqual({
			first_call_max: 150000,
			ratio_of_limit: 0.8,
			context_limits: {},
			tool_group: "^_?mcp__([A-Za-z0-9]+)_",
		});
		expect(bloatRules(cfg)).toEqual({ first_call_max: 150000, ratio_of_limit: 0.8, context_limits: {} });
	});

	test("a user config overrides the bloat keys; context_limits is an open map", () => {
		const home = join(TMP, "cfg-user");
		mkdirSync(join(home, ".config", "neurastream"), { recursive: true });
		writeFileSync(
			join(home, ".config", "neurastream", "config.yml"),
			`paths:
  home: "${home}"
traces:
  bloat:
    first_call_max: 200000
    ratio_of_limit: 0.5
    context_limits:
      big-model: 200000
    tool_group: '^x__([a-z]+)_'
`,
		);
		const cfg = loadConfig({ home, env: {} });
		expect(cfg.traces.bloat).toEqual({
			first_call_max: 200000,
			ratio_of_limit: 0.5,
			context_limits: { "big-model": 200000 },
			tool_group: "^x__([a-z]+)_",
		});
	});

	test("check() rejects an out-of-range ratio, non-positive numbers and a bad group regex", () => {
		const cases: [string, RegExp][] = [
			["    ratio_of_limit: 0", /ratio_of_limit/],
			["    ratio_of_limit: 1.5", /ratio_of_limit/],
			["    first_call_max: 0", /first_call_max/],
			["    context_limits:\n      m: -1", /context_limits/],
			["    tool_group: \"(\"", /tool_group/],
			["    nope: 1", /unknown key traces\.bloat\.nope/],
		];
		for (const [yaml, rx] of cases) {
			const home = join(TMP, `cfg-bad-${Math.abs(hash(yaml))}`);
			mkdirSync(join(home, ".config", "neurastream"), { recursive: true });
			writeFileSync(
				join(home, ".config", "neurastream", "config.yml"),
				`paths:
  home: "${home}"
traces:
  bloat:
${yaml}
`,
			);
			let err: unknown = null;
			try {
				loadConfig({ home, env: {} });
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as Error).message).toMatch(rx);
		}
	});
});

/** Stable little hash so each bad-config case gets its own sandbox home. */
function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

// ---- P2: the dumped-request breakdown and the `traces bloat` CLI ----

import { dumpParts, ompDumpDir, ompDumps, ompTraceSource } from "../src/adapters/omp/traces.ts";
import { bloatBreakdown } from "../src/core/trace-bloat.ts";
import { runTraces } from "../src/cli/traces.ts";

describe("dumpParts (P2)", () => {
	test("bytes are the JSON.stringify length of each body part", () => {
		const file = join(TMP, "tiny-dump.json");
		writeFileSync(file, JSON.stringify({ api: "a", body: { system: "ab", messages: [{ r: 1 }], tools: [{ name: "t1", x: 1 }], model: "m" } }));
		// "ab" -> '"ab"' (4); [{r:1}] -> '[{"r":1}]' (9); the tool -> '{"name":"t1","x":1}' (19)
		expect(dumpParts(file)).toEqual({ system: 4, messages: 9, tools: [{ name: "t1", bytes: 19 }] });
	});

	test("the synthetic fixture dump: 21 tools, two MCP groups, one huge schema", () => {
		const parts = dumpParts(join(FIX, "bloat-dump.json"));
		expect(parts.tools).toHaveLength(21);
		expect(parts.tools.reduce((s, t) => s + t.bytes, 0)).toBe(18400);
		expect(parts.tools[0]).toEqual({ name: "mcp__zoho_getthing0", bytes: 651 });
		expect(parts.tools[11]).toEqual({ name: "mcp__zoho_createworkflowrules", bytes: 4740 });
		expect(parts.system).toBe(1077);
		expect(parts.messages).toBe(594);
	});

	test("missing parts are zero; a broken dump reads as empty, never throws", () => {
		const empty = join(TMP, "empty-body.json");
		writeFileSync(empty, JSON.stringify({ body: {} }));
		expect(dumpParts(empty)).toEqual({ system: 0, messages: 0, tools: [] });
		const noTools = join(TMP, "no-tools.json");
		writeFileSync(noTools, JSON.stringify({ body: { system: "x", messages: [] } }));
		expect(dumpParts(noTools)).toEqual({ system: 3, messages: 2, tools: [] });
		expect(dumpParts(join(TMP, "missing.json"))).toEqual({ system: 0, messages: 0, tools: [] });
		const junk = join(TMP, "junk.json");
		writeFileSync(junk, "not json {");
		expect(dumpParts(junk)).toEqual({ system: 0, messages: 0, tools: [] });
	});

	test("a nameless tool keeps its bytes as ?", () => {
		const file = join(TMP, "nameless.json");
		writeFileSync(file, JSON.stringify({ body: { tools: [{ schema: "s" }, { name: "t", schema: "s" }] } }));
		const parts = dumpParts(file);
		expect(parts.tools).toEqual([
			{ name: "?", bytes: JSON.stringify({ schema: "s" }).length },
			{ name: "t", bytes: JSON.stringify({ name: "t", schema: "s" }).length },
		]);
	});
});

describe("bloatBreakdown (P2)", () => {
	const GROUP = "^mcp__([A-Za-z0-9]+)_";

	test("tools group by the first capture; parts come back largest first", () => {
		const b = bloatBreakdown(dumpParts(join(FIX, "bloat-dump.json")), GROUP);
		expect(b.parts).toEqual([
			{ name: "zoho", bytes: 11902 },
			{ name: "brightdata", bytes: 5635 },
			{ name: "system", bytes: 1077 },
			{ name: "builtin", bytes: 863 },
			{ name: "messages", bytes: 594 },
		]);
	});

	test("top tools are the five largest, largest first", () => {
		const b = bloatBreakdown(dumpParts(join(FIX, "bloat-dump.json")), GROUP);
		expect(b.tools).toHaveLength(5);
		expect(b.tools[0]!.name).toBe("mcp__zoho_createworkflowrules");
		expect(b.tools[0]!.bytes).toBe(4740);
		const sizes = b.tools.map((t) => t.bytes);
		expect([...sizes].sort((x, y) => y - x)).toEqual(sizes);
	});

	test("a regex without a match or a capture groups the tool as builtin; a bad regex disables grouping", () => {
		const tiny = { system: 0, messages: 0, tools: [{ name: "mcp__zoho_a", bytes: 10 }, { name: "bash", bytes: 5 }] };
		expect(bloatBreakdown(tiny, "^zzz").parts.map((p) => p.name)).toEqual(["builtin", "system", "messages"]);
		expect(bloatBreakdown(tiny, "^mcp__").parts.map((p) => p.name)).toEqual(["builtin", "system", "messages"]);
		expect(bloatBreakdown(tiny, "(").parts.map((p) => p.name)).toEqual(["builtin", "system", "messages"]);
	});
});

describe("traces bloat CLI (P2)", () => {
	const P9 = mkdtempSync(join(tmpdir(), "ns-trace-bloat-cli-"));
	const P9SESSIONS = join(P9, ".omp/agent/sessions/bloat-proj");
	const P9DUMPS = ompDumpDir(P9);
	mkdirSync(P9SESSIONS, { recursive: true });
	mkdirSync(P9DUMPS, { recursive: true });
	mkdirSync(join(P9, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(P9, ".config/neurastream/config.yml"),
		`paths:
  home: "${P9}"
traces:
  bloat:
    context_limits:
      test-model: 100000
`,
	);
	writeFileSync(join(P9SESSIONS, "2026-10-25T10-00-00-000Z_bloat.jsonl"), readFileSync(join(FIX, "bloat-run.jsonl"), "utf8"));
	writeFileSync(join(P9SESSIONS, "2026-10-25T09-00-00-000Z_bloat.jsonl"), readFileSync(join(FIX, "bloat-run.jsonl"), "utf8"));
	// one dump inside the fresh run's window (after its first event, before its mtime), one
	// an hour before any run of the fixture, named like the real ones: <epoch-ms>-<id>.json
	const IN_MS = parseTs("2026-10-24T10:00:05.000Z")! * 1000 + 5000;
	const OUT_MS = parseTs("2026-10-24T10:00:01.000Z")! * 1000 - 3_600_000;
	writeFileSync(join(P9DUMPS, `${IN_MS}-synthtic01.json`), readFileSync(join(FIX, "bloat-dump.json"), "utf8"));
	writeFileSync(join(P9DUMPS, `${OUT_MS}-synthtic02.json`), readFileSync(join(FIX, "bloat-dump.json"), "utf8"));
	// the 09-00-00 file was written "now" too; backdate it outside the default 24h window
	const oldMs = Date.now() - 30 * 3600 * 1000;
	utimesSync(join(P9SESSIONS, "2026-10-25T09-00-00-000Z_bloat.jsonl"), oldMs / 1000, oldMs / 1000);
	afterAll(() => rmSync(P9, { recursive: true, force: true }));

	async function jsonReports(args: string[]): Promise<Record<string, unknown>[]> {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["bloat", ...args, "--json"], { home: P9 });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		const parsed = JSON.parse(logs.join("\n"));
		return Array.isArray(parsed) ? parsed : parsed.reports;
	}

	test("--since 48h lists both runs; only the run whose window holds the dump gets a breakdown", async () => {
		const reports = await jsonReports(["--since", "48h"]);
		expect(reports.map((r) => r.runId).sort()).toEqual(["MAIN 09-00-00", "MAIN 10-00-00"]);
		const fresh = reports.find((r) => r.runId === "MAIN 10-00-00")!;
		expect(fresh.calls).toBe(8);
		expect(fresh.firstPrompt).toBe(40000);
		expect(fresh.maxPrompt).toBe(85000);
		expect((fresh.findings as { summary: string }[]).map((f) => f.summary)).toEqual([
			"run MAIN 10-00-00: call 7 (test-model) prompt 85000 tokens is 85% of its 100000 context limit",
		]);
		const breakdown = fresh.breakdown as { parts: { name: string; bytes: number }[]; tools: { name: string }[] };
		expect(breakdown.parts[0]).toEqual({ name: "zoho", bytes: 11902 });
		expect(breakdown.tools[0]!.name).toBe("mcp__zoho_createworkflowrules");
		expect(reports.find((r) => r.runId === "MAIN 09-00-00")!.breakdown).toBeUndefined();
	});

	test("without --since the window defaults to 24h", async () => {
		const reports = await jsonReports([]);
		expect(reports.map((r) => r.runId)).toEqual(["MAIN 10-00-00"]);
	});

	test("one run by id gets the same report; selector rules match claims and actions", async () => {
		const reports = await jsonReports(["MAIN 10-00-00"]);
		const one = reports[0]!;
		expect(one.runId).toBe("MAIN 10-00-00");
		expect(one.breakdown).toBeDefined();
		expect(await runTraces(["bloat", "MAIN 10-00-00", "--since", "24h"], { home: P9 })).toBe(2);
		expect(await runTraces(["nope"], { home: P9 })).toBe(2);
	});

	test("text output prints counts, findings, parts and top tools", async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		let rc = -1;
		try {
			rc = await runTraces(["bloat", "MAIN 10-00-00"], { home: P9 });
		} finally {
			console.log = orig;
		}
		expect(rc).toBe(0);
		expect(logs[0]).toBe("MAIN 10-00-00: 8 calls, first 40000, max 85000 (1 prompt-bloat)");
		expect(logs[1]).toBe("  prompt-bloat: run MAIN 10-00-00: call 7 (test-model) prompt 85000 tokens is 85% of its 100000 context limit");
		expect(logs[2]).toMatch(/^    evidence: call 7 of 8 \(model test-model\) prompt 85000; limit 100000/);
		expect(logs[3]).toBe("  prompt parts: zoho 11902, brightdata 5635, system 1077, builtin 863, messages 594");
		expect(logs[4]).toMatch(/^  top tools: mcp__zoho_createworkflowrules 4740, /);
	});

	test("ompDumps lists only <epoch-ms>-<id>.json files, oldest first", () => {
		const stray = join(P9DUMPS, "not-a-dump.txt");
		writeFileSync(stray, "x");
		const dumps = ompDumps(P9);
		expect(dumps.map((d) => d.ms)).toEqual([OUT_MS, IN_MS]);
		expect(readdirSync(P9DUMPS)).toContain("not-a-dump.txt");
		expect(ompDumpDir(P9)).toBe(P9DUMPS);
	});
});

// ---- P3: the flag a REJECTED call feeds (its trace carries no usage, the dump does) ----

import { statSync } from "node:fs";
import { dumpPromptTokens } from "../src/adapters/omp/traces.ts";
import { assignDumps, bloatReport } from "../src/cli/traces.ts";
import { dumpFinding } from "../src/core/trace-bloat.ts";

describe("dumpPromptTokens (P3)", () => {
	test("the prompt count and maximum the error response states, with the request's model", () => {
		expect(dumpPromptTokens(join(FIX, "bloat-dump-rejected.json"))).toEqual({
			tokens: 1172629,
			limit: 1000000,
			model: "big-model",
		});
	});

	test("a stated count without a maximum still reads; no count anywhere reads as null", () => {
		const only = join(TMP, "count-only.json");
		writeFileSync(only, JSON.stringify({ body: { model: "m" }, errorResponse: { status: 400, message: "request of 999999 tokens rejected" } }));
		expect(dumpPromptTokens(only)).toEqual({ tokens: 999999, model: "m" });
		const none = join(TMP, "no-count.json");
		writeFileSync(none, JSON.stringify({ body: { model: "m" }, errorResponse: { status: 400, message: "invalid api key" } }));
		expect(dumpPromptTokens(none)).toBeNull();
		const noErr = join(TMP, "no-error.json");
		writeFileSync(noErr, JSON.stringify({ body: { model: "m" } }));
		expect(dumpPromptTokens(noErr)).toBeNull();
		expect(dumpPromptTokens(join(TMP, "missing.json"))).toBeNull();
	});
});

describe("dumpFinding (P3)", () => {
	test("flags the stated prompt over the first-call ceiling, and names the error response as the source", () => {
		const f = dumpFinding("r1", { tokens: 1172629, limit: 1000000, model: "big-model" }, DEFAULTS)!;
		expect(f.kind).toBe("prompt-bloat");
		expect(f.fingerprint).toBe("prompt-bloat:r1:dump");
		expect(f.summary).toContain("1172629");
		expect(f.summary).toContain("first-call ceiling");
		expect(f.evidence).toContain("error response");
	});

	test("the stated maximum and the model's config limit are ceilings too; under every ceiling is null", () => {
		const high = { first_call_max: 1000000, ratio_of_limit: 0.8, context_limits: { "big-model": 1000000 } };
		expect(dumpFinding("r1", { tokens: 900000, model: "big-model" }, high)).not.toBeNull();
		expect(dumpFinding("r1", { tokens: 700000, model: "big-model" }, high)).toBeNull();
		expect(dumpFinding("r1", { tokens: 900000, limit: 1000000, model: "small-model" }, high)).not.toBeNull();
		expect(dumpFinding("r1", { tokens: 100000, model: "big-model" }, DEFAULTS)).toBeNull();
	});
});

describe("bloatReport dump flag (P3)", () => {
	const P10 = mkdtempSync(join(tmpdir(), "ns-trace-bloat-p3-"));
	const P10SESSIONS = join(P10, ".omp/agent/sessions/bloat-proj");
	const P10DUMPS = ompDumpDir(P10);
	mkdirSync(P10SESSIONS, { recursive: true });
	mkdirSync(P10DUMPS, { recursive: true });
	mkdirSync(join(P10, ".config/neurastream"), { recursive: true });
	writeFileSync(join(P10, ".config/neurastream/config.yml"), `paths:\n  home: "${P10}"\n`);
	// A run whose rejected call produced no usage row: its only mapped event is an assistant
	// message with no content and no usage, so calls reads 0 while a first ts still exists.
	writeFileSync(
		join(P10SESSIONS, "2026-10-24T01-00-00-000Z_reject.jsonl"),
		[
			{ type: "session", timestamp: "2026-10-24T01:00:00.000Z", id: "x" },
			{ type: "message", timestamp: "2026-10-24T01:00:01.000Z", message: { role: "assistant", model: "big-model", provider: "test-provider", responseId: "rr", stopReason: "toolUse", content: [] } },
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n",
	);
	writeFileSync(join(P10SESSIONS, "2026-10-24T10-00-00-000Z_flagged.jsonl"), readFileSync(join(FIX, "bloat-run.jsonl"), "utf8"));
	const REJ_MS = parseTs("2026-10-24T01:02:00.000Z")! * 1000;
	const IN_MS = parseTs("2026-10-24T10:00:05.000Z")! * 1000;
	writeFileSync(join(P10DUMPS, `${REJ_MS}-synthrej01.json`), readFileSync(join(FIX, "bloat-dump-rejected.json"), "utf8"));
	writeFileSync(join(P10DUMPS, `${IN_MS}-synthrej02.json`), readFileSync(join(FIX, "bloat-dump-rejected.json"), "utf8"));
	afterAll(() => rmSync(P10, { recursive: true, force: true }));

	const GROUP10 = "^_?mcp__([A-Za-z0-9]+)_";
	// The trace source reads a sessions ROOT: dated files one project dir below it.
	const src = ompTraceSource(join(P10, ".omp/agent/sessions"));
	const dumps = ompDumps(P10);

	test("a run whose rejected call has no usage flags from the matched dump's stated prompt", () => {
		const file = join(P10SESSIONS, "2026-10-24T01-00-00-000Z_reject.jsonl");
		const rep = bloatReport(src, "MAIN 01-00-00", DEFAULTS, GROUP10, dumps, statSync(file).mtimeMs / 1000);
		expect(rep.calls).toBe(0);
		expect(rep.firstPrompt).toBeNull();
		expect(rep.dumpPrompt).toEqual({ tokens: 1172629, limit: 1000000 });
		expect(rep.findings).toHaveLength(1);
		expect(rep.findings[0]!.kind).toBe("prompt-bloat");
		expect(rep.findings[0]!.summary).toContain("1172629");
		expect(rep.breakdown).toBeDefined();
	});

	test("a run its own usage already flags keeps those findings; the dump prompt is still recorded", () => {
		const file = join(P10SESSIONS, "2026-10-24T10-00-00-000Z_flagged.jsonl");
		const rules = { ...DEFAULTS, context_limits: { "test-model": 100000 } };
		const rep = bloatReport(src, "MAIN 10-00-00", rules, GROUP10, dumps, statSync(file).mtimeMs / 1000);
		expect(rep.findings.map((f) => f.summary)).toEqual([
			"run MAIN 10-00-00: call 7 (test-model) prompt 85000 tokens is 85% of its 100000 context limit",
		]);
		expect(rep.dumpPrompt).toEqual({ tokens: 1172629, limit: 1000000 });
	});
});
// ---- P3b: each dump has one owner, even when run windows overlap ----
describe("overlapping run dump ownership (P3b)", () => {
	const P11 = mkdtempSync(join(tmpdir(), "ns-trace-bloat-p3b-"));
	const sessions = join(P11, ".omp/agent/sessions/bloat-proj");
	const dumpDir = ompDumpDir(P11);
	mkdirSync(sessions, { recursive: true });
	mkdirSync(dumpDir, { recursive: true });
	mkdirSync(join(P11, ".config/neurastream"), { recursive: true });
	writeFileSync(join(P11, ".config/neurastream/config.yml"), `paths:\n  home: "${P11}"\n`);
	const trace = (model: string, ts: string) =>
		[
			{ type: "session", timestamp: ts, id: "x" },
			{ type: "message", timestamp: ts, message: { role: "assistant", model, provider: "test-provider", responseId: "rr", stopReason: "toolUse", content: [] } },
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n";
	writeFileSync(join(sessions, "2026-10-24T01-00-00-000Z_first.jsonl"), trace("other-model", "2026-10-24T01:00:01.000Z"));
	writeFileSync(join(sessions, "2026-10-24T01-00-10-000Z_second.jsonl"), trace("big-model", "2026-10-24T01:00:02.000Z"));
	const ms = parseTs("2026-10-24T01:00:03.000Z")! * 1000;
	writeFileSync(join(dumpDir, `${ms}-synthrej03.json`), readFileSync(join(FIX, "bloat-dump-rejected.json"), "utf8"));
	afterAll(() => rmSync(P11, { recursive: true, force: true }));

	test("overlapping windows assign the rejected prompt to only the closest same-model run", async () => {
		const logs: string[] = [];
		const orig = console.log;
		console.log = (line: string) => logs.push(line);
		try {
			expect(await runTraces(["bloat", "--since", "7d", "--json"], { home: P11 })).toBe(0);
		} finally {
			console.log = orig;
		}
		const output = JSON.parse(logs.join("\n")) as { reports: Record<string, unknown>[]; unmatchedDumps: unknown[] };
		const owners = output.reports.filter((r) => r.dumpPrompt !== undefined);
		expect(owners).toHaveLength(1);
		expect(owners[0]!.runId).toBe("MAIN 01-00-10");
		expect(owners[0]!.dumpPrompt).toEqual({ tokens: 1172629, limit: 1000000 });
		expect(output.unmatchedDumps).toHaveLength(0);
	});
});
describe("shared dump assignment (P3c)", () => {
	test("does not parse runs outside dump coverage and parses candidates only once for multiple dumps", () => {
		const ms = 1_800_000_000_000;
		const futureFile = join(TMP, "future-session.jsonl");
		writeFileSync(futureFile, `${JSON.stringify({ type: "title" })}\n${JSON.stringify({ type: "session", timestamp: "2027-01-15T08:00:01.000Z" })}\n`);
		const runs = [
			{ runId: "ended", file: "ended", mtimeSec: ms / 1000 - 10 },
			{ runId: "future", file: futureFile, mtimeSec: ms / 1000 + 100 },
			{ runId: "candidate", file: "candidate", mtimeSec: ms / 1000 + 100 },
		];
		const counts = new Map<string, number>();
		const src = { events(id: string): TraceEvent[] { counts.set(id, (counts.get(id) ?? 0) + 1); return [called(1, "big-model", { ts: ms / 1000 - 5, runId: id })]; } };
		const secondDump = join(TMP, "second-dump.json");
		writeFileSync(secondDump, readFileSync(join(FIX, "bloat-dump-rejected.json"), "utf8"));
		const result = assignDumps(runs, src, [{ file: join(FIX, "bloat-dump-rejected.json"), ms }, { file: secondDump, ms: ms + 1 }]);
		expect(counts.get("ended") ?? 0).toBe(0);
		expect(counts.get("future") ?? 0).toBe(0);
		expect(counts.get("candidate")).toBe(1);
		expect(result.owners.size).toBe(2);
	});
});

