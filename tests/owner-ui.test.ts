// Owner phone page (plan 20261024_2230_owner_phone_ui, P1): auth, page sections, the answer
// inbox, and unlock/lock — every request against a temp HOME with an injectable tailscale
// resolver and an injectable peer address, so no test ever calls the real tailscale binary or
// binds the real tailnet address. The server binds 127.0.0.1 here; who the request appears to
// come from is a startOwnerUi option, exactly the seam the real CLI leaves in place for these
// tests.

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Run, RunSource, ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { addIncident } from "../src/core/incidents.ts";
import { appendMetric } from "../src/core/metrics.ts";
import { checkTool } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { createOmpAdapter, ownerInboxCursorPath, ownerInboxMessage, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { inboxPath, agentRows, buildPageData, ciRows, dropSlot, edgeScrollStep, incidentRows, machineRow, nowStats, questionRows, queueRows, scoresData, startOwnerUi, type OwnerUiOptions, type OwnerUiServer } from "../src/core/owner-ui.ts";
import { runUi } from "../src/cli/ui.ts";
import { parsePlan, stateDirPath, unlockPath } from "../src/core/queue/lib.ts";
import { parseWhoisLogin, type Tailscale } from "../src/core/tailscale.ts";

const OWNER = "owner@example.com";
const OWN_IP = "100.95.10.2"; // fixture: this machine's tailnet address
const DNS_NAME = "ukd.tail4295de.ts.net"; // fixture: this machine's MagicDNS name
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

const PLAN_TEXT = (status: string, waiting: boolean, waitsOn?: string) => `# Toy plan

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
${waiting ? `\nWAITING on owner: ${QUESTION}\n` : ""}${waitsOn ? `\nWaits on: ${waitsOn}\n` : ""}
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
mkdirSync(join(TOY, ".git"), { recursive: true }); // gitTop only looks for the dir: the repo label is basename(TOY)
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
		prefillTokens: 0,
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
	// The seam's contract (like realTailscale): the MagicDNS name, trailing dot already stripped.
	dnsName: () => DNS_NAME,
	whois: (peer: string) => (peer === PEER ? OWNER : peer === "100.95.10.7" ? "other@example.com" : null),
	logins: () => [OWNER, "other@example.com"],
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
	rmSync(ownerInboxCursorPath(), { force: true });
	rmSync(unlockPath(), { force: true });
	rmSync(join(stateDirPath(), "autonomy-tier"), { force: true });
	rmSync(join(stateDirPath(), "autonomy-go"), { force: true });
	rmSync(join(stateDirPath(), "owner-messages"), { recursive: true, force: true });
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

// Raw HTTP with a controllable Host header: the allowlist (P3a) reads Host, so the tests choose
// it — fetch pins it to the connect host. Default Host: the tailnet address the allowlist names.
function raw(
	svc: OwnerUiServer,
	method: string,
	path: string,
	opts: { host?: string | null; origin?: string | null; body?: Record<string, string>; accept?: string; rawBody?: Uint8Array; contentType?: string } = {},
): Promise<Response> {
	const host = opts.host === null ? null : (opts.host ?? `${OWN_IP}:${svc.port}`);
	const headers: Record<string, string> = {};
	if (host !== null) headers.host = host;
	if (opts.origin) headers.origin = opts.origin;
	if (opts.accept) headers.accept = opts.accept;
	const body = opts.body === undefined ? undefined : new URLSearchParams(opts.body).toString();
	if (opts.rawBody !== undefined) headers["content-type"] = opts.contentType ?? "application/octet-stream";
	else if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const req = request({ host: "127.0.0.1", port: svc.port, method, path, headers }, res => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("end", () => {
			// All response headers: the P2 tests read Location and Content-Security-Policy. The body
			// stays bytes so the P13 image route can be compared byte for byte.
			const resHeaders: Record<string, string> = {};
			for (let i = 0; i < res.rawHeaders.length; i += 2) resHeaders[(res.rawHeaders[i] ?? "").toLowerCase()] = String(res.rawHeaders[i + 1] ?? "");
			resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: resHeaders }));
		});
	});
	req.on("error", reject);
	req.end(opts.rawBody !== undefined ? opts.rawBody : body);
	return promise;
}

function get(svc: OwnerUiServer, path = "/", host?: string | null): Promise<Response> {
	return raw(svc, "GET", path, { host });
}

function post(
	svc: OwnerUiServer,
	path: string,
	fields: Record<string, string>,
	origin?: string | null,
	host?: string | null,
): Promise<Response> {
	return raw(svc, "POST", path, {
		origin: origin === undefined ? `http://${OWN_IP}:${svc.port}` : origin,
		host,
		body: fields,
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

// --- P13 helpers: multipart posts and the message store ---

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

function messagesDir(): string {
	return join(stateDirPath(), "owner-messages");
}

function storedMessages(): Record<string, unknown>[] {
	try {
		return readdirSync(messagesDir()).map(id => JSON.parse(readFileSync(join(messagesDir(), id, "message.json"), "utf8")) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** A real multipart body for POST /message (the page's form enctype); files go in as raw bytes. */
function postMessage(svc: OwnerUiServer, fields: Record<string, string>, files: { field: string; filename: string; bytes: Uint8Array }[], json = false): Promise<Response> {
	const boundary = `nsuitest${Math.random().toString(16).slice(2)}`;
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
	for (const f of files) {
		parts.push(enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`));
		parts.push(f.bytes);
		parts.push(enc.encode("\r\n"));
	}
	parts.push(enc.encode(`--${boundary}--\r\n`));
	const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		body.set(p, at);
		at += p.length;
	}
	const opts = json ? { accept: "application/json" as const, rawBody: body, contentType: `multipart/form-data; boundary=${boundary}` } : { rawBody: body, contentType: `multipart/form-data; boundary=${boundary}` };
	return raw(svc, "POST", "/message", { origin: `http://${OWN_IP}:${svc.port}`, ...opts });
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

test("GET / renders the mockup Now tab: top bar, Today tiles, the ask card and the queue preview", async () => {
	const svc = ui();
	const res = await get(svc);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");
	const body = await res.text();
	// sticky top bar: logo, pill tabs with Now on, the lock pill Off
	expect(body).toContain('class="logo">ns</span>');
	expect(body).toContain('href="/?tab=now" class="on">Now</a>');
	expect(body).toContain("🔒 Off");
	// Today tiles from nowStats: 1 waiting plan, one running sub run at $0.20, 1 open plan
	expect(body).toContain("Today");
	expect(body).toContain('style="color:var(--warn)">1</div>');
	expect(body).toContain("answer below ↓");
	expect(body).toContain("$0.20");
	expect(body).toContain("Main $0.00 · agents $0.20");
	expect(body).toContain("1 running · 0 died");
	// ask card: title, repo eyebrow (age dropped — P18b), Do line, goal under Background, Done for a task ask
	expect(body).toContain("Toy plan");
	expect(body).toContain('<p class="eyebrow">toy</p>');
	expect(body).not.toContain("toy · waiting");
	expect(body).toContain(`<b>Do</b> ${QUESTION}`);
	expect(body).toContain("Owner page toy.");
	expect(body).toContain('name="answer" value="done">Done ✓');
	expect(body).not.toContain('value="yes"');
	// queue preview row with the plain-language chip; a one-plan queue has no "Show all"
	expect(body).toContain(`data-plan="${PLAN_W}"`);
	expect(body).toContain("waits you");
	expect(body).not.toContain("Show all");
	// no raw text dumps, no meta refresh
	expect(body).toContain("<details");
	expect(body).not.toContain("<pre>");
	expect(body).not.toContain("http-equiv");
});

test("need card: three-part line shows Do, Stuck until then and Why you; a question shows Yes/No; a waiter is named", async () => {
	const other = join(TOY, "docs/plans/20261019_blocked.md");
	const three = "ship the patch — blocked: the release stays dark — why you: Main cannot tag";
	try {
		writeFileSync(
			PLAN_W,
			PLAN_TEXT("open", false).replace("## Progress\nStatus: open\n", `## Progress\nStatus: open\nWAITING on owner: ${three}\n`),
		);
		writeFileSync(other, PLAN_TEXT("open", false, PLAN_W).replace("# Toy plan", "# Blocked sibling"));
		writeFileSync(INDEX, `${PLAN_W}\n${other}\n${PLAN_D}\n`);
		const body = await (await get(ui())).text();
		expect(body).toContain("<b>Do</b> ship the patch");
		expect(body).toContain("<b>Stuck until then</b> the release stays dark also unblocks: Blocked sibling");
		expect(body).toContain("<b>Why you</b> Main cannot tag");
		expect(body).toContain('name="answer" value="done">Done ✓');
		expect(body).not.toContain('value="yes"');
		expect(body).not.toContain("toy · waiting");

		writeFileSync(
			PLAN_W,
			PLAN_TEXT("open", false).replace("## Progress\nStatus: open\n", "## Progress\nStatus: open\nWAITING on owner: ship it?\n"),
		);
		writeFileSync(INDEX, `${PLAN_W}\n${PLAN_D}\n`);
		const q = await (await get(ui())).text();
		expect(q).toContain("<b>Do</b> ship it?");
		expect(q).toContain('value="yes"');
		expect(q).toContain('value="no"');
		expect(q).not.toContain("<b>Stuck until then</b>");
		expect(q).not.toContain("<b>Why you</b>");
		expect(q).not.toContain('value="done"');
	} finally {
		writeFileSync(PLAN_W, PLAN_TEXT("open", true));
		writeFileSync(INDEX, `${PLAN_W}\n${PLAN_D}\n`);
		rmSync(other, { force: true });
	}
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
	expect(() => ui({ tailscale: { ip4: () => null, dnsName: () => null, whois: () => null, logins: () => null }, hostname: undefined })).toThrow();
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

// --- host allowlist (P3a): DNS rebinding is refused on every request, before whois ---

test("a rebinding POST (Host and Origin evil.example) from the owner's phone gets 403 and appends nothing", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" }, `http://evil.example:${svc.port}`, `evil.example:${svc.port}`);
	expect(res.status).toBe(403);
	expect(inboxRecords()).toEqual([]);
});

test("a rebinding GET (Host evil.example) from the owner's phone gets 403", async () => {
	const svc = ui();
	expect((await get(svc, "/", `evil.example:${svc.port}`)).status).toBe(403);
});

test("a Host without the page's port gets 403", async () => {
	const svc = ui();
	expect((await get(svc, "/", OWN_IP)).status).toBe(403);
});

test("the MagicDNS Host serves the owner; an Origin naming the other allowed host is refused", async () => {
	const svc = ui();
	expect((await get(svc, "/", `${DNS_NAME}:${svc.port}`)).status).toBe(200);
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" }, `http://${OWN_IP}:${svc.port}`, `${DNS_NAME}:${svc.port}`);
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

test("an answer to an unknown plan is refused", async () => {
	const svc = ui();
	expect((await post(svc, "/answer", { plan: join(TOY, "docs/plans/20261019_missing.md"), answer: "yes" })).status).toBe(409);
	expect(inboxRecords()).toEqual([]);
});

test("an answer to a plan whose WAITING Main cleared still reaches Main, marked already cleared (P8b)", async () => {
	const svc = ui();
	try {
		writeFileSync(PLAN_W, PLAN_TEXT("open", false)); // Main removed the WAITING line after the page was rendered
		const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("Already handled — Main cleared this question before your answer; your answer was still passed on.");
		const recs = inboxRecords();
		expect(recs.length).toBe(1);
		expect(recs[0]).toEqual({ ts: expect.any(Number), plan: PLAN_W, question: "(already cleared)", answer: "yes", login: OWNER });
	} finally {
		writeFileSync(PLAN_W, PLAN_TEXT("open", true));
	}
});

test("an answer to a complete plan still reaches Main, marked already cleared (P8b)", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_D, answer: "yes" });
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("Already handled — Main cleared this question before your answer; your answer was still passed on.");
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({ ts: expect.any(Number), plan: PLAN_D, question: "(already cleared)", answer: "yes", login: OWNER });
});

test("a second press of the same answer within 10 s appends nothing (P8c)", async () => {
	const saved = process.env.NEURASTREAM_NOW;
	const now = nowSec();
	try {
		process.env.NEURASTREAM_NOW = String(now);
		const svc = ui();
		expect((await post(svc, "/answer", { plan: PLAN_W, answer: "yes" })).status).toBe(303);
		process.env.NEURASTREAM_NOW = String(now + 2);
		const again = await post(svc, "/answer", { plan: PLAN_W, answer: " yes " });
		expect(again.status).toBe(303);
		expect(again.headers.get("location")).toBe("/?sent=answer");
		expect(inboxRecords().length).toBe(1);
	} finally {
		if (saved === undefined) delete process.env.NEURASTREAM_NOW;
		else process.env.NEURASTREAM_NOW = saved;
	}
});

test("the same answer after 10 s is appended again (P8c)", async () => {
	const saved = process.env.NEURASTREAM_NOW;
	const now = nowSec();
	try {
		process.env.NEURASTREAM_NOW = String(now);
		const svc = ui();
		await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
		process.env.NEURASTREAM_NOW = String(now + 11);
		expect((await post(svc, "/answer", { plan: PLAN_W, answer: "yes" })).status).toBe(303);
		expect(inboxRecords().length).toBe(2);
	} finally {
		if (saved === undefined) delete process.env.NEURASTREAM_NOW;
		else process.env.NEURASTREAM_NOW = saved;
	}
});

test("the same text for another plan is appended (P8c)", async () => {
	const saved = process.env.NEURASTREAM_NOW;
	const now = nowSec();
	try {
		process.env.NEURASTREAM_NOW = String(now);
		const svc = ui();
		await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
		process.env.NEURASTREAM_NOW = String(now + 2);
		expect((await post(svc, "/answer", { plan: PLAN_D, answer: "yes" })).status).toBe(200);
		const recs = inboxRecords();
		expect(recs.length).toBe(2);
		expect(recs.map(r => r.plan)).toEqual([PLAN_W, PLAN_D]);
	} finally {
		if (saved === undefined) delete process.env.NEURASTREAM_NOW;
		else process.env.NEURASTREAM_NOW = saved;
	}
});

test("a different text for the same plan is appended (P8c)", async () => {
	const saved = process.env.NEURASTREAM_NOW;
	const now = nowSec();
	try {
		process.env.NEURASTREAM_NOW = String(now);
		const svc = ui();
		await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
		process.env.NEURASTREAM_NOW = String(now + 2);
		expect((await post(svc, "/answer", { plan: PLAN_W, answer: "no" })).status).toBe(303);
		const recs = inboxRecords();
		expect(recs.length).toBe(2);
		expect(recs.map(r => r.answer)).toEqual(["yes", "no"]);
	} finally {
		if (saved === undefined) delete process.env.NEURASTREAM_NOW;
		else process.env.NEURASTREAM_NOW = saved;
	}
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
	expect(page).toContain("🔓 5 min");
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

test("unlock or lock with the chat gate off redirects to the explanation and changes nothing", async () => {
	const svc = ui({ cfg: { ...CFG, guards: { ...CFG.guards, chat_unlock: false } } });
	const res = await post(svc, "/unlock", { minutes: "5" });
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=unlock-off");
	expect(existsSync(unlockPath())).toBe(false);
	expect(planGuardLogLines().some(l => l.includes("UNLOCK"))).toBe(false);
	expect(inboxRecords()).toEqual([]);
	const lock = await post(svc, "/lock", {});
	expect(lock.status).toBe(303);
	expect(lock.headers.get("location")).toBe("/?sent=unlock-off");
	expect(existsSync(unlockPath())).toBe(false);
	expect(inboxRecords()).toEqual([]);
});

// --- unlock / lock append owner-inbox records for Main ---

test("POST /unlock with chat_unlock on appends one unlock inbox record", async () => {
	const svc = ui();
	const before = nowSec();
	const res = await post(svc, "/unlock", { minutes: "5" });
	expect(res.status).toBe(303);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({
		ts: expect.any(Number),
		kind: "unlock",
		minutes: 5,
		until: expect.any(Number),
		login: OWNER,
	});
	expect(Number(recs[0]!.ts)).toBeGreaterThanOrEqual(before);
	expect(Number(recs[0]!.until)).toBeGreaterThan(Number(recs[0]!.ts));
});

test("POST /lock appends one lock inbox record", async () => {
	const svc = ui();
	const res = await post(svc, "/lock", {});
	expect(res.status).toBe(303);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({
		ts: expect.any(Number),
		kind: "lock",
		login: OWNER,
	});
});

// --- tier buttons: POST /tier (plan 20261025_1940 P3) ---

test("POST /tier writes the tier file, logs TIER ui, marks the current button and appends one inbox record", async () => {
	const svc = ui();
	const res = await post(svc, "/tier", { tier: "full" });
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=tier&tier=full");
	expect(readFileSync(join(stateDirPath(), "autonomy-tier"), "utf8")).toBe("full\n");
	const lines = planGuardLogLines().filter(l => l.includes(" TIER "));
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain(`TIER full ui source=ui:${OWNER}`);
	const page = await (await get(svc)).text();
	expect(page).toContain("Tier: strict");
	expect(page).toContain("Tier: opinionated");
	expect(page).toContain(`value="full"><input type="hidden" name="tab" value="now"><button class="btn on" type="submit">Tier: full</button>`);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({ ts: expect.any(Number), kind: "tier", tier: "full", login: OWNER });
});

test("POST /tier from a stranger gets 403 and writes nothing", async () => {
	const svc = ui({ peerOf: () => "100.95.10.7" }); // whois: other@example.com
	const res = await post(svc, "/tier", { tier: "full" });
	expect(res.status).toBe(403);
	expect(existsSync(join(stateDirPath(), "autonomy-tier"))).toBe(false);
});

test("POST /tier with a bad name gets 400 before the core is called", async () => {
	const svc = ui();
	const res = await post(svc, "/tier", { tier: "nope" });
	expect(res.status).toBe(400);
	expect(existsSync(join(stateDirPath(), "autonomy-tier"))).toBe(false);
	expect(planGuardLogLines().some(l => l.includes(" TIER "))).toBe(false);
	expect(inboxRecords()).toEqual([]);
});

test("tier buttons with the chat gate off redirect to the explanation and change nothing", async () => {
	const svc = ui({ cfg: { ...CFG, guards: { ...CFG.guards, chat_unlock: false } } });
	const res = await post(svc, "/tier", { tier: "full" });
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=unlock-off");
	expect(existsSync(join(stateDirPath(), "autonomy-tier"))).toBe(false);
	expect(inboxRecords()).toEqual([]);
});

// --- every request is logged ---

test("every request logs UI <method> <path> login=<l> → <code> to the guard log", async () => {
	const svc = ui();
	await get(svc);
	await get(svc, "/nope");
	// A second server whose peer resolves to a different login: refused, so login stays "-" in the log.
	const stranger = ui({ peerOf: () => "100.95.10.7" });
	await get(stranger);
	const lines = guardLogLines();
	expect(lines.length).toBe(3);
	expect(lines[0]).toMatch(/^\S+ UI GET \/ login=owner@example\.com → 200$/);
	expect(lines[1]).toMatch(/^\S+ UI GET \/nope login=owner@example\.com → 404$/);
	expect(lines[2]).toMatch(/^\S+ UI GET \/ login=- → 403$/);
});

// --- resilience ---

test("an unreadable section shows unavailable and never fails the page", async () => {
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, ranking_board: join(TMP, "missing-dir", "board.md") } } });
	// the Now tab stays whole…
	const now = await (await get(svc)).text();
	expect(now).toContain(QUESTION);
	// …and the tab that owns the unreadable source says so instead of dying.
	const agents = await (await get(svc, "/?tab=agents")).text();
	expect(agents).toContain("unavailable");
});

// --- inbox location (the adapter reads it in P3) ---

test("the owner inbox lives under the queue state dir", () => {
	expect(inboxPath()).toBe(join(stateDirPath(), "owner-inbox.jsonl"));
});

// --- adapter: inbox delivery to Main (P3b) ---

function fakePi(): { pi: ExtensionHost; sent: (string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[])[]; handlers: Map<string, (e: unknown, ctx: unknown) => unknown> } {
	const sent: (string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[])[] = [];
	// INCIDENT I-20261025-21/22: keep EVERY handler per event (the real omp runner calls them all
	// in registration order); handlers.get(event) is the dispatcher the tests invoke.
	const registered = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const pi: ExtensionHost = {
		on: (event, cb) => {
			const list = registered.get(event) ?? [];
			list.push(cb as (e: unknown, ctx: unknown) => unknown);
			registered.set(event, list);
			handlers.set(event, (e, ctx) => {
				let out: unknown;
				for (const h of list) {
					const r = h(e, ctx);
					if (r !== undefined) out = r;
				}
				return out;
			});
		},
		registerCommand: () => {},
		sendUserMessage: content => sent.push(content),
		sendMessage: () => {},
	};
	return { pi, sent, handlers };
}

test("ownerInboxMessage returns phone message text and image content", () => {
	const id = `${Math.floor(nowSec())}-abcdef`;
	const dir = join(messagesDir(), id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "1.png"), PNG_BYTES);
	writeFileSync(join(dir, "2.jpg"), Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
	writeFileSync(join(dir, "message.json"), JSON.stringify({ ts: nowSec(), text: "Please inspect these.", images: ["1.png", "2.jpg"] }));
	const ts = nowSec();
	expect(ownerInboxMessage({ ts, kind: "message", id })).toEqual([
		{ type: "text", text: `Owner message from the phone page (${strftime(ts, "%H:%M")}): Please inspect these.\nImages:\n- ${join(dir, "1.png")}\n- ${join(dir, "2.jpg")}` },
		{ type: "image", data: Buffer.from(PNG_BYTES).toString("base64"), mimeType: "image/png" },
		{ type: "image", data: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"), mimeType: "image/jpeg" },
	]);
});

test("ownerInboxMessage handles text-only and expired phone messages", () => {
	const id = `${Math.floor(nowSec())}-fedcba`;
	const dir = join(messagesDir(), id);
	mkdirSync(dir, { recursive: true });
	const ts = nowSec();
	writeFileSync(join(dir, "message.json"), JSON.stringify({ ts, text: "Only text.", images: [] }));
	expect(ownerInboxMessage({ ts, kind: "message", id })).toEqual([
		{ type: "text", text: `Owner message from the phone page (${strftime(ts, "%H:%M")}): Only text.` },
	]);
	const expiredTs = nowSec() - 3600;
	expect(ownerInboxMessage({ ts: expiredTs, kind: "message", id: "123456-abcdef" })).toEqual([
		{ type: "text", text: `Owner sent a message from the phone page at ${strftime(expiredTs, "%H:%M")}; it expired (12 h) before delivery.` },
	]);
});

test("deliverOwnerInbox sends the structured phone message unchanged", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	const ts = nowSec();
	const id = `${Math.floor(ts)}-123abc`;
	const dir = join(messagesDir(), id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "1.png"), PNG_BYTES);
	writeFileSync(join(dir, "message.json"), JSON.stringify({ ts, text: "Look.", images: ["1.png"] }));
	appendFileSync(inboxPath(), `${JSON.stringify({ ts, kind: "message", id, login: OWNER })}\n`);
	handlers.get("agent_end")!({ willContinue: false }, mainCtx);
	expect(sent).toEqual([ownerInboxMessage({ ts, kind: "message", id })!]);
});

const rec = (answer: string) => JSON.stringify({ ts: nowSec(), plan: PLAN_W, question: QUESTION, answer, login: OWNER });

// INCIDENT I-20261025-21 / I-20261025-22: the fake host kept only the LAST handler per event, so a
// second pi.on("agent_end") silently shadowed the first (the real omp runner calls them all).
test("fakePi keeps every handler per event and runs them in registration order", () => {
	const { pi, handlers } = fakePi();
	const ran: string[] = [];
	pi.on("agent_end", () => (ran.push("first"), "a"));
	pi.on("agent_end", () => (ran.push("second"), "b"));
	const out = handlers.get("agent_end")!({}, mainCtx);
	expect(ran).toEqual(["first", "second"]);
	// The last handler's non-undefined result is the event's result.
	expect(out).toBe("b");
});

test("ownerInboxMessage formats unlock, lock, answer, reorder and rejects unknown kinds", () => {
	const until = nowSec() + 300;
	expect(ownerInboxMessage({ ts: nowSec(), kind: "unlock", minutes: 5, until, login: OWNER })).toBe(
		`Owner unlocked the guards from the phone page for 5 min (until ${strftime(until, "%H:%M")}). Do the step that waited on the unlock now.`,
	);
	expect(ownerInboxMessage({ ts: nowSec(), kind: "lock", login: OWNER })).toBe("Owner locked the guards from the phone page.");
	expect(ownerInboxMessage({ ts: nowSec(), plan: PLAN_W, question: QUESTION, answer: "yes", login: OWNER })).toBe(
		`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → yes`,
	);
	expect(ownerInboxMessage({ ts: nowSec(), kind: "reorder", plan: PLAN_W, from: 1, to: 2, login: OWNER })).toBe(
		"Owner moved 20261019_wait.md from #1 to #2 on the phone page; INDEX.md has the new order — work by it.",
	);
	expect(ownerInboxMessage({ ts: nowSec(), kind: "reorder", plan: PLAN_W, to: 2, login: OWNER })).toBe(null);
	expect(ownerInboxMessage({ ts: nowSec(), kind: "bogus", login: OWNER })).toBe(null);
});

const mainCtx = { agent: { kind: "main" } };
const subCtx = { agent: { kind: "sub" } };

test("the adapter delivers an undelivered inbox record to Main once; the cursor holds it back", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	appendFileSync(inboxPath(), `${rec("yes")}\n`);
	handlers.get("agent_end")!({ willContinue: false }, mainCtx);
	expect(sent).toEqual([`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → yes`]);
	expect(readFileSync(ownerInboxCursorPath(), "utf8")).toBe("1\n");
	// A second poll at the same cursor sends nothing.
	handlers.get("agent_end")!({ willContinue: false }, mainCtx);
	expect(sent.length).toBe(1);
	// A new record delivers alone.
	appendFileSync(inboxPath(), `${rec("no")}\n`);
	handlers.get("agent_end")!({ willContinue: false }, mainCtx);
	expect(sent.length).toBe(2);
	expect(sent[1]).toContain("→ no");
});

test("deliverOwnerInbox sends answer then unlock in order and moves the cursor by 2", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	const until = nowSec() + 300;
	const unlockLine = JSON.stringify({ ts: nowSec(), kind: "unlock", minutes: 5, until, login: OWNER });
	appendFileSync(inboxPath(), `${rec("yes")}\n${unlockLine}\n`);
	handlers.get("agent_end")!({ willContinue: false }, mainCtx);
	expect(sent.length).toBe(2);
	expect(sent[0]).toBe(`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → yes`);
	expect(sent[1]).toBe(
		`Owner unlocked the guards from the phone page for 5 min (until ${strftime(until, "%H:%M")}). Do the step that waited on the unlock now.`,
	);
	expect(readFileSync(ownerInboxCursorPath(), "utf8")).toBe("2\n");
});

test("a torn inbox tail waits for the write to complete and is never delivered twice", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	const full = `${rec("wait for it")}\n`;
	appendFileSync(inboxPath(), full.slice(0, 20));
	handlers.get("agent_end")!({}, mainCtx);
	expect(sent).toEqual([]);
	appendFileSync(inboxPath(), full.slice(20));
	handlers.get("agent_end")!({}, mainCtx);
	expect(sent).toEqual([`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → wait for it`]);
});

test("a malformed complete inbox row is consumed but skipped, so delivery never wedges", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	appendFileSync(inboxPath(), `not json\n${rec("after garbage")}\n`);
	handlers.get("agent_end")!({}, mainCtx);
	expect(sent).toEqual([`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → after garbage`]);
	expect(readFileSync(ownerInboxCursorPath(), "utf8")).toBe("2\n");
});

test("a subagent session never delivers and never moves the cursor", () => {
	const { pi, sent, handlers } = fakePi();
	createOmpAdapter(pi, CFG);
	appendFileSync(inboxPath(), `${rec("yes")}\n`);
	handlers.get("agent_end")!({}, subCtx);
	expect(sent).toEqual([]);
	expect(existsSync(ownerInboxCursorPath())).toBe(false);
});

test("Main's session start arms a 15 s inbox poll; a subagent session arms none", () => {
	const saved = process.env.QUEUE_CLOSE_BIN;
	process.env.QUEUE_CLOSE_BIN = "true"; // autoClose (same handler) must spawn no real close
	try {
		const { pi, sent, handlers } = fakePi();
		createOmpAdapter(pi, CFG);
		let tick: (() => void) | null = null;
		let ms = 0;
		handlers.get("session_start")!(undefined, {
			setInterval: (cb: () => void, every: number) => {
				tick = cb;
				ms = every;
				return 7;
			},
		});
		expect(ms).toBe(15_000);
		appendFileSync(inboxPath(), `${rec("later")}\n`);
		tick!();
		expect(sent).toEqual([`Owner answered on the phone page — 20261019_wait.md: ${QUESTION} → later`]);
		// A subagent session arms no timer (the handler returns before arming).
		let subTimers = 0;
		const sub = fakePi();
		createOmpAdapter(sub.pi, CFG);
		sub.handlers.get("session_start")!(undefined, {
			agent: { kind: "sub" },
			setInterval: () => {
				subTimers++;
				return 8;
			},
		});
		expect(subTimers).toBe(0);
	} finally {
		if (saved === undefined) delete process.env.QUEUE_CLOSE_BIN;
		else process.env.QUEUE_CLOSE_BIN = saved;
	}
});

test("an agent write to the owner inbox is refused like any protected state file", () => {
	const ev: ToolEvent = { tool: "write", input: { path: inboxPath() }, cwd: TMP, agent: "sub", agentId: "regress", calls: 0, paths: [], writes: [], command: "" };
	const d = checkTool(ev, CFG);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("protected");
	const main: ToolEvent = { ...ev, agent: "main", agentId: "regress-main" };
	expect(checkTool(main, CFG).allow).toBe(false);
});

// --- guards: agents must not start the owner page (P3c) ---

test("guards refuse agent shell commands that start the owner page", () => {
	const cfg: Config = { ...CFG, guards: { ...CFG.guards, shell_tools: ["bash"] } };
	const denies = (command: string, agent: "main" | "sub" = "sub"): boolean =>
		!checkTool({ tool: "bash", input: { command }, cwd: TMP, agent, agentId: "uistart", calls: 0, paths: [], writes: [], command: "" }, cfg).allow;
	expect(denies("neurastream ui")).toBe(true);
	expect(denies("neurastream ui --port 1234")).toBe(true);
	// ui on/off are the one-command setup of the page itself (plan 20261025_0300): refused like
	// every other `neurastream ui` command, with any arguments.
	expect(denies("neurastream ui on --login x@y.z")).toBe(true);
	expect(denies("neurastream ui off")).toBe(true);
	expect(denies('sh -c "neurastream ui"', "main")).toBe(true);
	expect(denies("bun ~/.bun/bin/neurastream ui")).toBe(true);
	expect(denies("systemctl --user start neurastream-ui")).toBe(true);
	expect(denies("systemctl --user restart neurastream-ui.service")).toBe(true);
	expect(denies("sudo systemctl --user enable neurastream-ui.timer")).toBe(true);
	// Reads and unrelated commands stay allowed.
	expect(denies("neurastream doctor")).toBe(false);
	expect(denies("systemctl --user status neurastream-ui")).toBe(false);
	expect(denies("grep neurastream ui notes.md")).toBe(false);
	// The refusal is logged plan-guard style.
	expect(planGuardLogLines().some(l => l.includes("ui-start"))).toBe(true);
});

// --- CLI: `neurastream ui` keeps serving (the 0.2.8 unit exited 0 after 90 ms) ---

test("runUi never resolves once the page is started, so the CLI does not exit and kill the server", async () => {
	let started = 0;
	const served = runUi([], { cfg: CFG, start: () => (started++, { stop() {}, hostname: "127.0.0.1", port: 0 }) });
	// An async runUi that returns a code is already settled here, so its .then is queued ahead of
	// the second racer; one that never resolves loses to it. No clock involved.
	const winner = await Promise.race([served.then(code => `exited ${code}`), Promise.resolve().then(() => "still serving")]);
	expect(started).toBe(1);
	expect(winner).toBe("still serving");
});

test("runUi refuses with exit 1 and starts nothing when the page is off", async () => {
	let started = 0;
	const code = await runUi([], { cfg: { ...CFG, ui: { ...CFG.ui, enabled: false } }, start: () => (started++, { stop() {}, hostname: "", port: 0 }) });
	expect(code).toBe(1);
	expect(started).toBe(0);
});

// Regression (2026-10-25): the real seam read only the first stdout line ("{") and looked under
// `User`, so every real peer's login was null and the owner's own phone got 403.
test("parseWhoisLogin reads UserProfile.LoginName from the multi-line `tailscale whois --json` output", () => {
	const out = JSON.stringify(
		{
			Node: { Name: "phone.example.ts.net.", Addresses: ["100.68.9.81/32"] },
			UserProfile: { ID: 1, LoginName: "owner@example.com", DisplayName: "Owner" },
			CapMap: {},
		},
		null,
		"\t",
	);
	expect(parseWhoisLogin(out)).toBe("owner@example.com");
	expect(parseWhoisLogin(JSON.stringify({ User: { LoginName: "owner@example.com" } }))).toBeNull();
	expect(parseWhoisLogin("not json")).toBeNull();
});

// --- P2: the redesigned page's receipt, all-clear and CSP plumbing ---

test("zero waiting plans render the all-clear tile and the empty state", async () => {
	const emptyIndex = join(TMP, "empty-index.md");
	writeFileSync(emptyIndex, `${PLAN_D}\n`);
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: emptyIndex } } });
	const body = await (await get(svc)).text();
	expect(body).toContain('<div class="num">0</div>');
	expect(body).toContain("all clear");
	expect(body).toContain("Nothing needs you right now");
	expect(body).not.toContain("answer below");
});

