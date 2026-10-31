// Provider out-until state (plan 20261025_1700 P1): the parse-and-record path, the status read,
// the quota-reset --provider recording, and the adapter's automatic recordings. The incident's
// timezone case (I-20261025-164) is pinned: a zai reset at "2026-10-25 18:56:22" named in
// Asia/Shanghai wall time is 10:56:22 UTC, so all day in Europe the provider was free long
// before 18:56 local — the mistake that kept Main off GLM for a day.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import type { ExtensionHost } from "../src/adapters/omp/index.ts";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig } from "../src/core/config.ts";
import { nowSec } from "../src/core/clock.ts";
import { outUntil, pinModel, providerOfModel, providerStatus, readOut, recordOut, resetEpochFromText } from "../src/core/provider-state.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "provider-state-"));
const roots: string[] = [];

afterAll(() => {
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sandbox(pins: [string, string][] = []): Config {
	const home = mkdtempSync("/tmp/neurastream-home-pstate-");
	roots.push(home);
	const agents = join(home, ".omp/agent/agents");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(agents, { recursive: true });
	for (const [name, model] of pins) writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\nmodel: ${model}\n---\n\nBody.\n`);
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`adapter:\n  name: omp\n  sessions: "${join(home, ".omp/agent/sessions")}"\n  pins: "${agents}"\n  extensions: "${join(home, ".omp/agent/extensions")}"\n`,
	);
	return loadConfig({ home, env: {} });
}

// The provider's own words, with the reset zone from quota.reset_tz (Asia/Shanghai).
const RESET_PATTERN = loadConfig({ home: join(TMP, "unused"), env: {} }).quota.reset_pattern;
const SHANGHAI = { pattern: RESET_PATTERN, zone: "Asia/Shanghai" };
// 2026-10-25 18:56:22 in Asia/Shanghai = 2026-10-25T10:56:22Z.
const INCIDENCE = Date.UTC(2026, 9, 25, 10, 56, 22) / 1000;

test("resetEpochFromText reads the incident's 429 line: Shanghai wall time becomes 10:56 UTC", () => {
	const text = "429 rate limit exceeded, reset at 2026-10-25 18:56:22";
	expect(resetEpochFromText(text, SHANGHAI)).toBe(INCIDENCE);
	expect(new Date(INCIDENCE * 1000).toISOString()).toBe("2026-10-25T10:56:22.000Z");
});

test("an explicit zone or offset in the text beats reset_tz; no match parses to null", () => {
	expect(resetEpochFromText("reset at 2026-10-25 18:56:22 +08:00", SHANGHAI)).toBe(INCIDENCE);
	expect(resetEpochFromText("reset at 2026-10-25 10:56:22 UTC", SHANGHAI)).toBe(INCIDENCE);
	expect(resetEpochFromText("no time here", SHANGHAI)).toBeNull();
	expect(resetEpochFromText("reset at 2026-13-45 99:99:99", SHANGHAI)).toBeNull();
});

test("recordOut appends {provider, until, at, source} lines; readOut skips unparseable ones", () => {
	const cfg = sandbox();
	recordOut(cfg, "zai", INCIDENCE, "quota-reset", 1760000000);
	recordOut(cfg, "openrouter", 1760001000, "task-result", 1760000001);
	expect(readOut(cfg)).toEqual([
		{ provider: "zai", until: INCIDENCE, at: 1760000000, source: "quota-reset" },
		{ provider: "openrouter", until: 1760001000, at: 1760000001, source: "task-result" },
	]);
	const file = readFileSync(join(cfg.paths.queue_state, "provider-out.jsonl"), "utf8");
	expect(file.split("\n").filter(Boolean).map(l => JSON.parse(l).provider)).toEqual(["zai", "openrouter"]);
});

test("providerStatus: out until the recorded time, free after it, newest record wins", () => {
	const cfg = sandbox();
	recordOut(cfg, "zai", INCIDENCE, "quota-reset");
	expect(providerStatus(cfg, INCIDENCE - 1)).toEqual([{ provider: "zai", until: INCIDENCE }]);
	// After the recorded time zai is free — the check the incident's day never made.
	expect(providerStatus(cfg, INCIDENCE + 1)).toEqual([{ provider: "zai", until: null }]);
	expect(outUntil(cfg, "zai", INCIDENCE + 1)).toBeNull();
	// A later record replaces the picture: out again, then free when that passes too.
	recordOut(cfg, "zai", INCIDENCE + 3600, "rate-limit");
	expect(outUntil(cfg, "zai", INCIDENCE + 60)).toBe(INCIDENCE + 3600);
	expect(outUntil(cfg, "openrouter", INCIDENCE + 60)).toBeNull(); // no record = free
	// A provider only the file knows (not in ledger.providers) is still listed.
	recordOut(cfg, "other-provider", INCIDENCE + 60, "task-result");
	expect(providerStatus(cfg, INCIDENCE).map(s => s.provider)).toEqual(["zai", "other-provider"]);
});

test("providerOfModel and pinModel resolve an agent pin to its provider prefix", () => {
	const cfg = sandbox([["glm", "zai/glm-5.3-flash"]]);
	expect(providerOfModel(pinModel(cfg, "glm"))).toBe("zai");
	writeFileSync(join(cfg.adapter!.pins, "bare.md"), "---\nname: bare\n---\nno model line\n");
	expect(pinModel(cfg, "bare")).toBeNull();
	expect(providerOfModel(null)).toBeNull();
	expect(pinModel(cfg, "missing")).toBeNull();
});

// --- quota-reset --provider records the parsed time ---

function quota(home: string, args: string[]): { code: number; stdout: string; stderr: string } {
	// The caller's live QUEUE_* would point the child at the real state dir; sandbox wins. The
	// zone goes in as a computed property like tests/quota-reset.test.ts: the quota-tz blocker
	// rejects a literal zone-env pin, and the named zone must match date(1), not the host's.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("QUEUE_")) env[key] = value;
	}
	const ZONE_ENV = "TZ";
	const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "bin/quota-reset"), ...args], {
		encoding: "utf8",
		env: { ...env, HOME: home, [ZONE_ENV]: "UTC" },
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("quota-reset --provider zai records the reset time; the guards read it back", () => {
	const cfg = sandbox([["glm", "zai/glm-5.3-flash"]]);
	const r = quota(cfg.paths.home, ["2099-01-01 08:00:00", "--provider", "zai"]);
	expect(r.code).toBe(0);
	// 08:00 in Asia/Shanghai (the default reset_tz) is 00:00:00 UTC — the recorded until is an
	// epoch, immune to the caller's local zone.
	expect(r.stdout).toContain("quota reset (local): 2099-01-01 00:00:00");
	expect(r.stdout).toContain("recorded: zai out until 2099-01-01 00:00:00");
	const records = readOut(cfg);
	expect(records).toHaveLength(1);
	expect(records[0]).toEqual({ provider: "zai", until: Date.UTC(2099, 0, 1, 0, 0, 0) / 1000, source: "quota-reset", at: records[0]!.at });
	expect(outUntil(cfg, "zai", nowSec())).toBe(Date.UTC(2099, 0, 1, 0, 0, 0) / 1000);
});

test("quota-reset refuses an unknown provider and works without --provider as before", () => {
	const cfg = sandbox();
	const bad = quota(cfg.paths.home, ["2099-01-01 08:00:00", "--provider", "nope"]);
	expect(bad.code).toBe(1);
	expect(bad.stderr).toContain('unknown provider "nope"');
	expect(readOut(cfg)).toEqual([]);
	const plain = quota(cfg.paths.home, ["2099-01-01 08:00:00"]);
	expect(plain.code).toBe(0);
	expect(readOut(cfg)).toEqual([]); // no provider: prints only, records nothing
});

// --- the adapter's automatic recordings (fake host, no real chat) ---

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeHost {
	handlers: Map<string, Handler[]>;
	sent: string[];
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
}

function fakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	return {
		handlers,
		sent,
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

/** The subset of the extension host createOmpAdapter calls: on(), plus the resume timer's send. */
function hostFor(host: FakeHost): ExtensionHost {
	return {
		on: (event, cb) => { host.handlers.set(event, [...(host.handlers.get(event) ?? []), cb]); },
		registerCommand: () => {},
		sendUserMessage: (content: string) => { host.sent.push(content); },
		sendMessage: () => {},
	};
}

const mainCtx = (sessionFile: string): unknown => ({
	agent: { kind: "main", id: "main" },
	cwd: TMP,
	sessionManager: { getSessionId: () => "provider-state-test", getSessionFile: () => sessionFile },
});

async function adapterWith(cfg: Config) {
	applyQueueEnv(cfg);
	const host = fakeHost();
	createOmpAdapter(hostFor(host), cfg);
	return host;
}

test("a task result quoting the reset time records the sub's provider from its pin", async () => {
	const cfg = sandbox([["glm", "zai/glm-5.3-flash"]]);
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	const host = await adapterWith(cfg);
	const session = join(TMP, "task-session.jsonl");
	writeFileSync(session, "");
	const event = {
		toolCallId: "t1",
		toolName: "task",
		isError: false,
		input: { tasks: [{ name: "w1", agent: "glm", task: "x", context: "" }] },
		content: [{ type: "text", text: "worker hit a 429: reset at 2026-10-25 18:56:22" }],
	};
	await host.emit("tool_result", event, mainCtx(session));
	const records = readOut(cfg);
	expect(records).toEqual([{ provider: "zai", until: INCIDENCE, at: records[0]!.at, source: "task-result" }]);
}, 20_000);

test("a rate-limited turn with no reset time in the text records the armed wait", async () => {
	const cfg = sandbox([["glm", "zai/glm-5.3-flash"]]);
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	const host = await adapterWith(cfg);
	const session = join(TMP, "stop-session.jsonl");
	writeFileSync(session, "");
	const turn = {
		role: "assistant",
		stopReason: "error",
		provider: "zai",
		model: "glm-5.3-flash",
		errorMessage: '429 {"error":{"type":"rate_limit_error"}} retry-after-ms=40',
		content: [],
	};
	await host.emit("session_stop", { last_assistant_message: turn, messages: [turn] }, mainCtx(session));
	const records = readOut(cfg);
	expect(records).toHaveLength(1);
	expect(records[0]!.provider).toBe("zai");
	expect(records[0]!.source).toBe("rate-limit");
	expect(records[0]!.until).toBeGreaterThan(Math.floor(Date.now() / 1000));
	// The provider's own words, when the error text names a reset time, win over the wait.
	writeFileSync(session, "");
	const named = { ...turn, errorMessage: '429 rate limit, reset at 2026-10-25 18:56:22 retry-after-ms=40' };
	await host.emit("session_stop", { last_assistant_message: named, messages: [named] }, mainCtx(session));
	const after = readOut(cfg);
	expect(after).toHaveLength(2);
	expect(after[1]).toEqual({ provider: "zai", until: INCIDENCE, at: after[1]!.at, source: "rate-limit-reset" });
}, 20_000);

test("a turn that ends without a rate limit records nothing", async () => {
	const cfg = sandbox([["glm", "zai/glm-5.3-flash"]]);
	mkdirSync(cfg.paths.queue_state, { recursive: true });
	const host = await adapterWith(cfg);
	const session = join(TMP, "clean-session.jsonl");
	writeFileSync(session, "");
	const turn = { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3-flash", content: [{ type: "text", text: "done" }] };
	await host.emit("session_stop", { last_assistant_message: turn, messages: [turn] }, mainCtx(session));
	expect(readOut(cfg)).toEqual([]);
}, 20_000);
