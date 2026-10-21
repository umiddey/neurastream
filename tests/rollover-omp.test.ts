// Session rollover through the omp adapter, in-process with a fake extension host: the size check
// and the one-time note instruction, the input rewrite to /main-rollover, and the command's refusals
// and handoff. The session file is a temp file; the note is written under the queue state dir for
// a unique session id and removed afterwards.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { notePath } from "../src/core/rollover.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: MainCtx) => unknown;

interface FakeHost {
	commands: Map<string, CommandHandler>;
	sent: string[];
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { handler: CommandHandler }): void;
	sendUserMessage(content: string): void;
	/** Every handler's non-undefined result, in registration order. */
	emit(event: string, payload: unknown, ctx: MainCtx): Promise<unknown[]>;
}

function fakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const sent: string[] = [];
	return {
		commands,
		sent,
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand(name, opts) {
			commands.set(name, opts.handler);
		},
		sendUserMessage(content) {
			sent.push(content);
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

interface Job {
	label: string;
}

interface MainCtx {
	agent: { kind: string; id: string };
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string };
	getAsyncJobSnapshot(): { running: Job[]; recent: unknown[]; delivery: unknown };
	waitForIdle(): Promise<void>;
	newSession(opts?: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	ui: { notify(message: string): void };
}

interface RolloverMessage {
	content: string;
}

/** The rollover notices among the before_agent_start results; they ride in the Main queue message. */
function rolloverMessages(results: unknown[]): RolloverMessage[] {
	const out: RolloverMessage[] = [];
	for (const r of results) {
		if (!r || typeof r !== "object" || !("message" in r)) continue;
		const m = r.message;
		if (m && typeof m === "object" && "content" in m) {
			if (typeof m.content === "string" && m.content.includes("Session rollover:")) {
				out.push({ content: m.content });
			}
		}
	}
	return out;
}

const TMP = mkdtempSync(join(tmpdir(), "rollover-omp-"));
const SESSION_FILE = join(TMP, "session.jsonl");
const SESSION_ID = `rollover-test-${process.pid}-${Date.now()}`;
const NOTE = notePath(SESSION_ID);
const BIG = "x".repeat(4096);

const baseCfg: Config = loadConfig();
const overCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 0.000001 } };
const belowCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 1024 } };

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	rmSync(NOTE, { force: true });
});

const newSessions: Array<{ parentSession?: string } | undefined> = [];
const notes: string[] = [];

function mainCtx(over: Partial<MainCtx> = {}): MainCtx {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => SESSION_FILE },
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
		waitForIdle: async () => {},
		newSession: async opts => {
			newSessions.push(opts);
			return { cancelled: false };
		},
		ui: { notify: message => notes.push(message) },
		...over,
	};
}

/** Make the session over the threshold, let the size check see it, then write a fresh note. */
async function armReady(host: FakeHost, ctx: MainCtx, note: string): Promise<void> {
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	mkdirSync(dirname(NOTE), { recursive: true });
	writeFileSync(NOTE, note);
	const later = (Date.now() + 5_000) / 1000;
	utimesSync(NOTE, later, later);
}

function resetState(): void {
	newSessions.length = 0;
	notes.length = 0;
	rmSync(NOTE, { force: true });
	writeFileSync(SESSION_FILE, "");
}

test("below the threshold: no rollover instruction", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, belowCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	const results = await host.emit("before_agent_start", { prompt: "hi" }, ctx);
	expect(rolloverMessages(results)).toEqual([]);
});

test("over the threshold without a note: instruction names the note path, once", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	const first = rolloverMessages(await host.emit("before_agent_start", { prompt: "next" }, ctx));
	expect(first.length).toBe(1);
	expect(first[0]?.content).toContain(NOTE);
	expect(first[0]?.content).toContain("handoff note");
	const second = rolloverMessages(await host.emit("before_agent_start", { prompt: "again" }, ctx));
	expect(second).toEqual([]);
});

test("ready: an interactive plain message becomes /main-rollover <text>", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	const results = await host.emit("input", { text: "hello", source: "interactive" }, ctx);
	expect(results).toEqual([{ text: "/main-rollover hello" }]);
});

test("slash commands and non-interactive input are left alone", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	expect(await host.emit("input", { text: "/help", source: "interactive" }, ctx)).toEqual([]);
	expect(await host.emit("input", { text: "hello", source: "rpc" }, ctx)).toEqual([]);
});

test("running own job: the command refuses and does not start a session", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx({ getAsyncJobSnapshot: () => ({ running: [{ label: "sub-1" }], recent: [], delivery: {} }) });
	await armReady(host, ctx, "## In progress\nstep");
	const run = host.commands.get("main-rollover");
	expect(run).toBeDefined();
	await run?.("owner msg", ctx);
	expect(newSessions.length).toBe(0);
	expect(host.sent.length).toBe(0);
	expect(notes.some(n => n.includes("running"))).toBe(true);
});

test("no note: the command refuses", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	await host.commands.get("main-rollover")?.("owner msg", ctx);
	expect(newSessions.length).toBe(0);
	expect(host.sent.length).toBe(0);
	expect(notes.some(n => n.includes("note"))).toBe(true);
});

test("ready: new session with the session as parent; handoff carries note and owner message", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	await host.commands.get("main-rollover")?.("owner msg", ctx);
	expect(newSessions).toEqual([{ parentSession: SESSION_FILE }]);
	expect(host.sent.length).toBe(1);
	const handoff = host.sent[0] ?? "";
	expect(handoff).toContain("## Main's handoff note (verbatim)\n## In progress\nstep");
	expect(handoff.endsWith("Owner's message:\nowner msg")).toBe(true);
}, 60_000);
