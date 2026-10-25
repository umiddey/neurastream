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
function fold(out: Finding[], seen: Set<string>, kind: string, summary: string, evidence: string, fingerprint: string): void {
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
				fold(out, seen, "model-swap", `run ${e.runId}: the requested model was resolved to a fallback`,
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
			fold(out, seen, "model-swap", `run ${e.runId}: asked for ${askedModel}, an assistant message says ${e.model}`,
				`run ${e.runId}: model_change says ${announced.model}, message says model ${e.model} (provider ${e.provider ?? "?"})`,
				`model-swap:${e.runId}:model:${askedModel}:${e.model}`);
		}
		if (askedProvider && e.provider && e.provider !== askedProvider) {
			fold(out, seen, "model-swap", `run ${e.runId}: asked provider ${askedProvider}, an assistant message says ${e.provider}`,
				`run ${e.runId}: model_change says ${announced.model}, message says provider ${e.provider} (model ${e.model ?? "?"})`,
				`model-swap:${e.runId}:provider:${askedProvider}:${e.provider}`);
		}
	}
	return out;
}

/**
 * Response-id shapes per provider (traces.provider.id_patterns): an id that misses the
 * configured shape — or is absent where a shape is configured — is odd. A provider without an
 * entry is not checked, and an unparseable pattern disables that one provider rather than
 * guessing what its ids should look like. Repeats fold to one finding per run and provider.
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
		if (e.responseId !== undefined && rx.test(e.responseId)) continue;
		fold(out, seen, "odd-response-id", `run ${e.runId}: ${e.provider} answered with a responseId that misses its configured shape`,
			`${e.provider} responseId ${e.responseId === undefined ? "<absent>" : `"${e.responseId}"`} must match ${pattern}`,
			`odd-response-id:${e.runId}:${e.provider}`);
	}
	return out;
}

/**
 * Tool calls for tools the session was never shown as offered. The offered set is the config
 * allow-list plus the names parsed from the request's own tool list (an http dump, passed in by
 * the caller) plus every tool the run itself served successfully. The plan wording says
 * "earlier successful tool names"; the check accepts a success anywhere in the run on purpose:
 * a first call that succeeds proves the tool was offered (the harness refuses unknown tools, so
 * a hallucinated call errors and never succeeds), and judging only what came earlier would
 * flag the honest first use of every tool in every run.
 */
export function unofferedTools(events: TraceEvent[], allowTools: string[], offered: string[] = []): Finding[] {
	const proven = new Set<string>([...allowTools, ...offered]);
	for (const e of events) {
		if (e.kind === "toolResult" && e.isError !== true && e.tool) proven.add(e.tool);
	}
	const out: Finding[] = [];
	const seen = new Set<string>();
	for (const e of events) {
		if (e.kind !== "toolCall" || !e.tool || e.tool === "?") continue;
		if (proven.has(e.tool)) continue;
		fold(out, seen, "unoffered-tool", `run ${e.runId}: toolCall "${e.tool}" was never offered to the session`,
			`toolCall "${e.tool}" has no successful result in the run, is not allow-listed and is not in the request's tool list`,
			`unoffered-tool:${e.runId}:${e.tool}`);
	}
	return out;
}