test("the CSP header nonce equals the inline script nonce, and there is no meta refresh", async () => {
	const svc = ui();
	const res = await get(svc);
	const csp = res.headers.get("content-security-policy") ?? "";
	expect(csp).toContain("default-src 'none'");
	const nonce = /nonce-([A-Za-z0-9]+)/.exec(csp)?.[1];
	expect(nonce).toBeTruthy();
	const body = await res.text();
	expect(body).toContain(`<script nonce="${nonce}">`);
	expect(body).not.toContain("http-equiv");
});

test("POST /answer redirects to the one-time receipt", async () => {
	const svc = ui();
	const res = await post(svc, "/answer", { plan: PLAN_W, answer: "yes" });
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=answer");
});

// --- P1: typed page data (the plain-language card rows) ---

test("parsePlan takes the title from the first # heading (else the basename) and the goal bullets, max 6", () => {
	const p = parsePlan(TOY, PLAN_W, readFileSync(PLAN_W, "utf8"));
	expect(p.title).toBe("Toy plan");
	expect(p.goal).toEqual(["Owner page toy."]);
	const goals = Array.from({ length: 9 }, (_, i) => `- goal line ${i + 1}`).join("\n");
	const q = parsePlan(TOY, join(TOY, "docs/plans/20261020_goals.md"), `# Deep goals\n\n## Goal\n${goals}\n`);
	expect(q.title).toBe("Deep goals");
	expect(q.goal).toEqual(["goal line 1", "goal line 2", "goal line 3", "goal line 4", "goal line 5", "goal line 6"]);
	const bare = parsePlan(TOY, join(TOY, "docs/plans/20261020_bare.md"), "no heading here");
	expect(bare.title).toBe("20261020_bare.md");
	expect(bare.goal).toEqual([]);
});

