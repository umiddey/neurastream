// Session rollover through the omp adapter, in-process with a fake extension host: the size check
// and the one-time note instruction, the input rewrite to /main-rollover, and the command's refusals
// and handoff. The session file is a temp file; the note is written under the queue state dir for
// a unique session id and removed afterwards.

import { afterAll, expect, test, vi } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter } from "../src/adapters/omp/index.ts";
import { blockersDirPath, indexPath, REPO_INDEX } from "../src/core/queue/lib.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { addIncident, incidentsFile } from "../src/core/incidents.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: MainCtx) => unknown;

interface FakeHost {
	commands: Map<string, CommandHandler>;
	sent: string[];
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { handler: CommandHandler }): void;
	sendUserMessage(content: string): void;
	messages: Array<{ message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean; deliverAs: string } }>;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: string }): void;
	/** Every handler's non-undefined result, in registration order. */
	emit(event: string, payload: unknown, ctx: MainCtx): Promise<unknown[]>;
}

function fakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const sent: string[] = [];
	const messages: FakeHost["messages"] = [];
	return {
		commands,
		sent,
		messages,
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand(name, opts) {
			commands.set(name, opts.handler);
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
	shutdown(): void;
	ui: { notify(message: string): void; getEditorText(): string };
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
// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); save and
// delete them before loadConfig so every path resolves under the sandbox home — including
// notePath(), which reads QUEUE_STATE. createOmpAdapter runs in-process here and applyQueueEnv
// writes QUEUE_* back into process.env; afterAll restores what the parent had.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
// A throwaway home: the real ~/.config/neurastream/config.yml points main-start at the live queue
// and every live repo, and the note would land in the live queue state dir.
const baseCfg: Config = loadConfig({ home: join(TMP, "home") });
applyQueueEnv(baseCfg);
const overCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 0.000001, exit_grace_s: 20 } };
const belowCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 1024, exit_grace_s: 20 } };
// session_stop reads guards.ledger_command. The live ledger may show a running subagent, which would let the
// stop through, so these tests pin a fixed ledger with no subagent rows.
const stopCfg: Config = {
	...overCfg,
	guards: { ...overCfg.guards, ledger_command: "printf 'MAIN x RUNNING\\n'" },
};
const SESSION_FILE = join(TMP, "session.jsonl");
const SESSION_ID = `rollover-test-${process.pid}-${Date.now()}`;
const NOTE = notePath(SESSION_ID);
const BIG = "x".repeat(4096);
let jobs: Job[] = [];
let draft = "";
let shutdowns = 0;

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	rmSync(NOTE, { force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

const newSessions: Array<{ parentSession?: string } | undefined> = [];
const notes: string[] = [];

function mainCtx(over: Partial<MainCtx> = {}): MainCtx {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => SESSION_FILE },
		getAsyncJobSnapshot: () => ({ running: jobs, recent: [], delivery: {} }),
		waitForIdle: async () => {},
		newSession: async opts => {
			newSessions.push(opts);
			return { cancelled: false };
		},
		shutdown: () => {
			shutdowns++;
		},
		ui: { notify: message => notes.push(message), getEditorText: () => draft },
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
	// Plain omp unless a test sets the launcher flag itself (withLauncher): the caller's shell may export it.
	delete process.env.NEURASTREAM_MAIN_LAUNCHER;
	notes.length = 0;
	rmSync(NOTE, { force: true });
	writeFileSync(SESSION_FILE, "");
	jobs = [];
	draft = "";
	shutdowns = 0;
	rmSync(relaunchPath(), { force: true });
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

test("over the threshold: the note request goes out at turn end, once per session file", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	expect(host.messages.length).toBe(1);
	const sent = host.messages[0];
	expect(sent?.message.customType).toBe("main-guard.rollover");
	expect(sent?.message.content).toContain(NOTE);
	expect(sent?.message.content).toContain("handoff note");
	expect(sent?.message.display).toBe(false);
	expect(sent?.options).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
	await host.emit("agent_end", {}, ctx);
	expect(host.messages.length).toBe(1);
	// The next prompt no longer carries the request: it went out at turn end.
	expect(rolloverMessages(await host.emit("before_agent_start", { prompt: "next" }, ctx))).toEqual([]);
});

/** A package.json copy the adapter watches through NEURASTREAM_PACKAGE_JSON; mutated in place. */
function versionedPackage(dir: string, version: string): string {
	mkdirSync(dir, { recursive: true });
	const pkg = join(dir, "package.json");
	writeFileSync(pkg, JSON.stringify({ name: "neurastream", version }));
	return pkg;
}

test("a stale install asks for the note even below the threshold, names both versions, and asks once", async () => {
	resetState();
	const pkgDir = join(TMP, "pkg-stale");
	const pkg = versionedPackage(pkgDir, "0.1.13");
	process.env.NEURASTREAM_PACKAGE_JSON = pkg;
	try {
		const host = fakeHost();
		createOmpAdapter(host, belowCfg);
		const ctx = mainCtx();
		writeFileSync(SESSION_FILE, "x"); // far below the threshold
		await host.emit("agent_end", {}, ctx);
		expect(host.messages.length).toBe(0);
		// The installed package moved on: the running plugin is now stale.
		versionedPackage(pkgDir, "0.2.0");
		await host.emit("agent_end", {}, ctx);
		expect(host.messages.length).toBe(1);
		expect(host.messages[0]?.message.content).toContain("neurastream on disk is 0.2.0, this session runs 0.1.13");
		await host.emit("agent_end", {}, ctx);
		expect(host.messages.length).toBe(1); // still no note: no second request
	} finally {
		delete process.env.NEURASTREAM_PACKAGE_JSON;
		rmSync(pkgDir, { recursive: true, force: true });
	}
});

test("a note that is no longer fresh gets exactly one new request, then none for the same note", async () => {
	resetState();
	jobs = [{ label: "sub-1" }];
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	expect(host.messages.length).toBe(1);
	// A note whose mtime lies in the past (expired, or predating the crossing) reads as need-note
	// again; the request key changes because the note now exists.
	mkdirSync(dirname(NOTE), { recursive: true });
	writeFileSync(NOTE, "## In progress\nstep");
	const old = (Date.now() - 2 * 60 * 60_000) / 1000;
	utimesSync(NOTE, old, old);
	await host.emit("agent_end", {}, ctx);
	expect(host.messages.length).toBe(2);
	expect(host.messages[1]?.message.content).toContain("handoff note");
	await host.emit("agent_end", {}, ctx);
	expect(host.messages.length).toBe(2); // never a loop for the same expired note
});

const TASK_CALL = { toolName: "task", input: { tasks: [{ agent: "glmfix", context: "do it", task: "work" }] } };

/** A sandbox subagents.md whose Allowed list contains the test agent; QUEUE_SUBAGENTS points at it. */
function sandboxAllowedAgents(): string {
	const file = join(TMP, "subagents-allowed.md");
	writeFileSync(file, "## Allowed\n\n- `glmfix`\n");
	return file;
}

test("rollover pending (need-note): a Main task spawn is refused and lands in guard_log", async () => {
	resetState();
	mkdirSync(dirname(baseCfg.paths.guard_log), { recursive: true });
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx); // no note yet: need-note
	const r = (await host.emit("tool_call", TASK_CALL, ctx)) as Array<{ block?: boolean; reason?: string }>;
	expect(r).toEqual([
		{ block: true, reason: "main-guard: rollover pending (need-note); no new subagents until the session rolls over. Running: ." },
	]);
	expect(readFileSync(baseCfg.paths.guard_log, "utf8")).toContain("BLOCK spawn glmfix: rollover pending");
});

