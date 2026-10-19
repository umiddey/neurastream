// herdr pane reporter for the omp harness, ported from the original herdr-omp-agent-state.ts
// (integration id omp, version 10). Reports pane agent state over the herdr socket when
// HERDR_ENV=1; a nested session (OMPCODE=1) must not report. Not a core rule: core never
// imports this file, and reinstalling herdr overwrites its installed copy.
//
// Identical to the original: env names and values, socket methods and params, the state machine
// (working / blocked / idle), idle debounce 250 ms and retry grace 2500 ms (both overridable for
// tests), the retryable provider error pattern, and every subscribed event. Harness payloads are
// untyped at the boundary: every field read goes through a runtime check.

import net from "node:net";
import path from "node:path";

// installed by herdr; reinstalling or updating the integration overwrites this file.
// HERDR_INTEGRATION_ID=omp
// HERDR_INTEGRATION_VERSION=10

type Timer = NodeJS.Timeout;

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
	process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:omp";
// OMP marks every shell it spawns with OMPCODE=1. A nested `omp` launched from a parent
// session's shell inherits it, so that process is not the pane's root agent and must not report
// its short-lived session over the parent's.
const nestedOmpSession = process.env.OMPCODE === "1";

function enabled(): boolean {
	return HERDR_ENV === "1" && !!socketPath && !!paneId && !nestedOmpSession;
}

let requestQueue: Promise<void> = Promise.resolve();

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
	if (!enabled() || !socketEndpoint) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let done = false;
	let timeout: Timer | undefined;
	const finish = (delivered: boolean) => {
		if (done) return;
		done = true;
		clearTimeout(timeout);
		socket.destroy();
		resolve(delivered);
	};
	const socket = net.createConnection(socketEndpoint);
	socket.on("error", () => finish(false));
	socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", () => finish(true));
	socket.on("end", () => finish(false));
	timeout = setTimeout(() => finish(false), timeoutMs);
	timeout.unref?.();
	return promise;
}

async function sendRequestNow(request: unknown): Promise<void> {
	if (await sendRequestAttempt(request, 500)) return;
	await sendRequestAttempt(request, 1500);
}

function sendRequest(request: unknown): Promise<void> {
	requestQueue = requestQueue.then(
		() => sendRequestNow(request),
		() => sendRequestNow(request),
	);
	return requestQueue;
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
	state: AgentState;
	message?: string;
	seq: number;
};

const idleDebounceMs = parseDurationEnv("HERDR_OMP_IDLE_DEBOUNCE_MS", 250);
const retryGraceMs = parseDurationEnv("HERDR_OMP_RETRY_GRACE_MS", 2500);
const retryableErrorPattern =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
	reportSeq += 1;
	return reportSeq;
}

export function isAbsoluteSessionPath(file: unknown): file is string {
	return typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file));
}

// Dynamic field read off a harness payload: the envelope cast only enables the dynamic index,
// every caller checks the returned value before use.
function field(obj: unknown, key: string): unknown {
	if (!obj || typeof obj !== "object" || !(key in obj)) return undefined;
	return (obj as Record<string, unknown>)[key];
}

function stringField(obj: unknown, key: string): string | undefined {
	const value = field(obj, key);
	return typeof value === "string" ? value : undefined;
}

function boolField(obj: unknown, key: string): boolean | undefined {
	const value = field(obj, key);
	return typeof value === "boolean" ? value : undefined;
}

function arrayField(obj: unknown, key: string): unknown[] {
	const value = field(obj, key);
	return Array.isArray(value) ? value : [];
}

// ctx.sessionManager exposes zero-arg getters (original: ctx?.sessionManager?.getFile?.()).
function managerCall(ctx: unknown, method: "getSessionFile" | "getSessionId"): unknown {
	const manager = field(ctx, "sessionManager");
	if (!manager || typeof manager !== "object") return undefined;
	const get = field(manager, method);
	if (typeof get !== "function") return undefined;
	const call = get as () => unknown;
	return call();
}

