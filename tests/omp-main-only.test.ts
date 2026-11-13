// The main-only switch: plain `omp` registers no neurastream hook and no command; only
// NEURASTREAM_MAIN_LAUNCHER=1 — which `neurastream main` sets for its child — brings the
// adapter up, and the env reaches child harnesses too, so a tool cannot start an unguarded
// one. Fake extension host, sandbox HOME; the real ~/.omp is never touched.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompExtension, { type ExtensionHost } from "../src/adapters/omp/index.ts";
import { renderBlock } from "../src/core/agents-md.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { loadConfig } from "../src/core/config.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";

const MAIN_ONLY_ENV = "NEURASTREAM_MAIN_LAUNCHER";

const TMP = mkdtempSync(join(tmpdir(), "neurastream-home-"));
const STATE = join(TMP, "state");
// Bun caches os.homedir() at process start, so HOME reaches only child processes, not the
// loadConfig()/configFile() call inside this process: the adapter reads the live
// ~/.config/neurastream/config.yml, whose sessions root is the live ~/.omp/agent/sessions.
// Every path the handler touches is therefore pinned through env (applyEnv wins over the file).
const SANDBOX: Record<string, string> = {
	HOME: TMP,
	QUEUE_AGENT: join(TMP, "agent"),
	QUEUE_STATE: STATE,
	QUEUE_INDEX: join(TMP, "INDEX.md"),
	MAIN_GUARD_LEDGER: "true",
	MAIN_GUARD_LOG: join(TMP, "main-guard.log"),
	PLAN_GUARD_LOG: join(TMP, "plan-guard.log"),
};
const envBefore = Object.fromEntries(Object.keys(SANDBOX).map(k => [k, process.env[k]]));
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
Object.assign(process.env, SANDBOX);
// queue/lib.ts fixed its paths from the real home when it loaded: refresh them to the sandbox,
// or the onStart case appends `hello` to the live recall log and lists the live plans' open MRs.
refreshQueuePaths();
// The two incident gates each walk the session root when open: the daily check (once per day)
// and the detector scan (every scan_interval_sec). A fresh sandbox has neither stamp, so seed
// them as already run: today's daily stamp, and a scan stamp in the future so the gate stays
// shut for any interval.
mkdirSync(STATE, { recursive: true });
writeFileSync(join(STATE, "incidents-daily.json"), `${JSON.stringify({ date: strftime(nowSec(), "%Y-%m-%d") })}\n`);
writeFileSync(join(STATE, "incident-scan.json"), `${JSON.stringify({ lastScan: nowSec() + 86400, mainTs: 0 })}\n`);