test("rollover pending (wait-jobs): the refusal names the running jobs", async () => {
	resetState();
	jobs = [{ label: "sub-1" }];
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	const r = (await host.emit("tool_call", TASK_CALL, ctx)) as Array<{ block?: boolean; reason?: string }>;
	expect(r).toEqual([
		{ block: true, reason: "main-guard: rollover pending (wait-jobs); no new subagents until the session rolls over. Running: sub-1." },
	]);
});

test("below and ready: a Main task spawn passes the drain and reaches the plan gate", async () => {
	resetState();
	const subagents = sandboxAllowedAgents();
	const before = process.env.QUEUE_SUBAGENTS;
	try {
		const belowHost = fakeHost();
		createOmpAdapter(belowHost, belowCfg);
		// createOmpAdapter re-applies the config env, so the sandbox allow-list is set after it.
		process.env.QUEUE_SUBAGENTS = subagents;
		const ctx = mainCtx();
		writeFileSync(SESSION_FILE, "x"); // small, not stale: below
		const below = (await belowHost.emit("tool_call", TASK_CALL, ctx)) as Array<{ block?: boolean; reason?: string }>;
		expect(below[0]?.reason ?? "").toContain("an implementer needs an open plan");
		expect(below[0]?.reason ?? "").not.toContain("rollover pending");

		const readyHost = fakeHost();
		createOmpAdapter(readyHost, overCfg);
		process.env.QUEUE_SUBAGENTS = subagents;
		await armReady(readyHost, ctx, "## In progress\nstep"); // fresh note, no jobs: ready
		const ready = (await readyHost.emit("tool_call", TASK_CALL, ctx)) as Array<{ block?: boolean; reason?: string }>;
		// ready refuses too (e): the rollover follows the next idle, so a spawn now would be aborted.
		expect(ready[0]?.reason ?? "").toContain("rollover pending (ready)");
	} finally {
		if (before === undefined) delete process.env.QUEUE_SUBAGENTS;
		else process.env.QUEUE_SUBAGENTS = before;
		rmSync(subagents, { force: true });
	}
});

