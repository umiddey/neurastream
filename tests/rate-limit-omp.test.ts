// Plan 20261027_1500 P3: the adapter wires the limit probe loop. A rate-limited stop opens an episode
// (one "limited" chat post). A 30 s tick runs one probe per probe_interval_s until a probe gets
// through, or until the named reset passes, then sends Main one back message. An owner message
// cancels the tick and keeps the episode and its probe count; a turn that ends without a limit closes
// the episode. Every request lands on a local Bun.serve fake; no real chat host is contacted.
//
// The clock is fake: Date.now is spied and the tick is fired by hand. Probes run in-process through
// an injected runner, so no provider, omp or network is involved.

import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, recordProviderOutFromRateLimit, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { type ProbeRunner, probeStep, readLimitState } from "../src/core/limit-probe.ts";
import { readMetricEvents } from "../src/core/metrics.ts";
import { notifyIdle } from "../src/core/notify.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { blockersDirPath, indexPath } from "../src/core/queue/lib.ts";
import { readOut } from "../src/core/provider-state.ts";

const TMP = mkdtempSync(join(tmpdir(), "rate-limit-omp-"));
const HOME = join(TMP, "home");
const QUEUE_STATE = join(TMP, "queue-state");
const INDEX = join(TMP, "INDEX.md");
const GUARD_LOG = join(TMP, "guard.log");
const SECRETS = join(TMP, "secrets");
const DISCORD_FILE = join(SECRETS, "discord-webhook");
const SESSION_FILE = join(TMP, "session.jsonl");
const SESSION_ID = `rate-limit-test-${process.pid}`;

interface Hit {
	key: string;
	text: string;
}

const discordHits: Hit[] = [];
const discord = Bun.serve({
	port: 0,
	fetch: async req => {
		const body = (await req.json()) as Record<string, unknown>;
		const key = Object.keys(body)[0] ?? "";
		discordHits.push({ key, text: String(body[key] ?? "") });
		return Response.json({});
	},
});
const discordUrl = `http://127.0.0.1:${discord.port}/hook`;

function writeConfig(): Config {
	mkdirSync(dirname(join(HOME, ".config/neurastream/config.yml")), { recursive: true });
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  queue_index: "${INDEX}"
  queue_state: "${QUEUE_STATE}"
  guard_log: "${GUARD_LOG}"
  plan_guard_log: "${join(TMP, "plan-guard.log")}"
guards:
  rate_limit:
    probe_interval_s: 5
    slack_s: 0
notify:
  discord_webhook_file: "${DISCORD_FILE}"
`,
	);
	return loadConfig({ home: HOME });
}

// The stop guard reads guards.ledger_command; the pinned ledger has no live subagent rows.
const stopCfg = (cfg: Config): Config => ({ ...cfg, guards: { ...cfg.guards, ledger_command: "printf 'MAIN x RUNNING\\n'" } });

function seedSecrets(): void {
	mkdirSync(SECRETS, { recursive: true });
	writeFileSync(DISCORD_FILE, `${discordUrl}\n`);
}

function reset(): void {
	discordHits.length = 0;
	writeFileSync(INDEX, "");
	rmSync(GUARD_LOG, { force: true });
	writeFileSync(SESSION_FILE, "");
	seedSecrets();
}

// Exception to the no-wall-clock rule: the adapter posts over a real loopback HTTP fake whose
// completion is not exposed as a promise, so the wait polls the observable effect (the hit list).
async function until(cond: () => boolean, ticks = 400): Promise<void> {
	for (let i = 0; i < ticks && !cond(); i++) await sleep(25);
	expect(cond()).toBe(true);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const logLines = (): string[] => (existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8").split("\n").filter(l => l.trim() !== "") : []);

/** The rate-limit episode posts among every discord hit: a normal allowed stop's hand-back post
 *  (the existing behavior) lands on the same fake server and must not be counted here. */
const rlHits = (): Hit[] => discordHits.filter(h => h.text.startsWith("⏳"));

// --- event builders: the shapes omp's events carry (plan 20261025_0130) ---

type MsgOpts = { stopReason?: string; text?: string; errorMessage?: string; toolCall?: boolean; model?: string };

function msg(opts: MsgOpts = {}): Record<string, unknown> {
	const content: Record<string, unknown>[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) content.push({ type: "toolCall", id: "c1", name: "bash" });
	return {
		role: "assistant",
		model: opts.model ?? "test-model",
		stopReason: opts.stopReason ?? "stop",
		content,
		...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
	};
}

/** The real provider answer shape from 2026-10-25 02:07:49Z, with a controlled retry-after. */
const err429 = (retryMs: number): Record<string, unknown> =>
	msg({
		stopReason: "error",
		errorMessage: `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_x"} retry-after-ms=${retryMs}`,
	});