test("questionRows: title, repo label, waiting line, goal and minutes waiting from the file mtime", () => {
	const rows = questionRows(CFG);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ plan: PLAN_W, title: "Toy plan", repo: "toy", waitingLine: QUESTION, waitingAsk: QUESTION, waitingBlocked: null, waitingWhy: null, unblocks: [], goal: ["Owner page toy."] });
	expect(rows[0]!.waitingMin).toBeGreaterThanOrEqual(0);
});

test("agentRows: short model after the last /, detail and minutes since startedAt", () => {
	expect(agentRows(CFG, RUNS)).toEqual([{ id: "owner-ui-alice-run", model: "model", detail: "RUNNING", minutes: 0, status: "running" }]);
	const started = nowSec() - 5400;
	const rows = agentRows(CFG, {
		listRuns: () => [run({ id: "x", model: "zai/glm-5.3-flash", status: "waiting", statusDetail: "WAITING on owner", startedAt: started })],
		mainSession: () => null,
	});
	expect(rows[0]!.model).toBe("glm-5.3-flash");
	expect(rows[0]!.minutes).toBe(90);
	expect(rows[0]!.status).toBe("waiting");
});

test("queueRows: open plans only, with repo label, title, status and waiting", () => {
	expect(queueRows(CFG)).toEqual([{ repo: "toy", file: PLAN_W, title: "Toy plan", status: "open", waiting: true, summary: "Owner page toy.", state: "waits you" }]);
});

