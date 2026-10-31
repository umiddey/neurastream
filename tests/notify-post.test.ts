// Plan 20261024_2155 (P3): when a session stop hands the turn back to the owner, the adapter
// posts the last assistant text to the configured Discord and Slack webhooks — on every allow
// path, once per distinct text, never for a subagent, never while a relaunch is requested, and
// never delayed or thrown into the stop decision. Every request here lands on a local Bun.serve
// fake on 127.0.0.1; no real chat host is contacted.
//
// The waits below poll real I/O (`until`) or probe a bounded window (`expectNoMore`): the post is
// fire-and-forget by contract (the stop decision must not await it), so no promise or exposed
// signal exists to await, and fake timers cannot drive a real fetch against a real local server.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, reset as resetAdapter } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { postReply } from "../src/core/notify.ts";
import { notePath, relaunchPath } from "../src/core/rollover.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const REPO = dirname(dirname(import.meta.path));
const CLI = join(REPO, "src/cli/main.ts");
const TMP = mkdtempSync(join(tmpdir(), "notify-post-"));
const HOME = join(TMP, "home");
const QUEUE_STATE = join(TMP, "queue-state");
const INDEX = join(TMP, "INDEX.md");
const GUARD_LOG = join(TMP, "guard.log");
const SECRETS = join(TMP, "secrets");
const DISCORD_FILE = join(SECRETS, "discord-webhook");
const SLACK_FILE = join(SECRETS, "slack-webhook");
const SESSION_FILE = join(TMP, "session.jsonl");
const SESSION_ID = `notify-test-${process.pid}`;
const REPLY = "the final reply to the owner";
const BLOCKED_REPLY = "a reply written while the stop was blocked";

interface Hit {
	key: string;
	text: string;
}

type FakeMode = "ok" | "status500" | "hang" | "retryOnce" | "retryAlways" | "slow";

let discordMode: FakeMode = "ok";
let activeDiscordRequests = 0;
let maxActiveDiscordRequests = 0;
const discordHits: Hit[] = [];
const discord = Bun.serve({
	port: 0,
	fetch: async req => {
		const body = (await req.json()) as Record<string, unknown>;
		const key = Object.keys(body)[0] ?? "";
		discordHits.push({ key, text: String(body[key] ?? "") });
		if (discordMode === "status500") return new Response("no", { status: 500 });
		if (discordMode === "hang") await new Promise(() => {});
		if (discordMode === "retryOnce" && discordHits.length === 1) return Response.json({ retry_after: 0.2 }, { status: 429 });
		if (discordMode === "retryAlways") return Response.json({ retry_after: 0 }, { status: 429 });
		// A real overlap window is required here: fake time cannot control concurrently handled
		// server requests or prove that two network handlers were active at once.
		if (discordMode === "slow") {
			activeDiscordRequests++;
			maxActiveDiscordRequests = Math.max(maxActiveDiscordRequests, activeDiscordRequests);
			await new Promise(resolve => setTimeout(resolve, 30));
			activeDiscordRequests--;
		}
		return Response.json({});
	},
});
const discordUrl = `http://127.0.0.1:${discord.port}/hook`;

const slackHits: Hit[] = [];
const slack = Bun.serve({
	port: 0,
	fetch: async req => {
		const body = (await req.json()) as Record<string, unknown>;
		const key = Object.keys(body)[0] ?? "";
		slackHits.push({ key, text: String(body[key] ?? "") });
		return Response.json({});
	},
});
const slackUrl = `http://127.0.0.1:${slack.port}/hook`;

