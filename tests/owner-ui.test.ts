// Owner phone page (plan 20261024_2230_owner_phone_ui, P1): auth, page sections, the answer
// inbox, and unlock/lock — every request against a temp HOME with an injectable tailscale
// resolver and an injectable peer address, so no test ever calls the real tailscale binary or
// binds the real tailnet address. The server binds 127.0.0.1 here; who the request appears to
// come from is a startOwnerUi option, exactly the seam the real CLI leaves in place for these
// tests.

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec } from "../src/core/clock.ts";
import { addIncident } from "../src/core/incidents.ts";
import { appendMetric } from "../src/core/metrics.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { inboxPath, startOwnerUi, type OwnerUiOptions, type OwnerUiServer } from "../src/core/owner-ui.ts";
import { stateDirPath, unlockPath } from "../src/core/queue/lib.ts";
import type { Tailscale } from "../src/core/tailscale.ts";

const OWNER = "owner@example.com";
const OWN_IP = "100.95.10.2"; // fixture: this machine's tailnet address
const PEER = "100.95.10.9"; // fixture: the owner's phone
const QUESTION = "restart the pm runner after the disk cleanup";

const TMP = mkdtempSync(join(tmpdir(), "owner-ui-"));
// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); save and
// delete them before loadConfig so every path resolves under the sandbox home (see
// tests/guards-scope.test.ts:106-117 — the QUEUE_* env must be set after any process.env copy).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

const TOY = join(TMP, "toy");
const PLAN_W = join(TOY, "docs/plans/20261019_wait.md");
const PLAN_D = join(TOY, "docs/plans/20261019_done.md");

const PLAN_TEXT = (status: string, waiting: boolean) => `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Owner page toy.

## Forbidden
- Never skip tests.

## Blockers
- no-push

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: ${status}
${waiting ? `\nWAITING on owner: ${QUESTION}\n` : ""}
- Started the toy work.
`;

const baseCfg: Config = loadConfig({ home: join(TMP, "home") });
const CFG: Config = {
	...baseCfg,
	paths: {
		...baseCfg.paths,
		queue_state: join(TMP, "state"),
		guard_log: join(TMP, "guard.log"),
		plan_guard_log: join(TMP, "plan-guard.log"),
		ranking_board: join(TMP, "board.md"),
	},
	guards: { ...baseCfg.guards, chat_unlock: true },
	ui: { enabled: true, port: 7787, owner_login: OWNER },
};
applyQueueEnv(CFG);

const INDEX = CFG.paths.queue_index;
mkdirSync(join(TOY, "docs/plans"), { recursive: true });
mkdirSync(dirname(unlockPath()), { recursive: true });
mkdirSync(stateDirPath(), { recursive: true });
writeFileSync(PLAN_W, PLAN_TEXT("open", true));
writeFileSync(PLAN_D, PLAN_TEXT("complete", false));
writeFileSync(INDEX, `${PLAN_W}\n${PLAN_D}\n`);
writeFileSync(CFG.paths.ranking_board, "# Subagent ranking board\n\n- alice 4.2 (7d)\n");
appendMetric(CFG, { type: "ci", mr: "!77", repo: TOY, tries: 2, ts: nowSec() });
addIncident(CFG, { source: "main", kind: "toy", summary: "toy incident the page must show" });

function run(over: Partial<Run>): Run {
	return {
		id: "run",
		kind: "sub",
		model: "test/model",
		calls: 3,
		tokens: 100,
		cacheRead: 10,
		cost: 0.2,
		inputTokens: 0,
		status: "done",
		statusDetail: "done",
		startedAt: null,
		lastWriteAt: nowSec(),
		endedAt: null,
		messages: [],
		scoreModel: "",
		scoreCost: 0,
		scoreHours: 0,
		scoreRunning: false,
		scoreSurvived: false,
		scoreEnd: "",
		...over,
	};
}

const RUNS: RunSource = {
	listRuns: () => [run({ id: "owner-ui-alice-run", status: "running", statusDetail: "RUNNING" })],
	mainSession: () => null,
};

// Fixture tailscale: never the real binary. Only the owner's phone resolves to OWNER; a second
// tailnet peer resolves to someone else; everything else makes whois fail.
const TS: Tailscale = {
	ip4: () => OWN_IP,
	whois: (peer: string) => (peer === PEER ? OWNER : peer === "100.95.10.7" ? "other@example.com" : null),
};

