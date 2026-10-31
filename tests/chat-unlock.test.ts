// Chat unlock: the owner types "unlock", "unlock N" or "lock" as a whole message — in the
// local terminal (input event, source "interactive") or through a collab guest prompt from a
// write peer (a "collab-prompt" custom message that reaches the adapter on the context event).
// The core writes or removes the unlock file in-process; every other path (before_agent_start
// prompts, assistant messages, tool results, other custom types, non-interactive sources,
// subagent contexts, the config flag off) changes nothing.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { relaunchPath } from "../src/core/rollover.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { chatUnlock, unlockPath, unlocked } from "../src/core/queue/lib.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeHost {
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void;
	sent: string[];
	sendUserMessage(content: string): void;
	messages: Array<{ message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean; deliverAs: string } }>;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: string }): void;
	/** Every handler's non-undefined result, in registration order. */
	emit(event: string, payload: unknown, ctx: MainCtx): Promise<unknown[]>;
}

function fakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { description?: string; handler: (args: unknown, ctx: unknown) => unknown }>();
	const sent: string[] = [];
	const messages: FakeHost["messages"] = [];
	return {
		sent,
		messages,
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand(name, opts) {
			commands.set(name, opts);
		},
		sendUserMessage(content) {
			sent.push(content);
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		async emit(event, payload, ctx) {
			const out: unknown[] = [];
			for (const cb of handlers.get(event) ?? []) {
				const r = await cb(payload, ctx);
				if (r !== undefined) out.push(r);
			}
			return out;
		},
	};
}

interface MainCtx {
	agent: { kind: string; id: string };
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string };
	getAsyncJobSnapshot(): { running: unknown[]; recent: unknown[]; delivery: unknown };
	waitForIdle(): Promise<void>;
	newSession(opts?: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	shutdown(): void;
	ui: { notify(message: string): void; getEditorText(): string };
}

const TMP = mkdtempSync(join(tmpdir(), "chat-unlock-"));
// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); save and
// delete them before loadConfig so every path resolves under the sandbox home.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

const baseCfg: Config = loadConfig({ home: join(TMP, "home") });
const CFG: Config = {
	...baseCfg,
	paths: { ...baseCfg.paths, plan_guard_log: join(TMP, "plan-guard.log") },
	guards: { ...baseCfg.guards, chat_unlock: true },
};
const OFF: Config = { ...CFG, guards: { ...CFG.guards, chat_unlock: false } };
applyQueueEnv(CFG);

const UNLOCK = unlockPath();
const LOG = CFG.paths.plan_guard_log;
// Live installs have the agent dir (init creates it); the sandbox mirrors that.
mkdirSync(dirname(UNLOCK), { recursive: true });
const SESSION_FILE = join(TMP, "session.jsonl");
const SESSION_ID = `chat-unlock-test-${process.pid}-${Date.now()}`;
const NOTE = join(TMP, "handoff.md");
const BIG = "x".repeat(4096);

const notes: string[] = [];
let shutdowns = 0;

afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

function reset(): void {
	rmSync(UNLOCK, { force: true });
	rmSync(LOG, { force: true });
	rmSync(NOTE, { force: true });
	rmSync(relaunchPath(), { force: true });
	writeFileSync(SESSION_FILE, "");
	notes.length = 0;
	shutdowns = 0;
	delete process.env.NEURASTREAM_MAIN_LAUNCHER;
}

function logLines(): string {
	try {
		return readFileSync(LOG, "utf8");
	} catch {
		return "";
	}
}

function mtimeMs(): number {
	return statSync(UNLOCK).mtimeMs;
}

function mainCtx(over: Partial<MainCtx> = {}): MainCtx {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => SESSION_FILE },
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		shutdown: () => {
			shutdowns++;
		},
		ui: { notify: message => notes.push(message), getEditorText: () => "" },
		...over,
	};
}

function collabPrompt(
	text: string | Array<{ type: string; text: string }>,
	from = "Amiir",
	timestamp = Date.now(),
): Record<string, unknown> {
	return { role: "custom", customType: "collab-prompt", content: text, display: true, details: { from }, attribution: "user", timestamp };
}