function writeConfig(notifyBody: string): Config {
	mkdirSync(dirname(join(HOME, ".config/neurastream/config.yml")), { recursive: true });
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  queue_index: "${INDEX}"
  queue_state: "${QUEUE_STATE}"
  guard_log: "${GUARD_LOG}"
  plan_guard_log: "${join(TMP, "plan-guard.log")}"
notify:
${notifyBody}
`,
	);
	return loadConfig({ home: HOME });
}

const bothCfg = (): Config =>
	writeConfig(`  discord_webhook_file: "${DISCORD_FILE}"
  slack_webhook_file: "${SLACK_FILE}"`);
const slackOnlyCfg = (): Config => writeConfig(`  slack_webhook_file: "${SLACK_FILE}"`);

// The stop guard reads the queue index: absent = nothing open = the stop is allowed. A listed
// open plan blocks it (the pinned ledger has no live subagent rows).
const stopCfg = (cfg: Config): Config => ({ ...cfg, guards: { ...cfg.guards, ledger_command: "printf 'MAIN x RUNNING\\n'" } });

function seedSecrets(): void {
	mkdirSync(SECRETS, { recursive: true });
	writeFileSync(DISCORD_FILE, `${discordUrl}\n`);
	writeFileSync(SLACK_FILE, `${slackUrl}\n`);
}

function writeSession(text: string, pad = false): void {
	const lines = [JSON.stringify({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } })];
	if (pad) lines.push(JSON.stringify({ pad: "x".repeat(4096) }));
	writeFileSync(SESSION_FILE, `${lines.join("\n")}\n`);
}

function reset(): void {
	discordHits.length = 0;
	slackHits.length = 0;
	discordMode = "ok";
	activeDiscordRequests = 0;
	maxActiveDiscordRequests = 0;
	writeFileSync(INDEX, "");
	delete process.env.NEURASTREAM_MAIN_LAUNCHER;
	rmSync(GUARD_LOG, { force: true });
	rmSync(notePath(SESSION_ID), { force: true });
	rmSync(join(QUEUE_STATE, "notify-waiting.json"), { force: true });
	writeSession("");
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

/** Bounded probe for a negative claim (no further request arrives): real network I/O with no
 *  exposed promise, so a short real window is the only honest check; a stalled machine can only
 *  weaken it to a false pass, never fail correct code. */
async function expectNoMore(count: () => number, expected: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 150);
	await promise;
	expect(count()).toBe(expected);
}

const notifyLogLines = (): string[] => (existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8").split("\n").filter(l => l.includes("notify:")) : []);

function decisionOf(r: unknown): string {
	if (r !== null && typeof r === "object" && "decision" in r) return String(r.decision);
	return "";
}

// Plan 20261025_0130: the reply a stop or agent_end posts comes from the event itself, not from
// the session file (omp fires session_stop BEFORE agent_end, and skips it entirely while an async
// job is pending — a file read lags a whole turn or never happens). `msg` builds one assistant
// AgentMessage as omp's events carry it; `stopEvent` a session_stop payload.
type MsgOpts = { stopReason?: string; toolCall?: boolean };

function msg(text: string, opts: MsgOpts = {}): Record<string, unknown> {
	return {
		role: "assistant",
		stopReason: opts.stopReason ?? "stop",
		content: [{ type: "text", text }, ...(opts.toolCall ? [{ type: "toolCall", id: "c1", name: "bash" }] : [])],
	};
}

function stopEvent(text: string): Record<string, unknown> {
	return { last_assistant_message: msg(text), messages: [msg("an earlier turn"), msg(text)] };
}

// --- fake extension host (same shape as tests/rollover-omp.test.ts) ---

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;

interface Host {
	commands: Map<string, CommandHandler>;
	sent: string[];
	messages: Array<{ message: { customType: string; content: string; display: boolean }; options: { triggerTurn: boolean; deliverAs: string } }>;
	on(event: string, cb: Handler): void;
	registerCommand(name: string, opts: { handler: CommandHandler }): void;
	sendUserMessage(content: string): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: string }): void;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
}

function fakeHost(): Host {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const sent: string[] = [];
	const messages: Host["messages"] = [];
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

function ctxFor(kind: "main" | "sub", running: unknown[] = []): Ctx {
	return {
		agent: { kind, id: kind === "main" ? "main" : "w1" },
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

const PLAN = join(TMP, "docs/plans/20261024_toy.md");
const TOY_PLAN = `# Toy

## Goal
- blocked-stop toy

## Phases
- [ ] P1 not done

## Progress
Status: open
`;

beforeAll(() => {
	mkdirSync(dirname(PLAN), { recursive: true });
	writeFileSync(PLAN, TOY_PLAN);
	bothCfg();
});

// The stop path posts fire-and-forget (postReply().then chains append guard.log/metrics/incidents
// after the await points), and postReply serializes through a module-level FIFO queue. Another
// file's real timers (rate-limit-omp's resume waits) keep this process's loop turning past this
// file's afterAll, so a chain landing after the rmSync would recreate the sandbox. Awaiting one
// more enqueued post drains the FIFO: every earlier chain, its retry waits and its .then tails
// have landed once the sentinel resolves. The sentinel targets the stopped fakes, so it returns
// fast once the queue is empty.
const compileCacheBefore = process.env.NODE_COMPILE_CACHE;
process.env.NODE_COMPILE_CACHE = join(TMP, "compile-cache");

afterAll(async () => {
	discord.stop(true);
	slack.stop(true);
	await postReply("settle", bothCfg());
	// Clear the active adapter's rollover state before the sandbox dirs are removed (P3c).
	resetAdapter();
	rmSync(TMP, { recursive: true, force: true });
	if (compileCacheBefore === undefined) delete process.env.NODE_COMPILE_CACHE;
	else process.env.NODE_COMPILE_CACHE = compileCacheBefore;
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

test("an allowed stop posts the text to each configured provider once, with the right JSON key", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", { messages: [msg(REPLY)] }, ctx);
	expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]).toEqual({ key: "content", text: REPLY });
	expect(slackHits[0]).toEqual({ key: "text", text: REPLY });
});

test("the rollover-ready path relaunches and posts nothing", async () => {
	reset();
	writeSession(REPLY, true);
	// Any session size crosses this threshold; the fresh note makes the state ready.
	const tiny: Config = { ...stopCfg(bothCfg()), rollover: { enabled: true, max_session_mb: 0.000001, exit_grace_s: 20 } };
	const host = adapterWith(tiny);
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	mkdirSync(dirname(notePath(SESSION_ID)), { recursive: true });
	writeFileSync(notePath(SESSION_ID), "## In progress\nstep");
	const later = (Date.now() + 5_000) / 1000;
	utimesSync(notePath(SESSION_ID), later, later);
	expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
	// The relaunch owns the session's end: the reply is not posted as a hand-back, and the
	// request file is written for the launcher.
	expect(discordHits.length).toBe(0);
	expect(slackHits.length).toBe(0);
	expect(existsSync(relaunchPath())).toBe(true);
});

test("a 4500-char reply is 3 discord and 2 slack chunks, in order, nothing lost", async () => {
	reset();
	const big = "x".repeat(4500);
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	await host.emit("session_stop", stopEvent(big), ctx);
	await until(() => discordHits.length === 3 && slackHits.length === 2);
	expect(discordHits.map(h => h.key)).toEqual(["content", "content", "content"]);
	expect(discordHits.every(h => h.text.length <= 2000)).toBe(true);
	expect(discordHits.map(h => h.text).join("")).toBe(big);
	expect(slackHits.map(h => h.key)).toEqual(["text", "text"]);
	expect(slackHits.every(h => h.text.length <= 3000)).toBe(true);
	expect(slackHits.map(h => h.text).join("")).toBe(big);
});

test("a blocked stop posts its reply; the later allowed stop posts the final text", async () => {
	reset();
	writeFileSync(INDEX, `${PLAN}\n`);
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	const blocked = await host.emit("session_stop", stopEvent(BLOCKED_REPLY), ctx);
	expect(blocked.map(decisionOf)).toEqual(["block"]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("agent_end", {}, ctx);
	writeFileSync(INDEX, "");
	expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
	await until(() => discordHits.length === 2 && slackHits.length === 2);
	expect(discordHits.map(h => h.text)).toEqual([BLOCKED_REPLY, REPLY]);
	expect(slackHits.map(h => h.text)).toEqual([BLOCKED_REPLY, REPLY]);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (blocked session_stop)")).length).toBe(1);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (allowed session_stop)")).length).toBe(1);
});

test("the same text is posted once across two allowed stops", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("session_stop", stopEvent(REPLY), ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("session_stop", stopEvent(REPLY), ctx);
	await expectNoMore(() => discordHits.length, 1);
	await expectNoMore(() => slackHits.length, 1);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (allowed session_stop)")).length).toBe(1);
	expect(notifyLogLines().filter(l => l.includes("notify: skipped (duplicate, allowed session_stop)")).length).toBe(1);
});

test("a subagent session never posts", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("sub");
	await host.emit("agent_end", { willContinue: true, messages: [msg(REPLY)] }, ctx);
	expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
	expect(notifyLogLines().filter(l => l.includes("notify:")).length).toBe(0);
});

test("only the configured provider is posted to", async () => {
	reset();
	const host = adapterWith(stopCfg(slackOnlyCfg()));
	const ctx = ctxFor("main");
	expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
	await until(() => slackHits.length === 1);
	await expectNoMore(() => discordHits.length, 0);
});

test(
	"a 500 or a hanging provider never delays or changes the stop decision and logs one line each",
	async () => {
		reset();
		discordMode = "status500";
		// Slack hangs: a fake that accepts the connection and never answers; the client aborts at 5s.
		const hang = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) as unknown as Response });
		writeFileSync(SLACK_FILE, `http://127.0.0.1:${hang.port}/hook\n`);
		try {
			const host = adapterWith(stopCfg(bothCfg()));
			const ctx = ctxFor("main");
			await host.emit("agent_end", {}, ctx);
			const t0 = Date.now();
			expect(await host.emit("session_stop", stopEvent(REPLY), ctx)).toEqual([]);
			expect(Date.now() - t0).toBeLessThan(2000);
			// The decision logs its posted line at once; each failing provider logs one error line
			// (Discord at once, Slack at the 5s abort): three notify lines in total, no retry.
			await until(() => notifyLogLines().filter(l => l.includes("notify: posted (allowed session_stop)")).length === 1);
			await until(() => notifyLogLines().filter(l => l.includes("notify: discord:")).length === 1);
			expect(discordHits.length).toBe(1);
			expect(slackHits.length).toBe(0);
			await until(() => notifyLogLines().filter(l => l.includes("notify: slack:")).length === 1);
			await expectNoMore(() => notifyLogLines().length, 3);
			await expectNoMore(() => discordHits.length, 1);
		} finally {
			hang.stop(true);
		}
	},
	20000,
);

