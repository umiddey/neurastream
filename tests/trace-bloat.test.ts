// Prompt bloat (src/core/trace-bloat.ts, plan 20261024_0303 P1): how many tokens each model
// call had to read before it wrote, and when a run flags prompt-bloat. The bloat-run fixture
// carries the two look-alikes that are NOT model calls — a periodic model_usage accounting
// snapshot and a toolResult message that happens to carry usage — plus one assistant message
// with two content parts, which is one call, not two.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
			tool_group: "^mcp__([A-Za-z0-9]+)_",
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

	const bad = (yaml: string): string =>
		`paths:
  home: "${join(TMP, "cfg-bad")}"
traces:
  bloat:
${yaml}
`;

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
			writeFileSync(join(home, ".config", "neurastream", "config.yml"), bad(yaml));
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
