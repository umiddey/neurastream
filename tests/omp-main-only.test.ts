// The main-only switch: plain `omp` registers no neurastream hook and no command; only
// NEURASTREAM_MAIN_LAUNCHER=1 — which `neurastream main` sets for its child — brings the
// adapter up, and the env reaches child harnesses too, so a tool cannot start an unguarded
// one. Fake extension host, sandbox HOME; the real ~/.omp is never touched.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompExtension, { type ExtensionHost } from "../src/adapters/omp/index.ts";

const MAIN_ONLY_ENV = "NEURASTREAM_MAIN_LAUNCHER";

const TMP = mkdtempSync(join(tmpdir(), "neurastream-home-"));
// Live QUEUE_* (omp's plugin exports them to every child) would point loadConfig at the live
// queue; save and drop them, and point HOME at the sandbox so ompExtension's own loadConfig
// resolves under it. afterAll restores both.
const homeBefore = process.env.HOME;
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
process.env.HOME = TMP;

afterAll(() => {
	process.env.HOME = homeBefore;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
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