let stopFns: (() => void)[] = [];
afterEach(() => {
	for (const stop of stopFns) stop();
	stopFns = [];
});

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

beforeEach(() => {
	rmSync(inboxPath(), { force: true });
	rmSync(unlockPath(), { force: true });
	rmSync(CFG.paths.guard_log, { force: true });
	rmSync(CFG.paths.plan_guard_log, { force: true });
});

function ui(over: Partial<OwnerUiOptions> = {}): OwnerUiServer {
	const svc = startOwnerUi({
		cfg: CFG,
		tailscale: TS,
		source: RUNS,
		hostname: "127.0.0.1",
		port: 0,
		peerOf: () => PEER,
		...over,
	});
	stopFns.push(svc.stop);
	return svc;
}

function get(svc: OwnerUiServer, path = "/"): Promise<Response> {
	return fetch(`http://127.0.0.1:${svc.port}${path}`);
}

function post(
	svc: OwnerUiServer,
	path: string,
	fields: Record<string, string>,
	origin?: string | null,
): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
	if (origin !== null) headers.origin = origin ?? `http://127.0.0.1:${svc.port}`;
	return fetch(`http://127.0.0.1:${svc.port}${path}`, {
		method: "POST",
		redirect: "manual",
		headers,
		body: new URLSearchParams(fields),
	});
}

function inboxRecords(): Record<string, unknown>[] {
	try {
		return readFileSync(inboxPath(), "utf8")
			.split("\n")
			.filter(l => l.trim())
			.map(l => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function guardLogLines(): string[] {
	try {
		return readFileSync(CFG.paths.guard_log, "utf8").split("\n").filter(l => l.trim());
	} catch {
		return [];
	}
}

function planGuardLogLines(): string[] {
	try {
		return readFileSync(CFG.paths.plan_guard_log, "utf8").split("\n").filter(l => l.trim());
	} catch {
		return [];
	}
}

// --- auth: only the owner's phone gets through ---

test("GET / serves the owner: every section renders from fixture state", async () => {
	const svc = ui();
	const res = await get(svc);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");
	const body = await res.text();
	// questions: the plan's WAITING on owner line
	expect(body).toContain(QUESTION);
	expect(body).toContain(PLAN_W);
	// agents: the running ledger row
	expect(body).toContain("owner-ui-alice-run");
	expect(body).toContain("RUNNING");
	// queue: both plans with their status
	expect(body).toContain("20261019_wait.md");
	expect(body).toContain("20261019_done.md");
	// merges/CI: the metrics ci row
	expect(body).toContain("!77");
	// incidents
	expect(body).toContain("toy incident the page must show");
	// agent scores: the ranking board
	expect(body).toContain("alice 4.2");
	// machine health: disk and load numbers
	expect(body).toContain("disk");
	expect(body).toContain("load");
	// unlock state
	expect(body).toContain("locked");
	// mobile page plumbing: auto-refresh every 20 s
	expect(body).toContain('http-equiv="refresh"');
	expect(body).toContain('content="20"');
});

test("the machine's own tailnet address gets 403", async () => {
	const svc = ui({ peerOf: () => OWN_IP });
	const res = await get(svc);
	expect(res.status).toBe(403);
	expect(await res.text()).not.toContain(QUESTION);
});

test("loopback gets 403", async () => {
	const svc = ui({ peerOf: () => "127.0.0.1" });
	expect((await get(svc)).status).toBe(403);
});

test("a non-tailnet address gets 403", async () => {
	const svc = ui({ peerOf: () => "192.168.1.50" });
	expect((await get(svc)).status).toBe(403);
});

test("a whois failure gets 403", async () => {
	const svc = ui({ peerOf: () => "100.95.10.5" });
	expect((await get(svc)).status).toBe(403);
});

test("a different tailnet login gets 403", async () => {
	const svc = ui({ peerOf: () => "100.95.10.7" });
	expect((await get(svc)).status).toBe(403);
});

test("an empty ui.owner_login refuses to start and would serve nobody", () => {
	expect(() => ui({ cfg: { ...CFG, ui: { ...CFG.ui, owner_login: "" } } })).toThrow();
});

test("ui.enabled false refuses to start", () => {
	expect(() => ui({ cfg: { ...CFG, ui: { ...CFG.ui, enabled: false } } })).toThrow();
});

test("a silent tailscale refuses to start on the default hostname", () => {
	expect(() => ui({ tailscale: { ip4: () => null, whois: () => null }, hostname: undefined })).toThrow();
});

test("a real loopback request (no peer injection) gets 403", async () => {
	const svc = ui({ peerOf: undefined });
	expect((await get(svc)).status).toBe(403);
});

// --- origin: a POST from another page is refused ---

test("a POST with a foreign Origin gets 403 and appends nothing", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" }, "http://evil.example");
	expect(res.status).toBe(403);
	expect(inboxRecords()).toEqual([]);
});

test("a POST with no Origin gets 403", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" }, null);
	expect(res.status).toBe(403);
	expect(inboxRecords()).toEqual([]);
});

// --- answer: one record per POST into the owner inbox ---

test("POST /answer appends one record with ts, plan, question, answer and login", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
	expect(res.status).toBe(303);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({
		ts: expect.any(Number),
		plan: PLAN_W,
		question: QUESTION,
		answer: "yes",
		login: OWNER,
	});
	expect(Math.abs(Number(recs[0]!.ts) - nowSec())).toBeLessThan(120);
});