const stopEvent = (m: Record<string, unknown>): Record<string, unknown> => ({ last_assistant_message: m, messages: [m] });

// --- fake extension host (same shape as tests/notify-post.test.ts) ---

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Host {
	sent: string[];
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => unknown }): void;
	sendUserMessage(content: string): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: string }): void;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
}

function fakeHost(): Host {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	return {
		sent,
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage(content) {
			sent.push(content);
		},
		sendMessage() {},
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

interface Ctx {
	agent: { kind: string; id: string };
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string };
	getAsyncJobSnapshot(): { running: unknown[]; recent: unknown[]; delivery: unknown };
	waitForIdle(): Promise<void>;
	newSession(): Promise<{ cancelled: boolean }>;
	shutdown(): void;
	ui: { notify(message: string): void; getEditorText(): string };
}

function ctxFor(running: unknown[] = []): Ctx {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => SESSION_FILE },
		getAsyncJobSnapshot: () => ({ running, recent: [], delivery: {} }),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		shutdown: () => {},
		ui: { notify: () => {}, getEditorText: () => "" },
	};
}

function adapterWith(cfg: Config): Host {
	applyQueueEnv(cfg);
	const host = fakeHost();
	createOmpAdapter(host, cfg);
	return host;
}

// The parent shell may export live QUEUE_* (omp's plugin does); save, strip, restore.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
// The adapter's rollover/launcher paths spawn bun children that spill their transpile cache into
// $TMPDIR/node-compile-cache; point that inside TMP so the afterAll rmSync takes it with the
// sandbox.
const compileCacheBefore = process.env.NODE_COMPILE_CACHE;
process.env.NODE_COMPILE_CACHE = join(TMP, "compile-cache");

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

/** One open plan in a sandbox repo, listed in the sandbox queue index: session_stop has an open item to block on. */
function openPlanFixture(): () => void {
	const repo = join(TMP, "open-repo");
	const plan = join(repo, "docs/plans/20261025_open.md");
	mkdirSync(dirname(plan), { recursive: true });
	writeFileSync(plan, OPEN_PLAN);
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(blockersDirPath(), { recursive: true });
	mkdirSync(dirname(indexPath()), { recursive: true });
	writeFileSync(indexPath(), `${plan}\n`);
	return () => {
		writeFileSync(INDEX, "");
		rmSync(repo, { recursive: true, force: true });
	};
}

beforeAll(() => {
	writeConfig();
});