test("postReply refuses an empty secret file and a non-https URL without posting", async () => {
	reset();
	writeFileSync(DISCORD_FILE, "   \n");
	writeFileSync(SLACK_FILE, "http://example.com/hook\n");
	const rs = await postReply(REPLY, bothCfg());
	expect(rs.map(r => r.posted)).toEqual([false, false]);
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
});

test(
	"neurastream notify test exits 0 when every configured provider accepts, 1 when one fails",
	async () => {
		reset();
		const env = { ...process.env, HOME };
		// Async spawn: the fakes are hosted in this process, and a synchronous spawn would block
		// the event loop they answer on.
		const run = (): Promise<number> => {
			const proc = Bun.spawn(["bun", CLI, "notify", "test"], { env, stdout: "pipe", stderr: "pipe" });
			return proc.exited.then(code => code ?? 1);
		};
		expect(await run()).toBe(0);
		await until(() => discordHits.length >= 1 && slackHits.length >= 1);
		discordMode = "status500";
		expect(await run()).toBe(1);
	},
	20000,
);

// --- plan 20261025_0130: every hand-back to the owner reaches Discord ---

test("handback (a): an allowed stop posts its own event reply B, not the earlier agent_end reply A", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", { messages: [msg("reply A from the last run")] }, ctx);
	expect(await host.emit("session_stop", stopEvent("reply B from this run"), ctx)).toEqual([]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits.map(h => h.text)).toEqual(["reply B from this run"]);
	expect(slackHits.map(h => h.text)).toEqual(["reply B from this run"]);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (allowed session_stop)")).length).toBe(1);
});

