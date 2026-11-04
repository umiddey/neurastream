// Plan 20261103_1146 (limit probe): P1 — the probe child runs bun, never the harness binary;
// P2 — a second live Main session with the same id is refused before any model call, while a
// rollover's second in-process session_start is exempt. Both P2 tests start real processes
// (a bun-compiled stand-in host, real flocks) under a sandbox HOME — no stubbed spawns.
// P4 — a factory re-run must not drop the session lock; the rollover re-entry must keep it.

import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, limitProbeSpawn, reset as resetAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { MAIN_ENV } from "../src/adapters/omp/launch.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { mainId } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { notePath } from "../src/core/rollover.ts";

test("limit probe never starts a harness session", () => {
	const p = limitProbeSpawn({ [MAIN_ENV]: "1", PATH: "/usr/bin" });
	expect(p.args).toContain("bun");
	expect(p.args).not.toContain(process.execPath);
	expect(p.args.at(-1)).toMatch(/cli\/limit-probe\.ts$/);
	expect(p.env[MAIN_ENV]).toBeUndefined();
	expect(p.env.PATH).toBe("/usr/bin");
});

// --- P2: one live Main session per id, same process exempt ---

type Handler = (event: unknown, ctx: unknown) => unknown;

interface HostProc {
	proc: ChildProcess;
	out: string;
	err: string;
}

const TMP = mkdtempSync(join(tmpdir(), "neurastream-home-"));
const HOME = join(TMP, "home");
const GUARD_LOG = join(HOME, ".local/state/main-guard.log");
mkdirSync(HOME, { recursive: true });

// The caller's shell may export live QUEUE_* (omp's plugin does, to every child) and a live
// NEURASTREAM_MAIN_ID; the sandbox must win, so both are pinned here and put back at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const mainIdBefore = process.env.NEURASTREAM_MAIN_ID;
process.env.NEURASTREAM_MAIN_ID = "main";

const alive: HostProc[] = [];

/** The host's env: the sandbox HOME and this id, never the caller's live QUEUE_* state. */
function childEnv(id: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("QUEUE_")) env[k] = v;
	env.HOME = HOME;
	env.NEURASTREAM_MAIN_ID = id;
	env[MAIN_ENV] = "1";
	// The compiled binary loads the adapter side from disk (package paths under --compile would
	// lose import.meta), so it needs the worktree path of the fixture main.
	env.LIMIT_PROBE_FIXTURE_ENTRY = join(import.meta.dir, "fixtures/limit-probe-main-host-main.ts");
	return env;
}

function compileHost(): string {
	const bin = join(TMP, "main-host");
	if (existsSync(bin)) return bin;
	const r = spawnSync("bun", ["build", "--compile", join(import.meta.dir, "fixtures/limit-probe-main-host.ts"), "--outfile", bin], { cwd: join(HOME, "..") });
	if (r.status !== 0) throw new Error(`bun build --compile failed: ${r.stderr}`);
	return bin;
}

function startHost(bin: string, id: string): HostProc {
	const proc = spawn(bin, [], { env: childEnv(id), stdio: ["ignore", "pipe", "pipe"] });
	const h: HostProc = { proc, out: "", err: "" };
	proc.stdout?.on("data", d => {
		h.out += String(d);
	});
	proc.stderr?.on("data", d => {
		h.err += String(d);
	});
	alive.push(h);
	return h;
}

/** Resolves once the host has fired its main session_start (its ready line); rejects on early exit. */
function waitReady(h: HostProc, id: string, ms = 10_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let t: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	const done = (err?: Error): void => {
		clearTimeout(t);
		if (settled) return;
		settled = true;
		if (err === undefined) resolve();
		else reject(err);
	};
	const dump = (): string => `stdout: ${h.out.trim() || "(none)"}; stderr: ${h.err.trim() || "(none)"}`;
	t = setTimeout(() => done(new Error(`main host ${id} not ready within ${ms}ms; ${dump()}`)), ms);
	h.proc.stdout?.on("data", () => {
		if (h.out.includes(`main-host ready ${id}`)) done();
	});
	h.proc.once("close", () => done(new Error(`main host ${id} exited before ready; ${dump()}`)));
	return promise;
}