function updateSessionRef(ctx: unknown): void {
	try {
		const file = managerCall(ctx, "getSessionFile");
		currentAgentSessionPath = isAbsoluteSessionPath(file) ? file : undefined;
	} catch {
		currentAgentSessionPath = undefined;
	}
	try {
		const id = managerCall(ctx, "getSessionId");
		currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		currentAgentSessionId = undefined;
	}
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
	if (currentAgentSessionPath) return { ...params, agent_session_path: currentAgentSessionPath };
	if (currentAgentSessionId) return { ...params, agent_session_id: currentAgentSessionId };
	return params;
}

function parseDurationEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function currentSessionRef(): Record<string, unknown> | undefined {
	if (currentAgentSessionPath) return { agent_session_path: currentAgentSessionPath };
	if (currentAgentSessionId) return { agent_session_id: currentAgentSessionId };
	return undefined;
}

function reportSession(sessionStartSource = "startup"): Promise<void> {
	const sessionRef = currentSessionRef();
	if (!sessionRef) return Promise.resolve();
	return sendRequest({
		id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
		method: "pane.report_agent_session",
		params: {
			pane_id: paneId,
			source,
			agent: "omp",
			seq: nextReportSeq(),
			session_start_source: sessionStartSource,
			...sessionRef,
		},
	});
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
	return sendRequest({
		id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
		method: "pane.report_agent",
		params: withSessionRef({
			pane_id: paneId,
			source,
			agent: "omp",
			state,
			message,
			seq,
		}),
	});
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
	queuedState = { state, message, seq: nextReportSeq() };
	if (!sendInFlight) void drainStateQueue();
}

async function drainStateQueue(): Promise<void> {
	if (sendInFlight) return;
	sendInFlight = true;
	try {
		while (queuedState) {
			const next = queuedState;
			queuedState = undefined;
			await sendState(next.state, next.message, next.seq);
		}
	} finally {
		sendInFlight = false;
		if (queuedState) void drainStateQueue();
	}
}

function lastAssistantMessage(messages: unknown[]): unknown {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message && typeof message === "object" && stringField(message, "role") === "assistant") return message;
	}
	return undefined;
}

function retryableErrorMessage(event: unknown): string | undefined {
	const assistant = lastAssistantMessage(arrayField(event, "messages"));
	if (!assistant || stringField(assistant, "stopReason") !== "error") return undefined;
	const errorMessage = stringField(assistant, "errorMessage") ?? "";
	if (!retryableErrorPattern.test(errorMessage)) return undefined;
	return errorMessage || "retryable provider error";
}

function askBlockedMessage(args: unknown): string {
	for (const question of arrayField(args, "questions")) {
		const text = stringField(question, "question");
		if (text) return text;
	}
	return "waiting for user input";
}

function ctxHasUI(ctx: unknown): boolean {
	return boolField(ctx, "hasUI") === true;
}

function ctxNotIdle(ctx: unknown): boolean {
	const isIdle = field(ctx, "isIdle");
	if (typeof isIdle !== "function") return false;
	const call = isIdle as () => unknown;
	return call() === false;
}

/** What the adapter needs from the harness extension host (the original's `pi`). */
export interface HerdrHost {
	on(event: string, cb: (event: unknown, ctx: unknown) => unknown): void;
	events?: { on(event: string, cb: (data: unknown) => void): void };
}

