// Guard decisions and run data. No harness names. See docs/adapter.md.

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
	isError?: boolean;
	text?: string;
	model?: string;
	provider?: string;
	usage?: TraceUsage;
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
