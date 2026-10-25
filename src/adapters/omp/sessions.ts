import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../../core/config.ts";
import type { MainSession, Run, RunMessage, RunSource, RunStatus } from "../../core/adapter.ts";
import { nowSec } from "../../core/clock.ts";
import { readBudgets } from "../../core/guards.ts";
import { pyDumps } from "../../core/pyjson.ts";

function walk(dir: string, depth: number, out: string[]): void {
	if (depth < 0 || !existsSync(dir)) return;
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		let st;
		try {
			st = statSync(path);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(path, depth - 1, out);
		else if (depth === 0 && name.endsWith(".jsonl")) out.push(path);
	}
}

export function jsonlAt(root: string, levels: number): string[] {
	const out: string[] = [];
	walk(root, levels, out);
	return out;
}

export function parseTs(ts: string): number | null {
	const s = ts.slice(0, 19);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;
	const [date, time] = s.split("T") as [string, string];
	const [Y, M, D] = date.split("-").map(Number);
	const [h, m, sec] = time.split(":").map(Number);
	const suffix = ts.slice(19);
	const zone = suffix.replace(/^\.\d+/, "");
	if (zone === "Z" || /^[+-]\d{2}:\d{2}$/.test(zone)) {
		const utc = Date.UTC(Y!, M! - 1, D, h, m, sec);
		const offset = zone === "Z" ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone[0] === "+" ? 1 : -1);
		return (utc - offset * 60_000) / 1000;
	}
	if (zone !== "") return null;
	const local = new Date(Y!, M! - 1, D, h, m, sec);
	if (Number.isNaN(local.getTime())) return null;
	return local.getTime() / 1000;
}

