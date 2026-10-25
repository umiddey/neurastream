// Prompt bloat (plan 20261024_0303 P1): how big each model call's prompt was, and when a run
// is stuffing its context. A call's prompt is what the provider read before it wrote a token:
// usage.input + usage.cacheRead + usage.cacheWrite. Rows come from the usage assistant
// messages carry — one message is one call, and its content parts share the response id, so
// they fold into one row. The two look-alikes are not calls: the periodic model_usage lines are
// running totals of the accounting, not per-call rows, and a toolResult's usage belongs to no
// model call. A run flags prompt-bloat when its FIRST call opens over first_call_max (a run
// that starts huge stays huge), or any call passes ratio_of_limit × its model's
// context_limits entry — a model without an entry is not limit-checked, a wrong guess would be
// worse than no check. Finding text goes through the shared mask like every trace finding.

import type { TraceEvent } from "./adapter.ts";
import type { Config } from "./config.ts";
import type { Finding } from "./incident-detectors.ts";
import { foldFinding } from "./trace-provider.ts";

/** One model call's prompt size, in trace order. */
export interface CallSize {
	ts: number | null;
	model?: string;
	/** usage.input + usage.cacheRead + usage.cacheWrite. */
	prompt: number;
}

/** One row per model call: usage-bearing assistant messages, folded per response id. */
export function callSizes(events: TraceEvent[]): CallSize[] {
	const out: CallSize[] = [];
	let last = "";
	for (const e of events) {
		if (e.kind !== "toolCall" && e.kind !== "assistantText") continue;
		const u = e.usage;
		if (!u) continue;
		// Parts of one assistant message share the response id and carry the same usage; a
		// message without one folds only while the next usage-bearing event is identical.
		const key = e.responseId ?? `${e.ts}|${e.model}|${u.input}|${u.output}|${u.cacheRead}|${u.cacheWrite}`;
		if (key === last) continue;
		last = key;
		out.push({ ts: e.ts, model: e.model, prompt: u.input + u.cacheRead + u.cacheWrite });
	}
	return out;
}

/** What the bloat rules need from config (cfg.traces.bloat). */
export interface BloatRules {
	/** The largest first-call prompt a healthy run may open with. */
	first_call_max: number;
	/** A call flags when its prompt passes ratio_of_limit × its model's context limit. */
	ratio_of_limit: number;
	/** Model -> context tokens; a model without an entry is not limit-checked. */
	context_limits: Record<string, number>;
}

/** Maps config onto the rule set (cfg.traces.bloat), the way actionsRules maps the traces lists. */
export function bloatRules(cfg: Config): BloatRules {
	return {
		first_call_max: cfg.traces.bloat.first_call_max,
		ratio_of_limit: cfg.traces.bloat.ratio_of_limit,
		context_limits: cfg.traces.bloat.context_limits,
	};
}

/** The model's context_limits entry: the exact key wins, then the bare model without a provider prefix. */
function limitOf(model: string, limits: Record<string, number>): number | undefined {
	if (limits[model] !== undefined) return limits[model];
	const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	return limits[bare];
}

/**
 * The prompt-bloat findings of one run's events: a first-call finding when the run opens over
 * first_call_max, then one finding per call past its model's limit budget, each naming the
 * call's 1-based index. Findings fold like every rule's (one per fingerprint, masked evidence).
 */
export function bloatFindings(events: TraceEvent[], rules: BloatRules): Finding[] {
	const out: Finding[] = [];
	const seen = new Set<string>();
	const runId = events[0]?.runId ?? "?";
	const calls = callSizes(events);
	if (calls.length === 0) return out;
	const first = calls[0]!;
	if (first.prompt > rules.first_call_max) {
		foldFinding(out, seen, "prompt-bloat",
			`run ${runId}: the first call's prompt is ${first.prompt} tokens, over the ${rules.first_call_max} first-call ceiling`,
			`first call (model ${first.model ?? "?"}) prompt ${first.prompt}; ceiling ${rules.first_call_max}`,
			`prompt-bloat:${runId}:first`);
	}
	for (let i = 0; i < calls.length; i++) {
		const c = calls[i]!;
		if (!c.model) continue;
		const limit = limitOf(c.model, rules.context_limits);
		if (limit === undefined) continue;
		const budget = rules.ratio_of_limit * limit;
		if (c.prompt <= budget) continue;
		const pct = Math.round((c.prompt / limit) * 100);
		foldFinding(out, seen, "prompt-bloat",
			`run ${runId}: call ${i + 1} (${c.model}) prompt ${c.prompt} tokens is ${pct}% of its ${limit} context limit`,
			`call ${i + 1} of ${calls.length} (model ${c.model}) prompt ${c.prompt}; limit ${limit}, flag over ${rules.ratio_of_limit} × limit = ${budget}`,
			`prompt-bloat:${runId}:${i + 1}:${c.model}`);
	}
	return out;
}

/** One named slice of a dumped request's prompt; bytes are the JSON.stringify length. */
export interface DumpPart {
	name: string;
	bytes: number;
}

/** The prompt pieces of one dumped request: body.system, body.messages, body.tools[] in dump order. */
export interface DumpParts {
	system: number;
	messages: number;
	tools: DumpPart[];
}

export interface BloatBreakdown {
	/** system, messages and every tool group, largest first. */
	parts: DumpPart[];
	/** The five largest individual tools, largest first. */
	tools: DumpPart[];
}

/**
 * Groups a dumped request's tools by the first capture of the group regex on the tool name (a
 * name with no match — or a pattern with no capture, or an unparseable pattern, which disables
 * grouping rather than guessing — lands in "builtin"), and returns the prompt parts sorted by
 * bytes plus the five largest individual tools.
 */
export function bloatBreakdown(parts: DumpParts, groupRegex: string): BloatBreakdown {
	let rx: RegExp | null;
	try {
		rx = new RegExp(groupRegex);
	} catch {
		rx = null;
	}
	const groups = new Map<string, number>();
	for (const t of parts.tools) {
		const m = rx ? rx.exec(t.name) : null;
		const group = m?.[1] ?? "builtin";
		groups.set(group, (groups.get(group) ?? 0) + t.bytes);
	}
	const rows: DumpPart[] = [
		{ name: "system", bytes: parts.system },
		{ name: "messages", bytes: parts.messages },
		...[...groups].map(([name, bytes]) => ({ name, bytes })),
	];
	rows.sort((a, b) => b.bytes - a.bytes);
	const tools = [...parts.tools].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
	return { parts: rows, tools };
}