test("handback (b): the first stop of a session, no earlier agent_end, posts the reply from messages", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	expect(await host.emit("session_stop", { messages: [msg("earlier"), msg(REPLY)] }, ctx)).toEqual([]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toBe(REPLY);
	expect(slackHits[0]?.text).toBe(REPLY);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (allowed session_stop)")).length).toBe(1);
});

test("handback (c): agent_end willContinue with an async job pending and no stop follows posts the text-only reply once", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main", [{ label: "bg-1" }]);
	await host.emit("agent_end", { willContinue: true, messages: [msg(REPLY)] }, ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toBe(REPLY);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (agent_end hand-back)")).length).toBe(1);
	await host.emit("agent_end", { willContinue: true, messages: [msg(REPLY)] }, ctx);
	await expectNoMore(() => discordHits.length, 1);
});

test("handback (d): the same reply seen by both agent_end and session_stop is posted once", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main", [{ label: "bg-1" }]);
	await host.emit("agent_end", { willContinue: true, messages: [msg(REPLY)] }, ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("session_stop", stopEvent(REPLY), ctx);
	await expectNoMore(() => discordHits.length, 1);
	await expectNoMore(() => slackHits.length, 1);
	expect(notifyLogLines().filter(l => l.includes("notify: posted")).length).toBe(1);
	expect(notifyLogLines().filter(l => l.includes("notify: skipped (duplicate, allowed session_stop)")).length).toBe(1);
});

