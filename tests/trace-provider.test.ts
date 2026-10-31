// Provider-honesty rules (src/core/trace-provider.ts, plan 20261024_0302 P1): what came back
// must be what was asked for. Fixtures are synthetic JSONL in the documented session shape;
// every rule runs over parseTraceFile output so the adapter mapping (responseId, fallback) is
// exercised end to end, plus synthetic events for edges the fixtures cannot carry.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TraceEvent } from "../src/core/adapter.ts";
import { parseTraceFile, offeredFromDump } from "../src/adapters/omp/traces.ts";
import { loadConfig, TEMPLATE_PATH } from "../src/core/config.ts";
import { modelSwaps, oddResponseIds, unofferedTools, phantomOutput, costMismatch, providerFindings } from "../src/core/trace-provider.ts";
import { buildReport } from "../src/core/report.ts";

const REPO = dirname(dirname(import.meta.path));
const FIX = join(REPO, "tests", "fixtures", "traces");
const TMP = mkdtempSync(join(tmpdir(), "ns-trace-provider-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

/** One fixture run: file stem doubles as the run id fingerprints carry. */
function events(name: string): TraceEvent[] {
	return parseTraceFile(join(FIX, name), name.replace(/\.jsonl$/, ""));
}

function change(model: string, fallback = false): TraceEvent {
	return { kind: "modelChange", ts: null, runId: "synthetic", model, ...(fallback ? { fallback: true } : {}) };
}

function assistant(fields: { model?: string; provider?: string; responseId?: string; tool?: string }): TraceEvent {
	return {
		kind: fields.tool ? "toolCall" : "assistantText",
		ts: null,
		runId: "synthetic",
		...(fields.tool ? { tool: fields.tool, args: {} } : { text: "…" }),
		...(fields.model ? { model: fields.model } : {}),
		...(fields.provider ? { provider: fields.provider } : {}),
		...(fields.responseId ? { responseId: fields.responseId } : {}),
	};
}

function result(tool: string, isError: boolean): TraceEvent {
	return { kind: "toolResult", ts: null, runId: "synthetic", tool, isError, text: isError ? "No such tool" : "ok" };
}

const ANTHROPIC = { anthropic: "^msg_[A-Za-z0-9]+$" };

describe("model swaps (P1)", () => {
	test("benign run: the served model and provider always match the announcement", () => {
		expect(modelSwaps(events("provider-benign.jsonl"))).toEqual([]);
	});

	test("served model differs from the announced one, then the provider does", () => {
		const found = modelSwaps(events("provider-swap.jsonl"));
		expect(found.map((f) => f.fingerprint)).toEqual([
			"model-swap:provider-swap:model:claude-opus-5-5:glm-5.3-flash",
			"model-swap:provider-swap:provider:anthropic:zai",
		]);
		for (const f of found) {
			expect(f.kind).toBe("model-swap");
			expect(f.evidence?.length ?? 0).toBeLessThanOrEqual(160);
		}
	});

	test("a fallback resolution is a swap even when the served model matches", () => {
		const found = modelSwaps(events("provider-fallback.jsonl"));
		expect(found.map((f) => f.fingerprint)).toEqual(["model-swap:provider-fallback:fallback"]);
	});

	test("a run that never announced a model is not judged", () => {
		expect(modelSwaps([assistant({ model: "whatever", provider: "whoever" })])).toEqual([]);
	});

	test("a mid-run announcement governs the messages after it, not before", () => {
		const evs = [
			change("prov-a/mod-a"),
			assistant({ model: "mod-a", provider: "prov-a" }),
			change("prov-b/mod-b"),
			assistant({ model: "mod-a", provider: "prov-a" }),
		];
		const found = modelSwaps(evs);
		expect(found.map((f) => f.fingerprint)).toEqual([
			"model-swap:synthetic:model:mod-b:mod-a",
			"model-swap:synthetic:provider:prov-b:prov-a",
		]);
	});

	test("repeats of the same swap fold into one finding", () => {
		const evs = [change("prov-a/mod-a"), assistant({ model: "mod-x", provider: "prov-a" }), assistant({ model: "mod-x", provider: "prov-a" })];
		expect(modelSwaps(evs)).toHaveLength(1);
	});
});

describe("response ids (P1)", () => {
	test("benign run: every id matches its provider pattern", () => {
		expect(oddResponseIds(events("provider-benign.jsonl"), ANTHROPIC)).toEqual([]);
	});

	test("an id that misses the provider pattern is odd; an unchecked provider never is", () => {
		const found = oddResponseIds(events("provider-odd-id.jsonl"), ANTHROPIC);
		expect(found.map((f) => f.fingerprint)).toEqual(["odd-response-id:provider-odd-id:anthropic"]);
		expect(found[0]?.kind).toBe("odd-response-id");
	});

	test("a missing id is not checked: absent is not malformed", () => {
		expect(oddResponseIds([assistant({ provider: "anthropic" })], ANTHROPIC)).toEqual([]);
	});

	test("a provider without a configured pattern is not checked", () => {
		expect(oddResponseIds([assistant({ provider: "unknown", responseId: "x" })], ANTHROPIC)).toEqual([]);
	});

	test("an invalid pattern is skipped instead of crashing the check", () => {
		expect(oddResponseIds([assistant({ provider: "anthropic", responseId: "msg_ok" })], { anthropic: "(" })).toEqual([]);
	});

	test("repeats for one provider fold into one finding", () => {
		const evs = [assistant({ provider: "anthropic", responseId: "bad-1" }), assistant({ provider: "anthropic", responseId: "bad-2" })];
		expect(oddResponseIds(evs, ANTHROPIC)).toHaveLength(1);
	});
});

describe("config wiring", () => {
	test("template ships open provider maps; the four sampled id defaults live in README", () => {
		const cfg = loadConfig({ home: TMP, template: TEMPLATE_PATH });
		expect(cfg.traces.provider.id_patterns).toEqual({});
		expect(cfg.traces.provider.allow_tools).toEqual([]);
		expect(cfg.traces.provider.prices).toEqual({});
	});

	test("user config may add price rows and new id patterns (open maps)", () => {
		const file = join(TMP, "user-config.yml");
		writeFileSync(file, "traces:\n  provider:\n    id_patterns:\n      openai: '^resp_'\n    prices:\n      glm-test: { input: 2, output: 6, cache_read: 0.2, cache_write: 0.5 }\n");
		const cfg = loadConfig({ home: TMP, file, template: TEMPLATE_PATH });
		expect(cfg.traces.provider.id_patterns.openai).toBe("^resp_");
		expect(cfg.traces.provider.prices["glm-test"]?.input).toBe(2);
	});
});

describe("unoffered tools (P2)", () => {
	test("benign run: every call is backed by a successful result", () => {
		expect(unofferedTools(events("provider-benign.jsonl"), [])).toEqual([]);
	});

	test("calls the session never saw succeed are unoffered; errors prove it", () => {
		const found = unofferedTools(events("provider-tools.jsonl"), []);
		expect(found.map((f) => f.fingerprint)).toEqual([
			"unoffered-tool:provider-tools:made_up_tool",
			"unoffered-tool:provider-tools:ghost_tool",
		]);
		for (const f of found) {
			expect(f.kind).toBe("unoffered-tool");
			expect(f.evidence?.length ?? 0).toBeLessThanOrEqual(160);
		}
	});

	test("the config allow-list vouches for a tool no result ever served", () => {
		const found = unofferedTools(events("provider-tools.jsonl"), ["ghost_tool"]);
		expect(found.map((f) => f.fingerprint)).toEqual(["unoffered-tool:provider-tools:made_up_tool"]);
	});

	test("a first call that succeeds proves its own offer", () => {
		expect(unofferedTools([assistant({ tool: "task" }), result("task", false)], [])).toEqual([]);
	});

	test("a call refused as an unknown tool stays unoffered", () => {
		expect(unofferedTools([assistant({ tool: "phantom" }), result("phantom", true)], []).map((f) => f.fingerprint)).toEqual(["unoffered-tool:synthetic:phantom"]);
		const refused: TraceEvent = { kind: "toolResult", ts: null, runId: "synthetic", tool: "ghost", isError: true, text: "Tool ghost not found" };
		expect(unofferedTools([assistant({ tool: "ghost" }), refused], []).map((f) => f.fingerprint)).toEqual(["unoffered-tool:synthetic:ghost"]);
	});

	test("an errored result of a real tool (guard refusal, bad args) proves its offer", () => {
		const blocked: TraceEvent = { kind: "toolResult", ts: null, runId: "synthetic", tool: "edit", isError: true, text: "plan-guard: refused, path is protected" };
		const bare: TraceEvent = { kind: "toolResult", ts: null, runId: "synthetic", tool: "glob", isError: true };
		expect(unofferedTools([assistant({ tool: "edit" }), blocked, assistant({ tool: "glob" }), bare], [])).toEqual([]);
	});

	test("names parsed from the request's own tool list vouch for a call", () => {
		expect(unofferedTools([assistant({ tool: "phantom" }), result("phantom", true)], [], ["phantom"])).toEqual([]);
	});

	test("the parser's unnamed-call placeholder is never a tool name", () => {
		expect(unofferedTools([{ kind: "toolCall", ts: null, runId: "synthetic", tool: "?", args: {} }], [])).toEqual([]);
	});

	test("repeats of one phantom tool fold into one finding", () => {
		const evs = [assistant({ tool: "phantom" }), assistant({ tool: "phantom" })];
		expect(unofferedTools(evs, [])).toHaveLength(1);
	});
});

describe("offered tools from an http dump (P2)", () => {
	test("body.tools[].name of a dumped request, in file order", () => {
		expect(offeredFromDump(join(FIX, "http-dump.json"))).toEqual(["read", "bash"]);
	});

	test("a missing file, broken JSON or a dump without tools offers nothing", () => {
		expect(offeredFromDump(join(FIX, "does-not-exist.json"))).toEqual([]);
		expect(offeredFromDump(join(REPO, "README.md"))).toEqual([]);
		expect(offeredFromDump(join(FIX, "provider-benign.jsonl"))).toEqual([]);
	});
});

const withUsage = (text: string, output: number): TraceEvent => ({
	kind: "assistantText",
	ts: null,
	runId: "synthetic",
	text,
	usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output, cost: 0.001 },
});

const usageLine = (model: string, cost: number, input: number, cacheRead = 0): TraceEvent => ({
	kind: "usage",
	ts: null,
	runId: "synthetic",
	model,
	usage: { input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead, cost },
});

const PRICES = { "glm-test": { input: 2, output: 6, cache_read: 0.2, cache_write: 0.5 } };

describe("phantom output (P3)", () => {
	test("benign run: every billed output token came with content", () => {
		expect(phantomOutput(events("provider-benign.jsonl"))).toEqual([]);
	});

	test("output tokens billed for an empty message are phantom; a message without usage is not", () => {
		const found = phantomOutput(events("provider-phantom.jsonl"));
		expect(found.map((f) => f.fingerprint)).toEqual(["phantom-output:provider-phantom:msg_phantom000000000000001"]);
		expect(found[0]?.kind).toBe("phantom-output");
		expect(found[0]?.evidence?.length ?? 0).toBeLessThanOrEqual(160);
	});

	test("the parser marks a content-less assistant message as empty text", () => {
		expect(events("provider-phantom.jsonl").some((e) => e.kind === "assistantText" && e.text === "")).toBe(true);
	});

	test("output without usage, or content with output, is not phantom", () => {
		expect(phantomOutput([withUsage("a real reply", 512)])).toEqual([]);
		expect(phantomOutput([withUsage("", 0)])).toEqual([]);
		expect(phantomOutput([{ kind: "assistantText", ts: null, runId: "synthetic", text: "" }])).toEqual([]);
	});
});

describe("cost mismatch (P3)", () => {
	test("a run with no usage lines prices nothing", () => {
		expect(costMismatch(events("provider-benign.jsonl"), PRICES)).toEqual([]);
	});

	test("billed cost within the tolerance is honest, beyond it is a mismatch", () => {
		const found = costMismatch(events("provider-cost.jsonl"), PRICES);
		expect(found.map((f) => f.fingerprint)).toEqual(["cost-mismatch:provider-cost:glm-test"]);
		expect(found[0]?.kind).toBe("cost-mismatch");
		expect(found[0]?.evidence?.length ?? 0).toBeLessThanOrEqual(160);
	});

	test("the 20% boundary itself is honest; under-billing past it is not", () => {
		expect(costMismatch([usageLine("glm-test", 2.4, 1000000)], PRICES)).toEqual([]);
		expect(costMismatch([usageLine("glm-test", 1.0, 1000000)], PRICES)).toHaveLength(1);
	});

	test("a model without a price entry is not priced", () => {
		expect(costMismatch(events("provider-cost.jsonl"), {})).toEqual([]);
	});

	test("a zero-priced model that still bills is a mismatch", () => {
		const zero = { free: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
		expect(costMismatch([usageLine("free", 0.5, 1000)], zero)).toHaveLength(1);
		expect(costMismatch([usageLine("free", 0, 1000)], zero)).toEqual([]);
	});

	test("cache tokens are priced from their own rates", () => {
		expect(costMismatch([usageLine("glm-test", 4, 1000000, 1000000)], PRICES)).toHaveLength(1);
		expect(costMismatch([usageLine("glm-test", 2.2, 1000000, 1000000)], PRICES)).toEqual([]);
	});
});

describe("all rules in one pass", () => {
	test("providerFindings folds the five rules over one run's events", () => {
		const found = providerFindings(events("provider-tools.jsonl"), { id_patterns: {}, allow_tools: [] });
		expect(found.map((f) => f.kind)).toEqual(["unoffered-tool", "unoffered-tool"]);
	});

	test("one pass over merged runs keeps every kind", () => {
		const evs = [
			...events("provider-odd-id.jsonl"),
			...events("provider-phantom.jsonl"),
			withUsage("", 99),
		];
		const found = providerFindings(evs, { id_patterns: { anthropic: "^msg_[A-Za-z0-9]+$" }, allow_tools: [] });
		// The odd-id fixture's mystery-provider assistant also breaks the announced provider,
		// so the pass opens with a model-swap before the id and phantom findings.
		expect(found.map((f) => f.kind)).toEqual(["model-swap", "odd-response-id", "phantom-output", "phantom-output"]);
	});
});

describe("weekly provider honesty summary (P3)", () => {
	const src = { listRuns: () => [], mainSession: () => null };
	test("the report carries a provider honesty block when a summary is passed", () => {
		const rep = buildReport(loadConfig({ home: TMP, template: TEMPLATE_PATH }), src, 7, 1793000000, {
			runs: 3,
			byKind: { "model-swap": 2, "unoffered-tool": 1 },
		});
		expect(rep.text).toContain("Provider honesty over 3 runs: 2 model-swap, 1 unoffered-tool");
	});

	test("without a summary the block is absent (older callers unchanged)", () => {
		const rep = buildReport(loadConfig({ home: TMP, template: TEMPLATE_PATH }), src, 7, 1793000000);
		expect(rep.text).not.toContain("Provider honesty");
	});
});