test("a subagent's task call is never drained", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx({ agent: { kind: "sub", id: "w1" } });
	writeFileSync(SESSION_FILE, BIG);
	await host.emit("agent_end", {}, ctx);
	const r = (await host.emit("tool_call", TASK_CALL, ctx)) as Array<{ block?: boolean; reason?: string }>;
	expect(r).toEqual([]); // no block, and no rollover-pending refusal
});

async function withLauncher(value: string | undefined, fn: () => Promise<void>): Promise<void> {
	const before = process.env.NEURASTREAM_MAIN_LAUNCHER;
	if (value === undefined) delete process.env.NEURASTREAM_MAIN_LAUNCHER;
	else process.env.NEURASTREAM_MAIN_LAUNCHER = value;
	try {
		await fn();
	} finally {
		if (before === undefined) delete process.env.NEURASTREAM_MAIN_LAUNCHER;
		else process.env.NEURASTREAM_MAIN_LAUNCHER = before;
	}
}

/** A config over the rollover threshold with a short exit grace, so the timer fires inside the test. */
function graceCfg(): Config {
	return { ...baseCfg, rollover: { enabled: true, max_session_mb: 0.000001, exit_grace_s: 0.05 } };
}

/** A main ctx whose newSession resolves `opened` when the rollover reaches it (the awaited real signal). */
function ctxAwaitingOpen(over: Partial<MainCtx> = {}): { ctx: MainCtx; opened: Promise<void> } {
	const { promise, resolve } = Promise.withResolvers<void>();
	const ctx = mainCtx({
		newSession: async opts => {
			newSessions.push(opts);
			resolve();
			return { cancelled: false };
		},
		...over,
	});
	return { ctx, opened: promise };
}

test("launcher set, ready: relaunch.json has the three fields, omp shuts down and re-arms at the next run end", async () => {
	resetState();
	draft = "half-typed";
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
		await host.emit("agent_end", {}, ctx);
	});
	// omp 18.11.1 re-runs its deferred exit check only when shutdown() is called again: the second
	// terminal run end re-arms the exit instead of leaving the request to a dead UI.
	expect(shutdowns).toBe(2);
	expect(JSON.parse(readFileSync(relaunchPath(), "utf8"))).toEqual({
		previousSessionFile: SESSION_FILE,
		notePath: NOTE,
		draft: "half-typed",
	});
});

test("launcher set: the relaunch is requested only at a real run end and re-armed at later ones", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		// A tool result mid-run (the live incident: a wait result) never requests the relaunch.
		await host.emit("tool_result", { toolName: "read", toolCallId: "t1" }, ctx);
		expect(shutdowns).toBe(0);
		expect(existsSync(relaunchPath())).toBe(false);
		// A non-terminal run end (omp 18.11.1 sets willContinue) does not either.
		await host.emit("agent_end", { willContinue: true }, ctx);
		expect(shutdowns).toBe(0);
		expect(existsSync(relaunchPath())).toBe(false);
		// The run's real end requests the relaunch once.
		await host.emit("agent_end", {}, ctx);
		expect(shutdowns).toBe(1);
		expect(existsSync(relaunchPath())).toBe(true);
		// Every later terminal run end re-arms the exit.
		await host.emit("agent_end", {}, ctx);
		expect(shutdowns).toBe(2);
	});
});