afterAll(() => {
	resetAdapter();
	discord.stop(true);
	if (compileCacheBefore === undefined) delete process.env.NODE_COMPILE_CACHE;
	else process.env.NODE_COMPILE_CACHE = compileCacheBefore;
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

// --- the probe loop on a fake clock ---

const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);
let now = T0;
let probeOk = false;
let spawns = 0;
let nowSpy: { mockRestore(): void };

const failingRun: ProbeRunner = () => ({ status: probeOk ? 0 : 1, stderr: probeOk ? "" : "still limited" });

/** The fake tick: `install` is the adapter's setInterval stand-in, `fire` runs the stored callback by hand. */
interface FakeTicks {
	install(fn: () => void, ms: number): Timer;
	fire(): void;
}

/** Keeps the adapter's tick callback so a test can fire it by hand; no timer ever runs. */
function fakeTicks(): FakeTicks {
	let cb: (() => void) | null = null;
	return {
		install(fn: () => void, _ms: number) {
			cb = fn;
			const handle = setInterval(() => {}, 1 << 30); // a real handle, so clearInterval has something to clear
			handle.unref();
			return handle;
		},
		fire: () => cb?.(),
	};
}

/** The omp ctx plus the adapter's two injection points: the tick and the probe spawner. */
function liveCtx(cfg: Config, ticks: FakeTicks): Record<string, unknown> {
	return {
		...ctxFor(),
		setInterval: ticks.install,
		spawnLimitProbe: () => {
			spawns++;
			probeStep(cfg, Date.now(), failingRun);
		},
	};
}

beforeEach(async () => {
	// The previous test's fire-and-forget posts must land while its own hit list still holds them:
	// drain the serial notify queue before reset() clears it, so no late post leaks into this test.
	await notifyIdle();
	reset();
	rmSync(join(QUEUE_STATE, "main-limit.json"), { force: true });
	now = T0;
	probeOk = false;
	spawns = 0;
	nowSpy = spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
	nowSpy.mockRestore();
	resetAdapter();
});

// A limited stop posts once; probes keep failing, so no back message goes out.
test("a limited stop posts once and sends no back message while probes keep failing", async () => {
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = liveCtx(cfg, ticks);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	expect(rlHits()[0]!.text).toMatch(/^⏳ Main hit its limit at \d\d:\d\d; checking every 5 s$/);
	expect(readLimitState(cfg)).toMatchObject({ back_at: null, next_probe_at: T0 + 5000, probes: 0 });
	now = T0 + 30_000;
	ticks.fire(); // probe 1: still limited
	now = T0 + 60_000;
	ticks.fire(); // probe 2: still limited
	expect(spawns).toBe(2);
	expect(readLimitState(cfg)).toMatchObject({ back_at: null, probes: 2 });
	expect(host.sent).toEqual([]);
	await sleep(100);
	expect(rlHits()).toHaveLength(1);
	expect(logLines().filter(l => l.includes("RATE-LIMIT stop"))).toHaveLength(1);
});

// A probe that gets through marks the episode back; the next tick sends the one back message.
test("a probe that gets through sends one back message and removes the episode", async () => {
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = liveCtx(cfg, ticks);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	now = T0 + 30_000;
	ticks.fire(); // probe 1: still limited
	probeOk = true;
	now = T0 + 60_000;
	ticks.fire(); // probe 2 gets through: marked back, nothing sent yet
	expect(readLimitState(cfg)).toMatchObject({ back_at: T0 + 60_000 });
	expect(host.sent).toEqual([]);
	now = T0 + 90_000;
	ticks.fire(); // the next tick sends the one back message and closes the episode
	expect(host.sent).toHaveLength(1);
	expect(host.sent[0]).toMatch(/^main-guard: the provider limit is over \(back at \d\d:\d\d\)\. Continue the queue where you stopped\.$/);
	expect(readLimitState(cfg)).toBeNull();
	expect(logLines().filter(l => l.includes("RATE-LIMIT back"))).toHaveLength(1);
	// P4: the owner hears exactly one back post (not one per probe), and the finished episode
	// becomes exactly one metric. Neither carries the probe's error text ("still limited").
	await until(() => discordHits.some(h => h.text.startsWith("✅")));
	const backs = discordHits.filter(h => h.text.startsWith("✅"));
	expect(backs).toHaveLength(1);
	expect(backs[0]!.text).toMatch(/^✅ Main is back at \d\d:\d\d \(limited 1 min, 2 checks\)$/);
	expect(JSON.stringify(discordHits)).not.toContain("still limited");
	expect(readMetricEvents(cfg).filter(e => e.type === "limit" && e.since === T0)).toEqual([
		{ type: "limit", since: T0, back_at: T0 + 60_000, minutes: 1, probes: 2, reset_named: false },
	]);
	ticks.fire(); // the tick is stopped: no second message, no probe
	expect(host.sent).toHaveLength(1);
	expect(spawns).toBe(2);
});

// An owner message cancels the tick but keeps the episode; a later limited stop re-arms it with the probe count intact.
test("an owner message mid-episode cancels the tick, and the probe count survives the re-arm", async () => {
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = liveCtx(cfg, ticks);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	now = T0 + 30_000;
	ticks.fire(); // probe 1: still limited
	expect(readLimitState(cfg)).toMatchObject({ probes: 1 });
	await host.emit("before_agent_start", { prompt: "hello" }, ctx);
	expect(logLines().filter(l => l.includes("RATE-LIMIT tick cancelled: owner message"))).toHaveLength(1);
	now = T0 + 60_000;
	ticks.fire(); // cancelled: no probe runs
	expect(spawns).toBe(1);
	expect(readLimitState(cfg)).toMatchObject({ probes: 1 });
	now = T0 + 60_000;
	await host.emit("session_stop", stopEvent(err429(2000)), ctx); // a new limited stop re-arms the tick
	expect(readLimitState(cfg)).toMatchObject({ probes: 1 });
	now = T0 + 90_000;
	ticks.fire(); // re-armed: probe 2 runs
	expect(spawns).toBe(2);
	expect(readLimitState(cfg)).toMatchObject({ probes: 2 });
	await sleep(100);
	expect(rlHits()).toHaveLength(1); // one limited post for the whole episode
});

// A turn that ends without a limit closes the episode: nothing is left to probe or send.
test("a turn that ends without a limit closes the episode; the next limit starts a new one", async () => {
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = liveCtx(cfg, ticks);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	await host.emit("session_stop", stopEvent(msg({ text: "all good" })), ctx);
	expect(readLimitState(cfg)).toBeNull();
	now = T0 + 30_000;
	ticks.fire();
	expect(spawns).toBe(0);
	expect(host.sent).toEqual([]);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 2);
	expect(logLines().filter(l => l.includes("RATE-LIMIT stop"))).toHaveLength(2);
});

