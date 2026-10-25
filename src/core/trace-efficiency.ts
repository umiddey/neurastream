// Waste counters (plan 20261024_0304 P1): score how much of a run's tool activity was wasted —
// the same file read again, a failed command rerun unchanged, an edit that errored, the same
// guard refusal hit twice, idle polling while waiting. Every input comes from config (the guard
// tool lists and the `traces.efficiency` values), so owners tune the rules without touching
// code. One call counts as wasted at most once: the first rule in the order below wins.

import type { TraceEvent } from "./adapter.ts";
import type { Config } from "./config.ts";

export type WasteRule = "repeat-read" | "repeat-fail" | "failed-edit" | "guard-repeat" | "poll";

/** First match wins; the array order is the rule order. */
const RULE_ORDER: WasteRule[] = ["repeat-read", "repeat-fail", "failed-edit", "guard-repeat", "poll"];

export interface EfficiencyRules {
	read_tools: string[];
	shell_tools: string[];
	write_tools: string[];
	/** The Nth identical read (same args JSON, no write between) counts; 2 = the first re-read. */
	repeat_read_min: number;
	/** A toolResult text starting with one of these is a guard block. */
	guard_prefixes: string[];
	/** Shell commands matching this poll while nothing else runs. */
	poll_pattern: string;
}

export interface WasteStep {
	/** Ordinal of the wasted call among the run's toolCall events (0-based). */
	index: number;
	rule: WasteRule;
}

export interface Efficiency {
	/** Number of toolCall events in the run. */
	calls: number;
	wasted: number;
	/** wasted / calls; 0 when calls is 0. */
	wastePct: number;
	byRule: Record<WasteRule, number>;
	steps: WasteStep[];
}

/** Maps config onto the rule set: the guard tool lists plus `traces.efficiency`. */
export function efficiencyRules(cfg: Config): EfficiencyRules {
	return {
		read_tools: cfg.guards.read_tools,
		shell_tools: cfg.guards.shell_tools,
		write_tools: cfg.guards.write_tools,
		repeat_read_min: cfg.traces.efficiency.repeat_read_min,
		guard_prefixes: cfg.traces.efficiency.guard_prefixes,
		poll_pattern: cfg.traces.efficiency.poll_pattern,
	};
}

function emptyByRule(): Record<WasteRule, number> {
	return { "repeat-read": 0, "repeat-fail": 0, "failed-edit": 0, "guard-repeat": 0, poll: 0 };
}

/**
 * Waste counters over one run's trace events. Calls are the toolCall events in event order; a
 * toolResult pairs to its call by callId (first result wins), and rules that look at outcomes
 * (repeat-fail, failed-edit, guard blocks) read the paired result. A write-tool call breaks the
 * read/fail chains — the agent changed something, so a rerun after it is not a blind repeat.
 */
export function runEfficiency(events: TraceEvent[], rules: EfficiencyRules): Efficiency {
	const calls = events.filter((e) => e.kind === "toolCall");
	const resultByCallId = new Map<string, TraceEvent>();
	for (const e of events) {
		if (e.kind !== "toolResult" || e.callId === undefined) continue;
		if (!resultByCallId.has(e.callId)) resultByCallId.set(e.callId, e);
	}
	const resultOf = (c: TraceEvent): TraceEvent | undefined => (c.callId === undefined ? undefined : resultByCallId.get(c.callId));

	const pollRe = new RegExp(rules.poll_pattern);
	const byRule = emptyByRule();
	const steps: WasteStep[] = [];

	const readCounts = new Map<string, number>(); // args JSON -> occurrences since the last write
	const failedCmds = new Set<string>(); // commands with an earlier failed result since the last write
	const guardFirstLines = new Set<string>();
	let pollRun = 0; // consecutive poll calls so far

	calls.forEach((c, index) => {
		const tool = c.tool ?? "?";
		const isRead = rules.read_tools.includes(tool);
		const isShell = rules.shell_tools.includes(tool);
		const isWrite = rules.write_tools.includes(tool);
		const command = isShell && typeof c.args?.command === "string" ? c.args.command : "";
		const res = resultOf(c);
		if (isWrite) {
			readCounts.clear();
			failedCmds.clear();
		}
		const isPoll = isShell && command !== "" && pollRe.test(command);
		if (!isPoll) pollRun = 0;

		let hit: WasteRule | null = null;
		if (isRead) {
			const argsJson = JSON.stringify(c.args ?? {});
			const n = (readCounts.get(argsJson) ?? 0) + 1;
			readCounts.set(argsJson, n);
			if (n >= rules.repeat_read_min) hit = "repeat-read";
		}
		if (hit === null && isShell && command !== "") {
			if (failedCmds.has(command)) hit = "repeat-fail";
			if (res?.isError === true) failedCmds.add(command);
		}
		if (hit === null && isWrite && res?.isError === true) hit = "failed-edit";
		if (hit === null && res !== undefined) {
			const text = res.text ?? "";
			const prefix = rules.guard_prefixes.find((p) => text.startsWith(p));
			if (prefix !== undefined) {
				const firstLine = text.split("\n", 1)[0] ?? text;
				if (guardFirstLines.has(firstLine)) hit = "guard-repeat";
				else guardFirstLines.add(firstLine);
			}
		}
		if (hit === null && isPoll) {
			pollRun += 1;
			if (pollRun >= 2) hit = "poll";
		}
		if (hit !== null) {
			byRule[hit] += 1;
			steps.push({ index, rule: hit });
		}
	});

	const wasted = steps.length;
	return { calls: calls.length, wasted, wastePct: calls.length > 0 ? wasted / calls.length : 0, byRule, steps };
}