test("ciRows: newest first, mr as text, tries as number", () => {
	appendMetric(CFG, { type: "ci", mr: "!78", repo: TOY, tries: 1, ts: nowSec() + 1 });
	const rows = ciRows(CFG);
	expect(rows.length).toBe(2);
	expect(rows[0]).toMatchObject({ mr: "!78", tries: 1 });
	expect(rows[1]!.mr).toBe("!77");
});

test("incidentRows: id, kind, summary, count", () => {
	const rows = incidentRows(CFG);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ kind: "toy", summary: "toy incident the page must show", count: 1 });
	expect(rows[0]!.id).toBeTruthy();
});

test("scoresData parses a markdown table into header and rows, other lines as text", () => {
	const board = join(TMP, "table-board.md");
	writeFileSync(
		board,
		["# Subagent ranking board", "", "| agent | score | runs |", "| --- | ---: | ---: |", "| alice | 4.2 | 7 |", "| bob | 3.9 | 5 |", "", "- alice 4.2 (7d)"].join("\n"),
	);
	const d = scoresData({ ...CFG, paths: { ...CFG.paths, ranking_board: board } });
	expect(d.header).toEqual(["agent", "score", "runs"]);
	expect(d.rows).toEqual([
		["alice", "4.2", "7"],
		["bob", "3.9", "5"],
	]);
	expect(d.text).toEqual(["# Subagent ranking board", "- alice 4.2 (7d)"]);
});