export function asObj(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function costOf(m: Record<string, unknown>): number {
	const u = asObj(m.usage);
	const c = u ? asObj(u.cost) : null;
	return c && typeof c.total === "number" ? c.total : 0;
}

/** Ledger run id for a session file: `MAIN <HH-MM-SS>` for dated main files, stem otherwise. */
export function runIdOf(file: string): string {
	const stem = basename(file).slice(0, -6);
	return /^\d{4}/.test(stem) ? `MAIN ${stem.slice(11, 19)}` : stem;
}

function build(file: string, cfg: Config, mtime: number): Run | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const stem = basename(file).slice(0, -6);
	const isMain = /^\d{4}/.test(stem);
	const id = runIdOf(file);
	let model = "?";
	let scoreModel = "?";
	let calls = 0;
	let tokens = 0;
	let cache = 0;
	let cost = 0;
	let scoreCost = 0;
	let err = "";
	let scoreErr = "";
	let exited = false;
	let yielded = false;
	let waiting = "";
	let final = false;
	let first: number | null = null;
	let last: number | null = null;
	let inputTokens = 0;
	const messages: RunMessage[] = [];

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let d: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line) as unknown;
			const obj = asObj(parsed);
			if (!obj) continue;
			d = obj;
		} catch {
			continue;
		}
		const ts = d.timestamp;
		if (typeof ts === "string") {
			const t = parseTs(ts);
			if (t !== null) {
				first = first ?? t;
				last = t;
			}
		}
		if (d.customType === "session_exit") exited = true;
		if (d.customType === "tool_execution_start") {
			const data = asObj(d.data) ?? {};
			waiting = data.toolName === "wait" ? `WAITING: ${String(data.intent ?? "").slice(0, 40)}` : "";
		}
		const m = asObj(d.message) ?? d;
		if (m.role === "assistant") {
			exited = false;
			yielded = false;
			const content = Array.isArray(m.content) ? m.content : [];
			const texts = content
				.filter((c): c is Record<string, unknown> => asObj(c) !== null && asObj(c)?.type === "text")
				.map(c => String(c.text ?? ""));
			final = (m.stopReason === "stop" || m.stopReason === "end_turn") && texts.some(t => t.trim());
		}
		if (m.role === "toolResult") waiting = "";
		if (m.role === "toolResult" && m.toolName === "yield" && !m.isError) yielded = true;
		if (m.model && m.provider) {
			model = `${m.provider}/${m.model}`;
			scoreModel = model;
		} else if (typeof m.model === "string" && m.model.includes("/")) {
			model = m.model;
		}
		const u = asObj(m.usage);
		const lineCost = costOf(m);
		scoreCost += lineCost;
		if (u && "totalTokens" in u) {
			calls += 1;
			tokens += typeof u.totalTokens === "number" ? u.totalTokens : 0;
			cache += typeof u.cacheRead === "number" ? u.cacheRead : 0;
			const c = asObj(u.cost);
			cost += c && typeof c.total === "number" ? c.total : 0;
		}
		if (m.role === "assistant" && u) {
			const input = typeof u.input === "number" ? u.input : 0;
			const cr = typeof u.cacheRead === "number" ? u.cacheRead : 0;
			const cw = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
			inputTokens = input + cr + cw;
		}
		if (typeof m.errorMessage === "string") {
			const head = m.errorMessage.split("\n")[0] ?? "";
			err = head.slice(0, 90);
			scoreErr = head.slice(0, 80);
		} else if (m.role === "assistant" && (m.stopReason === "stop" || m.stopReason === "end_turn" || m.stopReason === "toolUse")) {
			err = "";
			scoreErr = "";
		}
		if (isMain) {
			messages.push({
				role: typeof m.role === "string" ? m.role : "",
				cost: lineCost,
				text: pyDumps(m.content ?? "").slice(0, 20000),
			});
		}
	}

	const done = yielded || final;
	let state: string;
	if (!id.startsWith("MAIN") && (yielded || final)) state = "done";
	else if (!exited && !err) {
		const idle = Math.floor((nowSec() - mtime) / 60);
		state = (waiting || "RUNNING") + (idle >= cfg.ledger.idle_show_min ? ` (idle ${idle}m)` : "");
	} else if (id.startsWith("MAIN")) state = "done";
	else state = `DIED: ${err || "exited without a result"}`;
	if ((state.startsWith("RUNNING") || state.startsWith("WAITING")) && !id.startsWith("MAIN")) {
		const cap = readBudgets(cfg.paths.queue_state)[id] ?? cfg.guards.sub_max_calls;
		if (calls > cap) state += ` OVER-BUDGET(${calls}>${cap} calls)`;
	}
	let status: RunStatus = "done";
	if (state.startsWith("WAITING")) status = "waiting";
	else if (state.startsWith("RUNNING")) status = "running";
	else if (state.startsWith("DIED")) status = "died";

	const run: Run = {
		id,
		kind: isMain ? "main" : "sub",
		model,
		calls,
		tokens,
		cacheRead: cache,
		cost,
		inputTokens,
		status,
		statusDetail: state,
		startedAt: first,
		lastWriteAt: mtime,
		endedAt: last,
		messages: isMain ? messages : [],
		scoreModel,
		scoreCost,
		scoreHours: ((last ?? 0) - (first ?? 0)) / 3600,
		scoreRunning: !exited && !scoreErr && !done,
		scoreSurvived: done && !scoreErr,
		scoreEnd: scoreErr || (done ? "done" : "no final message"),
	};
	return run;
}

function readMain(file: string): MainSession {
	const calls: { inputPlusCache: number }[] = [];
	let lastUser: { at: string; text: string } | null = null;
	const text = readFileSync(file, "utf8");
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let d: Record<string, unknown>;
		try {
			const obj = asObj(JSON.parse(line) as unknown);
			if (!obj) continue;
			d = obj;
		} catch {
			continue;
		}
		const m = asObj(d.message);
		if (!m) continue;
		const u = asObj(m.usage);
		if (m.role === "assistant" && u) {
			const input = typeof u.input === "number" ? u.input : 0;
			const cr = typeof u.cacheRead === "number" ? u.cacheRead : 0;
			const cw = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
			calls.push({ inputPlusCache: input + cr + cw });
		}
		if (m.role === "user") {
			const c = m.content;
			const body = typeof c === "string"
				? c
				: (Array.isArray(c) ? c : [])
					.filter((p): p is Record<string, unknown> => asObj(p) !== null)
					.map(p => String(p.text ?? ""))
					.join(" ");
			if (body.trim() && !body.trimStart().startsWith("<")) {
				lastUser = {
					at: typeof d.timestamp === "string" ? d.timestamp : "?",
					text: body.trim().replaceAll("\n", " "),
				};
			}
		}
	}
	return { file, calls, lastUser };
}