test("handback (e): a blocked stop posts the reply and logs the post", async () => {
	reset();
	writeFileSync(INDEX, `${PLAN}\n`);
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	const blocked = await host.emit("session_stop", stopEvent(BLOCKED_REPLY), ctx);
	expect(blocked.map(decisionOf)).toEqual(["block"]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toBe(BLOCKED_REPLY);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (blocked session_stop)")).length).toBe(1);
});

test("handback (f): a willContinue agent_end whose last message has tool calls posts nothing and logs the skip", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main", [{ label: "bg-1" }]);
	await host.emit("agent_end", { willContinue: true, messages: [msg("running the check now", { stopReason: "toolUse", toolCall: true })] }, ctx);
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
	expect(notifyLogLines().filter(l => l.includes("notify: skipped (mid-run: stop reason toolUse + 1 tool call(s), agent_end hand-back)")).length).toBe(1);
});

test("handback (g): blocked stop reply posts once; agent_end skips duplicate", async () => {
	reset();
	writeFileSync(INDEX, `${PLAN}\n`);
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main", [{ label: "bg-1" }]);
	const blocked = await host.emit("session_stop", stopEvent(BLOCKED_REPLY), ctx);
	expect(blocked.map(decisionOf)).toEqual(["block"]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("agent_end", { willContinue: true, messages: [msg(BLOCKED_REPLY)] }, ctx);
	await expectNoMore(() => discordHits.length, 1);
	await expectNoMore(() => slackHits.length, 1);
	expect(notifyLogLines().filter(l => l.includes("notify: skipped (stop blocked, agent_end)")).length).toBe(1);
});

test("handback (h): a willContinue agent_end with no pending async job posts nothing", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", { willContinue: true, messages: [msg(REPLY)] }, ctx);
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
	expect(notifyLogLines().filter(l => l.includes("notify: skipped (no pending job, agent_end)")).length).toBe(1);
});

// --- plan 20261025_0130 P3b: "Needs you" pings ---

const WAIT_PLAN = join(TMP, "docs/plans/20261025_waiting.md");
const WAIT_TEXT = `# Waiting toy

## Goal
- needs-you toy

## Phases
- [ ] P1 not done

## Progress
Status: open
WAITING on owner: choose A or B
`;

const needsYouLines = (): string[] => notifyLogLines().filter(l => l.includes("notify: needs-you"));

function listWaitPlan(): void {
	writeFileSync(WAIT_PLAN, WAIT_TEXT);
	writeFileSync(INDEX, `${WAIT_PLAN}\n`);
}

test("needs-you (1): a new WAITING line posts one ping with the plan and the question", async () => {
	reset();
	listWaitPlan();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toContain("- Waiting toy: choose A or B");
	// ui is off in this config: no phone-page link.
	expect(discordHits[0]?.text).not.toContain("http");
	expect(needsYouLines().filter(l => l.includes("notify: needs-you posted (waiting: ")).length).toBe(1);
});

test("needs-you (2): the same WAITING line on the next turn posts nothing", async () => {
	reset();
	listWaitPlan();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("agent_end", {}, ctx);
	await expectNoMore(() => discordHits.length, 1);
	await expectNoMore(() => slackHits.length, 1);
	expect(needsYouLines().filter(l => l.includes("notify: needs-you skipped (no new waiting lines)")).length).toBe(1);
});

test("needs-you (3): the WAITING line removed then re-added posts again", async () => {
	reset();
	listWaitPlan();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	writeFileSync(INDEX, "");
	await host.emit("agent_end", {}, ctx);
	writeFileSync(INDEX, `${WAIT_PLAN}\n`);
	await host.emit("agent_end", {}, ctx);
	await until(() => discordHits.length === 2 && slackHits.length === 2);
	expect(discordHits[1]?.text).toContain("- Waiting toy: choose A or B");
	expect(needsYouLines().filter(l => l.includes("notify: needs-you posted (waiting: ")).length).toBe(2);
});

test("needs-you (4): a protected-file refusal pings for an unlock once per 30 min", async () => {
	reset();
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main");
	const call = (): Record<string, unknown> => ({ toolName: "write", input: { path: join(QUEUE_STATE, "x.txt") }, toolCallId: "t1" });
	const first = await host.emit("tool_call", call(), ctx);
	expect(String((first[0] as Record<string, unknown>).reason)).toContain("is a protected guard file");
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toContain('🔓 Main needs an unlock to continue (x.txt). Tap "unlock 30" on the phone page.');
	expect(needsYouLines().filter(l => l.includes("notify: needs-you posted (protected-file refusal)")).length).toBe(1);
	await host.emit("tool_call", call(), ctx);
	await expectNoMore(() => discordHits.length, 1);
	expect(needsYouLines().filter(l => l.includes("notify: needs-you skipped (unlock ping sent recently)")).length).toBe(1);
});

