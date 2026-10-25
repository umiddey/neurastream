// Provider-honesty rules (plan 20261024_0302): what came back must be what was asked for.
// Three checks over one run's TraceEvents, each a pure function so tests feed fixtures and the
// later detector/CLI wiring gathers real runs:
//   model-swap      the run announced a model (model_change) but an assistant message shows
//                   another model or another provider, or the run resolved to a fallback;
//   odd-response-id an assistant message's responseId misses the shape configured for its
//                   provider (traces.provider.id_patterns);
//   unoffered-tool  a toolCall for a tool the session was never shown as offered (P2).
// Finding text passes through the shared mask: evidence holds at most 160 chars and long
// token-like runs (a responseId can look exactly like a credential) never survive verbatim.

import type { TraceEvent } from "./adapter.ts";
import type { Finding } from "./incident-detectors.ts";
import { maskEvidence } from "./trace-claims.ts";

/**
 * Folds one finding into the list unless its fingerprint is already there, so repeats of the
 * same dishonesty in one run stay one finding (first sighting wins the evidence). Every rule
 * uses this, so masking and the evidence cap cannot be forgotten at a call site.
 */
export function foldFinding(out: Finding[], seen: Set<string>, kind: string, summary: string, evidence: string, fingerprint: string): void {
	if (seen.has(fingerprint)) return;
	seen.add(fingerprint);
	out.push({ kind, summary, evidence: maskEvidence(evidence), fingerprint });
}

/** Assistant-message events: the only lines that speak with a provider's voice. */
function isServed(e: TraceEvent): boolean {
	return e.kind === "toolCall" || e.kind === "assistantText";
}

/**
 * The run's announcements vs what the assistant messages show. The announced model is
 * provider-prefixed ("<provider>/<model>") while a message's fields are bare, so the prefix is
 * the promised provider and the rest the promised model; a model without a prefix promises no
 * provider and only the model is judged. A run that never announced a model is not judged:
 * without a claim there is nothing to be honest against. A `resolvedModelIsFallback`
 * announcement is itself a swap — the run was asked for one model and served another.
 */
export function modelSwaps(events: TraceEvent[]): Finding[] {
	const out: Finding[] = [];
	const seen = new Set<string>();
	let announced: TraceEvent | undefined;
	for (const e of events) {
		if (e.kind === "modelChange") {
			announced = e;
			if (e.fallback) {
				foldFinding(out, seen, "model-swap", `run ${e.runId}: the requested model was resolved to a fallback`,
					`run ${e.runId}: model_change for ${e.model ?? "?"} says resolvedModelIsFallback`,
					`model-swap:${e.runId}:fallback`);
			}
			continue;
		}
		if (!isServed(e) || !announced?.model) continue;
		const slash = announced.model.indexOf("/");
		const askedModel = slash === -1 ? announced.model : announced.model.slice(slash + 1);
		const askedProvider = slash === -1 ? undefined : announced.model.slice(0, slash);
		if (e.model && e.model !== askedModel) {
			foldFinding(out, seen, "model-swap", `run ${e.runId}: asked for ${askedModel}, an assistant message says ${e.model}`,
				`run ${e.runId}: model_change says ${announced.model}, message says model ${e.model} (provider ${e.provider ?? "?"})`,
				`model-swap:${e.runId}:model:${askedModel}:${e.model}`);
		}
		if (askedProvider && e.provider && e.provider !== askedProvider) {
			foldFinding(out, seen, "model-swap", `run ${e.runId}: asked provider ${askedProvider}, an assistant message says ${e.provider}`,
				`run ${e.runId}: model_change says ${announced.model}, message says provider ${e.provider} (model ${e.model ?? "?"})`,
				`model-swap:${e.runId}:provider:${askedProvider}:${e.provider}`);
		}
	}
	return out;
}

/**
 * Response-id shapes per provider (traces.provider.id_patterns): an id that misses the
 * configured shape is odd. An absent id is not checked — missing is not malformed, and the
 * 7-day smoke showed absent ids on every run of some providers. A provider without an entry is
 * not checked, and an unparseable pattern disables that one provider rather than guessing what
 * its ids should look like. Repeats fold to one finding per run and provider.
 */
export function oddResponseIds(events: TraceEvent[], idPatterns: Record<string, string>): Finding[] {
	const out: Finding[] = [];
	const seen = new Set<string>();
	const shapes = new Map<string, RegExp | null>();
	for (const e of events) {
		if (!isServed(e) || !e.provider) continue;
		const pattern = idPatterns[e.provider];
		if (pattern === undefined) continue;
		if (!shapes.has(e.provider)) {
			let rx: RegExp | null;
			try {
				rx = new RegExp(pattern);
			} catch {
				rx = null;
			}
			shapes.set(e.provider, rx);
		}
		const rx = shapes.get(e.provider);
		if (!rx) continue;
		if (e.responseId === undefined || rx.test(e.responseId)) continue;
		foldFinding(out, seen, "odd-response-id", `run ${e.runId}: ${e.provider} answered with a responseId that misses its configured shape`,
			`${e.provider} responseId "${e.responseId}" must match ${pattern}`,
			`odd-response-id:${e.runId}:${e.provider}`);
	}
	return out;
}

/** A tool result that says the harness does not know the tool at all (the refusal of a made-up call). */
const UNKNOWN_TOOL = /^(tool \S+ not found|no such tool|unknown tool)\b/i;

