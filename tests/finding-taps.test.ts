// Finding taps (plan 20261028_1135_finding_taps). P1: Main proposes, in writing, why a finding
// incident is or is not a bug (`neurastream incident propose <id> --why "<file:line + reason>"`).
// A proposal is not a resolution: the incident stays open until the owner taps or a plan lands.
// P2: the open-incident row carries Main's latest why, and the agents page shows it with two
// owner tap buttons.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { runIncident } from "../src/cli/incident.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { addIncident, dismissIncident, openIncidents, readIncidents } from "../src/core/incidents.ts";
import { incidentRows, inboxPath, startOwnerUi } from "../src/core/owner-ui.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import type { Tailscale } from "../src/core/tailscale.ts";

const ROOT = "/tmp/neurastream-home-findingtaps/p1";
const HOME = join(ROOT, "home");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const STATE = join(HOME, ".local/state/queue");
const SAVED_HOME = process.env.HOME;

const OWNER = "owner@example.com";
const OWN_IP = "100.95.10.2"; // fixture: this machine's tailnet address
const PEER = "100.95.10.9"; // fixture: the owner's phone
const TS: Tailscale = {
	ip4: () => OWN_IP,
	dnsName: () => "ukd.tail4295de.ts.net",
	whois: (peer: string) => (peer === PEER ? OWNER : null),
	logins: () => [OWNER],
};

let cfg: Config;