test("launcher: omp still running past exit_grace_s rolls over in-process with the owner's typed message", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, graceCfg());
	const { ctx, opened } = ctxAwaitingOpen();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx); // the relaunch is requested; omp does not exit here
		expect(shutdowns).toBe(1);
		await host.emit("input", { text: "a", source: "interactive" }, ctx);
		await opened; // the fallback reached newSession: its own real signal, no guessed duration
	});
	expect(newSessions).toEqual([{ parentSession: SESSION_FILE }]);
	expect(host.sent.length).toBe(1);
	expect(host.sent[0]?.endsWith("Owner's message:\na")).toBe(true);
	expect(existsSync(relaunchPath())).toBe(false);
	expect(shutdowns).toBe(2);
	expect(notes.some(n => n.includes("omp did not restart"))).toBe(true);
}, 60_000);

test("launcher: the in-process fallback without an owner message carries the owner-away text", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, graceCfg());
	const { ctx, opened } = ctxAwaitingOpen();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
		await opened;
	});
	expect(host.sent.length).toBe(1);
	expect(host.sent[0]?.endsWith(
		"Owner's message:\nOwner away (automatic rollover). Continue the work in the note and the queue; the owner reads results later.",
	)).toBe(true);
}, 60_000);

test("launcher: omp really shutting down (session_shutdown) cancels the in-process fallback", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, graceCfg());
	const ctx = mainCtx();
	vi.useFakeTimers();
	try {
		await withLauncher("1", async () => {
			await armReady(host, ctx, "## In progress\nstep");
			await host.emit("agent_end", {}, ctx); // arms the grace timer (now fake)
			await host.emit("session_shutdown", {}, ctx); // omp is really exiting: must clear it
			vi.advanceTimersByTime(60_000); // the grace and far beyond, without real waiting
		});
	} finally {
		vi.useRealTimers();
	}
	expect(newSessions.length).toBe(0);
	expect(host.sent.length).toBe(0);
	// A fired fallback deletes the request synchronously; it must still be there.
	expect(existsSync(relaunchPath())).toBe(true);
});

test("launcher unset, ready: no shutdown and no relaunch.json", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher(undefined, async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
	});
	expect(shutdowns).toBe(0);
	expect(existsSync(relaunchPath())).toBe(false);
});

test("launcher set, own job running: no relaunch; once the job is gone the next turn end relaunches", async () => {
	resetState();
	jobs = [{ label: "sub-1" }];
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
	});
	expect(shutdowns).toBe(0);
	expect(existsSync(relaunchPath())).toBe(false);
	jobs = [];
	await withLauncher("1", async () => {
		await host.emit("agent_end", {}, ctx);
	});
	expect(shutdowns).toBe(1);
	expect(existsSync(relaunchPath())).toBe(true);
});

test("ready: an interactive plain message becomes /main-rollover <text>", async () => {
	await withLauncher(undefined, async () => {
		resetState();
		const host = fakeHost();
		createOmpAdapter(host, overCfg);
		const ctx = mainCtx();
		await armReady(host, ctx, "## In progress\nstep");
		const results = await host.emit("input", { text: "hello", source: "interactive" }, ctx);
		expect(results).toEqual([{ text: "/main-rollover hello" }]);
	});
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

test("main-rollover keeps the event loop running while main-start gathers state", async () => {
	resetState();
	const bin = join(TMP, "home", ".local", "bin");
	mkdirSync(bin, { recursive: true });
	const guard = join(bin, "machine-guard");
	writeFileSync(guard, "#!/bin/sh\nsleep 2\necho OK\n");
	chmodSync(guard, 0o755);
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	// Real-clock exception: the claim under test is that the event loop keeps turning while a child
	// runs. A blocking spawn starves this interval; fake timers cannot observe that.
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 50);
	try {
		await host.commands.get("main-rollover")?.("owner msg", ctx);
	} finally {
		clearInterval(timer);
	}
	expect(ticks).toBeGreaterThanOrEqual(10);
	expect(notes.some(n => n.includes("collecting main-start state"))).toBe(true);
	expect(newSessions).toEqual([{ parentSession: SESSION_FILE }]);
	const handoff = host.sent[0] ?? "";
	expect(handoff).toContain("## Main's handoff note (verbatim)\n## In progress\nstep");
	expect(handoff.endsWith("Owner's message:\nowner msg")).toBe(true);
}, 60_000);

test("agent host: a child's stderr is appended to the handoff text, right after its stdout", async () => {
	resetState();
	const bin = join(TMP, "home", ".local", "bin");
	mkdirSync(bin, { recursive: true });
	const check = join(bin, "queue-check");
	writeFileSync(check, "#!/bin/sh\necho QC-OUT\necho QC-ERR 1>&2\n");
	chmodSync(check, 0o755);
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await armReady(host, ctx, "## In progress\nstep");
	await host.commands.get("main-rollover")?.("owner msg", ctx);
	const handoff = host.sent[0] ?? "";
	expect(handoff).toContain("QC-ERR");
	expect(handoff.indexOf("QC-OUT")).toBeLessThan(handoff.indexOf("QC-ERR"));
}, 60_000);

test("launcher set: a non-main session never relaunches", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx({ agent: { kind: "sub", id: "w1" } });
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
	});
	expect(shutdowns).toBe(0);
	expect(existsSync(relaunchPath())).toBe(false);
});