test("machineRow: free GB, disk minimum, load, load max and cores", () => {
	const m = machineRow(CFG);
	expect(m.freeGb).toBeGreaterThan(0);
	expect(typeof m.diskMin).toBe("number");
	expect(m.cores).toBeGreaterThan(0);
	expect(m.loadMax).toBeGreaterThan(0);
	expect(m.load).toBeGreaterThanOrEqual(0);
});

// --- P6: nowStats, the numbers behind the top tiles ---

test("nowStats: the 24 h window — exactly 24 h old is out, 23:59 h is in — and hourly buckets oldest → newest", () => {
	const now = 1_800_000_000;
	const source: RunSource = {
		listRuns: since => {
			expect(since).toBe(now - 86400);
			return [
				run({ id: "edge-out", cost: 1, startedAt: null, lastWriteAt: now - 86_400 }),
				run({ id: "edge-in", cost: 2, startedAt: null, lastWriteAt: now - 86_340 }),
				run({ id: "fresh", cost: 4, startedAt: now - 60, lastWriteAt: now - 30 }),
				run({ id: "older", cost: 8, startedAt: null, lastWriteAt: now - 86_400 - 3600 }),
			];
		},
		mainSession: () => null,
	};
	const s = nowStats(CFG, source, now);
	expect(s.runs24).toBe(2);
	expect(s.spend24).toBeCloseTo(6);
	// 23:59 h ago sits in the oldest bucket (0); a minute ago in the newest (23)
	expect(s.runsByHour[0]).toBe(1);
	expect(s.runsByHour[23]).toBe(1);
	expect(s.spendByHour[0]).toBeCloseTo(2);
	expect(s.spendByHour[23]).toBeCloseTo(4);
	expect(s.openPlans).toBe(1); // the toy INDEX lists one open plan
});

test("nowStats: running and died counts, main vs sub spend split and per-model spend", () => {
	const now = 1_800_000_000;
	const source: RunSource = {
		listRuns: () => [
			run({ id: "m1", kind: "main", model: "zai/glm-5.3-flash", cost: 0.7, status: "running", startedAt: now - 600, lastWriteAt: now - 10 }),
			run({ id: "s1", kind: "sub", model: "zai/glm-5.3-flash", cost: 0.2, status: "died", startedAt: now - 7200, lastWriteAt: now - 3600 }),
			run({ id: "s2", kind: "sub", model: "grok/grok-4-fast", cost: 0.1, status: "done", startedAt: now - 50_000, lastWriteAt: now - 40_000 }),
			run({ id: "s3", kind: "sub", model: "grok/grok-4-fast", cost: 0.3, status: "waiting", startedAt: null, lastWriteAt: now - 100 }),
		],
		mainSession: () => null,
	};
	const s = nowStats(CFG, source, now);
	expect(s.running).toBe(1);
	expect(s.died).toBe(1);
	expect(s.runs24).toBe(4);
	expect(s.mainSpend).toBeCloseTo(0.7);
	expect(s.agentSpend).toBeCloseTo(0.6);
	expect(s.spend24).toBeCloseTo(1.3);
	expect(s.byModel.map(m => m.model)).toEqual(["glm-5.3-flash", "grok-4-fast"]);
	expect(s.byModel[0]!.spend).toBeCloseTo(0.9);
	expect(s.byModel[0]!.runs).toBe(2);
	expect(s.byModel[1]!.spend).toBeCloseTo(0.4);
	expect(s.byModel[1]!.runs).toBe(2);
});

test("buildPageData wraps nowStats in the safe() rule: a throwing run source gives stats null and a live page", () => {
	const bad: RunSource = {
		listRuns: () => {
			throw new Error("boom");
		},
		mainSession: () => null,
	};
	const d = buildPageData(CFG, bad);
	expect(d.stats).toBeNull();
	expect(d.questions).toHaveLength(1);
});

// --- P4: queue reorder by drag and drop ---

const PLAN_A = join(TOY, "docs/plans/20261021_alpha.md");
const PLAN_B = join(TOY, "docs/plans/20261021_beta.md");
const PLAN_C = join(TOY, "docs/plans/20261021_gamma.md");
const PLAN_E = join(TOY, "docs/plans/20261021_delta.md");

// A temp INDEX.md with comment and blank lines: every non-plan line sits above the plan that
// follows it, and a successful reorder keeps exactly that attachment.
function reorderIndex(): string {
	writeFileSync(PLAN_A, PLAN_TEXT("open", false));
	writeFileSync(PLAN_B, PLAN_TEXT("open", false));
	writeFileSync(PLAN_C, PLAN_TEXT("open", false));
	const index = join(TMP, "reorder-index.md");
	writeFileSync(
		index,
		[
			"<!-- the top comment belongs to the plan below it -->",
			PLAN_A,
			"",
			"<!-- pinned above B -->",
			PLAN_B,
			PLAN_C,
			"",
		].join("\n"),
	);
	return index;
}

