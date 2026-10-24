// Owner phone page (plan 20261024_2230): one server-rendered page over Tailscale that shows the
// questions waiting on the owner, the guard unlock, the running agents, the queue, recent CI,
// open incidents, agent scores and machine health. Answers are appended to the owner inbox
// (<queue_state>/owner-inbox.jsonl) where the adapter picks them up; unlock/lock go through the
// core chatUnlock. Every section is built from the existing core readers, never by shelling out
// to a CLI. Tailscale is an injected Tailscale value (src/core/tailscale.ts has the real one) so
// tests never call the binary; the peer address is an injectable seam too, so tests bind
// 127.0.0.1 while the real server binds only the tailnet address from `tailscale ip -4`.

import { appendFileSync, mkdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import os from "node:os";
import { basename } from "node:path";
import type { RunSource } from "./adapter.ts";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { cpuCount } from "./host.ts";
import { openIncidents } from "./incidents.ts";
import { log } from "./guards.ts";
import { readMetricEvents } from "./metrics.ts";
import { activePlans, chatUnlock, expandHome, stateDirPath, unlockPath, type Plan } from "./queue/lib.ts";
import type { Tailscale } from "./tailscale.ts";

const ANSWER_MAX = 2000;
const REFRESH_SEC = 20;
// Tailscale hands out addresses from 100.64.0.0/10 (CGNAT) and its own ULA /48 for IPv6.
const TAILNET6 = /^fd7a:115c:a1e0:/i;

/** The slice of Bun's server the page needs: the peer address of a request. Bun.serve's return satisfies it. */
export interface UiHttpServer {
	requestIP(req: Request): { address: string; family: string; port: number } | null;
}

export interface OwnerUiServer {
	stop(): void;
	hostname: string;
	port: number;
}

export interface OwnerUiOptions {
	cfg: Config;
	tailscale: Tailscale;
	source: RunSource;
	/** Bind address. Default: the tailnet address from `tailscale ip -4`. Tests bind 127.0.0.1. */
	hostname?: string;
	/** Bind port. Default: ui.port; 0 picks a free port (tests). */
	port?: number;
	/** The peer address of a request. Default: the socket address. Tests inject fixture peers. */
	peerOf?: (req: Request, server: UiHttpServer) => string;
}

export type Auth = { ok: true; login: string } | { ok: false; why: string };

/** The inbox the page appends answers to and the adapter delivers from: under the queue state dir. */
export function inboxPath(): string {
	return `${stateDirPath()}/owner-inbox.jsonl`;
}

function isLoopback(peer: string): boolean {
	return peer === "::1" || peer === "localhost" || peer.startsWith("127.");
}

function isTailnet(peer: string): boolean {
	const v4 = /^(\d+)\.(\d+)\./.exec(peer);
	if (v4) return v4[1] === "100" && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
	return TAILNET6.test(peer);
}

/** Serve only the owner's phone: a tailnet peer that is not this machine and not loopback, whose tailscale whois login equals ui.owner_login. Everything else is a 403. */
export function authenticate(cfg: Config, tailscale: Tailscale, peer: string): Auth {
	if (!cfg.ui.owner_login) return { ok: false, why: "ui.owner_login is empty" };
	if (isLoopback(peer)) return { ok: false, why: "loopback peer" };
	if (!isTailnet(peer)) return { ok: false, why: "peer is not a tailnet address" };
	if (peer === tailscale.ip4()) return { ok: false, why: "this machine's own tailnet address" };
	const login = tailscale.whois(peer);
	if (!login) return { ok: false, why: "tailscale whois failed" };
	if (login !== cfg.ui.owner_login) return { ok: false, why: "not the owner's login" };
	return { ok: true, login };
}

// ---- sections ----

interface Section {
	title: string;
	body: string;
}

function section(title: string, build: () => string): Section {
	try {
		return { title, body: build() };
	} catch {
		// One unreadable source must never take the page down.
		return { title, body: "<p>unavailable</p>" };
	}
}

function esc(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function answerForm(plan: Plan): string {
	return [
		`<form method="post" action="/answer">`,
		`<input type="hidden" name="plan" value="${esc(plan.file)}">`,
		`<p><strong>${esc(basename(plan.file))}</strong><br>${esc(plan.waitingLine ?? "")}</p>`,
		`<button type="submit" name="answer" value="yes">yes</button>`,
		`<button type="submit" name="answer" value="no">no</button>`,
		`<input type="text" name="answer_text" maxlength="${ANSWER_MAX}" placeholder="short answer">`,
		`<button type="submit">send</button>`,
		`</form>`,
	].join("\n");
}

function questionsBody(cfg: Config): string {
	const waiting = activePlans(cfg.paths.queue_index).filter(p => p.waiting && p.status === "open" && p.waitingLine);
	return waiting.length ? waiting.map(answerForm).join("\n") : "<p>nothing is waiting on you</p>";
}

function guardsBody(cfg: Config): string {
	let state = "<p>guards locked</p>";
	try {
		const end = statSync(unlockPath()).mtimeMs + cfg.guards.unlock_minutes * 60_000;
		const left = Math.round((end - Date.now()) / 60_000);
		if (left > 0) state = `<p>guards <strong>unlocked</strong> for ~${left} more min</p>`;
	} catch {}
	const button = (minutes: number) =>
		`<form method="post" action="/unlock"><input type="hidden" name="minutes" value="${minutes}"><button type="submit">unlock ${minutes}</button></form>`;
	return [
		state,
		button(5),
		button(15),
		button(30),
		`<form method="post" action="/lock"><button type="submit">lock now</button></form>`,
	].join("\n");
}

function agentsBody(cfg: Config, source: RunSource): string {
	const cut = nowSec() - cfg.ledger.default_hours * 3600;
	const live = source
		.listRuns(cut)
		.filter(r => r.status === "running" || r.status === "waiting")
		.map(r => `${r.id}  ${r.statusDetail}  ${r.model}`);
	return live.length ? `<pre>${esc(live.join("\n"))}</pre>` : "<p>no agents running or waiting</p>";
}

function queueBody(cfg: Config): string {
	const plans = activePlans(cfg.paths.queue_index).map(
		p => `${basename(p.file)} — ${p.status ?? "?"}${p.waiting ? " — WAITING on owner" : ""}`,
	);
	return plans.length ? `<pre>${esc(plans.join("\n"))}</pre>` : "<p>the queue is empty</p>";
}

function ciBody(cfg: Config): string {
	const rows = readMetricEvents(cfg)
		.filter(e => e.type === "ci")
		.slice(-10)
		.reverse()
		.map(e => `${String(e.mr)} — ${Number(e.tries)} pipeline(s) — ${strftime(Number(e.ts), "%m-%d %H:%M")}`);
	return rows.length ? `<pre>${esc(rows.join("\n"))}</pre>` : "<p>no CI runs recorded</p>";
}

function incidentsBody(cfg: Config): string {
	const open = openIncidents(cfg).map(i => `${i.id} [${i.source}/${i.kind}] ${i.summary}${i.count > 1 ? ` — ${i.count}x` : ""}`);
	return open.length ? `<pre>${esc(open.join("\n"))}</pre>` : "<p>no open incidents</p>";
}

function scoresBody(cfg: Config): string {
	return `<pre>${esc(readFileSync(cfg.paths.ranking_board, "utf8").trimEnd())}</pre>`;
}

function machineBody(cfg: Config): string {
	const st = statfsSync(expandHome(cfg.machine.disk_path));
	const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
	const load = os.loadavg()[0] ?? 0;
	const cores = cpuCount();
	const loadMax = cfg.machine.load_max > 0 ? cfg.machine.load_max : cores + cfg.machine.load_over_cores;
	const disk = `disk ${freeGb.toFixed(0)} GB free in ${cfg.machine.disk_path} (min ${cfg.machine.disk_min_gb} GB)${freeGb < cfg.machine.disk_min_gb ? " — LOW" : ""}`;
	const loadLine = `load ${load.toFixed(2)} on ${cores} cores (max ${loadMax})${load > loadMax ? " — HIGH" : ""}`;
	return `<pre>${esc([disk, loadLine].join("\n"))}</pre>`;
}

function buildSections(cfg: Config, source: RunSource): Section[] {
	return [
		section("Waiting on you", () => questionsBody(cfg)),
		section("Guards", () => guardsBody(cfg)),
		section("Agents", () => agentsBody(cfg, source)),
		section("Queue", () => queueBody(cfg)),
		section("Merges / CI", () => ciBody(cfg)),
		section("Incidents", () => incidentsBody(cfg)),
		section("Agent scores", () => scoresBody(cfg)),
		section("Machine", () => machineBody(cfg)),
	];
}

function renderPage(sections: Section[]): string {
	const body = sections.map(s => `<section><h2>${esc(s.title)}</h2>${s.body}</section>`).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SEC}">
<title>neurastream</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: 40rem; font-size: 1.05rem; line-height: 1.45; }
section { border: 1px solid #8884; border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
h2 { font-size: 1.15rem; margin: 0 0 0.5rem; }
button { font-size: 1.15rem; padding: 0.55rem 1.1rem; margin: 0.2rem 0.2rem 0.2rem 0; border-radius: 8px; }
input[type=text] { font-size: 1.1rem; padding: 0.5rem; width: 55%; border-radius: 8px; }
pre { white-space: pre-wrap; margin: 0; font-size: 0.95rem; overflow-wrap: anywhere; }
form { margin: 0.3rem 0; }
@media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } section { border-color: #6668; } }
@media (prefers-color-scheme: light) { body { background: #fff; color: #111; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---- request plumbing ----

async function fieldsOf(req: Request): Promise<Record<string, string>> {
	const ct = req.headers.get("content-type") ?? "";
	if (ct.includes("application/json")) {
		const raw: unknown = await req.json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
	}
	const form = await req.formData();
	return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

function textRes(body: string, status: number): Response {
	return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function redirect(): Response {
	return new Response(null, { status: 303, headers: { location: "/" } });
}

function handleAnswer(cfg: Config, fields: Record<string, string>, login: string): Response {
	const planFile = (fields.plan ?? "").trim();
	const answer = (fields.answer_text ?? "").trim() || (fields.answer ?? "").trim();
	if (!planFile || !answer) return textRes("plan and answer are required", 400);
	if (answer.length > ANSWER_MAX) return textRes(`answer is longer than ${ANSWER_MAX} chars`, 400);
	const plan = activePlans(cfg.paths.queue_index).find(p => p.file === planFile);
	if (!plan || plan.status !== "open" || !plan.waiting || !plan.waitingLine) {
		return textRes("plan is not open and waiting", 409);
	}
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), plan: planFile, question: plan.waitingLine, answer, login })}\n`);
	return redirect();
}

function handleUnlock(cfg: Config, fields: Record<string, string>, login: string): Response {
	const minutes = fields.minutes ?? "";
	if (minutes !== "" && !/^\d+$/.test(minutes)) return textRes("minutes must be a number", 400);
	const result = chatUnlock(minutes === "" ? "unlock" : `unlock ${minutes}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return textRes("unlock refused: guards.chat_unlock is off", 409);
	return redirect();
}

function handleLock(cfg: Config, login: string): Response {
	const result = chatUnlock("lock", cfg, `ui:${login}`, "ui");
	if (!result.applied) return textRes("lock refused: guards.chat_unlock is off", 409);
	return redirect();
}

/** Starts the page. Refuses to start when ui.enabled is false or ui.owner_login is empty, and on the default hostname when tailscale does not answer. */
export function startOwnerUi(opts: OwnerUiOptions): OwnerUiServer {
	const { cfg, tailscale, source } = opts;
	if (!cfg.ui.enabled) throw new Error("owner ui: ui.enabled is false — set it in the config first");
	if (!cfg.ui.owner_login) throw new Error("owner ui: ui.owner_login is empty — set the tailscale login that may open the page");
	const hostname = opts.hostname ?? tailscale.ip4();
	if (!hostname) throw new Error("owner ui: tailscale ip -4 did not answer — is tailscale up?");
	const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
	// Host allowlist (plan P3a): a DNS-rebinding page sends evil.example's Host with a matching
	// Origin from the owner's own phone, so the peer and Origin checks alone pass it. On every
	// request, before whois, the Host header must name this page — the tailnet address or the
	// MagicDNS name (dnsName(), trailing dot stripped) — with the served port. Anything else is a
	// 403 no matter whose peer it is. Computed once, against the bound port (tests bind 0).
	let allowedHosts: string[] | null = null;
	const hostAllowed = (hostHeader: string, port: number | undefined): boolean => {
		// No bound port (never expected): nothing is allowed — fail closed.
		if (port === undefined) return false;
		if (allowedHosts === null) {
			const dns = tailscale.dnsName();
			allowedHosts = [tailscale.ip4(), dns].filter((h): h is string => Boolean(h)).map(h => `${h}:${port}`);
		}
		return allowedHosts.includes(hostHeader);
	};
	const server = Bun.serve({
		hostname,
		port: opts.port ?? cfg.ui.port,
		fetch: async (req, srv) => {
			const url = new URL(req.url);
			let code = 500;
			let login: string | null = null;
			let res: Response;
			try {
				const hostHeader = req.headers.get("host") ?? "";
				if (!hostAllowed(hostHeader, srv.port)) {
					res = textRes("forbidden: host is not this page", 403);
					code = 403;
				} else {
					const auth = authenticate(cfg, tailscale, peerOf(req, srv));
					if (!auth.ok) {
						res = textRes("forbidden: this page serves only the owner", 403);
						code = 403;
					} else {
						login = auth.login;
						if (req.method === "POST" && req.headers.get("origin") !== `http://${hostHeader}`) {
							res = textRes("forbidden: origin is not this page", 403);
							code = 403;
						} else if (req.method === "GET" && url.pathname === "/") {
							res = new Response(renderPage(buildSections(cfg, source)), {
								status: 200,
								headers: { "content-type": "text/html; charset=utf-8" },
							});
							code = 200;
						} else if (req.method === "POST" && url.pathname === "/answer") {
							res = handleAnswer(cfg, await fieldsOf(req), login);
							code = res.status;
						} else if (req.method === "POST" && url.pathname === "/unlock") {
							res = handleUnlock(cfg, await fieldsOf(req), login);
							code = res.status;
						} else if (req.method === "POST" && url.pathname === "/lock") {
							res = handleLock(cfg, login);
							code = res.status;
						} else {
							res = textRes("not found", 404);
							code = 404;
						}
					}
				}
			} catch {
				res = textRes("internal error", 500);
				code = 500;
			}
			log(cfg.paths.guard_log, `UI ${req.method} ${url.pathname} login=${login ?? "-"} → ${code}`);
			return res;
		},
	});
	return { stop: () => server.stop(true), hostname, port: Number(server.port) };
}
