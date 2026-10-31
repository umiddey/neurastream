// Plan 20261025_0640 P2: the adapter turns a rate-limited stop into a wait-it-out: ALLOW without
// touching the idle-stop counters, one chat post per limit episode, one resume timer that gives
// Main a new turn when the wait is over, an owner message cancels the resume, and a rate-limited
// deferred hand-back (agent_end willContinue) arms the timer instead of logging "no reply text".
// Every request lands on a local Bun.serve fake on 127.0.0.1; no real chat host is contacted.
//
// Real short timers by exception (same reason as tests/notify-post.test.ts): the resume timer is
// internal to the adapter closure (no exposed promise), and firing it must drive a real fetch
// against the local webhook server — fake timers cannot advance a real network round-trip. The
// tests therefore parse a small retry-after-ms (2 s, slack 0) and poll with until(); the
// negative claims probe a bounded window just past the armed wait.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { blockersDirPath, indexPath } from "../src/core/queue/lib.ts";

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
    default_wait_s: 5
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

async function until(cond: () => boolean, ms = 9000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 25);
		await promise;
	}
}

/** Bounded probe for a negative claim (no further send arrives): real timers, no exposed handle. */
async function expectNoMore(count: () => number, expected: number, ms = 2600): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
	expect(count()).toBe(expected);
}

const logLines = (): string[] => (existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8").split("\n").filter(l => l.trim() !== "") : []);

/** The rate-limit episode posts among every discord hit: a normal allowed stop's hand-back post
 *  (the existing behavior) lands on the same fake server and must not be counted here. */
const rlHits = (): Hit[] => discordHits.filter(h => h.text.startsWith("⏳"));

// --- event builders: the shapes omp's events carry (plan 20261025_0130) ---

type MsgOpts = { stopReason?: string; text?: string; errorMessage?: string; toolCall?: boolean };

function msg(opts: MsgOpts = {}): Record<string, unknown> {
	const content: Record<string, unknown>[] = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) content.push({ type: "toolCall", id: "c1", name: "bash" });
	return {
		role: "assistant",
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
const err429WithoutRetryAfter = (): Record<string, unknown> =>
	msg({
		stopReason: "error",
		errorMessage: `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_x"}`,
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

// (a) a 429 stop → allowed, no block reason, one post, timer armed with the parsed wait; firing
// it sends exactly one user message.
test("a 429 stop is allowed with one episode post and one resume timer that sends one message", async () => {
	reset();
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ctx = ctxFor();
	const results = await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	expect(results).toEqual([]); // ALLOW: no block decision
	await until(() => rlHits().length === 1);
	expect(rlHits()[0]!.text).toMatch(/^⏳ Main is rate limited by its provider until \d\d:\d\d \(local\); it resumes on its own\.$/);
	const stop = logLines().filter(l => l.includes("RATE-LIMIT stop"));
	expect(stop).toHaveLength(1);
	expect(stop[0]).toMatch(/RATE-LIMIT stop: resume at \d\d:\d\d \(2s, attempt 1\)$/); // parsed 2s, slack 0
	await until(() => host.sent.length === 1, 8000);
	expect(host.sent[0]).toMatch(/^main-guard: the provider rate limit is over \(waited until \d\d:\d\d\)\. Continue the queue where you stopped\.$/);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume"))).toHaveLength(1);
}, 30_000);

// (b) a second 429 after the resume → doubled wait, no second post in the same episode; ONE
// timer (the doubled one) — the earlier arm is replaced, so exactly two messages in total.
test("a second 429 in the episode doubles the wait, replaces the timer, posts nothing", async () => {
	reset();
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(2000)), ctx); // attempt 1: 2 s
	await until(() => rlHits().length === 1);
	await host.emit("session_stop", stopEvent(err429WithoutRetryAfter()), ctx); // attempt 2: doubled default wait
	const stop = logLines().filter(l => l.includes("RATE-LIMIT stop"));
	expect(stop).toHaveLength(2);
	expect(stop[1]).toMatch(/RATE-LIMIT stop: resume at \d\d:\d\d \(10s, attempt 2\)$/);
	await expectNoMore(() => host.sent.length, 0); // past the replaced 2 s arm: nothing sent yet
	expect(rlHits()).toHaveLength(1); // no second post in the episode
	await until(() => host.sent.length === 1, 12_000); // only the doubled default timer fires
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume"))).toHaveLength(1);
	expect(rlHits()).toHaveLength(1);
}, 30_000);

// A non-turn input leaves the resume armed; only an actual Main turn takes it over.
test("slash command input leaves the resume armed until it fires", async () => {
	reset();
	const host = adapterWith(stopCfg(writeConfig()));
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(15_000)), ctx);
	await until(() => rlHits().length === 1, 20_000);
	await host.emit("input", { text: "/usage", source: "interactive" }, ctx);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume cancelled: owner message"))).toHaveLength(0);
	await until(() => host.sent.length === 1, 20_000);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume: new turn sent"))).toHaveLength(1);
}, 30_000);