afterAll(() => {
	for (const [k, v] of Object.entries(envBefore)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Records what the extension registers; nothing else. */
function recordingHost(): { events: Map<string, Handler[]>; commands: Map<string, unknown> } & ExtensionHost {
	const events = new Map<string, Handler[]>();
	const commands = new Map<string, unknown>();
	return {
		events,
		commands,
		on(event: string, cb: Handler): void {
			events.set(event, [...(events.get(event) ?? []), cb]);
		},
		registerCommand(name: string, _opts: { description?: string; handler: (args: unknown, ctx: unknown) => unknown }): void {
			commands.set(name, _opts);
		},
		sendUserMessage(): void {},
		sendMessage(): void {},
	};
}

const GUARD_HOOKS = ["before_agent_start", "tool_call", "session_stop", "before_subagent_spawn"];

test("plain omp: no handler and no command is registered", () => {
	const before = process.env[MAIN_ONLY_ENV];
	delete process.env[MAIN_ONLY_ENV];
	try {
		const host = recordingHost();
		ompExtension(host);
		expect(host.events.size).toBe(0);
		expect(host.commands.size).toBe(0);
	} finally {
		if (before === undefined) delete process.env[MAIN_ONLY_ENV];
		else process.env[MAIN_ONLY_ENV] = before;
	}
});

test("Main: the guard hooks and the rollover command are registered", () => {
	const before = process.env[MAIN_ONLY_ENV];
	process.env[MAIN_ONLY_ENV] = "1";
	try {
		const host = recordingHost();
		ompExtension(host);
		for (const event of GUARD_HOOKS) expect(host.events.has(event), event).toBe(true);
		expect(host.commands.has("main-rollover")).toBe(true);
	} finally {
		if (before === undefined) delete process.env[MAIN_ONLY_ENV];
		else process.env[MAIN_ONLY_ENV] = before;
	}
});

test("a child harness inherits the env and stays guarded", () => {
	// The parent holds MAIN_ONLY_ENV=1 and the child sets nothing itself: registration proves
	// the inheritance, so `omp` started from a tool inside Main cannot come up unguarded.
	const before = process.env[MAIN_ONLY_ENV];
	process.env[MAIN_ONLY_ENV] = "1";
	try {
		const adapter = join(import.meta.dir, "../src/adapters/omp/index.ts");
		// The child is its own process: the specifier is resolved here at runtime, a static
		// import cannot cross into spawned `bun -e` code.
		const code = `const m = await import(${JSON.stringify(adapter)}); // runtime-resolved: spawned child process
			const events = []; const commands = [];
			m.default({ on: (_e, cb) => events.push(cb), registerCommand: (n) => commands.push(n), sendUserMessage() {}, sendMessage() {} });
			console.log(JSON.stringify({ events: events.length, commands: commands.length }));`;
		const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env }, encoding: "utf8" });
		expect(r.status).toBe(0);
		const counts = JSON.parse(r.stdout.trim()) as { events: number; commands: number };
		expect(counts.events).toBeGreaterThanOrEqual(GUARD_HOOKS.length);
		expect(counts.commands).toBe(1);
	} finally {
		if (before === undefined) delete process.env[MAIN_ONLY_ENV];
		else process.env[MAIN_ONLY_ENV] = before;
	}
});

test("a child without the env registers nothing", () => {
	const before = process.env[MAIN_ONLY_ENV];
	delete process.env[MAIN_ONLY_ENV];
	try {
		const adapter = join(import.meta.dir, "../src/adapters/omp/index.ts");
		const code = `const m = await import(${JSON.stringify(adapter)}); // runtime-resolved: spawned child process
			const events = []; const commands = [];
			m.default({ on: (_e, cb) => events.push(cb), registerCommand: (n) => commands.push(n), sendUserMessage() {}, sendMessage() {} });
			console.log(JSON.stringify({ events: events.length, commands: commands.length }));`;
		const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env }, encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim())).toEqual({ events: 0, commands: 0 });
	} finally {
		if (before === undefined) delete process.env[MAIN_ONLY_ENV];
		else process.env[MAIN_ONLY_ENV] = before;
	}
});

test("Main mode: the Main rules join the systemPrompt once, after the host's parts; subagents get none", async () => {
	const before = process.env[MAIN_ONLY_ENV];
	process.env[MAIN_ONLY_ENV] = "1";
	try {
		const host = recordingHost();
		ompExtension(host);
		const [onStart] = host.events.get("before_agent_start") ?? [];
		if (!onStart) throw new Error("no before_agent_start handler registered");
		const main = { agent: { kind: "main", id: "main" }, cwd: TMP };
		const result = (await onStart({ prompt: "hello", systemPrompt: ["host rules"] }, main)) as { systemPrompt?: string[] };
		expect(result.systemPrompt).toEqual(["host rules", renderBlock(loadConfig({ home: TMP }))]);
		const sub = { agent: { kind: "sub", id: "s1" }, cwd: TMP };
		const subResult = (await onStart({ prompt: "brief", systemPrompt: ["host rules"] }, sub)) as { systemPrompt?: string[] } | undefined;
		expect(subResult?.systemPrompt).toBeUndefined();
	} finally {
		if (before === undefined) delete process.env[MAIN_ONLY_ENV];
		else process.env[MAIN_ONLY_ENV] = before;
	}
});
