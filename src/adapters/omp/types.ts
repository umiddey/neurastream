// Shared omp extension host types and runtime-checked payload accessors.

import type { Decision } from "../../core/adapter.ts";

/** Subset of the harness extension host the adapter needs. */
export interface ExtensionHost {
	on(event: string, cb: (...args: unknown[]) => unknown): void;
	registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void;
	sendUserMessage(content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "nextTurn" }): void;
}

/** The parts of a harness call context the handlers look at. */
export interface HostCtx {
	hasAgent: boolean;
	kind?: string;
	id?: string;
	cwd?: string;
	setInterval?: (cb: () => void, ms: number) => unknown;
	spawnLimitProbe?: () => void;
}

/** The last assistant message of an omp event's `messages` array, as the adapter needs it: its
 *  joined text-block text and the shape that tells a real hand-back from a mid-run continuation
 *  (plan 20261025_0130). omp sends the reply in `session_stop.last_assistant_message` (falling
 *  back to the last assistant entry of `messages`) and in `agent_end.messages`; reading the
 *  session file instead lags a whole turn because session_stop fires BEFORE agent_end. */
export interface EventReply {
	text: string;
	stopReason: string | null;
	toolCalls: number;
	/** The provider's error text on a turn that ended on one (`429 … retry-after-ms=…`); null otherwise. */
	errorMessage: string | null;
	/** The provider and model fields of the assistant message, when the event carries them; the provider-out recording keys on the provider. */
	provider: string | null;
	model: string | null;
}

export interface RolloverCtx {
	sessionId: string;
	sessionFile: string;
	runningJobs(): string[];
	waitForIdle(): unknown;
	newSession(opts: { parentSession: string }): unknown;
	notify(message: string): void;
	draft(): string;
	shutdown(): void;
}

export function asRecord(v: unknown): Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

/** Call a method on a harness object by name; undefined when it is not a function. */
export function call(obj: Record<string, unknown>, key: string, args: unknown[] = []): unknown {
	const fn = obj[key];
	return typeof fn === "function" ? Reflect.apply(fn, obj, args) : undefined;
}

export function lastAssistantIn(messages: unknown): EventReply | null {
	const arr = Array.isArray(messages) ? messages : [];
	for (let i = arr.length - 1; i >= 0; i--) {
		const m = asRecord(arr[i]);
		if (m.role !== "assistant") continue;
		const content = Array.isArray(m.content) ? m.content : [];
		const text = content
			.filter(c => asRecord(c).type === "text")
			.map(c => asString(asRecord(c).text))
			.join("\n")
			.trim();
		return {
			text,
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			toolCalls: content.filter(c => asRecord(c).type === "toolCall").length,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
			provider: typeof m.provider === "string" ? m.provider : null,
			model: typeof m.model === "string" ? m.model : null,
		};
	}
	return null;
}

export function asCtx(v: unknown): HostCtx {
	const r = asRecord(v);
	// The agent envelope only ever carries kind/id strings (original extensions read just those);
	// cast fixes the envelope, every field below is checked before use.
	const agent = r.agent as { kind?: unknown; id?: unknown } | null | undefined;
	const out: HostCtx = { hasAgent: agent !== null && agent !== undefined };
	if (agent) {
		if (typeof agent.kind === "string") out.kind = agent.kind;
		if (typeof agent.id === "string") out.id = agent.id;
	}
	if (typeof r.cwd === "string") out.cwd = r.cwd;
	// Harness-injected timer with the original main-guard signature (ctx.setInterval).
	const interval = r.setInterval as ((cb: () => void, ms: number) => unknown) | undefined;
	if (typeof interval === "function") out.setInterval = interval;
	// Harness-injected probe spawner (tests); the default starts the niced probe child.
	const probe = r.spawnLimitProbe as (() => void) | undefined;
	if (typeof probe === "function") out.spawnLimitProbe = probe;
	return out;
}

export function asRolloverCtx(v: unknown): RolloverCtx | null {
	const r = asRecord(v);
	const sm = asRecord(r.sessionManager);
	const sessionId = call(sm, "getSessionId");
	const sessionFile = call(sm, "getSessionFile");
	if (typeof sessionId !== "string" || typeof sessionFile !== "string") return null;
	return {
		sessionId,
		sessionFile,
		runningJobs: () => {
			const running = asRecord(call(r, "getAsyncJobSnapshot")).running;
			return Array.isArray(running) ? running.map(j => asString(asRecord(j).label, "job")) : [];
		},
		waitForIdle: () => call(r, "waitForIdle"),
		newSession: opts => call(r, "newSession", [opts]),
		notify: message => call(asRecord(r.ui), "notify", [message]),
		draft: () => {
			const text = call(asRecord(r.ui), "getEditorText");
			return typeof text === "string" ? text : "";
		},
		shutdown: () => {
			call(r, "shutdown");
		},
	};
}

export function isMain(ctx: unknown): boolean {
	const c = asCtx(ctx);
	return !c.hasAgent || c.kind === "main";
}

/** Map a core decision onto the extension return shapes. */
export function toExtensionResult(d: Decision): Record<string, unknown> {
	if (!d.allow) return { block: true, reason: d.reason, decision: "block" };
	if (d.inject) return { additionalContext: d.inject };
	return {};
}
