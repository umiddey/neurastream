// Session-file trace reader: replays one run's raw activity as TraceEvents (plan
// 20261024_0300 P1). Run-id derivation matches the ledger (src/adapters/omp/sessions.ts):
// dated depth-1 files are main runs with id `MAIN <HH-MM-SS>` from the stem, deeper files are
// subagent runs with the bare stem as id. Every line type this harness writes that carries
// trace-relevant data is mapped; anything else (session banners, custom lines, compaction
// notes, unparseable lines) is skipped.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TraceEvent, TraceSource, TraceUsage } from "../../core/adapter.ts";
import type { DumpParts, DumpTokens } from "../../core/trace-bloat.ts";
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
			// An assistant message with no content at all would vanish (nothing to map); an empty
			// text marks it so the phantom-output rule can see billed tokens with no words. An
			// aborted or errored stream (owner interrupt, provider error) drops its partial content
			// while keeping the usage of what streamed, so it is not marked.
			if (content.length === 0 && m.stopReason !== "aborted" && m.stopReason !== "error") {
				out.push({ kind: "assistantText", ts, runId, text: "", model, provider, usage, responseId: str(m.responseId) });
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

/** Read only the session banner at the start of a trace; null means it is unreadable. */
export function ompTraceStart(file: string): number | null {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return null;
	}
	const buffer = Buffer.allocUnsafe(4096);
	try {
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
			try {
				const value = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
				if (value.type === "session" && typeof value.timestamp === "string") return parseTs(value.timestamp);
			} catch {}
		}
		return null;
	} finally {
		closeSync(fd);
	}
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

/** The harness log dir holding the whole failed requests (http-4xx dumps), named by epoch ms. */
export function ompDumpDir(home: string): string {
	return join(home, ".omp", "logs", "http-400-requests");
}

/**
 * Every request dump under the harness log dir, oldest first. Dumps are named
 * `<epoch ms of the failed request>-<request id>.json`; anything else in the dir is not a dump.
 */
export function ompDumps(home: string): { file: string; ms: number }[] {
	let names: string[];
	try {
		names = readdirSync(ompDumpDir(home));
	} catch {
		return [];
	}
	const out: { file: string; ms: number }[] = [];
	for (const name of names) {
		const m = /^(\d+)-[A-Za-z0-9]+\.json$/.exec(name);
		if (m) out.push({ file: join(ompDumpDir(home), name), ms: Number(m[1]) });
	}
	return out.sort((a, b) => a.ms - b.ms);
}

/** Model requested by a failed request dump, if the JSON contains one. */
export function dumpModel(file: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const o = asObj(parsed);
		const body = asObj(o?.body);
		return str(body?.model) ?? str(o?.model);
	} catch {
		return undefined;
	}
}

/**
 * What a dumped request's prompt is made of, in JSON.stringify characters: body.system,
 * body.messages and every body.tools[] entry with its name (a nameless tool keeps its bytes
 * as "?"). A dump the reader cannot open or parse breaks down to zeros — a broken dump must
 * not look like a prompt that was mostly empty.
 */
export function dumpParts(file: string): DumpParts {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { system: 0, messages: 0, tools: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { system: 0, messages: 0, tools: [] };
	}
	const o = asObj(parsed);
	const body = asObj(o?.body) ?? o ?? {};
	const tools = Array.isArray(body.tools) ? body.tools : [];
	return {
		system: body.system === undefined ? 0 : JSON.stringify(body.system).length,
		messages: body.messages === undefined ? 0 : JSON.stringify(body.messages).length,
		tools: tools.map((t) => ({ name: str(asObj(t)?.name) ?? "?", bytes: JSON.stringify(t).length })),
	};
}

/**
 * What one dumped request's error response states about its own prompt: "<N> tokens > <M>
 * maximum" (the provider's rejection line) — or, when that shape is missing, a bare
 * "<N> tokens" — plus the request's model. A dump whose error response states no count, or a
 * dump the reader cannot open or parse, states nothing: a flag must never be guessed from
 * bytes alone.
 */
export function dumpPromptTokens(file: string): DumpTokens | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const o = asObj(parsed);
	const body = asObj(o?.body) ?? o ?? {};
	const message = str(asObj(o?.errorResponse)?.message);
	if (message === undefined) return null;
	const count = (v: string | undefined) => {
		const n = v === undefined ? NaN : Number(v.replaceAll(",", ""));
		return Number.isFinite(n) ? n : undefined;
	};
	const m = /(\d[\d,]*)\s*tokens?\s*>\s*([\d,]+)\s*maximum/.exec(message);
	const tokens = count(m?.[1]) ?? count(/(\d[\d,]*)\s*tokens?\b(?!\s*>)/.exec(message)?.[1]);
	if (tokens === undefined) return null;
	const out: DumpTokens = { tokens };
	const limit = count(m?.[2]);
	if (limit !== undefined) out.limit = limit;
	const model = str(body.model);
	if (model !== undefined) out.model = model;
	return out;
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

export interface RelatedTrace {
	/** The subagent run's trace run id — the agent name. */
	name: string;
	mtimeSec: number;
	events: TraceEvent[];
}

/**
 * The subagent runs of one Main run: the depth-2 session files under the Main file's session
 * dir (plan 20261024_0301 P5) — the runs Main spawned there, whose results Main's report cites.
 * Non-Main run ids have none.
 */
export function subagentTraces(root: string, mainRunId: string): RelatedTrace[] {
	if (!mainRunId.startsWith("MAIN ")) return [];
	const main = ompTraceRuns(root).find((r) => r.runId === mainRunId);
	if (!main) return [];
	return jsonlAt(dirname(main.file), 1).map((file) => {
		const name = runIdOf(file);
		let mtimeSec = 0;
		try {
			mtimeSec = statSync(file).mtimeMs / 1000;
		} catch {}
		return { name, mtimeSec, events: parseTraceFile(file, name) };
	});
}