/** One open plan in a sandbox repo, listed in the sandbox queue index: session_stop has an open item to block on. */
function openPlanFixture(): () => void {
	const repo = join(TMP, "open-repo");
	const plan = join(repo, "docs/plans/20261023_open.md");
	mkdirSync(dirname(plan), { recursive: true });
	writeFileSync(plan, OPEN_PLAN);
	writeFileSync(join(repo, REPO_INDEX), "docs/plans/20261023_open.md\n");
	mkdirSync(blockersDirPath(), { recursive: true });
	mkdirSync(dirname(indexPath()), { recursive: true });
	writeFileSync(indexPath(), `${repo}\n`);
	return () => {
		rmSync(indexPath(), { force: true });
		rmSync(repo, { recursive: true, force: true });
	};
}

const OPEN_PLAN = `# Open fixture plan

Worktree: -
Branch: feat/open

## Goal
- Fixture for the session_stop check.

## Phases
- [ ] P1 fixture — verify: test -f src/a.ts

## Done check
test -f src/a.ts

## Progress
Status: open
`;

test("launcher: a relaunch requested with an open plan lets session_stop through", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		await withLauncher("1", async () => {
			await armReady(host, ctx, "## In progress\nstep");
			await host.emit("agent_end", {}, ctx);
		});
		expect(shutdowns).toBe(1);
		expect(await host.emit("session_stop", {}, ctx)).toEqual([]);
	} finally {
		cleanup();
	}
});

test("no relaunch: session_stop still blocks on the open plan", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const r = (await host.emit("session_stop", {}, mainCtx())) as Array<{ decision?: string }>;
		expect(r[0]?.decision).toBe("block");
	} finally {
		cleanup();
	}
});

/** The guard log so far: each rollover stop decision in session_stop writes one line. */
function guardLog(): string {
	try {
		return readFileSync(baseCfg.paths.guard_log, "utf8");
	} catch {
		return "";
	}
}

test("ready under the launcher: session_stop requests the relaunch and allows the stop, with an open plan", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		await withLauncher("1", async () => {
			await armReady(host, ctx, "## In progress\nstep");
			expect(await host.emit("session_stop", {}, ctx)).toEqual([]);
		});
		expect(shutdowns).toBe(1);
		expect(existsSync(relaunchPath())).toBe(true);
		expect(guardLog()).toContain("ALLOW stop: rollover ready");
	} finally {
		cleanup();
	}
});

test("ready in plain omp: session_stop allows the stop with an open plan and shuts nothing down", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		await armReady(host, ctx, "## In progress\nstep");
		expect(await host.emit("session_stop", {}, ctx)).toEqual([]);
		expect(shutdowns).toBe(0);
		expect(guardLog()).toContain("ALLOW stop: rollover ready");
	} finally {
		cleanup();
	}
});

test("wait-jobs: session_stop allows the stop while own jobs run, with an open plan", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		await armReady(host, ctx, "## In progress\nstep");
		jobs = [{ label: "ci-watch" }];
		expect(await host.emit("session_stop", {}, ctx)).toEqual([]);
		expect(shutdowns).toBe(0);
		expect(guardLog()).toContain("ALLOW stop: rollover wait-jobs");
	} finally {
		cleanup();
	}
});