/** Make the session over the rollover threshold and write a fresh handoff note (state: ready). */
async function armReady(host: FakeHost, ctx: MainCtx): Promise<void> {
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	writeFileSync(NOTE, "## Done\nnothing");
	const later = (Date.now() + 5_000) / 1000;
	utimesSync(NOTE, later, later);
}

// --- core: chatUnlock ---

test("unlock: fresh file, unlocked now, logged with the source", () => {
	reset();
	const r = chatUnlock("unlock", CFG, "interactive");
	expect(r.applied).toBe(true);
	expect(r.command).toBe("unlock");
	expect(r.minutes).toBe(CFG.guards.unlock_minutes);
	expect(existsSync(UNLOCK)).toBe(true);
	expect(unlocked()).toBe(true);
	expect(Date.now() - mtimeMs()).toBeLessThan(5_000);
	expect(logLines()).toContain(`UNLOCK chat source=interactive minutes=${CFG.guards.unlock_minutes}`);
});

test("unlock N: unlocked for exactly N minutes (mtime backdated)", () => {
	reset();
	const r = chatUnlock("unlock 10", CFG, "interactive");
	expect(r.applied).toBe(true);
	expect(r.minutes).toBe(10);
	expect(unlocked()).toBe(true);
	// Backdated by (unlock_minutes - 10) so the existing mtime window closes in exactly 10 min.
	const age = Date.now() - mtimeMs();
	const expected = (CFG.guards.unlock_minutes - 10) * 60_000;
	expect(Math.abs(age - expected)).toBeLessThan(5_000);
	// Ten minutes later the window is shut.
	const shifted = (mtimeMs() - 10.5 * 60_000) / 1000; // utimesSync takes seconds
	utimesSync(UNLOCK, shifted, shifted);
	expect(unlocked()).toBe(false);
});

test("unlock N above unlock_minutes clamps to unlock_minutes", () => {
	reset();
	const r = chatUnlock("unlock 999", CFG, "interactive");
	expect(r.applied).toBe(true);
	expect(r.minutes).toBe(CFG.guards.unlock_minutes);
	expect(Date.now() - mtimeMs()).toBeLessThan(5_000);
});

test("anything but the whole message changes nothing and logs nothing", () => {
	reset();
	for (const text of ["please unlock 30", "unlock abc", "unlock 0", "unlock -5", "", "unlock now", "lock the door", "unlock 30 extra"]) {
		const r = chatUnlock(text, CFG, "interactive");
		expect(r.applied).toBe(false);
	}
	expect(existsSync(UNLOCK)).toBe(false);
	expect(unlocked()).toBe(false);
	expect(logLines()).toBe("");
});

test("matching is trimmed and case-insensitive", () => {
	reset();
	expect(chatUnlock("  UNLOCK 15  ", CFG, "interactive").applied).toBe(true);
	expect(unlocked()).toBe(true);
	reset();
	expect(chatUnlock("Lock", CFG, "interactive").applied).toBe(true);
	expect(existsSync(UNLOCK)).toBe(false);
});

test("lock removes the file, also when it is already gone; every lock is logged", () => {
	reset();
	chatUnlock("unlock", CFG, "interactive");
	expect(chatUnlock("lock", CFG, "collab:Amiir").command).toBe("lock");
	expect(existsSync(UNLOCK)).toBe(false);
	expect(unlocked()).toBe(false);
	// Locking again (no file) stays a valid owner command and is logged. \b keeps "UNLOCK chat" lines out.
	expect(chatUnlock("lock", CFG, "interactive").applied).toBe(true);
	const lines = logLines().split("\n").filter(l => /\bLOCK chat/.test(l));
	expect(lines.length).toBe(2);
	expect(lines[0]).toContain("source=collab:Amiir");
});

test("guards.chat_unlock false: even a real command changes nothing", () => {
	reset();
	const r = chatUnlock("unlock 30", OFF, "interactive");
	expect(r.applied).toBe(false);
	expect(existsSync(UNLOCK)).toBe(false);
	expect(unlocked()).toBe(false);
	expect(logLines()).toBe("");
});

// --- adapter: input event (local terminal) ---

test("input interactive unlock 30: handled, unlocked, owner notified", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	const results = await host.emit("input", { text: "unlock 30", source: "interactive" }, ctx);
	expect(results).toEqual([{ handled: true }]);
	expect(unlocked()).toBe(true);
	expect(notes.length).toBe(1);
});

