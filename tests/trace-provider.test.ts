// Provider-honesty rules (src/core/trace-provider.ts, plan 20261024_0302 P1): what came back
// must be what was asked for. Fixtures are synthetic JSONL in the documented session shape;
// every rule runs over parseTraceFile output so the adapter mapping (responseId, fallback) is
// exercised end to end, plus synthetic events for edges the fixtures cannot carry.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TraceEvent } from "../src/core/adapter.ts";
import { parseTraceFile, offeredFromDump } from "../src/adapters/omp/traces.ts";
import { loadConfig, TEMPLATE_PATH } from "../src/core/config.ts";
import { modelSwaps, oddResponseIds, unofferedTools } from "../src/core/trace-provider.ts";

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

	test("a missing id counts as odd when the provider has a pattern", () => {
		const found = oddResponseIds([assistant({ provider: "anthropic" })], ANTHROPIC);
		expect(found).toHaveLength(1);
		expect(found[0]?.fingerprint).toBe("odd-response-id:synthetic:anthropic");
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
	test("template ships provider defaults under traces.provider", () => {
		const cfg = loadConfig({ home: TMP, template: TEMPLATE_PATH });
		expect(Object.keys(cfg.traces.provider.id_patterns)).toContain("anthropic");
		expect(Array.isArray(cfg.traces.provider.allow_tools)).toBe(true);
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

	test("a call that only ever errors stays unoffered even with a result present", () => {
		expect(unofferedTools([assistant({ tool: "phantom" }), result("phantom", true)], []).map((f) => f.fingerprint)).toEqual(["unoffered-tool:synthetic:phantom"]);
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

