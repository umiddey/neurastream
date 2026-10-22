// Session rollover through the omp adapter, in-process with a fake extension host: the size check
// and the one-time note instruction, the input rewrite to /main-rollover, and the command's refusals
// and handoff. The session file is a temp file; the note is written under the queue state dir for
// a unique session id and removed afterwards.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

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
const overCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 0.000001 } };
const belowCfg: Config = { ...baseCfg, rollover: { enabled: true, max_session_mb: 1024 } };
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
		expect(ready[0]?.reason ?? "").toContain("an implementer needs an open plan");
		expect(ready[0]?.reason ?? "").not.toContain("rollover pending");
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

test("launcher set, ready: relaunch.json has the three fields and omp shuts down once", async () => {
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
	expect(shutdowns).toBe(1);
	expect(JSON.parse(readFileSync(relaunchPath(), "utf8"))).toEqual({
		previousSessionFile: SESSION_FILE,
		notePath: NOTE,
		draft: "half-typed",
	});
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
