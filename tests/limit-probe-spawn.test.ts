// Plan 20261103_1146 (limit probe): P1 — the probe child runs bun, never the harness binary;
// P2 — a second live Main session with the same id is refused before any model call, while a
// rollover's second in-process session_start is exempt. Both P2 tests start real processes
// (a bun-compiled stand-in host, real flocks) under a sandbox HOME — no stubbed spawns.

import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter, limitProbeSpawn, reset as resetAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { MAIN_ENV } from "../src/adapters/omp/launch.ts";
import { loadConfig } from "../src/core/config.ts";

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