export function ompRunSource(root: string, cfg: Config): RunSource {
	return {
		listRuns(since: number): Run[] {
			const files = [...jsonlAt(root, 1), ...jsonlAt(root, 2)];
			const runs: Run[] = [];
			for (const file of files) {
				let mtime: number;
				try {
					mtime = statSync(file).mtimeMs / 1000;
				} catch {
					continue;
				}
				if (mtime < since) continue;
				const run = build(file, cfg, mtime);
				if (run) runs.push(run);
			}
			return runs;
		},
		mainSession(file?: string): MainSession | null {
			if (file) {
				if (!existsSync(file)) return null;
				return readMain(file);
			}
			const files = jsonlAt(root, 1);
			if (files.length === 0) return null;
			let best = files[0]!;
			let bestMt = statSync(best).mtimeMs;
			for (const f of files.slice(1)) {
				const mt = statSync(f).mtimeMs;
				if (mt > bestMt) {
					best = f;
					bestMt = mt;
				}
			}
			return readMain(best);
		},
	};
}

export function defaultRunSource(cfg: Config): RunSource {
	const root = cfg.adapter?.sessions || join(cfg.paths.home, ".omp", "agent", "sessions");
	return ompRunSource(root, cfg);
}

/**
 * Completed subagent task-results announced in one Main session file. Two carriers:
 * `custom_message` lines of `customType` "async-result" whose content carries
 * `<task-result id="X" … status="completed">` (trimmed real case:
 * tests/fixtures/incidents/async-result-line.json), and `wait` toolResults — Main's `wait`
 * returns the finished jobs' `<task-result …>` blocks in its text (trimmed real case:
 * tests/fixtures/incidents/wait-toolresult-line.json; P3 fix B: results Main receives through
 * wait were invisible here, so D1 never saw them). A line without a readable timestamp is
 * skipped — without one the contradiction grace cannot be aged.
 */
export function completedResults(text: string): { agent: string; ts: number }[] {
	const out: { agent: string; ts: number }[] = [];
	for (const line of text.split("\n")) {
		const isAsync = line.includes('"async-result"');
		const isWait = line.includes('"toolName":"wait"');
		if (!isAsync && !isWait) continue;
		let d: Record<string, unknown> | null = null;
		try {
			d = asObj(JSON.parse(line) as unknown);
		} catch {
			d = null;
		}
		if (!d) continue;
		const ts = typeof d.timestamp === "string" ? parseTs(d.timestamp) : null;
		if (ts === null) continue;
		if (isAsync) {
			if (d.type !== "custom_message" || d.customType !== "async-result") continue;
			const content = typeof d.content === "string" ? d.content : "";
			const m = /<task-result\s+id="([^"]+)"[^>]*\bstatus="completed"/.exec(content);
			if (m) out.push({ agent: m[1]!, ts });
			continue;
		}
		const m = asObj(d.message);
		if (!m || m.role !== "toolResult" || m.toolName !== "wait") continue;
		const content = Array.isArray(m.content)
			? m.content.map((p) => asObj(p)?.text).filter((t): t is string => typeof t === "string").join("\n")
			: typeof m.content === "string"
				? m.content
				: "";
		for (const hit of content.matchAll(/<task-result\s+id="([^"]+)"[^>]*\bstatus="completed"/g)) {
			out.push({ agent: hit[1]!, ts });
		}
	}
	return out;
}

/** `completedResults` of the newest Main session file (the one `mainSession()` picks). */
export function defaultCompletedResults(cfg: Config): { agent: string; ts: number }[] {
	try {
		const s = defaultRunSource(cfg).mainSession();
		return s ? completedResults(readFileSync(s.file, "utf8")) : [];
	} catch {
		return [];
	}
}
