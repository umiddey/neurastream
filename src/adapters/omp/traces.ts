// Session-file trace reader: replays one run's raw activity as TraceEvents (plan
// 20261024_0300 P1). Run-id derivation matches the ledger (src/adapters/omp/sessions.ts):
// dated depth-1 files are main runs with id `MAIN <HH-MM-SS>` from the stem, deeper files are
// subagent runs with the bare stem as id. Every line type this harness writes that carries
// trace-relevant data is mapped; anything else (session banners, custom lines, compaction
// notes, unparseable lines) is skipped.

import { readFileSync, statSync } from "node:fs";
import type { TraceEvent, TraceSource, TraceUsage } from "../../core/adapter.ts";
import { asObj, jsonlAt, parseTs, runIdOf } from "./sessions.ts";

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageOf(u: unknown): TraceUsage | undefined {
	const o = asObj(u);
	if (!o) return undefined;
	const c = asObj(o.cost);
	return {
		input: num(o.input),
		output: num(o.output),
		cacheRead: num(o.cacheRead),
		cacheWrite: num(o.cacheWrite),
		totalTokens: num(o.totalTokens),
		cost: c ? num(c.total) : 0,
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => (asObj(p)?.type === "text" ? String(asObj(p)?.text ?? "") : ""))
		.filter((t) => t !== "")
		.join("\n");
}

/** Every trace event in one session file, in file order. */
export function parseTraceFile(file: string, runId: string): TraceEvent[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: TraceEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const d = asObj(parsed);
		if (!d) continue;
		const ts = typeof d.timestamp === "string" ? parseTs(d.timestamp) : null;
		if (d.type === "model_change") {
			out.push({
				kind: "modelChange",
				ts,
				runId,
				model: str(d.model),
				provider: str(d.provider),
				fallback: d.resolvedModelIsFallback === true ? true : undefined,
			});
			continue;
		}
		if (d.type === "model_usage") {
			const usage = usageOf(d.usage);
			if (usage) out.push({ kind: "usage", ts, runId, model: str(d.model), provider: str(d.provider), usage });
			continue;
		}
		const m = asObj(d.message) ?? (d.type === "message" || d.role ? d : null);
		if (!m) continue;
		const role = str(m.role);
		const model = str(m.model);
		const provider = str(m.provider);
		const usage = usageOf(m.usage);
		if (role === "assistant") {
			const content = Array.isArray(m.content) ? m.content : [];
			for (const part of content) {
				const p = asObj(part);
				if (!p) continue;
				if (p.type === "text") {
					const t = String(p.text ?? "");
					if (t.trim()) out.push({ kind: "assistantText", ts, runId, text: t, model, provider, usage, responseId: str(m.responseId) });
				} else if (p.type === "toolCall") {
					out.push({
						kind: "toolCall",
						ts,
						runId,
						tool: str(p.name) ?? "?",
						args: asObj(p.arguments) ?? {},
						model,
						provider,
						usage,
						responseId: str(m.responseId),
					});
				}
			}
		} else if (role === "toolResult") {
			out.push({
				kind: "toolResult",
				ts,
				runId,
				tool: str(m.toolName) ?? "?",
				isError: m.isError === true,
				text: textOf(m.content),
				usage,
			});
		}
	}
	return out;
}

/** Every run id with a trace under the root, each mapped to its newest file. */
export function ompTraceRuns(root: string): { runId: string; file: string; mtimeSec: number }[] {
	const newest: Record<string, { file: string; mtimeSec: number }> = {};
	for (const file of [...jsonlAt(root, 1), ...jsonlAt(root, 2)]) {
		let mt: number;
		try {
			mt = statSync(file).mtimeMs;
		} catch {
			continue;
		}
		const mtimeSec = mt / 1000;
		const id = runIdOf(file);
		const prev = newest[id];
		if (!prev || mtimeSec > prev.mtimeSec) newest[id] = { file, mtimeSec };
	}
	return Object.entries(newest).map(([runId, v]) => ({ runId, file: v.file, mtimeSec: v.mtimeSec }));
}

/**
 * Tool names one dumped request offered: body.tools[].name of an http-4xx dump. A dump the
 * reader cannot open or parse offers nothing — a broken dump must not widen the offered set.
 */
export function offeredFromDump(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const o = asObj(parsed);
	const body = asObj(o?.body) ?? o;
	const tools = body?.tools;
	if (!Array.isArray(tools)) return [];
	return tools.map((t) => str(asObj(t)?.name)).filter((n): n is string => n !== undefined);
}

/** TraceSource over a sessions root: dated main files at depth 1, subagent files at depth 2. */
export function ompTraceSource(root: string): TraceSource {
	return {
		events(runId: string): TraceEvent[] {
			const file = ompTraceRuns(root).find((r) => r.runId === runId)?.file;
			return file ? parseTraceFile(file, runId) : [];
		},
	};
}
