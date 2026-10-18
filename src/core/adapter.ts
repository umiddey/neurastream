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
}

export interface MainSession {
	file: string;
	calls: { inputPlusCache: number }[];
	lastUser: { at: string; text: string } | null;
}

export interface RunSource {
	listRuns(since: number): Run[];
	mainSession(): MainSession | null;
}

export interface Decision {
	allow: boolean;
	reason: string;
	inject?: string;
	restore?: { path: string; text: string };
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
}

export interface SpawnEvent {
	agent: string;
	invocationKind: string;
	brief: string;
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