// A named reset is waited for: no probe before it, one back message once it has passed.
test("a named reset is waited for: no probe before it, one back message after it", async () => {
	now = Date.UTC(2026, 9, 26, 22, 0, 0); // before the named reset 2026-10-26T23:04:26Z
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = liveCtx(cfg, ticks);
	await host.emit("session_stop", stopEvent(msg({ stopReason: "error", errorMessage: ZAI_RESET_TEXT })), ctx);
	await until(() => rlHits().length === 1);
	expect(readLimitState(cfg)).toMatchObject({ reset_named: true, back_at: ZAI_RESET_EPOCH_S * 1000 });
	now = Date.UTC(2026, 9, 26, 23, 0, 0);
	ticks.fire();
	expect(spawns).toBe(0);
	expect(host.sent).toEqual([]);
	now = ZAI_RESET_EPOCH_S * 1000 + 30_000;
	ticks.fire(); // back_at has passed: the back message, still no probe
	expect(spawns).toBe(0);
	expect(host.sent).toHaveLength(1);
	expect(readLimitState(cfg)).toBeNull();
});

// (d) a normal stop with an open queue still blocks as today.
test("a normal stop with an open queue still blocks, no post, no rate-limit lines", async () => {
	const restore = openPlanFixture();
	try {
		const cfg = stopCfg(writeConfig());
		const host = adapterWith(cfg);
		const ctx = ctxFor();
		const results = await host.emit("session_stop", stopEvent(msg({ text: "done for now" })), ctx);
		expect(results).toHaveLength(1);
		const decision = results[0] as { decision?: string; reason?: string };
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("main-guard");
		expect(discordHits).toEqual([]);
		expect(logLines().filter(l => l.includes("RATE-LIMIT"))).toEqual([]);
	} finally {
		restore();
	}
}, 30_000);

// (e) the idle-stop counters are unchanged by a 429 stop.
test("a 429 stop leaves the idle-stop counters alone: three real empty stops still needed", async () => {
	const restore = openPlanFixture();
	try {
		const cfg = stopCfg(writeConfig());
		const host = adapterWith(cfg);
		const ctx = liveCtx(cfg, fakeTicks());
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 1: BLOCK
		await host.emit("session_stop", stopEvent(err429(2000)), ctx); // rate limited: ALLOW, counters untouched
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 2: BLOCK
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 3: ALLOW after 3
		const blocks = logLines().filter(l => l.includes("BLOCK stop; open:"));
		expect(blocks).toHaveLength(2);
		const allows = logLines().filter(l => l.includes("ALLOW stop after 3 idle stop attempts"));
		expect(allows).toHaveLength(1);
		expect(logLines().indexOf(allows[0]!)).toBeGreaterThan(logLines().findIndex(l => l.includes("RATE-LIMIT stop")));
	} finally {
		restore();
	}
}, 30_000);

