// P9 (plan 20261027_1430): a phone-page owner message that has waited past
// notify.answer_within_min (default 3 min) with no hand-back steers Main once per message —
// "Owner asked at HH:MM; end your turn with the answer now" — through the omp adapter's
// tool_result hook, and a hand-back clears the wait. The watcher counts M8, one metric per
// waiting message (the release verdict reads it in the owner-pain group). Tests touch only a
// temp QUEUE_STATE sandbox — no real home, no live session, no network.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { beat } from "../src/core/heartbeat.ts";
import { readMetricEvents } from "../src/core/metrics.ts";
import { ownerAnswerHandback, ownerAnswerSteer, waitingOwnerMessages } from "../src/core/notify.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { watchOnce, type WatchDeps } from "../src/core/watch.ts";
import { createOmpAdapter, reset } from "../src/adapters/omp/index.ts";

const DIRS: string[] = [];
// The adapter test runs applyQueueEnv, which sets every QUEUE_* path; restore the caller's so
// nothing leaks into the test files that run after this one (index-guard (e) on macOS CI).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	reset();
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

/** Sandbox config; its queue_state is also QUEUE_STATE — owner-messages dirs and the steer
 * state live there (owner-ui's storeOwnerMessage and the adapter's applyQueueEnv both go
 * through stateDirPath()). Rollover stays off: the size check needs a live sessionManager. */
function sandbox(label: string, within?: number): Config {
	const dir = mkdtempSync(join(tmpdir(), `owner-answer-${label}-`));
	DIRS.push(dir);
	mkdirSync(join(dir, ".config/neurastream"), { recursive: true });
	let yaml = `paths:
  home: "${dir}"
  queue_index: "${join(dir, "INDEX.md")}"
  queue_state: "${join(dir, "queue-state")}"
  guard_log: "${join(dir, "guard.log")}"
  plan_guard_log: "${join(dir, "plan-guard.log")}"
rollover:
  enabled: false
`;
	if (within !== undefined) yaml += `notify:
  answer_within_min: ${within}
`;
	writeFileSync(join(dir, ".config/neurastream/config.yml"), yaml);
	const cfg = loadConfig({ home: dir, env: {} });
	process.env.QUEUE_STATE = join(dir, "queue-state");
	process.env.QUEUE_CLOSE_BIN = "true";
	return cfg;
}

/** A phone-page owner message the way storeOwnerMessage leaves it: dir `<ts>-<6 chars>`, message.json inside. */
function storeMessage(at: number, text: string): string {
	const id = `${Math.floor(at)}-aaaa01`;
	const dir = `${process.env.QUEUE_STATE}/owner-messages/${id}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/message.json`, `${JSON.stringify({ ts: at, text, login: "owner", images: [] })}\n`);
	return id;
}

const steerFor = (at: number): string => `Owner asked at ${strftime(at, "%H:%M")}; end your turn with the answer now`;

/** Fresh beats for every job in watch.expect, so the watcher sees nothing stale (watch-notify's healthy()). */
function healthy(cfg: Config): void {
	for (const name of Object.keys(cfg.watch.expect)) beat(cfg, name, { ok: true });
}

test("the default limit is 3 minutes", () => {
	const cfg = sandbox("default");
	expect(cfg.notify.answer_within_min).toBe(3);
});

test("a negative limit is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "owner-answer-neg-"));
	DIRS.push(dir);
	mkdirSync(join(dir, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(dir, ".config/neurastream/config.yml"),
		`paths:\n  home: "${dir}"\n  queue_index: "${join(dir, "INDEX.md")}"\n  queue_state: "${join(dir, "queue-state")}"\n  guard_log: "${join(dir, "guard.log")}"\n  plan_guard_log: "${join(dir, "plan-guard.log")}"\nnotify:\n  answer_within_min: -1\n`,
	);
	expect(() => loadConfig({ home: dir, env: {} })).toThrow(/answer_within_min/);
});

test("a message past the limit steers exactly once", () => {
	const cfg = sandbox("once");
	const at = nowSec() - 600;
	storeMessage(at, "how do I read the queue?");
	expect(ownerAnswerSteer(cfg, nowSec())).toBe(steerFor(at));
	expect(ownerAnswerSteer(cfg, nowSec() + 60)).toBeNull();
});

