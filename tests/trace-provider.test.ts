// Provider-honesty rules (src/core/trace-provider.ts, plan 20261024_0302 P1): what came back
// must be what was asked for. Fixtures are synthetic JSONL in the documented session shape;
// every rule runs over parseTraceFile output so the adapter mapping (responseId, fallback) is
// exercised end to end, plus synthetic events for edges the fixtures cannot carry.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TraceEvent } from "../src/core/adapter.ts";
import { parseTraceFile } from "../src/adapters/omp/traces.ts";
import { loadConfig, TEMPLATE_PATH } from "../src/core/config.ts";
import { modelSwaps, oddResponseIds } from "../src/core/trace-provider.ts";

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