test("a free-text answer lands in the record", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer_text: "do it after lunch" });
	expect(res.status).toBe(303);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]!.answer).toBe("do it after lunch");
});

test("an answer longer than 2000 chars is refused", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "x".repeat(2001) });
	expect(res.status).toBe(400);
	expect(inboxRecords()).toEqual([]);
});

test("an answer for a plan that is not open and waiting is refused", async () => {
	const svc = ui();
	expect((await post(svc, "/answer", { plan: PLAN_D, answer: "yes" })).status).toBe(409);
	expect((await post(svc, "/answer", { plan: join(TOY, "docs/plans/20261019_missing.md"), answer: "yes" })).status).toBe(409);
	expect(inboxRecords()).toEqual([]);
});

// --- unlock / lock through the core function, logged with the ui word ---

test("POST /unlock moves the guard unlock file and logs UNLOCK ui source=ui:<login> minutes=N", async () => {
	const svc = ui();
	const res = await post(svc, "/unlock", { minutes: "5" });
	expect(res.status).toBe(303);
	expect(existsSync(unlockPath())).toBe(true);
	const lines = planGuardLogLines().filter(l => l.includes("UNLOCK"));
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain(`UNLOCK ui source=ui:${OWNER} minutes=5`);
	const page = await (await get(svc)).text();
	expect(page).toMatch(/unlocked/i);
});

test("POST /lock removes the unlock file and logs LOCK ui source=ui:<login>", async () => {
	const svc = ui();
	await post(svc, "/unlock", { minutes: "5" });
	const res = await post(svc, "/lock", {});
	expect(res.status).toBe(303);
	expect(existsSync(unlockPath())).toBe(false);
	const lines = planGuardLogLines().filter(l => /^\S+ LOCK /.test(l));
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain(`LOCK ui source=ui:${OWNER}`);
});

test("unlock with the chat gate off is refused and logs nothing", async () => {
	const svc = ui({ cfg: { ...CFG, guards: { ...CFG.guards, chat_unlock: false } } });
	const res = await post(svc, "/unlock", { minutes: "5" });
	expect(res.status).toBe(409);
	expect(existsSync(unlockPath())).toBe(false);
	expect(planGuardLogLines().some(l => l.includes("UNLOCK"))).toBe(false);
});

// --- every request is logged ---

test("every request logs UI <method> <path> login=<l> → <code> to the guard log", async () => {
	const svc = ui();
	await get(svc);
	await get(svc, "/nope");
	// A second server whose peer resolves to a different login: refused, so login stays "-" in the log.
	const stranger = ui({ peerOf: () => "100.95.10.7" });
	await fetch(`http://127.0.0.1:${stranger.port}/`);
	const lines = guardLogLines();
	expect(lines.length).toBe(3);
	expect(lines[0]).toMatch(/^\S+ UI GET \/ login=owner@example\.com → 200$/);
	expect(lines[1]).toMatch(/^\S+ UI GET \/nope login=owner@example\.com → 404$/);
	expect(lines[2]).toMatch(/^\S+ UI GET \/ login=- → 403$/);
});

// --- resilience ---

test("an unreadable section shows unavailable and never fails the page", async () => {
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, ranking_board: join(TMP, "missing-dir", "board.md") } } });
	const res = await get(svc);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("unavailable");
	expect(body).toContain(QUESTION);
});

// --- inbox location (the adapter reads it in P3) ---

test("the owner inbox lives under the queue state dir", () => {
	expect(inboxPath()).toBe(join(stateDirPath(), "owner-inbox.jsonl"));
});