test("handled chat unlock leaves the resume armed until it fires", async () => {
	reset();
	const cfg = writeConfig();
	const host = adapterWith(stopCfg({ ...cfg, guards: { ...cfg.guards, chat_unlock: true } }));
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	const unlockResults = await host.emit("input", { text: "unlock 5", source: "interactive" }, ctx);
	expect(unlockResults).toContainEqual({ handled: true });
	await until(() => host.sent.length === 1, 8000);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume: new turn sent"))).toHaveLength(1);
}, 30_000);

test("a Main turn takeover cancels the resume timer once", async () => {
	reset();
	const host = adapterWith(stopCfg(writeConfig()));
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	await host.emit("input", { text: "taking over", source: "interactive" }, ctx);
	await host.emit("before_agent_start", { prompt: "taking over" }, ctx);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume cancelled: owner message"))).toHaveLength(1);
	await expectNoMore(() => host.sent.length, 0);
}, 30_000);

test("the resume's own turn does not log a cancellation", async () => {
	reset();
	const host = adapterWith(stopCfg(writeConfig()));
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(2000)), ctx);
	await until(() => rlHits().length === 1);
	await until(() => host.sent.length === 1, 8000);
	await host.emit("before_agent_start", { prompt: host.sent[0] }, ctx);
	expect(logLines().filter(l => l.includes("RATE-LIMIT resume cancelled: owner message"))).toHaveLength(0);
}, 30_000);

// (d) a normal stop with an open queue still blocks as today.
test("a normal stop with an open queue still blocks, no post, no rate-limit lines", async () => {
	reset();
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
	reset();
	const restore = openPlanFixture();
	try {
		const cfg = stopCfg(writeConfig());
		const host = adapterWith(cfg);
		const ctx = ctxFor();
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 1: BLOCK
		await host.emit("session_stop", stopEvent(err429(2000)), ctx); // rate limited: ALLOW, counters untouched
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 2: BLOCK
		await host.emit("session_stop", stopEvent(msg({ text: "" })), ctx); // idle stop 3: ALLOW after 3
		const blocks = logLines().filter(l => l.includes("BLOCK stop; open:"));
		expect(blocks).toHaveLength(2);
		const allows = logLines().filter(l => l.includes("ALLOW stop after 3 idle stop attempts"));
		expect(allows).toHaveLength(1);
		expect(logLines().indexOf(allows[0]!)).toBeGreaterThan(logLines().findIndex(l => l.includes("RATE-LIMIT stop")));
		// The rate-limit episode reset on the next non-limited stop: its pending timer is gone.
		await expectNoMore(() => host.sent.length, 0);
	} finally {
		restore();
	}
}, 30_000);

// The willContinue agent_end hand-back path gets the same check.
test("a rate-limited deferred hand-back arms the timer instead of logging no reply text", async () => {
	reset();
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ctx = ctxFor([{ label: "bg-job" }]);
	await host.emit("agent_end", { willContinue: true, messages: [err429(2000)] }, ctx);
	expect(logLines().filter(l => l.includes("no reply text"))).toEqual([]);
	expect(logLines().filter(l => l.includes("RATE-LIMIT stop"))).toHaveLength(1);
	await until(() => rlHits().length === 1);
	await until(() => host.sent.length === 1, 8000);
	expect(host.sent[0]).toContain("the provider rate limit is over");
}, 30_000);

// The episode resets on a turn that ends without a rate limit: the next 429 is attempt 1 again.
test("after a normal turn the episode restarts: attempt 1 again and a fresh post", async () => {
	reset();
	const cfg = stopCfg(writeConfig());
	const host = adapterWith(cfg);
	const ctx = ctxFor();
	await host.emit("session_stop", stopEvent(err429(2000)), ctx); // attempt 1
	await until(() => rlHits().length === 1);
	await host.emit("session_stop", stopEvent(msg({ text: "all good" })), ctx); // normal turn end: episode over
	await expectNoMore(() => rlHits().length, 1, 500);
	await host.emit("session_stop", stopEvent(err429(2000)), ctx); // new episode: attempt 1, posts again
	const stops = logLines().filter(l => l.includes("RATE-LIMIT stop"));
	expect(stops).toHaveLength(2);
	expect(logLines().filter(l => l.includes("(2s, attempt 1)"))).toHaveLength(2);
	await until(() => rlHits().length === 2);
}, 30_000);