test("needs-you (5): a subagent session never pings", async () => {
	reset();
	listWaitPlan();
	const host = adapterWith(stopCfg(bothCfg()));
	await host.emit("agent_end", {}, ctxFor("main"));
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	discordHits.length = 0;
	slackHits.length = 0;
	await host.emit("agent_end", {}, ctxFor("sub", [{ label: "bg-1" }]));
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
	expect(needsYouLines().filter(l => l.includes("notify: needs-you posted")).length).toBe(1);
});

test("needs-you (6): notify off pings nothing and does not throw", async () => {
	reset();
	listWaitPlan();
	const host = adapterWith(
		writeConfig(`  discord_webhook_file: ""
  slack_webhook_file: ""`),
	);
	const ctx = ctxFor("main");
	await host.emit("agent_end", {}, ctx);
	await expectNoMore(() => discordHits.length, 0);
	await expectNoMore(() => slackHits.length, 0);
	expect(needsYouLines().filter(l => l.includes("notify: needs-you skipped (notify off, waiting: ")).length).toBe(1);
});

test("needs-you batches all fresh plans into one post", async () => {
	reset();
	const second = join(TMP, "docs/plans/20261025_waiting-two.md");
	const third = join(TMP, "docs/plans/20261025_waiting-three.md");
	writeFileSync(WAIT_PLAN, WAIT_TEXT);
	writeFileSync(second, WAIT_TEXT.replace("Waiting toy", "Waiting two").replace("choose A or B", "choose C"));
	writeFileSync(third, WAIT_TEXT.replace("Waiting toy", "Waiting three").replace("choose A or B", "choose D"));
	writeFileSync(INDEX, `${WAIT_PLAN}\n${second}\n${third}\n`);
	const host = adapterWith(stopCfg(bothCfg()));
	await host.emit("agent_end", {}, ctxFor("main"));
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	expect(discordHits[0]?.text).toContain("🔔 Needs you (3):");
	expect(discordHits[0]?.text).toContain("Waiting toy");
	expect(discordHits[0]?.text).toContain("Waiting two");
	expect(discordHits[0]?.text).toContain("Waiting three");
	expect(needsYouLines().filter(l => l.includes("notify: needs-you posted (waiting: 3 plans)")).length).toBe(1);
});

test("blocked stop posts its reply once and agent_end does not duplicate it", async () => {
	reset();
	writeFileSync(INDEX, `${PLAN}\n`);
	const host = adapterWith(stopCfg(bothCfg()));
	const ctx = ctxFor("main", [{ label: "bg-1" }]);
	const blocked = await host.emit("session_stop", stopEvent(BLOCKED_REPLY), ctx);
	expect(blocked.map(decisionOf)).toEqual(["block"]);
	await until(() => discordHits.length === 1 && slackHits.length === 1);
	await host.emit("agent_end", { willContinue: true, messages: [msg(BLOCKED_REPLY)] }, ctx);
	await expectNoMore(() => discordHits.length, 1);
	await expectNoMore(() => slackHits.length, 1);
	expect(discordHits[0]?.text).toBe(BLOCKED_REPLY);
	expect(notifyLogLines().filter(l => l.includes("notify: posted (blocked session_stop)")).length).toBe(1);
});

test("postReply serializes concurrent calls in invocation order without overlap", async () => {
	reset();
	discordMode = "slow";
	const cfg = writeConfig(`  discord_webhook_file: "${DISCORD_FILE}"`);
	const first = postReply("first", cfg);
	const second = postReply("second", cfg);
	const third = postReply("third", cfg);
	await Promise.all([first, second, third]);
	expect(discordHits.map(hit => hit.text)).toEqual(["first", "second", "third"]);
	expect(maxActiveDiscordRequests).toBe(1);
});

test("postReply retries one 429 after retry_after", async () => {
	reset();
	discordMode = "retryOnce";
	const result = await postReply("retry me", writeConfig(`  discord_webhook_file: "${DISCORD_FILE}"`));
	expect(result[0]).toMatchObject({ posted: true, chunks: 1, error: "" });
	expect(discordHits).toHaveLength(2);
});

test("postReply returns the second 429 as failure", async () => {
	reset();
	discordMode = "retryAlways";
	const result = await postReply("still limited", writeConfig(`  discord_webhook_file: "${DISCORD_FILE}"`));
	expect(result[0]).toMatchObject({ posted: false, error: expect.stringContaining("answered 429") });
	expect(discordHits).toHaveLength(2);
});
