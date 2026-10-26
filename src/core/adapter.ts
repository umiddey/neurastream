// Guard decisions and run data. No harness names. See docs/adapter.md.

import type { mainStartText } from "./main-start.ts";

export type RunStatus = "running" | "waiting" | "done" | "died";

export interface RunMessage {
	role: string;
	cost: number;
	text: string;
}

export interface Run {
	id: string;
	kind: "main" | "sub";
	model: string;
	calls: number;
	tokens: number;
	cacheRead: number;
	cost: number;
	inputTokens: number;
	/** The run's prefill tokens: the sum of input + cacheRead + cacheWrite over its assistant
	 *  usage — the prompt side of `tokens`, and the ledger's tok/call numerator. */
	prefillTokens: number;
	status: RunStatus;
	statusDetail: string;
	startedAt: number | null;
	lastWriteAt: number;
	endedAt: number | null;
	messages: RunMessage[];
	scoreModel: string;
	scoreCost: number;
	scoreHours: number;
	scoreRunning: boolean;
	scoreSurvived: boolean;
	scoreEnd: string;
}

export interface MainSession {
	file: string;
	calls: { inputPlusCache: number }[];
	lastUser: { at: string; text: string } | null;
}

export interface RunSource {
	listRuns(since: number): Run[];
	mainSession(file?: string): MainSession | null;
}

// Trace events: the raw activity of one run, used for claimed-vs-done checks and cross-run
// questions. Harness-specific parsing lives in the adapters; core only defines the shape.

export interface TraceUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type TraceEventKind = "toolCall" | "toolResult" | "usage" | "modelChange" | "assistantText";

export interface TraceEvent {
	kind: TraceEventKind;
	/** Unix seconds; null when the source line carries no readable timestamp. */
	ts: number | null;
	runId: string;
	tool?: string;
	args?: Record<string, unknown>;
	/** Harness call id: the toolCall part id on a call, the toolCallId on its result; pairs them. */
	callId?: string;
	isError?: boolean;
	text?: string;
	model?: string;
	provider?: string;
	/** Adapter-provided API identifier for the message carrying this event. */
	api?: string;
	usage?: TraceUsage;
	/** Provider response id of the assistant message; absent when the line carries none. */
	responseId?: string;
	/** modelChange only: the run resolved the requested model to a fallback. */
	fallback?: boolean;
}

export interface TraceSource {
	events(runId: string): TraceEvent[];
}

export interface Decision {
	allow: boolean;
	reason: string;
	inject?: string;
	restore?: { path: string; text: string | null }; // null: the file did not exist before; delete it
	/** Next keep-working counters for the caller to feed back into later StopEvents. */
	state?: { callsSinceStop: number; idleStops: number };
}

export interface ToolEvent {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	agent: "main" | "sub";
	agentId: string;
	calls: number;
	paths: string[];
	writes: string[];
	command: string;
	/** Labels of the harness's own running background jobs at call time; undefined when the caller has no job info (CLI without it). */
	runningJobs?: string[];
}

export interface SpawnEvent {
	agent: string;
	invocationKind: string;
	brief: string;
	/** Labels of the harness's own running background jobs; undefined when the caller has no job info. */
	runningJobs?: string[];
}

export interface InjectEvent {
	inject: string;
	agent: "main" | "sub";
}

export interface PlanEditEvent {
	path: string;
	before: string;
	after: string;
	agent: "main" | "sub";
}

export interface StopEvent {
	agent: "main" | "sub";
	callsSinceStop: number;
	idleStops: number;
	ledgerText: string;
}

export const GUARD_EVENTS = ["pre-tool", "inject", "spawn", "plan-edit", "stop"] as const;
export type GuardEvent = (typeof GUARD_EVENTS)[number];

// Shapes the registry (src/adapters/index.ts) and the CLI share. No harness names — only
// src/adapters may name one.

/** Every run id with a trace under a sessions root, each mapped to its newest file. */
export interface TraceRun {
	runId: string;
	file: string;
	mtimeSec: number;
}

/** One failed-request dump file: its path plus the epoch-ms stamp in its name. */
export interface DumpRef {
	file: string;
	ms: number;
}

/** One subagent run's trace under one main run's session dir. */
export interface RelatedTrace {
	/** The subagent run's trace run id — the agent name. */
	name: string;
	mtimeSec: number;
	events: TraceEvent[];
}

/** One finished subagent task-result announced in the newest main session file. */
export interface TaskResult {
	agent: string;
	ts: number;
}

/** Options for launching the harness binary; tests inject another path and a failing generator. */
export interface LaunchOptions {
	harness?: string;
	/** The main-start text generator for the handoff (default: src/core/main-start.ts). Tests inject a failing one. */
	mainStart?: typeof mainStartText;
}