// The incident shape: a complete plan (B) is still indexed while it awaits its merge, so the
// page shows only the open plans A, C, D — and only those are reorderable.
function mixedIndex(): string {
	writeFileSync(PLAN_A, PLAN_TEXT("open", false));
	writeFileSync(PLAN_B, PLAN_TEXT("complete", false));
	writeFileSync(PLAN_C, PLAN_TEXT("open", false));
	writeFileSync(PLAN_E, PLAN_TEXT("open", true));
	const index = join(TMP, "reorder-index-open.md");
	writeFileSync(
		index,
		[
			"<!-- the top comment belongs to A -->",
			PLAN_A,
			"<!-- pinned above B -->",
			PLAN_B,
			"",
			PLAN_C,
			"<!-- pinned above D -->",
			PLAN_E,
			"",
		].join("\n"),
	);
	return index;
}

test("POST /reorder rewrites the index in the new order, keeping every comment and blank line above the plan that follows it", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const res = await post(svc, "/reorder", {
		order: [PLAN_B, PLAN_C, PLAN_A].join("\n"),
		before: [PLAN_A, PLAN_B, PLAN_C].join("\n"),
		moved: PLAN_A,
	});
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=reorder&to=3");
	expect(readFileSync(index, "utf8")).toBe(
		[
			"",
			"<!-- pinned above B -->",
			PLAN_B,
			PLAN_C,
			"<!-- the top comment belongs to the plan below it -->",
			PLAN_A,
			"",
		].join("\n"),
	);
});

test("POST /reorder appends exactly one reorder inbox record with 1-based from/to ranks and the login", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const before = nowSec();
	const res = await post(svc, "/reorder", {
		order: [PLAN_C, PLAN_A, PLAN_B].join("\n"),
		before: [PLAN_A, PLAN_B, PLAN_C].join("\n"),
		moved: PLAN_A,
	});
	expect(res.status).toBe(303);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({
		ts: expect.any(Number),
		kind: "reorder",
		plan: PLAN_A,
		from: 1,
		to: 2,
		login: OWNER,
	});
	expect(Number(recs[0]!.ts)).toBeGreaterThanOrEqual(before);
});

