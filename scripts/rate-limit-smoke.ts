// Rate-limit live smoke (plan 20261025_0640 P3, adapter-replay fallback). omp's provider catalog
// comes from models.dev (pi-catalog) with per-provider auth storage; its config.yml schema exposes
// no custom-provider/base-URL key, so it cannot be pointed at a local 429 stub without patching
// the harness. Per the plan, this script instead replays a recorded 429 `session_stop` through
// the adapter of THIS worktree inside a throwaway HOME:
//
//   HOME=$TMP/home  QUEUE_*=sandbox  guard log=$TMP/guard.log  discord webhook=$TMP/secrets/discord
//   listener=Bun.serve on 127.0.0.1 (port 0) counting POSTs
//
// The replayed turn end is the real 02:07:49Z shape (`429 {"type":"error","error":{"type":
// "rate_limit_error",…}}` with the retry-after set to the plan's stub value 20000 ms), so the
// expected wait is 20 s + slack 15 s = 35 s. Observed and printed for the plan's Progress:
//   - `RATE-LIMIT stop: resume at HH:MM (35s, attempt 1)` in the sandbox guard log
//   - exactly one webhook POST (the ⏳ text) at the local listener
//   - `RATE-LIMIT resume` about 35 s later, then exactly one new user message (the new turn's
//     trigger; in this replay the message goes to a recorded sink instead of a live session)
//
// Run: bun scripts/rate-limit-smoke.ts   (exits 0 when every observation holds)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOmpAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const TMP = mkdtempSync(join(tmpdir(), "neurastream-smoke-rl-"));
const HOME = join(TMP, "home");
const GUARD_LOG = join(TMP, "guard.log");
const INDEX = join(TMP, "INDEX.md");
const DISCORD_FILE = join(TMP, "secrets", "discord-webhook");
const SESSION_FILE = join(TMP, "session.jsonl");

interface Hit {
	key: string;
	text: string;
}

const hits: Hit[] = [];
const listener = Bun.serve({
	port: 0,
	fetch: async req => {
		if (req.method !== "POST") return new Response("no", { status: 405 });
		const body = (await req.json()) as Record<string, unknown>;
		const key = Object.keys(body)[0] ?? "";
		hits.push({ key, text: String(body[key] ?? "") });
		return Response.json({});
	},
});

// The recorded 429: the real provider answer of 2026-10-25 02:07:49Z, retry-after set to the
// plan's stub value (20000 ms) so the smoke waits 35 s, not 12 minutes.
const RECORDED_429 = `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_011CgN93NGbSQ3eRQEzJS7qT"} retry-after-ms=20000`;
const stopEvent = {
	last_assistant_message: { role: "assistant", stopReason: "error", content: [], errorMessage: RECORDED_429 },
	messages: [{ role: "assistant", stopReason: "error", content: [], errorMessage: RECORDED_429 }],
};

// Sandbox config: template defaults (rate_limit slack 15), one webhook, everything under TMP.
mkdirSync(dirname(join(HOME, ".config/neurastream/config.yml")), { recursive: true });
mkdirSync(dirname(DISCORD_FILE), { recursive: true });
writeFileSync(DISCORD_FILE, `http://127.0.0.1:${listener.port}/hook\n`);
writeFileSync(
	join(HOME, ".config/neurastream/config.yml"),
	`paths:
  home: "${HOME}"
  queue_index: "${INDEX}"
  queue_state: "${join(TMP, "queue-state")}"
  guard_log: "${GUARD_LOG}"
  plan_guard_log: "${join(TMP, "plan-guard.log")}"
notify:
  discord_webhook_file: "${DISCORD_FILE}"
`,
);
writeFileSync(INDEX, "");
writeFileSync(SESSION_FILE, "");

// The caller's shell may export live QUEUE_* (omp's plugin does); strip, then point at the sandbox.
for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
const cfg: Config = loadConfig({ home: HOME });
applyQueueEnv(cfg);

// The recorded sink for the resume message: a fake extension host that stores the registered
// handlers so the script can emit the recorded session_stop exactly as omp would; everything
// else (guard calls, notify post, resume timer) is the real adapter code of this worktree.
const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
const sent: string[] = [];
const pi: ExtensionHost = {
	on(event, cb) {
		handlers.set(event, [...(handlers.get(event) ?? []), cb]);
	},
	registerCommand() {},
	sendUserMessage(content: string) {
		sent.push(content);
	},
	sendMessage() {},
};

const fail = (why: string): never => {
	console.error(`SMOKE FAIL: ${why}`);
	listener.stop(true);
	rmSync(TMP, { recursive: true, force: true });
	process.exit(1);
};

createOmpAdapter(pi, cfg);
const t0 = Date.now();
// session_stop fires exactly as omp would deliver the recorded turn end (main ctx envelope); the
// ALLOW shows in the sandbox guard log (no BLOCK line) and in the one episode POST below.
for (const cb of handlers.get("session_stop") ?? []) await cb(stopEvent, { agent: { kind: "main", id: "main" }, cwd: TMP });

// 1) the stop log line, synchronously written by the handler
const logSoFar = (): string[] => (existsSync(GUARD_LOG) ? readFileSync(GUARD_LOG, "utf8").split("\n").filter(l => l.trim() !== "") : []);
const stopLine = logSoFar().find(l => l.includes("RATE-LIMIT stop"));
if (!stopLine || !/RATE-LIMIT stop: resume at \d\d:\d\d \(35s, attempt 1\)$/.test(stopLine)) fail(`no RATE-LIMIT stop (35s, attempt 1) line in ${GUARD_LOG}: ${JSON.stringify(logSoFar())}`);

// 2) exactly one webhook POST, the ⏳ text (fire-and-forget; poll the real listener briefly)
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) fail(`timeout waiting for ${what}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 50);
		await promise;
	}
}
await until(() => hits.length === 1, 9000, "the episode webhook POST");
if (!hits[0]!.text.startsWith("⏳ Main is rate limited by its provider until ")) fail(`wrong post text: ${JSON.stringify(hits[0])}`);

// 3) the resume about 35 s later: log line + exactly one new user message (the new turn's trigger)
await until(() => sent.length === 1, 45_000, "the resume user message");
const elapsedS = Math.round((Date.now() - t0) / 1000);
const lines = logSoFar();
const resumeLine = lines.find(l => l.includes("RATE-LIMIT resume"));
if (!resumeLine) fail(`no RATE-LIMIT resume line: ${JSON.stringify(lines)}`);
if (!sent[0]!.startsWith("main-guard: the provider rate limit is over (waited until ")) fail(`wrong resume message: ${JSON.stringify(sent)}`);
if (elapsedS < 30 || elapsedS > 45) fail(`resume at ${elapsedS}s, expected about 35s`);

console.log("SMOKE OK — sandbox guard log lines:");
for (const l of lines) if (l.includes("RATE-LIMIT") || l.includes("notify:")) console.log(`  ${l}`);
console.log("webhook POSTs observed at the local listener:");
for (const h of hits) console.log(`  POST ${h.key}: ${h.text}`);
console.log(`resume user message (${elapsedS}s after the stop): ${sent[0]}`);
console.log(`session file of the replay sandbox (kept for inspection): ${SESSION_FILE}`);

listener.stop(true);
rmSync(TMP, { recursive: true, force: true });