/**
 * Tool calls for tools the session was never shown as offered. The offered set is the config
 * allow-list plus the names parsed from the request's own tool list (an http dump, passed in by
 * the caller) plus every tool the run itself got a result for — except a result refusing the
 * call as an unknown tool. The plan wording says "earlier successful tool names"; the check
 * accepts any non-refusal result anywhere in the run on purpose: judging only what came earlier
 * would flag the honest first use of every tool, and an error (a guard refusal, bad arguments)
 * still means the harness ran the tool — the 7-day smoke had 14 such real tools flagged.
 */
export function unofferedTools(events: TraceEvent[], allowTools: string[], offered: string[] = []): Finding[] {
	const proven = new Set<string>([...allowTools, ...offered]);
	for (const e of events) {
		if (e.kind !== "toolResult" || !e.tool) continue;
		if (e.isError === true && UNKNOWN_TOOL.test(e.text ?? "")) continue;
		proven.add(e.tool);
	}
	const out: Finding[] = [];
	const seen = new Set<string>();
	for (const e of events) {
		if (e.kind !== "toolCall" || !e.tool || e.tool === "?") continue;
		if (proven.has(e.tool)) continue;
		foldFinding(out, seen, "unoffered-tool", `run ${e.runId}: toolCall "${e.tool}" was never offered to the session`,
			`toolCall "${e.tool}" has no successful result in the run, is not allow-listed and is not in the request's tool list`,
			`unoffered-tool:${e.runId}:${e.tool}`);
	}
	return out;
}

/**
 * Output tokens billed for an assistant message that wrote nothing: the parser marks a
 * content-less message as assistantText with empty text, and billed output with no content is
 * phantom. A message without usage cannot be judged and a real reply never is. Each phantom
 * message is its own finding, keyed by response id (or position when the line carries neither).
 */
export function phantomOutput(events: TraceEvent[]): Finding[] {
	const out: Finding[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < events.length; i++) {
		const e = events[i]!;
		if (e.kind !== "assistantText" || e.text !== "" || !e.usage) continue;
		if (!(e.usage.output > 0)) continue;
		const id = e.responseId ?? (e.ts === null ? String(i) : String(e.ts));
		foldFinding(out, seen, "phantom-output", `run ${e.runId}: an assistant message billed ${e.usage.output} output tokens but wrote nothing`,
			`assistant message billed ${e.usage.output} output tokens with empty content (responseId ${e.responseId ?? "<absent>"})`,
			`phantom-output:${e.runId}:${id}`);
	}
	return out;
}

/**
 * The run's own model_usage accounting vs the configured price table ($ per million tokens).
 * Billed cost beyond ±20% of the table price is a mismatch in either direction — over-billing
 * and under-billing both lie about what the run cost. A zero-priced model that still bills is
 * a mismatch too (no percentage exists against zero). A model without an entry is not priced:
 * a wrong guess would be worse than no check. Repeats fold per run and model.
 */
export function costMismatch(events: TraceEvent[], prices: Record<string, ProviderPrice>): Finding[] {
	const out: Finding[] = [];
	const seen = new Set<string>();
	for (const e of events) {
		if (e.kind !== "usage" || !e.model || !e.usage) continue;
		const u = e.usage;
		if (!(u.totalTokens > 0)) continue;
		const bare = e.model.includes("/") ? e.model.slice(e.model.indexOf("/") + 1) : e.model;
		const price = prices[e.model] ?? prices[bare];
		if (!price) continue;
		const expected = (u.input * price.input + u.output * price.output + u.cacheRead * price.cache_read + u.cacheWrite * price.cache_write) / 1_000_000;
		const billed = u.cost;
		const off = expected > 0 ? Math.abs(billed - expected) / expected : Math.abs(billed);
		if (!(off > 0.2)) continue;
		const pct = expected > 0 ? ` (${Math.round((billed / expected - 1) * 100)}%)` : "";
		foldFinding(out, seen, "cost-mismatch", `run ${e.runId}: ${e.model} billed $${billed} but the price table says $${Number(expected.toFixed(6))}${pct}`,
			`model_usage ${e.model}: billed $${billed}, tokens in ${u.input} out ${u.output} cacheRead ${u.cacheRead} cacheWrite ${u.cacheWrite}, table says $${Number(expected.toFixed(6))}${pct}`,
			`cost-mismatch:${e.runId}:${e.model}`);
	}
	return out;
}

/** What the provider-honesty rules need from config (cfg.traces.provider). */
export interface ProviderRules {
	id_patterns: Record<string, string>;
	allow_tools: string[];
}

/** One model's price row: $ per million tokens (traces.provider.prices). */
export interface ProviderPrice {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
}

/**
 * Every rule at once over one run's events, in rule order (P1 swaps, P1 ids, P2 tools, P3
 * phantom, P3 cost) — the shape the metrics report summary and the smoke scan both fold.
 */
export function providerFindings(events: TraceEvent[], rules: ProviderRules, prices: Record<string, ProviderPrice> = {}, offered: string[] = []): Finding[] {
	return [
		...modelSwaps(events),
		...oddResponseIds(events, rules.id_patterns),
		...unofferedTools(events, rules.allow_tools, offered),
		...phantomOutput(events),
		...costMismatch(events, prices),
	];
}