function fresh(): void {
	rmSync(ROOT, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(join(AGENT, "INDEX.md"), "");
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	process.env.HOME = HOME;
	cfg = loadConfig({ home: HOME, env: {} });
	applyQueueEnv(cfg);
}

// fresh() points QUEUE_* env at the sandbox per test; restore the caller's at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

afterAll(() => {
	if (SAVED_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = SAVED_HOME;
	rmSync(ROOT, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

beforeEach(fresh);

const WHY = "src/core/guards.ts:40 the bucket is never created, so the stop guard reads nothing";

test("incident propose records the reason and the incident stays open", async () => {
	const { incident } = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" });
	expect(await runIncident(["propose", incident.id, "--why", WHY])).toBe(0);
	expect(openIncidents(cfg).map(i => i.id)).toEqual([incident.id]);
	expect(readIncidents(cfg).find(i => i.id === incident.id)?.proposal?.why).toBe(WHY);
});

test("a newer propose replaces the older one", async () => {
	const { incident } = addIncident(cfg, { source: "main", kind: "main-finding", summary: "bucket missing" });
	expect(await runIncident(["propose", incident.id, "--why", WHY])).toBe(0);
	const newer = "src/core/guards.ts:41 the bucket is created after the read, so the reading is empty";
	expect(await runIncident(["propose", incident.id, "--why", newer])).toBe(0);
	expect(readIncidents(cfg).find(i => i.id === incident.id)?.proposal?.why).toBe(newer);
});

test("incident propose refuses an unknown id, a resolved incident, a non-finding kind and a why without file:line", async () => {
	const finding = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" }).incident;
	const toy = addIncident(cfg, { source: "realtime", kind: "toy", summary: "not a finding" }).incident;
	const closed = addIncident(cfg, { source: "realtime", kind: "toy", summary: "already closed" }).incident;
	expect(await runIncident(["propose", "I-19990101-9", "--why", WHY])).toBe(1);
	expect(await runIncident(["propose", toy.id, "--why", WHY])).toBe(1);
	expect(await runIncident(["propose", finding.id, "--why", "no reference at all"])).toBe(1);
	expect(readIncidents(cfg).find(i => i.id === finding.id)?.proposal ?? null).toBe(null);
	expect(dismissIncident(cfg, closed.id, "closed to test refusals")).toBe(null);
	expect(await runIncident(["propose", closed.id, "--why", WHY])).toBe(1);
});

// P2: the open-incident row carries Main's latest why, and the agents page shows it with two
// owner tap buttons. Red until incidentRows and incidentsHtml change.
test("incidentRows carries Main's latest why for a finding and null for a non-finding", async () => {
	const finding = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" }).incident;
	const toy = addIncident(cfg, { source: "realtime", kind: "toy", summary: "not a finding" }).incident;
	expect(await runIncident(["propose", finding.id, "--why", WHY])).toBe(0);
	const rows = incidentRows(cfg);
	expect(rows.find(r => r.id === finding.id)?.proposal).toBe(WHY);
	expect(rows.find(r => r.id === toy.id)?.proposal).toBe(null);
});

function pageHtml(port: number, path: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `${OWN_IP}:${port}` } }, res => {
		let body = "";
		res.setEncoding("utf8");
		res.on("data", chunk => (body += chunk));
		res.on("end", () => resolve(body));
	});
	req.on("error", reject);
	req.end();
	return promise;
}

test("the agents page shows Main's why and two tap buttons for a finding, and says so when there is no why", async () => {
	const proposed = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" }).incident;
	const unproposed = addIncident(cfg, { source: "findings", kind: "main-finding", summary: "no reason yet" }).incident;
	expect(await runIncident(["propose", proposed.id, "--why", WHY])).toBe(0);
	const svc = startOwnerUi({
		cfg: { ...cfg, ui: { ...cfg.ui, enabled: true, port: 7787, owner_login: OWNER } },
		tailscale: TS,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: "127.0.0.1",
		port: 0,
		peerOf: () => PEER,
	});
	try {
		const html = await pageHtml(svc.port, "/?tab=agents");
		expect(html).toContain(WHY);
		expect(html).toContain(`action="/incident"`);
		expect(html).toContain(`name="id" value="${proposed.id}"`);
		expect(html).toContain(`name="choice" value="bug"`);
		expect(html).toContain(`name="choice" value="false"`);
		expect(html).toContain("Main has not said why yet");
		expect(html).toContain(unproposed.id);
	} finally {
		svc.stop();
	}
});

// P3: the owner's two tap buttons. POST /incident is the only write path; red until the handler exists.
function startPage() {
	return startOwnerUi({
		cfg: { ...cfg, ui: { ...cfg.ui, enabled: true, port: 7787, owner_login: OWNER } },
		tailscale: TS,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: "127.0.0.1",
		port: 0,
		peerOf: () => PEER,
	});
}

function postForm(port: number, path: string, fields: Record<string, string>): Promise<{ status: number; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
	const payload = new URLSearchParams(fields).toString();
	const req = request(
		{
			host: "127.0.0.1",
			port,
			path,
			method: "POST",
			headers: {
				host: `${OWN_IP}:${port}`,
				origin: `http://${OWN_IP}:${port}`,
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded",
				"content-length": Buffer.byteLength(payload),
			},
		},
		res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		},
	);
	req.on("error", reject);
	req.end(payload);
	return promise;
}

test("POST /incident choice=false closes a finding and records the owner's tap with Main's why", async () => {
	const id = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "bucket missing" }).incident.id;
	expect(await runIncident(["propose", id, "--why", WHY])).toBe(0);
	const svc = startPage();
	try {
		const res = await postForm(svc.port, "/incident", { id, choice: "false", tab: "agents" });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
	} finally {
		svc.stop();
	}
	expect(openIncidents(cfg).map(i => i.id)).not.toContain(id);
	const resolution = readIncidents(cfg).find(i => i.id === id)?.resolution;
	expect(resolution && "why" in resolution ? resolution.why : "").toContain(`owner tapped "false alarm" on the phone page (${OWNER}): ${WHY}`);
});

test("POST /incident choice=bug keeps the finding open and adds one inbox message", async () => {
	const id = addIncident(cfg, { source: "findings", kind: "main-finding", summary: "stop guard reads nothing" }).incident.id;
	const svc = startPage();
	try {
		const res = await postForm(svc.port, "/incident", { id, choice: "bug", tab: "agents" });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).ok).toBe(true);
	} finally {
		svc.stop();
	}
	expect(openIncidents(cfg).map(i => i.id)).toContain(id);
	const inbox = readFileSync(inboxPath(), "utf8").split("\n").filter(l => l.includes(`"id":"`) && l.includes(`"kind":"message"`));
	expect(inbox.length).toBe(1);
});

test("POST /incident refuses an unknown or already-closed incident with 409", async () => {
	const id = addIncident(cfg, { source: "findings", kind: "agent-finding", summary: "already closed" }).incident.id;
	expect(dismissIncident(cfg, id, "a reason", undefined, OWNER)).toBe(null);
	const svc = startPage();
	try {
		expect((await postForm(svc.port, "/incident", { id: "I-19990101-9", choice: "false", tab: "agents" })).status).toBe(409);
		expect((await postForm(svc.port, "/incident", { id, choice: "false", tab: "agents" })).status).toBe(409);
	} finally {
		svc.stop();
	}
});