export default function herdrAgentState(pi: HerdrHost): void {
	if (!enabled()) return;

	let agentActive = false;
	let retryHoldActive = false;
	let failureBlocked = false;
	let failureMessage: string | undefined;
	let blockedCount = 0;
	let blockedMessage: string | undefined;
	let lastState: AgentState | undefined;
	let lastMessage: string | undefined;
	let idleTimer: Timer | undefined;
	let retryTimer: Timer | undefined;
	let rootSession = false;

	function clearPendingTimers(): void {
		clearTimeout(idleTimer);
		clearTimeout(retryTimer);
		idleTimer = undefined;
		retryTimer = undefined;
	}

	function clearFailureState(): void {
		retryHoldActive = false;
		failureBlocked = false;
		failureMessage = undefined;
	}

	function desiredState(): { state: AgentState; message: string | undefined } {
		if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
		if (failureBlocked) return { state: "blocked", message: failureMessage };
		if (agentActive || retryHoldActive) return { state: "working", message: undefined };
		return { state: "idle", message: undefined };
	}

	function publishState(force = false): void {
		const next = desiredState();
		if (!force && next.state === lastState && next.message === lastMessage) return;
		lastState = next.state;
		lastMessage = next.message;
		queueState(next.state, next.message);
	}

	function scheduleIdle(): void {
		clearPendingTimers();
		clearFailureState();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			publishState();
		}, idleDebounceMs);
		idleTimer.unref?.();
	}

	function holdForRetry(message: string): void {
		clearPendingTimers();
		retryHoldActive = true;
		failureBlocked = false;
		failureMessage = message;
		publishState();
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retryHoldActive = false;
			failureBlocked = true;
			publishState();
		}, retryGraceMs);
		retryTimer.unref?.();
	}

	function activateRootSession(ctx: unknown, sessionStartSource = "startup"): boolean {
		if (!ctxHasUI(ctx)) return false;
		rootSession = true;
		updateSessionRef(ctx);
		void reportSession(sessionStartSource);
		return true;
	}

	function resetSessionState(): void {
		clearPendingTimers();
		clearFailureState();
		agentActive = false;
		blockedCount = 0;
		blockedMessage = undefined;
	}

	function activateBlocked(message: string | undefined): void {
		clearPendingTimers();
		blockedCount += 1;
		blockedMessage = message;
		publishState();
	}

	function deactivateBlocked(): void {
		blockedCount = Math.max(0, blockedCount - 1);
		if (blockedCount === 0) blockedMessage = undefined;
		publishState();
	}

	pi.events?.on("herdr:blocked", (data: unknown) => {
		if (!rootSession) return;
		if (boolField(data, "active") === false) {
			deactivateBlocked();
			return;
		}
		activateBlocked(stringField(data, "label"));
	});

	pi.on("session_start", (_event: unknown, ctx: unknown) => {
		if (!activateRootSession(ctx)) return;
		// A reload can replace this extension mid-run without emitting another agent_start.
		agentActive = ctxNotIdle(ctx);
		publishState(true);
	});

	pi.on("session_switch", (event: unknown, ctx: unknown) => {
		if (!activateRootSession(ctx, stringField(event, "reason") || "resume")) return;
		resetSessionState();
		publishState(true);
	});

	pi.on("agent_start", (_event: unknown, ctx: unknown) => {
		if (!rootSession && !activateRootSession(ctx)) return;
		updateSessionRef(ctx);
		void reportSession();
		clearPendingTimers();
		clearFailureState();
		agentActive = true;
		publishState();
	});

	pi.on("tool_approval_requested", (event: unknown, ctx: unknown) => {
		if (!rootSession && !activateRootSession(ctx)) return;
		const label = stringField(event, "reason") || `${stringField(event, "toolName") || "Tool"} approval`;
		activateBlocked(label);
	});

	pi.on("tool_approval_resolved", (_event: unknown, ctx: unknown) => {
		if (!rootSession && !activateRootSession(ctx)) return;
		deactivateBlocked();
	});

	pi.on("tool_execution_start", (event: unknown, ctx: unknown) => {
		if (stringField(event, "toolName") !== "ask") return;
		if (!rootSession && !activateRootSession(ctx)) return;
		activateBlocked(askBlockedMessage(field(event, "args")));
	});

	pi.on("tool_execution_end", (event: unknown, ctx: unknown) => {
		if (stringField(event, "toolName") !== "ask") return;
		if (!rootSession && !activateRootSession(ctx)) return;
		deactivateBlocked();
	});

	pi.on("agent_end", (event: unknown) => {
		if (!rootSession) return;
		if (!agentActive) {
			// OMP can emit duplicate/late end events while auto-retry is already holding the pane
			// in Working. Do not let an unqualified duplicate end cancel the retry hold and
			// publish a false Idle.
			return;
		}
		if (boolField(event, "willContinue") === true) {
			// A continuation is already scheduled, so this end is not a settle. Older builds omit
			// the field and fall through as before.
			return;
		}

		agentActive = false;

		const retryableMessage = retryableErrorMessage(event);
		if (retryableMessage) {
			holdForRetry(retryableMessage);
			return;
		}

		scheduleIdle();
	});

	pi.on("session_shutdown", () => {
		if (rootSession) clearPendingTimers();
	});
}