test("a /reorder order that is not exactly the index's plans gets 400 and leaves the file unchanged", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	const full = [PLAN_A, PLAN_B, PLAN_C];
	// a dropped plan
	expect((await post(svc, "/reorder", { order: [PLAN_A, PLAN_B].join("\n"), before: full.join("\n"), moved: PLAN_A })).status).toBe(400);
	// an added plan
	expect((await post(svc, "/reorder", { order: [...full, PLAN_D].join("\n"), before: full.join("\n"), moved: PLAN_A })).status).toBe(400);
	// a duplicated plan
	expect((await post(svc, "/reorder", { order: [PLAN_A, PLAN_B, PLAN_C, PLAN_A].join("\n"), before: full.join("\n"), moved: PLAN_A })).status).toBe(400);
	// an empty order
	expect((await post(svc, "/reorder", { order: "", before: full.join("\n"), moved: PLAN_A })).status).toBe(400);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

// --- P5: a drag may not put a plan above the open plan it waits on (I-20261025-208) ---

// A carries "Waits on: B", so the index order B, C, A is legal and any order with A above B is not.
function waitsIndex(): string {
	writeFileSync(PLAN_A, PLAN_TEXT("open", false, PLAN_B).replace("# Toy plan", "# Alpha"));
	writeFileSync(PLAN_B, PLAN_TEXT("open", false));
	writeFileSync(PLAN_C, PLAN_TEXT("open", false));
	const index = join(TMP, "reorder-index-waits.md");
	writeFileSync(index, [PLAN_B, PLAN_C, PLAN_A, ""].join("\n"));
	return index;
}

test("POST /reorder refuses a drag that puts a plan above the open plan it waits on: 409, index bytes and inbox untouched", async () => {
	const index = waitsIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	const res = await post(svc, "/reorder", {
		order: [PLAN_A, PLAN_B, PLAN_C].join("\n"),
		before: [PLAN_B, PLAN_C, PLAN_A].join("\n"),
		moved: PLAN_A,
	});
	expect(res.status).toBe(409);
	expect(await res.text()).toContain(
		'blocked: #1 Alpha waits on #2 Toy plan; it cannot sit above it — move #2 up first or remove the "Waits on" line',
	);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

test("POST /reorder still allows a legal drag when plans carry Waits on lines", async () => {
	const index = waitsIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const res = await post(svc, "/reorder", {
		order: [PLAN_C, PLAN_B, PLAN_A].join("\n"),
		before: [PLAN_B, PLAN_C, PLAN_A].join("\n"),
		moved: PLAN_C,
	});
	expect(res.status).toBe(303);
	expect(readFileSync(index, "utf8")).toBe([PLAN_C, PLAN_B, PLAN_A, ""].join("\n"));
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toMatchObject({ kind: "reorder", plan: PLAN_C, from: 2, to: 1, login: OWNER });
});

test("a stale before order gets 409 and leaves the file unchanged", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	// The page was rendered with B,A,C but the index now holds A,B,C: Main reordered meanwhile.
	const res = await post(svc, "/reorder", {
		order: [PLAN_C, PLAN_B, PLAN_A].join("\n"),
		before: [PLAN_B, PLAN_A, PLAN_C].join("\n"),
		moved: PLAN_C,
	});
	expect(res.status).toBe(409);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

test("with a complete plan still indexed, the page ranks only the open plans and dragging the last card to the top rewrites only the open slots", async () => {
	const index = mixedIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	// the page shows A, C, D ranked 1–3; the complete B is not on it
	expect([...(await (await get(svc)).text()).matchAll(/data-plan="([^"]+)"/g)].map(m => m[1])).toEqual([PLAN_A, PLAN_C, PLAN_E]);
	// drag D (page rank 3) to the top: the open plans fill the open slots, B keeps its slot
	const res = await post(svc, "/reorder", {
		order: [PLAN_E, PLAN_A, PLAN_C].join("\n"),
		before: [PLAN_A, PLAN_C, PLAN_E].join("\n"),
		moved: PLAN_E,
	});
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=reorder&to=1");
	expect(readFileSync(index, "utf8")).toBe(
		[
			"<!-- pinned above D -->",
			PLAN_E,
			"<!-- pinned above B -->",
			PLAN_B,
			"<!-- the top comment belongs to A -->",
			PLAN_A,
			"",
			PLAN_C,
			"",
		].join("\n"),
	);
	const recs = inboxRecords();
	expect(recs.length).toBe(1);
	expect(recs[0]).toEqual({ ts: expect.any(Number), kind: "reorder", plan: PLAN_E, from: 3, to: 1, login: OWNER });
});

test("posting a non-open plan in the order gets 400 and leaves the file unchanged", async () => {
	const index = mixedIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	const open = [PLAN_A, PLAN_C, PLAN_E];
	// B is complete, so it is not on the page and not reorderable
	expect((await post(svc, "/reorder", { order: [PLAN_A, PLAN_B, PLAN_C].join("\n"), before: open.join("\n"), moved: PLAN_A })).status).toBe(400);
	// not even appended to an otherwise correct order
	expect((await post(svc, "/reorder", { order: [...open, PLAN_B].join("\n"), before: open.join("\n"), moved: PLAN_A })).status).toBe(400);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

test("a before order that still names a non-open plan is stale and gets 409", async () => {
	const index = mixedIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	// a page rendered before B completed carries B in `before`; against the open plans that render is stale
	const res = await post(svc, "/reorder", {
		order: [PLAN_E, PLAN_A, PLAN_C].join("\n"),
		before: [PLAN_A, PLAN_B, PLAN_C, PLAN_E].join("\n"),
		moved: PLAN_E,
	});
	expect(res.status).toBe(409);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

test("a non-owner peer is refused on /reorder like /answer", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } }, peerOf: () => "100.95.10.7" });
	const original = readFileSync(index, "utf8");
	const res = await post(svc, "/reorder", {
		order: [PLAN_B, PLAN_C, PLAN_A].join("\n"),
		before: [PLAN_A, PLAN_B, PLAN_C].join("\n"),
		moved: PLAN_A,
	});
	expect(res.status).toBe(403);
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

// --- P10: the drag drop lands where the owner aimed it ---

test("dropSlot: a drag from #1 toward #2 lands in slot 2, not second-to-last (P10)", async () => {
	// before the FIRST card below the drag point; a drop above the top stays top; past the end lands after the last.
	// (The old loop kept moving the placeholder in front of every card below the drag point, so
	// the last write won and the card always landed before the LAST card — second-to-last.)
	expect(dropSlot([10, 30, 50, 70], 25)).toBe(1);
	expect(dropSlot([10, 30, 50, 70], 5)).toBe(0);
	expect(dropSlot([10, 30, 50, 70], 99)).toBe(4);
	// the page script inlines this exact function, so what the test runs is what the page runs
	const svc = ui();
	expect(await (await get(svc)).text()).toContain("var dropSlot=");
});

// --- P5b: a drag held at the screen edge autoscrolls the page ---

test("edgeScrollStep: 0 mid-screen, positive in the bottom band growing to the 24 px cap, negative in the top band (P5b)", async () => {
	// middle of the screen and just outside either band: no scroll
	expect(edgeScrollStep(400, 800)).toBe(0);
	expect(edgeScrollStep(72, 800)).toBe(0);
	expect(edgeScrollStep(727, 800)).toBe(0);
	// bottom band: positive, larger nearer the edge, never above the cap
	expect(edgeScrollStep(740, 800)).toBeGreaterThan(0);
	expect(edgeScrollStep(795, 800)).toBeGreaterThan(edgeScrollStep(740, 800));
	expect(edgeScrollStep(800, 800)).toBe(24);
	expect(edgeScrollStep(900, 800)).toBe(24); // a pointer past the edge stays capped
	// top band: negative, larger in magnitude nearer the edge
	expect(edgeScrollStep(60, 800)).toBeLessThan(0);
	expect(edgeScrollStep(10, 800)).toBeLessThan(edgeScrollStep(60, 800));
	expect(edgeScrollStep(-100, 800)).toBe(-24);
	// the page script inlines this exact function, so what the test runs is what the page runs
	const svc = ui();
	expect(await (await get(svc)).text()).toContain("var edgeScrollStep=");
});

test("the reorder receipt says the rank is among open plans (P10)", async () => {
	const svc = ui();
	const res = await get(svc, "/?sent=reorder&to=2");
	expect(await res.text()).toContain("Moved to #2 of open plans");
});

// --- P11: reorder over fetch, no full reload, every POST keeps the tab ---

test("a JSON /reorder answers {ok:true,to:N}, rewrites the index and appends the inbox line (P11)", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const res = await raw(svc, "POST", "/reorder", {
		accept: "application/json",
		origin: `http://${OWN_IP}:${svc.port}`,
		body: { order: [PLAN_B, PLAN_C, PLAN_A].join("\n"), before: [PLAN_A, PLAN_B, PLAN_C].join("\n"), moved: PLAN_A },
	});
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true, to: 3 });
	expect(readFileSync(index, "utf8")).toBe(
		["", "<!-- pinned above B -->", PLAN_B, PLAN_C, "<!-- the top comment belongs to the plan below it -->", PLAN_A, ""].join("\n"),
	);
	const recs = inboxRecords();
	expect(recs).toHaveLength(1);
	expect(recs[0]).toMatchObject({ kind: "reorder", plan: PLAN_A, from: 1, to: 3 });
});

test("a JSON /reorder on a stale before gets JSON {ok:false} with 409 and leaves the file unchanged (P11)", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const original = readFileSync(index, "utf8");
	const res = await raw(svc, "POST", "/reorder", {
		accept: "application/json",
		origin: `http://${OWN_IP}:${svc.port}`,
		body: { order: [PLAN_C, PLAN_B, PLAN_A].join("\n"), before: [PLAN_B, PLAN_A, PLAN_C].join("\n"), moved: PLAN_C },
	});
	expect(res.status).toBe(409);
	expect(await res.json()).toEqual({ ok: false, error: expect.any(String) });
	expect(readFileSync(index, "utf8")).toBe(original);
	expect(inboxRecords()).toEqual([]);
});

test("a plain form /reorder still answers 303 and its location keeps the posted tab (P11)", async () => {
	const index = reorderIndex();
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const res = await post(svc, "/reorder", {
		order: [PLAN_B, PLAN_C, PLAN_A].join("\n"),
		before: [PLAN_A, PLAN_B, PLAN_C].join("\n"),
		moved: PLAN_A,
		tab: "queue",
	});
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?tab=queue&sent=reorder&to=3");
	// the rendered Queue tab carries the hidden tab field the form posts back
	const body = await (await get(svc, "/?tab=queue")).text();
	expect(body).toContain(`name="tab" value="queue"`);
});

test("answer, unlock and lock redirects keep the posted tab; an unknown tab falls back to now (P11)", async () => {
	const svc = ui();
	const answer = await post(svc, "/answer", { plan: PLAN_W, answer: "yes", tab: "queue" });
	expect(answer.status).toBe(303);
	expect(answer.headers.get("location")).toBe("/?tab=queue&sent=answer");
	const unlock = await post(svc, "/unlock", { minutes: "15", tab: "agents" });
	expect(unlock.headers.get("location")).toBe("/?tab=agents&sent=unlock&minutes=15");
	const lock = await post(svc, "/lock", { tab: "spend" });
	expect(lock.headers.get("location")).toBe("/?tab=spend&sent=lock");
	const tier = await post(svc, "/tier", { tier: "full", tab: "queue" });
	expect(tier.headers.get("location")).toBe("/?tab=queue&sent=tier&tier=full");
	const unknown = await post(svc, "/answer", { plan: PLAN_W, answer: "no", tab: "bogus" });
	expect(unknown.headers.get("location")).toBe("/?sent=answer");
});

test("the page CSP allows fetch to itself only, and the script fetch-swaps main instead of reloading (P11)", async () => {
	const svc = ui();
	const res = await get(svc);
	const csp = res.headers.get("content-security-policy") ?? "";
	expect(csp).toContain("connect-src 'self'");
	expect(csp).not.toContain("connect-src *");
	expect(csp).toContain("img-src 'self' data:");
	const body = await res.text();
	expect(body).toContain("createHTMLDocument");
	expect(body).not.toContain("location.reload");
	// the reorder goes over fetch asking for JSON
	expect(body).toContain('"accept":"application/json"');
});

// --- P13: the Tell Main message box ---

test("the Now tab has the Tell Main card above Today; the receipt says Sent to Main (P13)", async () => {
	const svc = ui();
	const body = await (await get(svc)).text();
	const tellAt = body.indexOf("Tell Main");
	expect(tellAt).toBeGreaterThan(-1);
	expect(body.indexOf("<h1>Today</h1>")).toBeGreaterThan(tellAt);
	expect(body).toContain('action="/message" enctype="multipart/form-data"');
	expect(body).toContain('name="images" accept="image/*" multiple');
	expect(body).toContain('maxlength="4000"');
	const res = await get(svc, "/?sent=message");
	expect(await res.text()).toContain("Sent to Main ·");
});

test("POST /message stores a text-only note and appends one inbox line carrying only the id (P13)", async () => {
	const svc = ui();
	const res = await postMessage(svc, { text: "  disk nearly full on the pm box  " }, []);
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?sent=message");
	const recs = inboxRecords();
	expect(recs).toHaveLength(1);
	expect(recs[0]).toMatchObject({ kind: "message", login: OWNER });
	expect(String(recs[0]!.id)).toMatch(/^[0-9]+-[0-9a-f]{6}$/);
	expect(String(recs[0]!)).not.toContain("disk nearly full");
	const dirs = readdirSync(messagesDir());
	expect(dirs).toEqual([String(recs[0]!.id)]);
	const meta = JSON.parse(readFileSync(join(messagesDir(), dirs[0]!, "message.json"), "utf8")) as Record<string, unknown>;
	expect(meta).toMatchObject({ text: "disk nearly full on the pm box", login: OWNER, images: [] });
	expect(typeof meta.ts).toBe("number");
});

test("POST /message with text and the empty file part a browser sends when no file is chosen stores the text (P13)", async () => {
	const svc = ui();
	const res = await postMessage(svc, { text: "text only" }, [{ field: "images", filename: "", bytes: new Uint8Array() }]);
	expect(res.status).toBe(303);
	const id = String(inboxRecords()[0]!.id);
	expect(JSON.parse(readFileSync(join(messagesDir(), id, "message.json"), "utf8"))).toMatchObject({ text: "text only", images: [] });
});

test("POST /message stores a PNG named .bin by its detected type, bytes intact (P13)", async () => {
	const svc = ui();
	const res = await postMessage(svc, { text: "screenshot" }, [{ field: "images", filename: "shot.bin", bytes: PNG_BYTES }]);
	expect(res.status).toBe(303);
	const id = String(inboxRecords()[0]!.id);
	expect(JSON.parse(readFileSync(join(messagesDir(), id, "message.json"), "utf8")).images).toEqual(["1.png"]);
	expect([...readFileSync(join(messagesDir(), id, "1.png"))]).toEqual([...PNG_BYTES]);
});

test("a PDF named x.png is refused with a plain reason and stores nothing (P13)", async () => {
	const svc = ui();
	const res = await postMessage(svc, { text: "look" }, [{ field: "images", filename: "x.png", bytes: PDF_BYTES }]);
	expect(res.status).toBe(400);
	expect(await res.text()).toContain("PNG, JPEG, GIF or WEBP");
	expect(storedMessages()).toEqual([]);
	expect(inboxRecords()).toEqual([]);
});

test("five images, an empty message and an over-long text are refused (P13)", async () => {
	const svc = ui();
	const five = [1, 2, 3, 4, 5].map(i => ({ field: "images", filename: `${i}.png`, bytes: PNG_BYTES }));
	expect((await postMessage(svc, { text: "five" }, five)).status).toBe(400);
	expect((await postMessage(svc, {}, [])).status).toBe(400);
	expect((await postMessage(svc, { text: "x".repeat(4001) }, [])).status).toBe(400);
	expect(storedMessages()).toEqual([]);
	expect(inboxRecords()).toEqual([]);
});

test("a stranger's message gets 403 like /answer and stores nothing (P13)", async () => {
	const svc = ui({ peerOf: () => "100.95.10.7" });
	const res = await postMessage(svc, { text: "hi" }, []);
	expect(res.status).toBe(403);
	expect(storedMessages()).toEqual([]);
	expect(inboxRecords()).toEqual([]);
});

test("GET /message-image serves the stored bytes and refuses a foreign name or a path guess (P13)", async () => {
	const svc = ui();
	await postMessage(svc, { text: "photo" }, [{ field: "images", filename: "p.png", bytes: PNG_BYTES }]);
	const id = String(inboxRecords()[0]!.id);
	const img = await get(svc, `/message-image/${id}/1.png`);
	expect(img.status).toBe(200);
	expect(img.headers.get("content-type")).toBe("image/png");
	expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([...PNG_BYTES]);
	// a name not in message.json
	expect((await get(svc, `/message-image/${id}/2.png`)).status).toBe(404);
	// traversal and junk ids never reach a path join
	expect((await get(svc, `/message-image/${id}/..%2Fowner-inbox.jsonl`)).status).toBe(404);
	expect((await get(svc, "/message-image/not-an-id/1.png")).status).toBe(404);
	expect((await get(svc, "/message-image/extra/parts/1.png")).status).toBe(404);
});

test("a 13 h old message is swept by a GET; an 11 h old one stays and shows (P13)", async () => {
	const svc = ui();
	const now = nowSec();
	const mk = (ageHours: number, text: string) => {
		const ts = now - ageHours * 3600;
		const dir = join(messagesDir(), `${ts}-abc123`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "message.json"), `${JSON.stringify({ ts, text, login: OWNER, images: [] })}\n`);
	};
	mk(13, "expired note");
	mk(11, "still fresh note");
	const body = await (await get(svc)).text();
	expect(existsSync(join(messagesDir(), `${now - 13 * 3600}-abc123`))).toBe(false);
	expect(body).toContain("still fresh note");
	expect(body).not.toContain("expired note");
});

// --- P11b: every POST answers JSON when asked; a plain post keeps its 303 ---

test("POST /answer JSON: ok, stale and error replies (P11b)", async () => {
	const svc = ui();
	const ok = await raw(svc, "POST", "/answer", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { plan: PLAN_W, answer: "yes" } });
	expect(ok.status).toBe(200);
	const okBody = (await ok.json()) as Record<string, unknown>;
	expect(okBody).toMatchObject({ ok: true, sent: "answer" });
	expect(String(okBody.receipt)).toContain("Sent to Main ·");
	expect(inboxRecords()).toHaveLength(1);
	// a stale answer (P8b) shows its text in place
	try {
		writeFileSync(PLAN_W, PLAN_TEXT("open", false));
		const stale = await raw(svc, "POST", "/answer", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { plan: PLAN_W, answer_text: "do it now" } });
		expect(stale.status).toBe(200);
		const staleBody = (await stale.json()) as Record<string, unknown>;
		expect(staleBody).toMatchObject({ ok: true, sent: "stale" });
		expect(String(staleBody.receipt)).toContain("Already handled");
	} finally {
		writeFileSync(PLAN_W, PLAN_TEXT("open", true));
	}
	const err = await raw(svc, "POST", "/answer", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { plan: "/nope.md", answer: "yes" } });
	expect(err.status).toBe(409);
	expect(await err.json()).toEqual({ ok: false, error: "plan is not open and waiting" });
});