test("a fresh message and a 0 limit steer nothing", () => {
	const cfgOff = sandbox("off", 0);
	storeMessage(nowSec() - 600, "still waiting");
	expect(waitingOwnerMessages(cfgOff, nowSec())).toEqual([]);
	expect(ownerAnswerSteer(cfgOff, nowSec())).toBeNull();
	const cfgOn = sandbox("fresh");
	storeMessage(nowSec() - 10, "just asked");
	expect(ownerAnswerSteer(cfgOn, nowSec())).toBeNull();
});

test("a hand-back clears the wait; a new message after it steers again", () => {
	const cfg = sandbox("handback");
	const t0 = nowSec();
	storeMessage(t0 - 600, "first question");
	expect(ownerAnswerSteer(cfg, t0)).toBe(steerFor(t0 - 600));
	const t1 = t0 + 60;
	ownerAnswerHandback(t1);
	expect(waitingOwnerMessages(cfg, t1 + 400)).toEqual([]);
	expect(ownerAnswerSteer(cfg, t1 + 400)).toBeNull();
	// A message that arrives after the hand-back and then crosses the limit waits again.
	const at = t1 + 100;
	storeMessage(at, "second question");
	expect(waitingOwnerMessages(cfg, at + 300)).toHaveLength(1);
	expect(ownerAnswerSteer(cfg, at + 300)).toBe(steerFor(at));
});

test("the watcher counts M8 once per waiting message and posts nothing", () => {
	const cfg = sandbox("m8");
	healthy(cfg);
	const t = nowSec();
	const id = storeMessage(t - 600, "are we there yet?");
	const posts: string[] = [];
	const deps = (at: number): WatchDeps => ({
		now: () => at,
		listUnits: () => [],
		gather: (): GatedInputs => ({ results: [], runs: [], blocks: [] }),
		notify: text => posts.push(text),
		runner: () => ({ code: 1, stdout: "", stderr: "no forge in this test" }),
		plans: () => [],
		staffed: () => [],
	});
	const first = watchOnce(cfg, deps(t));
	expect(first.ownerWaits).toBe(1);
	expect(first.opened).toHaveLength(0);
	expect(posts).toEqual([]);
	const events = readMetricEvents(cfg).filter(e => e.type === "m8");
	expect(events).toHaveLength(1);
	expect(String(events[0]!.id)).toBe(id);
	expect(Number(events[0]!.ts)).toBe(t);
	expect(Number(events[0]!.waited_sec)).toBe(600);
	const second = watchOnce(cfg, deps(t));
	expect(second.ownerWaits).toBe(0);
	expect(readMetricEvents(cfg).filter(e => e.type === "m8")).toHaveLength(1);
});

test("the omp adapter steers once on tool_result and the hand-back clears it", () => {
	const cfg = sandbox("adapter");
	const sent: string[] = [];
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	createOmpAdapter(
		{
			on: (event, cb) => {
				const list = handlers.get(event) ?? [];
				list.push(cb as (e: unknown, ctx: unknown) => unknown);
				handlers.set(event, list);
			},
			registerCommand: () => {},
			sendUserMessage: content => sent.push(typeof content === "string" ? content : JSON.stringify(content)),
			sendMessage: () => {},
		},
		cfg,
		() => cfg,
	);
	const ctx = { hasAgent: true, kind: "main", id: "main", cwd: "/tmp" };
	const fireToolResult = (): void => {
		for (const cb of handlers.get("tool_result") ?? []) cb({ toolCallId: "t1", toolName: "bash", input: {}, content: [] }, ctx);
	};
	const at = nowSec() - 600;
	storeMessage(at, "did the release go out?");
	fireToolResult();
	expect(sent).toEqual([steerFor(at)]);
	fireToolResult();
	expect(sent).toHaveLength(1);
	// Terminal hand-back: the reply just posted answers the wait, so the old message never steers again.
	for (const cb of handlers.get("agent_end") ?? []) cb({ willContinue: undefined }, ctx);
	fireToolResult();
	expect(sent).toHaveLength(1);
});