test("input with the config off, a machine source, or a subagent context is not handled", async () => {
	reset();
	const offHost = fakeHost();
	createOmpAdapter(offHost, OFF);
	const main = mainCtx();
	expect(await offHost.emit("input", { text: "unlock 30", source: "interactive" }, main)).toEqual([]);
	expect(unlocked()).toBe(false);

	const host = fakeHost();
	createOmpAdapter(host, CFG);
	for (const source of ["rpc", "extension", ""]) {
		expect(await host.emit("input", { text: "unlock 30", source }, mainCtx())).toEqual([]);
	}
	expect(await host.emit("input", { text: "unlock 30", source: "interactive" }, mainCtx({ agent: { kind: "sub", id: "s1" } }))).toEqual([]);
	expect(await host.emit("input", { text: "please unlock 30", source: "interactive" }, mainCtx())).toEqual([]);
	expect(unlocked()).toBe(false);
	expect(logLines()).toBe("");
});

test("unlock works while a rollover is ready: the rollover input handler never sees the message", async () => {
	reset();
	process.env.NEURASTREAM_MAIN_LAUNCHER = "1";
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	await armReady(host, ctx);
	const results = await host.emit("input", { text: "unlock 30", source: "interactive" }, ctx);
	expect(results).toEqual([{ handled: true }]);
	expect(unlocked()).toBe(true);
	expect(shutdowns).toBe(0);
	expect(existsSync(relaunchPath())).toBe(false);
});

test("unlock works in plain omp with a rollover ready: no /main-rollover rewrite", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	await armReady(host, ctx);
	const results = await host.emit("input", { text: "unlock 30", source: "interactive" }, ctx);
	expect(results).toEqual([{ handled: true }]);
	expect(unlocked()).toBe(true);
});

// --- adapter: collab guest prompts on the context event ---

test("collab prompt from a write peer unlocks, logged with the peer name", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	await host.emit("context", { messages: [collabPrompt("unlock 30")] }, ctx);
	expect(unlocked()).toBe(true);
	expect(logLines()).toContain("UNLOCK chat source=collab:Amiir");
});

test("collab prompt with array content lock removes the file", async () => {
	reset();
	chatUnlock("unlock", CFG, "interactive");
	expect(unlocked()).toBe(true);
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	await host.emit("context", { messages: [collabPrompt([{ type: "text", text: "lock" }])] }, ctx);
	expect(unlocked()).toBe(false);
	expect(existsSync(UNLOCK)).toBe(false);
});

test("assistant messages, tool results, other custom types and non-user attribution never unlock", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "unlock 30" }] },
		{ role: "toolResult", toolCallId: "t1", content: "unlock 30" },
		{ role: "custom", customType: "todo-error-reminder", content: "unlock 30", details: {}, attribution: "agent", timestamp: Date.now() },
		{ ...collabPrompt("unlock 30"), attribution: "agent" },
		{ ...collabPrompt("unlock 30"), details: {} },
	];
	await host.emit("context", { messages }, ctx);
	expect(unlocked()).toBe(false);
	expect(logLines()).toBe("");
});

test("a collab prompt is acted on once: replays in later context fires do not refresh the unlock", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	const ctx = mainCtx();
	const message = collabPrompt("unlock 30");
	await host.emit("context", { messages: [message] }, ctx);
	const m1 = mtimeMs();
	await host.emit("context", { messages: [message] }, ctx);
	expect(mtimeMs()).toBe(m1);
	expect(logLines().split("\n").filter(l => l.includes("UNLOCK chat")).length).toBe(1);
});

test("an old collab prompt replayed from a resumed session does not unlock", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	await host.emit("context", { messages: [collabPrompt("unlock 30", "Amiir", Date.now() - 30 * 60_000)] }, mainCtx());
	expect(unlocked()).toBe(false);
	expect(logLines()).toBe("");
});

// --- machine prompt paths stay shut ---

test("before_agent_start carrying the words never unlocks", async () => {
	reset();
	const host = fakeHost();
	createOmpAdapter(host, CFG);
	await host.emit("before_agent_start", { prompt: "unlock 30" }, mainCtx());
	expect(unlocked()).toBe(false);
	expect(existsSync(UNLOCK)).toBe(false);
});