test("POST /unlock, /lock and /tier answer JSON; a plain post still gets its 303 (P11b)", async () => {
	const svc = ui();
	const unlock = await raw(svc, "POST", "/unlock", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { minutes: "15" } });
	expect(unlock.status).toBe(200);
	expect(await unlock.json()).toEqual({ ok: true, sent: "unlock", receipt: "Unlocked for 15 min" });
	const lock = await raw(svc, "POST", "/lock", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: {} });
	expect(await lock.json()).toEqual({ ok: true, sent: "lock", receipt: "Locked" });
	const tier = await raw(svc, "POST", "/tier", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { tier: "strict" } });
	expect(await tier.json()).toEqual({ ok: true, sent: "tier" });
	const badTier = await raw(svc, "POST", "/tier", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { tier: "nope" } });
	expect(badTier.status).toBe(400);
	expect(await badTier.json()).toEqual({ ok: false, error: "tier must be strict, opinionated or full" });
	const plain = await post(svc, "/unlock", { minutes: "15" });
	expect(plain.status).toBe(303);
	expect(plain.headers.get("location")).toBe("/?sent=unlock&minutes=15");
});

test("unlock and lock with the gate off answer JSON refused (P11b)", async () => {
	const svc = ui({ cfg: { ...CFG, guards: { ...CFG.guards, chat_unlock: false } } });
	const off = await raw(svc, "POST", "/unlock", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: { minutes: "15" } });
	expect(off.status).toBe(400);
	expect(await off.json()).toEqual({ ok: false, error: "Refused — chat unlock is off" });
	expect((await raw(svc, "POST", "/lock", { accept: "application/json", origin: `http://${OWN_IP}:${svc.port}`, body: {} })).status).toBe(400);
});

test("POST /message answers JSON ok and error (P11b)", async () => {
	const svc = ui();
	const ok = await postMessage(svc, { text: "note" }, [], true);
	expect(ok.status).toBe(200);
	const okBody = (await ok.json()) as Record<string, unknown>;
	expect(okBody).toMatchObject({ ok: true, sent: "message" });
	expect(String(okBody.receipt)).toContain("Sent to Main ·");
	const bad = await postMessage(svc, { text: "look" }, [{ field: "images", filename: "x.png", bytes: PDF_BYTES }], true);
	expect(bad.status).toBe(400);
	expect(await bad.json()).toEqual({ ok: false, error: "attachments must be PNG, JPEG, GIF or WEBP images — the type is read from the file itself" });
});

test("the queue section is one flat ranked list with a drag handle, arrow buttons and the rendered order in a before field", async () => {
	const svc = ui();
	const body = await (await get(svc)).text();
	expect(body).toContain('id="qlist"');
	expect(body).toContain(`data-plan="${PLAN_W}"`);
	expect(body).toContain('class="qrank">1<');
	expect(body).toContain("qhandle");
	expect(body).toContain(">↑ top<");
	expect(body).toContain(">↑<");
	expect(body).toContain(">↓<");
	expect(body).toContain(`name="before" value="${PLAN_W}"`);
	expect(body).toContain('action="/reorder"');
	// not grouped by repo any more
	expect(body).not.toContain("qrepo");
});

// --- P7: tab selection and the queue preview cut ---

test("tab selection: each tab shows its own sections and an unknown tab falls back to now", async () => {
	const svc = ui();
	const now = await (await get(svc)).text();
	expect(now).toContain("Today");
	expect(now).toContain(QUESTION);
	expect(now).not.toContain("owner-ui-alice-run");
	const queue = await (await get(svc, "/?tab=queue")).text();
	expect(queue).toContain('id="qlist"');
	expect(queue).not.toContain("Today");
	const agents = await (await get(svc, "/?tab=agents")).text();
	expect(agents).toContain("owner-ui-alice-run");
	expect(agents).toContain("alice 4.2");
	expect(agents).toContain("toy incident the page must show");
	expect(agents).toContain("!77");
	expect(agents).toContain("Disk free");
	expect(agents).not.toContain(QUESTION);
	const spend = await (await get(svc, "/?tab=spend")).text();
	expect(spend).toContain("By model");
	expect(spend).toContain("$0.20");
	expect(spend).not.toContain(QUESTION);
	const unknown = await (await get(svc, "/?tab=bogus")).text();
	expect(unknown).toContain("Today");
	expect(unknown).toContain('href="/?tab=now" class="on">Now</a>');
});

test("the Now tab cuts the queue preview at 8 rows with Show all N; the Queue tab lists every row", async () => {
	const files: string[] = [];
	for (let i = 0; i < 10; i++) {
		const f = join(TOY, `docs/plans/20261022_many_${i}.md`);
		writeFileSync(f, PLAN_TEXT("open", false));
		files.push(f);
	}
	const index = join(TMP, "many-open-index.md");
	writeFileSync(index, `${[...files, PLAN_W].join("\n")}\n`);
	const svc = ui({ cfg: { ...CFG, paths: { ...CFG.paths, queue_index: index } } });
	const now = await (await get(svc)).text();
	expect([...now.matchAll(/data-plan="([^"]+)"/g)]).toHaveLength(8);
	expect(now).toContain("Show all 11 ›");
	const full = await (await get(svc, "/?tab=queue")).text();
	expect([...full.matchAll(/data-plan="([^"]+)"/g)]).toHaveLength(11);
	expect(full).not.toContain("Show all");
});
