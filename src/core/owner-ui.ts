// Owner phone page (plan 20261024_2230): one server-rendered page over Tailscale that shows the
// questions waiting on the owner, the guard unlock, the running agents, the queue, recent CI,
// open incidents, agent scores and machine health. Answers are appended to the owner inbox
// (<queue_state>/owner-inbox.jsonl) where the adapter picks them up; unlock/lock go through the
// core chatUnlock. Every section is built from the existing core readers, never by shelling out
// to a CLI. Tailscale is an injected Tailscale value (src/core/tailscale.ts has the real one) so
// tests never call the binary; the peer address is an injectable seam too, so tests bind
// 127.0.0.1 while the real server binds only the tailnet address from `tailscale ip -4`.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { basename, resolve } from "node:path";
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

function esc(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// ---- page data: one pure typed-row builder per source; rendering reads only these ----

export interface QuestionRow {
	plan: string;
	title: string;
	repo: string;
	waitingLine: string;
	goal: string[];
	waitingMin: number;
}

export interface AgentRow {
	id: string;
	model: string;
	detail: string;
	minutes: number;
	status: string;
}

export interface QueueRow {
	repo: string;
	file: string;
	title: string;
	status: string;
	waiting: boolean;
}

export interface CiRow {
	mr: string;
	tries: number;
	ts: number;
}

export interface IncidentRow {
	id: string;
	kind: string;
	summary: string;
	count: number;
}

/** A markdown table from the ranking board plus every non-table line, kept in order. */
export interface ScoresData {
	header: string[];
	rows: string[][];
	text: string[];
}

export interface MachineRow {
	freeGb: number;
	diskMin: number;
	load: number;
	loadMax: number;
	cores: number;
}

export function questionRows(cfg: Config): QuestionRow[] {
	const now = Date.now();
	return activePlans(cfg.paths.queue_index)
		.filter(p => p.waiting && p.status === "open" && p.waitingLine)
		.map(p => {
			let waitingMin = 0;
			try {
				waitingMin = Math.max(0, Math.round((now - statSync(p.file).mtimeMs) / 60_000));
			} catch {}
			return {
				plan: p.file,
				title: p.title,
				repo: basename(p.repo),
				waitingLine: p.waitingLine ?? "",
				goal: p.goal,
				waitingMin,
			};
		});
}

export function agentRows(cfg: Config, source: RunSource): AgentRow[] {
	const cut = nowSec() - cfg.ledger.default_hours * 3600;
	return source
		.listRuns(cut)
		.filter(r => r.status === "running" || r.status === "waiting")
		.map(r => ({
			id: r.id,
			model: r.model.slice(r.model.lastIndexOf("/") + 1),
			detail: r.statusDetail,
			minutes: r.startedAt === null ? 0 : Math.max(0, Math.round((nowSec() - r.startedAt) / 60)),
			status: r.status,
		}));
}

export function queueRows(cfg: Config): QueueRow[] {
	return activePlans(cfg.paths.queue_index)
		.filter(p => p.status === "open")
		.map(p => ({ repo: basename(p.repo), file: p.file, title: p.title, status: p.status ?? "?", waiting: p.waiting }));
}

export function ciRows(cfg: Config): CiRow[] {
	return readMetricEvents(cfg)
		.filter(e => e.type === "ci")
		.slice(-10)
		.reverse()
		.map(e => ({ mr: String(e.mr), tries: Number(e.tries), ts: Number(e.ts) }));
}

export function incidentRows(cfg: Config): IncidentRow[] {
	return openIncidents(cfg).map(i => ({ id: i.id, kind: i.kind, summary: i.summary, count: i.count }));
}

export function scoresData(cfg: Config): ScoresData {
	const out: ScoresData = { header: [], rows: [], text: [] };
	for (const raw of readFileSync(cfg.paths.ranking_board, "utf8").split("\n")) {
		const line = raw.trim();
		if (line.startsWith("|") && line.endsWith("|")) {
			const cells = line.slice(1, -1).split("|").map(c => c.trim());
			if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
			if (!out.header.length) out.header = cells;
			else out.rows.push(cells);
		} else if (line) {
			out.text.push(line);
		}
	}
	return out;
}

export function machineRow(cfg: Config): MachineRow {
	const st = statfsSync(expandHome(cfg.machine.disk_path));
	const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
	const load = os.loadavg()[0] ?? 0;
	const cores = cpuCount();
	const loadMax = cfg.machine.load_max > 0 ? cfg.machine.load_max : cores + cfg.machine.load_over_cores;
	return { freeGb, diskMin: cfg.machine.disk_min_gb, load, loadMax, cores };
}

// ---- rendering (consumes the rows above, never the readers directly) ----

function needCard(row: QuestionRow, i: number): string {
	const goals = row.goal.map(g => `<li>${esc(g)}</li>`).join("");
	const wait = row.waitingMin < 60 ? `waiting ${row.waitingMin} min` : `waiting ${Math.max(1, Math.round(row.waitingMin / 60))} h`;
	const bg = row.goal.length ? `<details class="bg" id="bg-${i}"><summary>Background</summary><ul>${goals}</ul></details>` : "";
	return `<article class="card need">
<p class="eyebrow">${esc(row.repo)} · ${esc(wait)}</p>
<h3>${esc(row.title)}</h3>
<p class="ask">What I need from you</p>
<p class="q">${esc(row.waitingLine)}</p>
${bg}
<form method="post" action="/answer">
<input type="hidden" name="plan" value="${esc(row.plan)}">
<div class="acts">
<button class="primary" type="submit" name="answer" value="yes">Yes, go ahead</button>
<button type="submit" name="answer" value="no">No</button>
<button type="button" class="replybtn">Reply…</button>
</div>
<div class="reply" hidden>
<textarea name="answer_text" maxlength="${ANSWER_MAX}" rows="3" placeholder="Type your reply"></textarea>
<button class="primary" type="submit">Send reply</button>
</div>
</form>
</article>`;
}

function agentRowHtml(r: AgentRow): string {
	const dot = r.status === "running" ? "ok" : "warn";
	const mins = r.minutes > 0 ? ` · ${r.minutes} min` : "";
	return `<li class="agent"><span class="dot ${dot}" aria-hidden="true"></span><span class="aid">${esc(r.id)}</span><span class="model">${esc(r.model)}</span><span class="detail">${esc(r.detail)}${mins}</span></li>`;
}

function queueHtml(rows: QueueRow[]): string {
	const cards = rows
		.map(
			(r, i) => `<li class="qcard" data-plan="${esc(r.file)}">
<span class="qrank">${i + 1}</span>
<span class="qhandle" title="Drag to reorder" aria-label="Drag ${esc(r.title)}">⠿</span>
<span class="qtitle">${esc(r.title)}</span>
<span class="chip repo">${esc(r.repo)}</span>
${r.waiting ? `<span class="chip wait">waiting</span>` : ""}
<span class="qbtns"><button type="button" class="qmove" data-move="top">↑ top</button><button type="button" class="qmove" data-move="up">↑</button><button type="button" class="qmove" data-move="down">↓</button></span>
</li>`,
		)
		.join("\n");
	// before = the order this page was rendered with; the server refuses the move when the real
	// order has drifted (409), so a stale page can never reorder on a guess.
	const before = rows.map(r => r.file).join("\n");
	return `<ul class="qlist" id="qlist">
${cards}
</ul>
<form id="reorder-form" method="post" action="/reorder" hidden>
<input type="hidden" name="before" value="${esc(before)}">
<input type="hidden" name="order" value="">
<input type="hidden" name="moved" value="">
</form>`;
}

function ciHtml(rows: CiRow[]): string {
	return `<ul class="merges">${rows
		.map(r => `<li><span class="mono">${esc(r.mr)}</span> · ${r.tries} pipeline${r.tries === 1 ? "" : "s"} · ${esc(strftime(r.ts, "%m-%d %H:%M"))}</li>`)
		.join("")}</ul>`;
}

function incidentsHtml(rows: IncidentRow[]): string {
	return `<ul class="incidents">${rows
		.map(r => `<li><span class="mono">${esc(r.id)}</span> <span class="chip bad">${esc(r.kind)}</span> ${esc(r.summary)}${r.count > 1 ? ` · ${r.count}x` : ""}</li>`)
		.join("")}</ul>`;
}

function scoresHtml(d: ScoresData): string {
	const head = d.header.length ? `<thead><tr>${d.header.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>` : "";
	const body = d.rows.length ? `<tbody>${d.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>` : "";
	const table = head ? `<table>${head}${body}</table>` : "";
	const text = d.text.map(t => `<p>${esc(t)}</p>`).join("");
	return table + text;
}

function machineHtml(cfg: Config, m: MachineRow): string {
	const row = (label: string, value: string, bad = false) =>
		`<div class="mrow"><span>${esc(label)}</span><span class="mono${bad ? " bad" : ""}">${esc(value)}</span></div>`;
	return [
		row("Disk free", `${m.freeGb.toFixed(0)} GB (min ${m.diskMin} GB)`, m.freeGb < m.diskMin),
		row("Load", `${m.load.toFixed(2)} (max ${m.loadMax})`, m.load > m.loadMax),
		row("Cores", String(m.cores)),
	].join("");
}

function detailsBlock(id: string, label: string, count: string, inner: string): string {
	return `<details id="${id}"><summary>${esc(label)} <span class="chip">${esc(count)}</span></summary><div class="dbody">${inner}</div></details>`;
}

function na(label: string): string {
	return `<p class="na">${esc(label)} unavailable</p>`;
}

function receiptHtml(sent: string | null, params: URLSearchParams): string {
	if (!sent) return "";
	let text: string;
	switch (sent) {
		case "answer":
			text = `Sent to Main · ${strftime(nowSec(), "%H:%M")}`;
			break;
		case "unlock": {
			const minutes = Number(params.get("minutes"));
			text = Number.isInteger(minutes) && minutes > 0 ? `Unlocked for ${minutes} min` : "Unlocked";
			break;
		}
		case "lock":
			text = "Locked";
			break;
		case "reorder": {
			const to = Number(params.get("to"));
			text = Number.isInteger(to) && to > 0 ? `Moved to #${to} · Main sees it next turn` : "Moved · Main sees it next turn";
			break;
		}
		case "unlock-off":
			text = "Refused — chat unlock is off";
			break;
		default:
			return "";
	}
	return `<div class="receipt" role="status">${esc(text)}</div>`;
}

function bottomBar(cfg: Config, lockMinutesLeft: number | null): string {
	const state = lockMinutesLeft === null ? "Locked" : `Unlocked · ${lockMinutesLeft} min left`;
	const unlockBtn = (minutes: number) =>
		`<form method="post" action="/unlock"><input type="hidden" name="minutes" value="${minutes}"><button type="submit">Unlock ${minutes} min</button></form>`;
	const off = cfg.guards.chat_unlock
		? ""
		: `<p class="offnote">Unlocking from the page is switched off in the config. To turn it on, set:</p><code class="offcfg">guards: chat_unlock: true</code>`;
	return `<footer class="bar"><div class="barline"><div class="barinner"><p class="lockstate${lockMinutesLeft === null ? "" : " on"}">${esc(state)}</p><div class="barbtns">${unlockBtn(15)}${unlockBtn(30)}<form method="post" action="/lock"><button type="submit">Lock now</button></form></div></div></div>${off}</footer>`;
}

// ---- page assembly: one unreadable source never takes the page down ----

export interface PageData {
	questions: QuestionRow[] | null;
	agents: AgentRow[] | null;
	queue: QueueRow[] | null;
	ci: CiRow[] | null;
	incidents: IncidentRow[] | null;
	scores: ScoresData | null;
	machine: MachineRow | null;
	/** Minutes left in the guard unlock; null = locked. */
	lockMinutesLeft: number | null;
}

function safe<T>(build: () => T): T | null {
	try {
		return build();
	} catch {
		// One unreadable source must never take the page down.
		return null;
	}
}

function lockMinutesLeft(cfg: Config): number | null {
	try {
		const end = statSync(unlockPath()).mtimeMs + cfg.guards.unlock_minutes * 60_000;
		const left = Math.round((end - Date.now()) / 60_000);
		return left > 0 ? left : null;
	} catch {
		return null;
	}
}

export function buildPageData(cfg: Config, source: RunSource): PageData {
	return {
		questions: safe(() => questionRows(cfg)),
		agents: safe(() => agentRows(cfg, source)),
		queue: safe(() => queueRows(cfg)),
		ci: safe(() => ciRows(cfg)),
		incidents: safe(() => incidentRows(cfg)),
		scores: safe(() => scoresData(cfg)),
		machine: safe(() => machineRow(cfg)),
		lockMinutesLeft: lockMinutesLeft(cfg),
	};
}

function stripHtml(data: PageData): string {
	const n = data.questions?.length ?? null;
	const left =
		n === null
			? `<span class="count na">–</span>`
			: n === 0
				? `<span class="count clear">All clear</span>`
				: `<a class="count" href="#needs" aria-label="${n} plans need you">${n}</a>`;
	const working = data.agents === null ? "working –" : `${data.agents.length} working`;
	const ci =
		data.incidents === null
			? "CI –"
			: data.incidents.length
				? `<span class="bad">${data.incidents.length === 1 ? "1 incident" : `${data.incidents.length} incidents`}</span>`
				: `<span class="fine">CI ok</span>`;
	const m = data.machine;
	const disk =
		m === null
			? "disk –"
			: m.freeGb < m.diskMin
				? `<span class="bad">disk ${m.freeGb.toFixed(0)} GB</span>`
				: m.load > m.loadMax
					? `<span class="bad">load ${m.load.toFixed(1)}</span>`
					: `disk ${m.freeGb.toFixed(0)} GB`;
	return `<header class="strip"><div class="barinner stripinner">${left}<div class="signals"><span>${esc(working)}</span><span>${ci}</span><span>${disk}</span></div></div></header>`;
}

const FAVICON =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23D98E04'/%3E%3C/svg%3E";

const SCRIPT = `(function(){
if(location.search)history.replaceState(null,"",location.pathname);
function store(d,v){var k="nsui:"+d.id;if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v?"1":"0");}
var ds=document.querySelectorAll("details[id]");
for(var i=0;i<ds.length;i++){(function(d){var s=store(d);if(s!==null)d.open=s==="1";d.addEventListener("toggle",function(){store(d,d.open);});})(ds[i]);}
var rb=document.querySelectorAll(".replybtn");
for(var j=0;j<rb.length;j++){rb[j].addEventListener("click",function(){var f=this.closest("form");var box=f&&f.querySelector(".reply");if(box){box.hidden=!box.hidden;if(!box.hidden){var t=box.querySelector("textarea");if(t)t.focus();}}});}
var qlist=document.getElementById("qlist");
var dragging=false;
if(qlist){
var rform=document.getElementById("reorder-form");
var qcards=function(){return Array.prototype.slice.call(qlist.querySelectorAll(".qcard"));};
var submitReorder=function(moved){if(!rform)return;var o=qcards().map(function(c){return c.getAttribute("data-plan");}).join("\\n");rform.querySelector("[name=order]").value=o;rform.querySelector("[name=moved]").value=moved;dragging=false;rform.submit();};
var moveCard=function(card,how){if(how==="top"){var f=qcards()[0];if(f&&f!==card)qlist.insertBefore(card,f);}else if(how==="up"){var p=card.previousElementSibling;if(p&&p.classList.contains("qcard"))qlist.insertBefore(card,p);}else if(how==="down"){var n=card.nextElementSibling;if(n&&n.classList.contains("qcard"))qlist.insertBefore(card,n.nextSibling);}};
qlist.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;var b=t.closest(".qmove");if(!b)return;var card=t.closest(".qcard");if(!card)return;moveCard(card,b.getAttribute("data-move"));submitReorder(card.getAttribute("data-plan"));});
var drag=null;
qlist.addEventListener("pointerdown",function(e){var t=e.target;if(!t||!t.closest)return;var h=t.closest(".qhandle");if(!h||drag)return;var card=t.closest(".qcard");if(!card)return;e.preventDefault();dragging=true;var r=card.getBoundingClientRect();var ph=document.createElement("li");ph.className="qph";ph.style.height=r.height+"px";qlist.insertBefore(ph,card);card.classList.add("dragging");card.style.width=r.width+"px";card.style.left=r.left+"px";card.style.top=r.top+"px";drag={card:card,ph:ph,y0:e.clientY,id:e.pointerId};try{h.setPointerCapture(e.pointerId);}catch(_){}});
window.addEventListener("pointermove",function(e){if(!drag||e.pointerId!==drag.id)return;var card=drag.card;card.style.transform="translateY("+(e.clientY-drag.y0)+"px)";var r=card.getBoundingClientRect();var mid=r.top+r.height/2;var els=Array.prototype.slice.call(qlist.children);for(var i=0;i<els.length;i++){var el=els[i];if(el===card||el===drag.ph)continue;var er=el.getBoundingClientRect();if(mid<er.top+er.height/2){if(el.previousElementSibling!==drag.ph)qlist.insertBefore(drag.ph,el);}else if(el.nextElementSibling!==drag.ph){qlist.insertBefore(drag.ph,el.nextSibling);}}});
var endDrag=function(e,submitIt){if(!drag||(e&&e.pointerId!==undefined&&e.pointerId!==drag.id))return;var card=drag.card,ph=drag.ph;card.classList.remove("dragging");card.style.transform="";card.style.width="";card.style.left="";card.style.top="";qlist.insertBefore(card,ph);qlist.removeChild(ph);drag=null;if(submitIt)submitReorder(card.getAttribute("data-plan"));else dragging=false;};
window.addEventListener("pointerup",function(e){endDrag(e,true);});
window.addEventListener("pointercancel",function(e){endDrag(e,false);});
}
function busy(){if(dragging)return true;var els=document.querySelectorAll("input:not([type=hidden]), textarea");for(var k=0;k<els.length;k++){if(els[k]===document.activeElement||els[k].value)return true;}return false;}
setInterval(function(){if(!busy())location.reload();},${REFRESH_SEC}000);
})();`;

/** The whole page as one HTML string. Exported for scripts/ui-preview.ts (no server). */
export function renderPage(cfg: Config, data: PageData, params: URLSearchParams, nonce: string): string {
	const needs = data.questions === null ? na("Waiting on you") : data.questions.length ? data.questions.map(needCard).join("\n") : `<p class="empty">Nothing needs you right now</p>`;
	const working =
		data.agents === null ? na("Working now") : data.agents.length ? `<ul class="agents">${data.agents.map(agentRowHtml).join("")}</ul>` : `<p class="empty">No agents running</p>`;
	const queue = detailsBlock(
		"d-queue",
		"Queue",
		data.queue === null ? "–" : String(data.queue.length),
		data.queue === null ? na("Queue") : data.queue.length ? queueHtml(data.queue) : `<p class="empty">The queue is empty</p>`,
	);
	const merges = detailsBlock(
		"d-merges",
		"Merges",
		data.ci === null ? "–" : String(data.ci.length),
		data.ci === null ? na("Merges") : data.ci.length ? ciHtml(data.ci) : `<p class="empty">No CI runs recorded</p>`,
	);
	const incidents = detailsBlock(
		"d-incidents",
		"Incidents",
		data.incidents === null ? "–" : String(data.incidents.length),
		data.incidents === null ? na("Incidents") : data.incidents.length ? incidentsHtml(data.incidents) : `<p class="empty">No open incidents</p>`,
	);
	const scores = detailsBlock(
		"d-scores",
		"Agent scores",
		data.scores === null ? "–" : String(data.scores.rows.length + data.scores.text.length),
		data.scores === null ? na("Agent scores") : scoresHtml(data.scores),
	);
	const machine = detailsBlock(
		"d-machine",
		"Machine",
		data.machine === null ? "–" : `${data.machine.freeGb.toFixed(0)} GB`,
		data.machine === null ? na("Machine") : machineHtml(cfg, data.machine),
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>neurastream</title>
<link rel="icon" href="${FAVICON}">
<style>
:root { color-scheme: light dark; --ink:#1C2430; --page:#EEF1F5; --card:#FFFFFF; --line:#D5DBE3; --muted:#5E6A7A; --amber:#D98E04; --teal:#0F8A8A; --red:#C8382F; --on-amber:#10141A; }
@media (prefers-color-scheme: dark) { :root { --ink:#E6EAF0; --page:#10141A; --card:#1A2029; --line:#2A323D; --muted:#94A0B0; } }
* { box-sizing: border-box; }
html { scroll-padding-top: 72px; }
body { margin: 0; background: var(--page); color: var(--ink); font: 17px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.barinner { max-width: 36rem; margin: 0 auto; padding: 0 16px; }
.mono, .aid, .model { font-family: ui-monospace, "SF Mono", "Roboto Mono", monospace; font-size: 14px; }
.strip { position: sticky; top: 0; z-index: 5; background: var(--page); border-bottom: 1px solid var(--line); }
.stripinner { display: flex; align-items: center; justify-content: space-between; min-height: 64px; }
.count { color: var(--amber); font-size: 34px; font-weight: 800; font-variant-numeric: tabular-nums; text-decoration: none; }
.count.clear { color: var(--teal); font-size: 20px; font-weight: 700; }
.count.na { color: var(--muted); font-size: 20px; }
.signals { display: flex; gap: 12px; color: var(--muted); font-size: 14px; text-align: right; }
.bad { color: var(--red); font-weight: 600; }
.fine { color: var(--teal); }
main { padding-bottom: 96px; }
.receipt { max-width: 36rem; margin: 12px auto 0; padding: 10px 16px; background: var(--card); border: 1px solid var(--teal); border-radius: 14px; color: var(--teal); font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin: 16px 0; }
.need { border-left: 4px solid var(--amber); }
.eyebrow { margin: 0 0 2px; color: var(--muted); font-size: 14px; }
.need .eyebrow { color: var(--amber); }
.card h3 { margin: 2px 0 8px; font-size: 20px; font-weight: 650; }
.ask { margin: 0 0 2px; color: var(--muted); font-size: 14px; }
.q { margin: 0 0 10px; }
details.bg { margin: 8px 0; border-top: 1px solid var(--line); padding-top: 6px; }
details.bg summary, details.block summary { min-height: 48px; display: flex; align-items: center; gap: 8px; color: var(--muted); }
details.bg ul { margin: 4px 0 8px; padding-left: 20px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
button { min-height: 48px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font: inherit; }
button.primary { background: var(--amber); border-color: var(--amber); color: var(--on-amber); font-weight: 650; }
:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.reply { margin-top: 8px; }
.reply textarea { width: 100%; padding: 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--page); color: var(--ink); font: inherit; }
.agents { list-style: none; margin: 0; padding: 0; }
.agent { display: flex; align-items: baseline; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.agent:last-child { border-bottom: none; }
.dot { width: 10px; height: 10px; border-radius: 50%; align-self: center; flex: none; }
.dot.ok { background: var(--teal); }
.dot.warn { background: var(--amber); }
.model { color: var(--muted); }
.detail { color: var(--muted); }
details.block { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 4px 16px; margin: 12px 0; }
details.block .dbody { border-top: 1px solid var(--line); padding: 10px 0 12px; }
.chip { display: inline-block; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; color: var(--muted); }
.chip.bad { color: var(--red); border-color: var(--red); }
.chip.wait { color: var(--amber); border-color: var(--amber); }
.qlist { list-style: none; margin: 0; padding: 0; }
.qcard { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.qcard:last-child { border-bottom: none; }
.qcard.dragging { position: fixed; z-index: 20; background: var(--card); border: 1px solid var(--amber); border-radius: 14px; padding: 10px 12px; margin: 0; user-select: none; opacity: 0.96; }
.qph { list-style: none; border: 2px dashed var(--line); border-radius: 14px; margin: 4px 0; }
.qrank { font-family: ui-monospace, "SF Mono", "Roboto Mono", monospace; font-size: 14px; color: var(--muted); min-width: 1.6em; text-align: right; font-variant-numeric: tabular-nums; }
.qhandle { touch-action: none; padding: 12px 10px; color: var(--muted); font-size: 18px; user-select: none; }
.qtitle { flex: 1; min-width: 0; }
.chip.repo { color: var(--teal); border-color: var(--teal); }
.qbtns { display: flex; gap: 6px; flex-wrap: wrap; }
.qbtns button { min-height: 48px; padding: 4px 10px; font-size: 14px; }
.merges, .incidents { margin: 0; padding-left: 20px; }
.merges li, .incidents li { margin: 6px 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
th { color: var(--muted); font-weight: 600; }
.mrow { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.mrow:last-child { border-bottom: none; }
.empty { color: var(--muted); }
.na { color: var(--muted); font-style: italic; }
.bar { position: sticky; bottom: 0; z-index: 5; background: var(--page); border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
.barline { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 64px; flex-wrap: wrap; padding-top: 6px; padding-bottom: 6px; }
.lockstate { margin: 0; font-weight: 650; color: var(--muted); }
.lockstate.on { color: var(--teal); }
.barbtns { display: flex; gap: 8px; flex-wrap: wrap; }
.barbtns button { min-height: 40px; padding: 6px 10px; font-size: 15px; }
.offnote { margin: 0; color: var(--muted); font-size: 14px; }
.offcfg { display: block; font-family: ui-monospace, "SF Mono", "Roboto Mono", monospace; font-size: 14px; padding: 4px 0 10px; }
@media (max-width: 360px) { .signals { display: none; } }
</style>
</head>
<body>
${stripHtml(data)}
${receiptHtml(params.get("sent"), params)}
<main>
<section id="needs"><h2 class="srt">Needs you</h2>
${needs}
</section>
<section id="working"><h2 class="srt">Working now</h2>
${working}
</section>
<div class="barinner">
${queue}
${merges}
${incidents}
${scores}
${machine}
</div>
</main>
${bottomBar(cfg, data.lockMinutesLeft)}
<script nonce="${nonce}">${SCRIPT}</script>
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

function redirect(target: string): Response {
	return new Response(null, { status: 303, headers: { location: target } });
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
	return redirect("/?sent=answer");
}

function handleUnlock(cfg: Config, fields: Record<string, string>, login: string): Response {
	const minutes = fields.minutes ?? "";
	if (minutes !== "" && !/^\d+$/.test(minutes)) return textRes("minutes must be a number", 400);
	const result = chatUnlock(minutes === "" ? "unlock" : `unlock ${minutes}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return redirect("/?sent=unlock-off");
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(
		inboxPath(),
		`${JSON.stringify({ ts: nowSec(), kind: "unlock", minutes: result.minutes, until: result.until, login })}\n`,
	);
	return redirect(`/?sent=unlock&minutes=${result.minutes}`);
}

function handleLock(cfg: Config, login: string): Response {
	const result = chatUnlock("lock", cfg, `ui:${login}`, "ui");
	if (!result.applied) return redirect("/?sent=unlock-off");
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), kind: "lock", login })}\n`);
	return redirect("/?sent=lock");
}

// ---- queue reorder (plan P4): the owner drags a card; INDEX.md is rewritten atomically ----

/**
 * INDEX.md's plan lines: every non-blank line that is not a `<!--` comment, normalized and
 * resolved the way the queue reader (readIndex) does it, first occurrence of a path wins,
 * in file order — with each line's raw text so a rewrite never re-serializes the index.
 */
function indexPlanLines(index: string): { path: string; raw: string }[] | null {
	let text: string;
	try {
		text = readFileSync(index, "utf8");
	} catch {
		return null;
	}
	const out: { path: string; raw: string }[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const norm = raw
			.trim()
			.replace(/^[-*]\s+/, "")
			.trim();
		if (!norm || norm.startsWith("<!--")) continue;
		const p = resolve(process.cwd(), expandHome(norm.replace(/`/g, "")));
		if (!seen.has(p)) {
			seen.add(p);
			out.push({ path: p, raw });
		}
	}
	return out;
}

/**
 * The index text with its plan lines reordered: every non-plan line (blank or `<!--` comment)
 * stays attached above the plan that follows it, and lines after the last plan keep the file's
 * end. Returns null when an order path is not in the file.
 */
function reorderedIndexText(index: string, order: string[]): string | null {
	let text: string;
	try {
		text = readFileSync(index, "utf8");
	} catch {
		return null;
	}
	const groups = new Map<string, string[]>();
	let pending: string[] = [];
	for (const raw of text.split("\n")) {
		const norm = raw
			.trim()
			.replace(/^[-*]\s+/, "")
			.trim();
		if (!norm || norm.startsWith("<!--")) {
			pending.push(raw);
			continue;
		}
		const p = resolve(process.cwd(), expandHome(norm.replace(/`/g, "")));
		if (!groups.has(p)) groups.set(p, [...pending, raw]);
		pending = [];
	}
	const parts: string[] = [];
	for (const p of order) {
		const g = groups.get(p);
		if (!g) return null;
		parts.push(...g);
	}
	parts.push(...pending);
	return parts.join("\n");
}

function handleReorder(cfg: Config, fields: Record<string, string>, login: string): Response {
	const index = cfg.paths.queue_index;
	const order = (fields.order ?? "")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const before = (fields.before ?? "")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);
	const moved = (fields.moved ?? "").trim();
	const current = indexPlanLines(index);
	if (!current) return textRes("the queue index is missing", 400);
	const paths = current.map(l => l.path);
	if (!moved || !order.length) return textRes("order and moved are required", 400);
	// 400: the posted order must be exactly the plans the index lists now — no adds, drops or duplicates.
	if (new Set(order).size !== order.length) return textRes("order lists a plan more than once", 400);
	const sortedOrder = [...order].sort();
	const sortedPaths = [...paths].sort();
	const sameSet = order.length === paths.length && sortedOrder.every((p, i) => p === sortedPaths[i]);
	if (!sameSet) return textRes("order is not exactly the plans now in the index", 400);
	// 409: the order the page was rendered with must still be the index's current order.
	const stale = before.length !== paths.length || before.some((p, i) => p !== paths[i]);
	if (stale) return textRes("the queue changed since the page loaded — reload and drag again", 409);
	const from = paths.indexOf(moved);
	const to = order.indexOf(moved);
	if (from === -1 || to === -1) return textRes("moved is not one of the index's plans", 400);
	const newText = reorderedIndexText(index, order);
	if (newText === null) return textRes("the queue index no longer lists every plan", 400);
	// Atomic write: a torn INDEX.md would break every reader, so temp file in the same dir + rename.
	const tmp = `${index}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, newText);
	renameSync(tmp, index);
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), kind: "reorder", plan: moved, from: from + 1, to: to + 1, login })}\n`);
	return redirect(`/?sent=reorder&to=${to + 1}`);
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
	// 403 no matter whose peer it is. Built once, against the bound port (tests bind 0).
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
							const nonce = randomUUID().replaceAll("-", "");
							res = new Response(renderPage(cfg, buildPageData(cfg, source), url.searchParams, nonce), {
								status: 200,
								headers: {
									"content-type": "text/html; charset=utf-8",
									"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
								},
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
						} else if (req.method === "POST" && url.pathname === "/reorder") {
							res = handleReorder(cfg, await fieldsOf(req), login);
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