test("ready with an open incident and no plan: session_stop allows the stop", async () => {
	resetState();
	addIncident(stopCfg, { source: "main", kind: "fixture", summary: "open incident for the stop check" });
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		await armReady(host, ctx, "## In progress\nstep");
		expect(await host.emit("session_stop", {}, ctx)).toEqual([]);
		expect(guardLog()).toContain("ALLOW stop: rollover ready");
	} finally {
		rmSync(incidentsFile(stopCfg), { force: true });
	}
});

test("need-note with an open plan: session_stop blocks with the note request only, never the queue text", async () => {
	resetState();
	const cleanup = openPlanFixture();
	try {
		const host = fakeHost();
		createOmpAdapter(host, stopCfg);
		const ctx = mainCtx();
		writeFileSync(SESSION_FILE, BIG);
		await host.emit("agent_end", {}, ctx); // no note yet: need-note
		const r = (await host.emit("session_stop", {}, ctx)) as Array<{ decision?: string; reason?: string }>;
		expect(r).toHaveLength(1);
		expect(r[0]?.decision).toBe("block");
		expect(r[0]?.reason).toContain("Write a handoff note to");
		expect(r[0]?.reason).not.toContain("spawn");
		expect(guardLog()).toContain("BLOCK stop: rollover need-note");
	} finally {
		cleanup();
	}
});

test("launcher: owner messages during a pending relaunch join its draft, in order, and none becomes /main-rollover", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.emit("agent_end", {}, ctx);
		expect(shutdowns).toBe(1);
		expect(await host.emit("input", { text: "first", source: "interactive" }, ctx)).toEqual([{ handled: true }]);
		expect(await host.emit("input", { text: "second", source: "interactive" }, ctx)).toEqual([{ handled: true }]);
	});
	expect(JSON.parse(readFileSync(relaunchPath(), "utf8")).draft).toBe("first\nsecond");
	expect(notes.filter(n => n.includes("rollover in progress")).length).toBe(2);
});

test("launcher: the first owner message in the ready state starts the relaunch, its text in the draft once", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		expect(await host.emit("input", { text: "hello", source: "interactive" }, ctx)).toEqual([{ handled: true }]);
	});
	// The request's shutdown plus the message's re-arm: omp re-checks only when shutdown() is called again.
	expect(shutdowns).toBe(2);
	expect(JSON.parse(readFileSync(relaunchPath(), "utf8"))).toEqual({
		previousSessionFile: SESSION_FILE,
		notePath: NOTE,
		draft: "hello",
	});
});

test("single-flight: a second /main-rollover during the first's wait adds its text; one new session, one handoff with both", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const ctx = mainCtx({ waitForIdle: () => gate });
	await armReady(host, ctx, "## In progress\nstep");
	const run = host.commands.get("main-rollover");
	const first = run?.("first msg", ctx);
	const second = run?.("second msg", ctx);
	release();
	await Promise.all([first, second]);
	expect(newSessions).toEqual([{ parentSession: SESSION_FILE }]);
	expect(host.sent.length).toBe(1);
	expect(host.sent[0]?.endsWith("Owner's message:\nfirst msg\nsecond msg")).toBe(true);
}, 60_000);

test("single-flight: a state change during the wait (a job starts) stops the rollover before the new session", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	let release: () => void = () => {};
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const ctx = mainCtx({ waitForIdle: () => gate });
	await armReady(host, ctx, "## In progress\nstep");
	const run = host.commands.get("main-rollover")?.("owner msg", ctx);
	try {
		jobs = [{ label: "sub-1" }];
		release();
		await run;
	} finally {
		jobs = [];
	}
	expect(newSessions.length).toBe(0);
	// The owner's text is not dropped: after an abort it goes to this session as an ordinary message.
	expect(host.sent).toEqual(["owner msg"]);
	expect(notes.some(n => n.includes("no new session"))).toBe(true);
}, 60_000);

test("launcher: /main-rollover is refused; the launcher's relaunch is the only rollover path", async () => {
	resetState();
	const host = fakeHost();
	createOmpAdapter(host, overCfg);
	const ctx = mainCtx();
	await withLauncher("1", async () => {
		await armReady(host, ctx, "## In progress\nstep");
		await host.commands.get("main-rollover")?.("owner msg", ctx);
	});
	expect(newSessions.length).toBe(0);
	expect(host.sent.length).toBe(0);
	expect(notes.some(n => n.includes("neurastream main"))).toBe(true);
});