// The willContinue agent_end hand-back path opens the episode too, instead of logging "no reply text".
test("a rate-limited deferred hand-back opens the episode instead of logging no reply text", async () => {
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = { ...ctxFor([{ label: "bg-job" }]), setInterval: ticks.install, spawnLimitProbe: () => {} };
	await host.emit("agent_end", { willContinue: true, messages: [err429(2000)] }, ctx);
	expect(logLines().filter(l => l.includes("no reply text"))).toEqual([]);
	expect(logLines().filter(l => l.includes("RATE-LIMIT stop"))).toHaveLength(1);
	await until(() => rlHits().length === 1);
	expect(readLimitState(cfg)).toMatchObject({ back_at: null });
});

// I-20261031-313: the deferred hand-back path parses the named reset too — the episode waits for
// it and no probe runs before it, exactly like the session_stop path.
test("a rate-limited deferred hand-back waits for a named reset instead of probing", async () => {
	now = Date.UTC(2026, 9, 26, 22, 0, 0); // before the named reset 2026-10-26T23:04:26Z
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ticks = fakeTicks();
	const ctx = { ...ctxFor([{ label: "bg-job" }]), setInterval: ticks.install, spawnLimitProbe: () => {} };
	await host.emit("agent_end", { willContinue: true, messages: [msg({ stopReason: "error", errorMessage: ZAI_RESET_TEXT })] }, ctx);
	await until(() => rlHits().length === 1);
	expect(readLimitState(cfg)).toMatchObject({ reset_named: true, back_at: ZAI_RESET_EPOCH_S * 1000, probes: 0 });
	now = ZAI_RESET_EPOCH_S * 1000 + 30_000;
	ticks.fire();
	expect(spawns).toBe(0);
	expect(host.sent).toHaveLength(1);
	expect(readLimitState(cfg)).toBeNull();
});

// Plan 20261027_1500 P1: the named reset is parsed once. recordProviderOutFromRateLimit returns it in
// epoch ms (null when the text names none) and records the same epoch as the provider's out-until.
const ZAI_RESET_TEXT = `429 {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 07:04:26"}`;
// 07:04:26 Asia/Shanghai (quota.reset_tz) = 00:04:26 CET = 2026-10-26T23:04:26Z.
const ZAI_RESET_EPOCH_S = Date.UTC(2026, 9, 26, 23, 4, 26) / 1000;
const PROVIDER_STATE = new URL("../src/core/provider-state.ts", import.meta.url).pathname;
const rateLimitedReply = (errorMessage: string) => ({ text: "", stopReason: "error", toolCalls: 0, errorMessage, provider: "zai", model: null });

test("a named reset is parsed once: the returned ms and the recorded until are the same zone-correct epoch", () => {
	const cfg = writeConfig();
	const named = recordProviderOutFromRateLimit(rateLimitedReply(ZAI_RESET_TEXT), Date.now() + 5000, cfg);
	expect(named).toBe(ZAI_RESET_EPOCH_S * 1000);
	expect(readOut(cfg).at(-1)).toMatchObject({ provider: "zai", until: ZAI_RESET_EPOCH_S, source: "rate-limit-reset" });
});

test("a rate-limited text that names no reset time returns null and records the armed wait", () => {
	const cfg = writeConfig();
	const before = readOut(cfg).length;
	const named = recordProviderOutFromRateLimit(rateLimitedReply("429 rate limit reached, try later"), Date.now() + 5000, cfg);
	expect(named).toBeNull();
	expect(readOut(cfg).slice(before).map(r => r.source)).toEqual(["rate-limit"]);
});

test("the named reset epoch is the same under any process time zone", () => {
	const cfg = writeConfig();
	const script = `import(${JSON.stringify(PROVIDER_STATE)}).then(m => console.log(m.resetEpochFromText(${JSON.stringify(ZAI_RESET_TEXT)}, { pattern: ${JSON.stringify(cfg.quota.reset_pattern)}, zone: "Asia/Shanghai" })));`;
	for (const TZ of ["Europe/Berlin", "UTC"]) {
		const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME, TZ }, encoding: "utf8" });
		expect(r.stdout.trim()).toBe(String(ZAI_RESET_EPOCH_S));
	}
});