function waitClose(h: HostProc, ms: number): Promise<number | "timeout"> {
	const { promise, resolve } = Promise.withResolvers<number | "timeout">();
	const t = setTimeout(() => resolve("timeout"), ms);
	h.proc.once("close", code => {
		clearTimeout(t);
		resolve(code ?? -1);
	});
	return promise;
}

async function stop(h: HostProc): Promise<void> {
	if (h.proc.exitCode !== null || h.proc.signalCode !== null) return;
	h.proc.kill("SIGKILL");
	await waitClose(h, 5_000);
}

afterAll(() => {
	resetAdapter();
	for (const h of alive) void stop(h);
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	if (mainIdBefore === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = mainIdBefore;
});

test("second Main is refused", async () => {
	const bin = compileHost();
	// The first Main with id "main": takes the session lock and stays up.
	const a = startHost(bin, "main");
	await waitReady(a, "main");
	expect(existsSync(join(HOME, ".local/state/queue/mains/main/session.lock"))).toBe(true);
	// A second real process with the SAME id is refused before its first model call.
	const b = startHost(bin, "main");
	const code = await waitClose(b, 10_000);
	if (code === "timeout") {
		await stop(b);
		throw new Error(`second Main kept running (no refusal within 10s); stderr: ${b.err.trim() || "(none)"}`);
	}
	expect(code).not.toBe(0);
	expect(`${b.out}\n${b.err}`).toContain("Main main is already running");
	const refusals = readFileSync(GUARD_LOG, "utf8").split("\n").filter(l => l.includes("second Main main refused: a Main session with this id is live"));
	expect(refusals.length).toBe(1);
	// A Main with a DIFFERENT id still starts side by side.
	const c = startHost(bin, "aux");
	await waitReady(c, "aux");
	await stop(c);
	// After the first Main dies, its id is free again (the kernel frees the flock on death).
	await stop(a);
	const d = startHost(bin, "main");
	await waitReady(d, "main");
	await stop(d);
}, 120_000);

test("rollover in-process session_start is never refused", async () => {
	// The rollover fallback re-enters session_start in the SAME process (newSession); its own
	// lock must read as fine, although a second flock of the same file in one process is busy.
	const handlers = new Map<string, Handler[]>();
	const host: ExtensionHost = {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage() {},
		sendMessage() {},
	};
	createOmpAdapter(host, loadConfig({ home: HOME, env: {} }));
	// Test 1's refused host wrote its line to the same sandbox guard log; judge only this test.
	rmSync(GUARD_LOG, { force: true });
	const ctx = { agent: { kind: "main", id: "main" } };
	const emitOnce = async (): Promise<unknown> => Promise.all((handlers.get("session_start") ?? []).map(cb => cb({}, ctx)));
	await emitOnce();
	await emitOnce();
	const log = existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8") : "";
	expect(log.includes("second Main main refused")).toBe(false);
});

// --- P4: the factory re-run must not drop the process-lifetime session lock ---

/** A host that records handlers so the test can emit the events omp would. */
function recordingHost(): { host: ExtensionHost; handlers: Map<string, Handler[]> } {
	const handlers = new Map<string, Handler[]>();
	const host: ExtensionHost = {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage() {},
		sendMessage() {},
	};
	return { host, handlers };
}

async function emit(handlers: Map<string, Handler[]>, event: string, payload: unknown, ctx: unknown): Promise<void> {
	await Promise.all((handlers.get(event) ?? []).map(cb => cb(payload, ctx)));
}

/** A separate process's non-blocking flock. Exit 1 means this process still holds the lock. */
function separateFlock(lock: string): number {
	const r = spawnSync("flock", ["-n", lock, "-c", "true"]);
	if (r.error) throw r.error;
	return r.status ?? -1;
}

/** Point queue reads at the sandbox for this test, and put the caller's env back after. autoClose
 * must not spawn a real queue-close child against whatever index the shell inherited. */
function pinSandbox(cfg: Config): () => void {
	const queueBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
	const closeBin = process.env.QUEUE_CLOSE_BIN;
	applyQueueEnv(cfg);
	process.env.QUEUE_CLOSE_BIN = "true";
	return () => {
		for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
		Object.assign(process.env, queueBefore);
		if (closeBin === undefined) delete process.env.QUEUE_CLOSE_BIN;
		else process.env.QUEUE_CLOSE_BIN = closeBin;
		refreshQueuePaths();
	};
}

test("factory re-run keeps the session lock", async () => {
	// The P2 in-process test above holds this process's lock until afterAll; release it first so
	// this test's flock sees only what the factory re-run does.
	resetAdapter();
	const cfg = loadConfig({ home: HOME, env: {} });
	expect(cfg.paths.guard_log).toBe(GUARD_LOG);
	const unpin = pinSandbox(cfg);
	try {
		rmSync(GUARD_LOG, { force: true });
		const ctx = { agent: { kind: "main", id: "main" } };
		const first = recordingHost();
		createOmpAdapter(first.host, cfg);
		await emit(first.handlers, "session_start", {}, ctx);
		// The factory re-run: createOmpAdapter calls activeAdapterReset before installing the new one.
		const second = recordingHost();
		createOmpAdapter(second.host, cfg);
		// Before the fix this exits 0: activeAdapterReset released the flock. After, it stays busy.
		expect(separateFlock(join(cfg.paths.queue_state, "mains", mainId(), "session.lock"))).toBe(1);
		await emit(second.handlers, "session_start", {}, ctx);
		const log = existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8") : "";
		expect(log.includes("second Main main refused")).toBe(false);
	} finally {
		resetAdapter();
		unpin();
	}
});

test("rollover re-entry keeps the session lock", async () => {
	resetAdapter();
	const cfg: Config = {
		...loadConfig({ home: HOME, env: {} }),
		rollover: { enabled: true, max_session_mb: 0.000001, exit_grace_s: 0.05 },
	};
	expect(cfg.paths.guard_log).toBe(GUARD_LOG);
	const unpin = pinSandbox(cfg);
	const sessionFile = join(TMP, "p4-session.jsonl");
	const sessionId = `limit-probe-p4-${process.pid}`;
	const note = notePath(sessionId);
	try {
		rmSync(GUARD_LOG, { force: true });
		const { host, handlers } = recordingHost();
		const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
		const ctx = {
			agent: { kind: "main", id: "main" },
			cwd: TMP,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
			},
			getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
			waitForIdle: async () => {},
			// omp re-enters session_start on the new session, in this same process.
			newSession: async () => {
				await emit(handlers, "session_start", {}, ctx);
				markOpened();
				return { cancelled: false };
			},
			shutdown: () => {},
			ui: { notify: () => {}, getEditorText: () => "" },
		};
		createOmpAdapter(host, cfg);
		await emit(handlers, "session_start", {}, ctx);
		writeFileSync(sessionFile, "x".repeat(4096));
		await emit(handlers, "agent_end", {}, ctx);
		mkdirSync(dirname(note), { recursive: true });
		writeFileSync(note, "## In progress\nstep");
		const later = (Date.now() + 5_000) / 1000;
		utimesSync(note, later, later);
		await emit(handlers, "agent_end", {}, ctx);
		await opened;
		expect(separateFlock(join(cfg.paths.queue_state, "mains", mainId(), "session.lock"))).toBe(1);
		const log = existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8") : "";
		expect(log.includes("second Main main refused")).toBe(false);
	} finally {
		resetAdapter();
		unpin();
		rmSync(sessionFile, { force: true });
		rmSync(note, { force: true });
	}
}, 60_000);
