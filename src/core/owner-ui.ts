// Owner phone page (plan 20261024_2230): one server-rendered page over Tailscale that shows the
// questions waiting on the owner, the guard unlock, the running agents, the queue, recent CI,
// open incidents, agent scores and machine health. Answers are appended to the owner inbox
// (<queue_state>/owner-inbox.jsonl) where the adapter picks them up; unlock/lock go through the
// core chatUnlock. Every section is built from the existing core readers, never by shelling out
// to a CLI. Tailscale is an injected Tailscale value (src/core/tailscale.ts has the real one) so
// tests never call the binary; the peer address is an injectable seam too, so tests bind
// 127.0.0.1 while the real server binds only the tailnet address from `tailscale ip -4`.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { basename, resolve } from "node:path";
import type { RunSource } from "./adapter.ts";
import { chatTier, currentTier, type Tier } from "./autonomy.ts";
import type { Config } from "./config.ts";
import { nowSec, strftime } from "./clock.ts";
import { cpuCount } from "./host.ts";
import { openIncidents } from "./incidents.ts";
import { log } from "./guards.ts";
import { readMetricEvents } from "./metrics.ts";
import { activePlans, chatUnlock, dependencyOrderProblems, expandHome, stateDirPath, unlockPath, type Plan } from "./queue/lib.ts";
import type { Tailscale } from "./tailscale.ts";

const ANSWER_MAX = 2000;
const MESSAGE_MAX = 4000;
const MESSAGE_IMAGES_MAX = 4;
const MESSAGE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** How long the page keeps an owner message: 12 h, then the sweep removes it (owner, 2026-10-25 19:10). */
export const OWNER_MESSAGE_KEEP_SEC = 43200;
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

export function isLoopback(peer: string): boolean {
	return peer === "::1" || peer === "localhost" || peer.startsWith("127.");
}

export function isTailnet(peer: string): boolean {
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
	/** The last answer this plan already got (from the owner inbox), so the card can say so. */
	answered: { answer: string; at: number } | null;
}

/** The newest inbox record that carries an answer for this plan, if any. A missing or torn inbox is simply "no answer". */
function lastAnswerFor(plan: string): { answer: string; at: number } | null {
	let lines: string[];
	try {
		lines = readFileSync(inboxPath(), "utf8").split("\n");
	} catch {
		return null;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (!line) continue;
		try {
			const rec = JSON.parse(line) as Record<string, unknown>;
			if (rec.plan === plan && typeof rec.answer === "string" && rec.answer) return { answer: rec.answer, at: Number(rec.ts) || 0 };
		} catch {}
	}
	return null;
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
				answered: lastAnswerFor(p.file),
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

/** The numbers behind the top tiles: everything in the last 24 h plus the open-plan count. */
export interface NowStats {
	/** Total list-price spend over the last 24 h. */
	spend24: number;
	/** The "main" kind's share of spend24. */
	mainSpend: number;
	/** The "sub" kind's share of spend24. */
	agentSpend: number;
	/** Runs seen in the last 24 h. */
	runs24: number;
	/** Of those, the ones still running. */
	running: number;
	/** Of those, the ones that died. */
	died: number;
	/** Spend per hour over the last 24 h: 24 buckets, oldest → newest. */
	spendByHour: number[];
	/** Runs started per hour over the last 24 h: 24 buckets, oldest → newest. */
	runsByHour: number[];
	/** Spend and run count per short model name (after the last /), costliest first. */
	byModel: { model: string; spend: number; runs: number }[];
	/** Open plans in INDEX.md. */
	openPlans: number;
}

/**
 * Pure tile math over `source.listRuns(now - 86400)`: a run is in the window when its
 * bucket time — `startedAt`, else `lastWriteAt` — is newer than exactly 24 h ago, and it
 * counts in the hourly bucket of that time. The run source pre-filters by its own mtime,
 * so the strict window check here is the one rule that decides.
 */
export function nowStats(cfg: Config, source: RunSource, now: number): NowStats {
	const cut = now - 86400;
	const spendByHour = Array.from({ length: 24 }, () => 0);
	const runsByHour = Array.from({ length: 24 }, () => 0);
	const models = new Map<string, { spend: number; runs: number }>();
	let spend24 = 0;
	let mainSpend = 0;
	let agentSpend = 0;
	let runs24 = 0;
	let running = 0;
	let died = 0;
	for (const r of source.listRuns(cut)) {
		const ts = r.startedAt ?? r.lastWriteAt;
		if (ts <= cut) continue;
		spend24 += r.cost;
		runs24++;
		if (r.kind === "main") mainSpend += r.cost;
		else agentSpend += r.cost;
		if (r.status === "running") running++;
		if (r.status === "died") died++;
		// A future clock (skew) clamps into the newest bucket, never out of the array.
		const hoursAgo = Math.min(23, Math.max(0, Math.floor((now - ts) / 3600)));
		const at = 23 - hoursAgo;
		spendByHour[at]! += r.cost;
		runsByHour[at]! += 1;
		const short = r.model.slice(r.model.lastIndexOf("/") + 1);
		const m = models.get(short) ?? { spend: 0, runs: 0 };
		m.spend += r.cost;
		m.runs += 1;
		models.set(short, m);
	}
	const byModel = [...models.entries()].map(([model, v]) => ({ model, spend: v.spend, runs: v.runs })).sort((a, b) => b.spend - a.spend);
	return { spend24, mainSpend, agentSpend, runs24, running, died, spendByHour, runsByHour, byModel, openPlans: queueRows(cfg).length };
}

// ---- owner messages (plan P13): a one-way note plus images, kept for 12 h ----

/** Where the page stores owner messages: under the queue state dir, one dir per message. */
function ownerMessagesDir(): string {
	return `${stateDirPath()}/owner-messages`;
}

export interface MessageRow {
	id: string;
	ts: number;
	text: string;
	images: string[];
}

/** The image type from the first bytes — PNG, JPEG, GIF or WEBP — never from the client's name or content type. */
function imageType(bytes: Uint8Array): "png" | "jpeg" | "gif" | "webp" | null {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "webp";
	return null;
}

const IMAGE_EXT: Record<string, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Removes every message dir older than the keep window; runs on every GET / and every POST /message. */
export function sweepOwnerMessages(now: number): void {
	let names: string[];
	try {
		names = readdirSync(ownerMessagesDir());
	} catch {
		return;
	}
	for (const name of names) {
		const ts = Number(name.slice(0, name.indexOf("-")));
		if (Number.isFinite(ts) && now - ts <= OWNER_MESSAGE_KEEP_SEC) continue;
		rmSync(`${ownerMessagesDir()}/${name}`, { recursive: true, force: true });
	}
}

/** The messages newer than the keep window for the "Sent today" list, newest first. A torn dir is skipped, not fatal. */
export function recentOwnerMessages(now: number): MessageRow[] {
	let names: string[] = [];
	try {
		names = readdirSync(ownerMessagesDir());
	} catch {
		return [];
	}
	const rows: MessageRow[] = [];
	for (const id of names) {
		const dirTs = Number(id.slice(0, id.indexOf("-")));
		if (!Number.isFinite(dirTs) || now - dirTs >= OWNER_MESSAGE_KEEP_SEC) continue;
		try {
			const meta = JSON.parse(readFileSync(`${ownerMessagesDir()}/${id}/message.json`, "utf8")) as Record<string, unknown>;
			rows.push({
				id,
				ts: Number(meta.ts) || dirTs,
				text: typeof meta.text === "string" ? meta.text : "",
				images: Array.isArray(meta.images) ? meta.images.filter((n): n is string => typeof n === "string") : [],
			});
		} catch {}
	}
	return rows.sort((a, b) => b.ts - a.ts);
}

// ---- rendering (consumes the rows above, never the readers directly) ----

/** The "Tell Main" card: one textarea, image picks, a Send button — no chat thread. Under it, "Sent today": this view's messages newer than the keep window, newest first, thumbnails served from /message-image. */
function messageCard(messages: MessageRow[] | null): string {
	const form = `<form class="msgform" method="post" action="/message" enctype="multipart/form-data">
<textarea name="text" maxlength="${MESSAGE_MAX}" rows="3" placeholder="What Main should know — a fix, a link, a photo"></textarea>
<input type="file" name="images" accept="image/*" multiple>
<button class="btn pri" type="submit">Send</button>
</form>`;
	let sent = "";
	if (messages === null) sent = na("Sent today");
	else if (messages.length) {
		const rows = messages
			.map(m => {
				const imgs = m.images.map(n => `<a href="/message-image/${esc(m.id)}/${esc(n)}"><img class="mthumb" src="/message-image/${esc(m.id)}/${esc(n)}" alt=""></a>`).join("");
				return `<div class="msg"><span class="mtime">${esc(strftime(m.ts, "%H:%M"))}</span><span class="mtext">${esc(m.text)}</span>${imgs ? `<span class="mimgs">${imgs}</span>` : ""}</div>`;
			})
			.join("");
		sent = `<p class="mlabel">Sent today</p>${rows}`;
	}
	return `<h2>Tell Main</h2>
<div class="card">
${form}
${sent}
</div>`;
}

function needCard(row: QuestionRow, i: number, tab: string): string {
	const goals = row.goal.map(g => `<li>${esc(g)}</li>`).join("");
	const wait = row.waitingMin < 60 ? `waiting ${row.waitingMin} min` : `waiting ${Math.max(1, Math.round(row.waitingMin / 60))} h`;
	const bg = row.goal.length ? `<details class="bg" id="bg-${i}"><summary>Background</summary><ul>${goals}</ul></details>` : "";
	let said = "";
	if (row.answered) {
		const text = row.answered.answer;
		const quote = text.length > 80 ? `${text.slice(0, 80)}…` : text;
		const verb = text.toLowerCase() === "yes" || text.toLowerCase() === "no" ? "answered" : "replied";
		said = `<p class="answered">You ${verb} "${esc(quote)}" · ${esc(strftime(row.answered.at, "%H:%M"))} — Main is on it</p>
<button type="button" class="replybtn link">change answer</button>`;
	}
	const acts = row.answered
		? said
		: `<div class="acts">
<button class="btn pri" type="submit" name="answer" value="yes">Yes</button>
<button class="btn" type="submit" name="answer" value="no">No</button>
<button type="button" class="btn replybtn">Reply…</button>
</div>`;
	return `<article class="ask">
<p class="eyebrow">${esc(row.repo)} · ${esc(wait)}</p>
<b>${esc(row.title)}</b>
<p class="q">${esc(row.waitingLine)}</p>
${bg}
<form method="post" action="/answer">
<input type="hidden" name="plan" value="${esc(row.plan)}">
<input type="hidden" name="tab" value="${esc(tab)}">
${acts}
<div class="reply" hidden>
<textarea name="answer_text" maxlength="${ANSWER_MAX}" rows="3" placeholder="Type your reply"></textarea>
<button class="btn pri" type="submit">Send reply</button>
</div>
</form>
</article>`;
}

function agentRowHtml(r: AgentRow): string {
	const dot = r.status === "running" ? "ok" : r.status === "waiting" ? "warn" : "bad";
	const mins = r.minutes > 0 ? ` · ${r.minutes} min` : "";
	return `<li class="agent"><span class="dot ${dot}" aria-hidden="true"></span><span class="aid">${esc(r.id)}</span><span class="model">${esc(r.model)}</span><span class="detail">${esc(r.detail)}${mins}</span></li>`;
}

function queueHtml(rows: QueueRow[], tab: string): string {
	const cards = rows
		.map(
			(r, i) => `<li class="qcard" data-plan="${esc(r.file)}">
<span class="qhandle" title="Drag to reorder" aria-label="Drag ${esc(r.title)}">≡</span>
<span class="qrank">${i + 1}</span>
<span class="qtitle">${esc(r.title)}</span>
${r.waiting ? `<span class="chip c-wait">waits you</span>` : `<span class="chip c-ready">ready</span>`}
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
<input type="hidden" name="tab" value="${esc(tab)}">
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

/** Inline SVG sparkline (mockup: a 130×40 polyline, oldest → newest, left → right). */
function sparkSvg(points: number[], stroke: string): string {
	const max = Math.max(...points, 0);
	const n = points.length;
	const pts = points
		.map((v, i) => {
			const x = n <= 1 ? 0 : (i / (n - 1)) * 130;
			const y = max > 0 ? 34 - (v / max) * 28 : 34;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	return `<svg class="spark" viewBox="0 0 130 40" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2"/></svg>`;
}

function tile(label: string, num: string, numStyle: string, note: string, spark = ""): string {
	return `<div class="tile"><div><div class="lbl">${esc(label)}</div><div class="num"${numStyle ? ` style="${numStyle}"` : ""}>${num}</div><div class="note">${note}</div></div>${spark}</div>`;
}

function spendTileHtml(data: PageData): string {
	const s = data.stats;
	return s
		? tile("Spend (list price)", `$${s.spend24.toFixed(2)}`, "", `Main $${s.mainSpend.toFixed(2)} · agents $${s.agentSpend.toFixed(2)}`, sparkSvg(s.spendByHour, "var(--acc)"))
		: tile("Spend (list price)", "–", "", "–");
}

/** The mockup's Today tile card: needs-you, spend, agent runs, open plans. */
function tilesHtml(data: PageData): string {
	const needs = data.questions === null ? null : data.questions.length;
	const needsTile = needs === null ? tile("Needs you", "–", "", "–") : needs > 0 ? tile("Needs you", String(needs), "color:var(--warn)", "answer below ↓") : tile("Needs you", "0", "", "all clear");
	const runs = data.stats ? tile("Agent runs", String(data.stats.runs24), "", `${data.stats.running} running · ${data.stats.died} died`, sparkSvg(data.stats.runsByHour, "var(--teal)")) : tile("Agent runs", "–", "", "–");
	const plans = data.stats ? tile("Plans", String(data.stats.openPlans), "", `<span style="color:var(--ok)">open</span>`) : tile("Plans", "–", "", "–");
	return [needsTile, spendTileHtml(data), runs, plans].join("\n");
}

/** The sticky mockup top bar: logo, pill tabs, and the lock pill that posts the unlock/lock and tier forms. */
function topBarHtml(tab: string, lockMinutesLeft: number | null, cfg: Config): string {
	const tabs: [string, string][] = [["now", "Now"], ["queue", "Queue"], ["agents", "Agents"], ["spend", "Spend"]];
	const pills = tabs.map(([id, label]) => `<a href="/?tab=${id}"${tab === id ? ` class="on"` : ""}>${label}</a>`).join("");
	const lockLabel = lockMinutesLeft === null ? "🔒 Off" : `🔓 ${lockMinutesLeft} min`;
	const tabField = `<input type="hidden" name="tab" value="${esc(tab)}">`;
	const unlockForm = (minutes: number) =>
		`<form method="post" action="/unlock"><input type="hidden" name="minutes" value="${minutes}">${tabField}<button class="btn" type="submit">Unlock ${minutes} min</button></form>`;
	const tierForm = (name: Tier, label: string) =>
		`<form method="post" action="/tier"><input type="hidden" name="tier" value="${name}">${tabField}<button class="btn${currentTier(cfg) === name ? " on" : ""}" type="submit">${label}</button></form>`;
	const off = cfg.guards.chat_unlock
		? ""
		: `<p class="offnote">Unlocking from the page is switched off in the config. To turn it on, set:</p><code class="offcfg">guards: chat_unlock: true</code>`;
	return `<div class="top"><span class="logo">ns</span>
<nav class="pills" aria-label="Sections">${pills}</nav>
<details class="lock" id="lock-pill"><summary>${lockLabel}</summary><div class="lockmenu">${unlockForm(15)}${unlockForm(30)}<form method="post" action="/lock">${tabField}<button class="btn" type="submit">Lock now</button></form><hr>${tierForm("strict", "Tier: strict")}${tierForm("opinionated", "Tier: opinionated")}${tierForm("full", "Tier: full")}${off}</div></details>
</div>`;
}

/** The queue card. Full on the Queue tab; the Now tab shows the first 8 rows plus the "Show all" link — the drag script merges the hidden rest from the form's before field, so a drag still posts the complete order. */
function queueCard(rows: QueueRow[] | null, full: boolean, tab: string): string {
	const head = full ? "" : `<h2>Queue <small>drag ≡ to sort</small></h2>`;
	if (rows === null) return `${head}<div class="card">${na("Queue")}</div>`;
	if (!rows.length) return `${head}<div class="card"><p class="empty">The queue is empty</p></div>`;
	const body = queueHtml(full ? rows : rows.slice(0, 8), tab);
	const more = !full && rows.length > 8 ? `<a class="more" href="/?tab=queue">Show all ${rows.length} ›</a>` : "";
	return `${head}<div class="card">${body}${more}</div>`;
}

function modelSpendTable(stats: NowStats | null): string {
	if (stats === null) return na("Spend");
	if (!stats.byModel.length) return `<p class="empty">No spend recorded in the last 24 hours</p>`;
	const rows = stats.byModel.map(m => `<tr><td>${esc(m.model)}</td><td>$${m.spend.toFixed(2)}</td><td>${m.runs}</td></tr>`).join("");
	return `<table><thead><tr><th>Model</th><th>Spend</th><th>Runs</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function na(label: string): string {
	return `<p class="na">${esc(label)} unavailable</p>`;
}

function receiptText(sent: string, params: URLSearchParams): string | null {
	let text: string;
	switch (sent) {
		case "answer":
		case "message":
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
			// The rank counts the OPEN plans (what the page shows), not every INDEX.md line.
			const to = Number(params.get("to"));
			text = Number.isInteger(to) && to > 0 ? `Moved to #${to} of open plans · Main sees it next turn` : "Moved · Main sees it next turn";
			break;
		}
		case "unlock-off":
			text = "Refused — chat unlock is off";
			break;
		case "stale":
			text = "Already handled — Main cleared this question before your answer; your answer was still passed on.";
			break;
		default:
			return null;
	}
	return text;
}

function receiptHtml(sent: string | null, params: URLSearchParams): string {
	if (!sent) return "";
	const text = receiptText(sent, params);
	return text === null ? "" : `<div class="receipt" role="status">${esc(text)}</div>`;
}

/** The JSON POST replies (P11b): the receipt text rides along so the page script never re-derives it. */
function jsonSent(sent: string, receipt?: string | null): Response {
	return Response.json(receipt ? { ok: true, sent, receipt } : { ok: true, sent });
}

function jsonFail(error: string, status: number): Response {
	return Response.json({ ok: false, error }, { status });
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
	/** The 24 h tile numbers; null when the run source is unreadable. */
	stats: NowStats | null;
	/** The owner's messages newer than the keep window, newest first; null when unreadable. */
	messages: MessageRow[] | null;
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
		stats: safe(() => nowStats(cfg, source, nowSec())),
		messages: safe(() => recentOwnerMessages(nowSec())),
		lockMinutesLeft: lockMinutesLeft(cfg),
	};
}

const FAVICON =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%23D98E04'/%3E%3C/svg%3E";

/**
 * Where a dropped card goes among the other cards, by vertical midpoint (y grows downward):
 * in front of the FIRST card whose midpoint is greater than the dragged card's, else after the
 * last card. Returns an index into `mids` (the first slot) or `mids.length` (after the last).
 * Pure and exported so the page script — which inlines this exact source via toString() — and
 * the test run the same code: dragging card 1 toward card 2 lands it at 2, never second-to-last.
 */
export function dropSlot(mids: number[], mid: number): number {
	for (let i = 0; i < mids.length; i++) if (mids[i]! > mid) return i;
	return mids.length;
}

/**
 * Autoscroll speed in px/frame while a drag is held near the screen edge (P5b): 0 outside a
 * 72 px band, negative in the top band, positive in the bottom band, growing toward the edge,
 * capped at 24 px/frame. Pure and exported so the page script — which inlines this exact
 * source via toString() — and the test run the same code.
 */
export function edgeScrollStep(y: number, viewportH: number): number {
	const BAND = 72;
	const CAP = 24;
	const fromTop = BAND - y;
	const fromBottom = y - (viewportH - BAND);
	if (fromTop > 0) return -Math.min(CAP, Math.ceil((CAP * fromTop) / BAND));
	if (fromBottom > 0) return Math.min(CAP, Math.ceil((CAP * fromBottom) / BAND));
	return 0;
}

const SCRIPT = `(function(){
var dropSlot=${dropSlot.toString()};
var edgeScrollStep=${edgeScrollStep.toString()};
// Keep only the tab in the address bar: receipts are one-time DOM, not a reloadable URL.
if(location.search){var keep=new URLSearchParams(location.search).get("tab");history.replaceState(null,"",location.pathname+(keep?"?tab="+keep:""));}
function store(d,v){var k="nsui:"+d.id;if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v?"1":"0");}
function bindDetails(root){var ds=root.querySelectorAll("details[id]");for(var i=0;i<ds.length;i++){(function(d){var s=store(d);if(s!==null)d.open=s==="1";d.addEventListener("toggle",function(){store(d,d.open);});})(ds[i]);}}
var dragging=false;
function showReceipt(text){var main=document.querySelector("main");if(!main)return null;var old=document.querySelector(".receipt[data-js]");if(old&&old.parentNode)old.parentNode.removeChild(old);var d=document.createElement("div");d.className="receipt";d.setAttribute("role","status");d.setAttribute("data-js","1");d.textContent=text;main.parentNode.insertBefore(d,main);return d;}
function renumber(list){var cards=list.querySelectorAll(".qcard");for(var i=0;i<cards.length;i++){var n=cards[i].querySelector(".qrank");if(n)n.textContent=String(i+1);}}
function sendReorder(moved,list){
var rform=document.getElementById("reorder-form");if(!rform||!moved)return;
var cards=list.querySelectorAll(".qcard");var shown=[];for(var i=0;i<cards.length;i++)shown.push(cards[i].getAttribute("data-plan"));
var bf=(rform.querySelector("[name=before]").value||"").split("\\n").filter(function(x){return x;});
var o=shown.slice();for(var j=0;j<bf.length;j++){if(shown.indexOf(bf[j])<0)o.push(bf[j]);}
dragging=false;
fetch("/reorder",{method:"POST",headers:{"accept":"application/json","content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({order:o.join("\\n"),before:bf.join("\\n"),moved:moved}).toString()}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j};});}).then(function(res){
if(res.s===200&&res.j&&res.j.ok){renumber(list);var b=rform.querySelector("[name=before]");if(b)b.value=o.join("\\n");showReceipt("Moved to #"+res.j.to+" of open plans · Main sees it next turn");}
else if(res.s===409){showReceipt((res.j&&res.j.error?res.j.error:"the queue changed since the page loaded")+" — showing the current order");refreshNow();}
else{showReceipt(res.j&&res.j.error?res.j.error:"the move was refused");}
}).catch(function(){showReceipt("could not reach the page server — try again");});
}
var swapping=false;
// Fetch a page URL and swap only <main> plus the tabs' active pill. push: new history entry; scroll: to top (tab change only).
function swapMain(href,push,scroll){
return fetch(href,{headers:{"accept":"text/html"}}).then(function(r){return r.text();}).then(function(html){
var doc=document.implementation.createHTMLDocument("");doc.body.innerHTML=html;
var fresh=doc.querySelector("main");var cur=document.querySelector("main");
if(fresh&&cur){cur.innerHTML=fresh.innerHTML;bindPage();
var pills=document.querySelectorAll(".pills a");var fp=doc.querySelectorAll(".pills a");for(var i=0;i<pills.length&&i<fp.length;i++)pills[i].className=fp[i].className;}
if(push)history.pushState(null,"",href);
if(scroll)window.scrollTo(0,0);})}
function navigate(href){swapMain(href,true,true).catch(function(){showNetErr();});}
function refreshNow(){if(swapping)return;swapping=true;swapMain(location.href,false,false).catch(function(){}).then(function(){swapping=false;});}
function showNetErr(){var d=showReceipt("Couldn't reach the page — tap to retry");if(d)d.setAttribute("data-js","neterr");}
var drag=null;
// One drag move: place the floating card at pointer Y and drop the placeholder between the
// cards around it. Also re-run after every autoscroll step, since scrolling moved the midpoints.
function dragMove(y){if(!drag)return;var card=drag.card,list=drag.list;card.style.transform="translateY("+(y-drag.y0)+"px)";var r=card.getBoundingClientRect();var mid=r.top+r.height/2;var mids=[];var els=[];var ch=list.children;for(var i=0;i<ch.length;i++){var el=ch[i];if(el===card||el===drag.ph)continue;var er=el.getBoundingClientRect();mids.push(er.top+er.height/2);els.push(el);}
var k=dropSlot(mids,mid);
if(k<mids.length){if(els[k].previousElementSibling!==drag.ph)list.insertBefore(drag.ph,els[k]);}else if(mids.length&&els[mids.length-1].nextElementSibling!==drag.ph){list.insertBefore(drag.ph,els[mids.length-1].nextSibling);}}
window.addEventListener("pointermove",function(e){if(!drag||e.pointerId!==drag.id)return;drag.y=e.clientY;dragMove(drag.y);});
// P5b: a finger held still at the screen edge fires no pointermove, so a rAF loop keeps
// scrolling by edgeScrollStep and re-drops the placeholder while it scrolls; endDrag stops it.
function dragFrame(){if(!drag)return;var dy=edgeScrollStep(drag.y,window.innerHeight);if(dy){window.scrollBy(0,dy);dragMove(drag.y);}requestAnimationFrame(dragFrame);}
var endDrag=function(e,submitIt){if(!drag||(e&&e.pointerId!==undefined&&e.pointerId!==drag.id))return;var card=drag.card,ph=drag.ph,list=drag.list;if(drag.raf)cancelAnimationFrame(drag.raf);card.classList.remove("dragging");card.style.transform="";card.style.width="";card.style.left="";card.style.top="";list.insertBefore(card,ph);list.removeChild(ph);drag=null;if(submitIt)sendReorder(card.getAttribute("data-plan"),list);else dragging=false;};
window.addEventListener("pointerup",function(e){endDrag(e,true);});
window.addEventListener("pointercancel",function(e){endDrag(e,false);});
// Every POST form goes over fetch and swaps main in place (P11b); a no-JS browser still submits for real and gets the 303s.
document.addEventListener("submit",function(e){
var f=e.target;if(!f||!f.getAttribute)return;
var action=f.getAttribute("action")||"/";
if((f.getAttribute("method")||"").toLowerCase()!=="post"||action.charAt(0)!=="/")return;
e.preventDefault();
fetch(action,{method:"POST",headers:{"accept":"application/json"},body:new FormData(f,e.submitter||undefined)}).then(function(r){return r.json().then(function(j){return{s:r.status,j:j};});}).then(function(res){
if(res.j&&res.j.receipt)showReceipt(res.j.receipt);else if(res.j&&res.j.error)showReceipt(res.j.error);
refreshNow();
}).catch(function(){showNetErr();});
});
// Same-origin links (tab pills, the queue's more link) swap main and pushState; Back swaps back via popstate; the net-error line retries on tap.
document.addEventListener("click",function(e){
if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var t=e.target;if(!t||!t.closest)return;
if(t.closest('.receipt[data-js="neterr"]')){e.preventDefault();refreshNow();return;}
var a=t.closest("a");if(!a)return;var href=a.getAttribute("href");
if(!href||a.target||href.charAt(0)!=="/")return;
e.preventDefault();navigate(href);
});
window.addEventListener("popstate",function(){swapMain(location.href,false,false).catch(function(){showNetErr();});});
function bindPage(){
var main=document.querySelector("main");if(!main)return;
bindDetails(main);
var rb=main.querySelectorAll(".replybtn");
for(var j=0;j<rb.length;j++){rb[j].addEventListener("click",function(){var f=this.closest("form");var box=f&&f.querySelector(".reply");if(box){box.hidden=!box.hidden;if(!box.hidden){var t=box.querySelector("textarea");if(t)t.focus();}}});}
var qlist=main.querySelector("#qlist");
if(qlist){
var moveCard=function(card,how){if(how==="top"){var f=qlist.querySelector(".qcard");if(f&&f!==card)qlist.insertBefore(card,f);}else if(how==="up"){var p=card.previousElementSibling;if(p&&p.classList.contains("qcard"))qlist.insertBefore(card,p);}else if(how==="down"){var n=card.nextElementSibling;if(n&&n.classList.contains("qcard"))qlist.insertBefore(card,n.nextSibling);}};
qlist.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;var b=t.closest(".qmove");if(!b)return;var card=t.closest(".qcard");if(!card)return;moveCard(card,b.getAttribute("data-move"));sendReorder(card.getAttribute("data-plan"),qlist);});
qlist.addEventListener("pointerdown",function(e){var t=e.target;if(!t||!t.closest)return;var h=t.closest(".qhandle");if(h&&!drag){var card=t.closest(".qcard");if(card){e.preventDefault();dragging=true;var r=card.getBoundingClientRect();var ph=document.createElement("li");ph.className="qph";ph.style.height=r.height+"px";qlist.insertBefore(ph,card);card.classList.add("dragging");card.style.width=r.width+"px";card.style.left=r.left+"px";card.style.top=r.top+"px";drag={card:card,ph:ph,y0:e.clientY,y:e.clientY,id:e.pointerId,list:qlist,raf:0};try{h.setPointerCapture(e.pointerId);}catch(_){}requestAnimationFrame(dragFrame);}}}});
}
}
function busy(){if(dragging)return true;var els=document.querySelectorAll("input:not([type=hidden]), textarea");for(var k=0;k<els.length;k++){if(els[k]===document.activeElement||els[k].value)return true;}return false;}
setInterval(function(){if(!busy()&&!swapping)refreshNow();},${REFRESH_SEC}000);
bindDetails(document);
bindPage();
})();`;

/** The whole page as one HTML string. Exported for scripts/ui-preview.ts (no server). */
export function renderPage(cfg: Config, data: PageData, params: URLSearchParams, nonce: string): string {
	const req = params.get("tab") ?? "";
	// Server-rendered tabs: the pill links carry ?tab=; anything unknown renders Now.
	const tab = req === "queue" || req === "agents" || req === "spend" ? req : "now";
	const needsBody =
		data.questions === null
			? na("Waiting on you")
			: data.questions.length
				? data.questions.map((row, i) => needCard(row, i, tab)).join("\n")
				: `<p class="empty">Nothing needs you right now</p>`;
	const working =
		data.agents === null ? na("Working now") : data.agents.length ? `<ul class="agents">${data.agents.map(agentRowHtml).join("")}</ul>` : `<p class="empty">No agents running</p>`;
	const scores = data.scores === null ? na("Agent scores") : scoresHtml(data.scores);
	const incidents = data.incidents === null ? na("Incidents") : data.incidents.length ? incidentsHtml(data.incidents) : `<p class="empty">No open incidents</p>`;
	const merges = data.ci === null ? na("Merges") : data.ci.length ? ciHtml(data.ci) : `<p class="empty">No CI runs recorded</p>`;
	const machine = data.machine === null ? na("Machine") : machineHtml(cfg, data.machine);
	const body =
		tab === "now"
			? `${messageCard(data.messages)}
<h1>Today</h1>
<p class="sub">What your agents did in the last 24 hours.</p>
<div class="card">
${tilesHtml(data)}
</div>
<h2>Needs you</h2>
<div class="card">
${needsBody}
</div>
${queueCard(data.queue, false, tab)}`
			: tab === "queue"
				? `<h1>Queue</h1>
<p class="sub">Drag ≡ to sort — Main works by the new order on its next turn.</p>
${queueCard(data.queue, true, tab)}`
				: tab === "agents"
					? `<h1>Agents</h1>
<p class="sub">Who is working right now, how they score, and what went wrong.</p>
<h2>Working now</h2>
<div class="card">
${working}
</div>
<h2>Agent scores</h2>
<div class="card">
${scores}
</div>
<h2>Incidents</h2>
<div class="card">
${incidents}
</div>
<h2>Merges</h2>
<div class="card">
${merges}
</div>
<h2>Machine</h2>
<div class="card">
${machine}
</div>`
					: `<h1>Spend</h1>
<p class="sub">List price over the last 24 hours.</p>
<div class="card">
${spendTileHtml(data)}
</div>
<h2>By model</h2>
<div class="card">
${modelSpendTable(data.stats)}
</div>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>neurastream</title>
<link rel="icon" href="${FAVICON}">
<style>
:root{--bg:#f4f4f6;--card:#fff;--fg:#111;--mut:#6b6b76;--bd:#e4e4ea;--acc:#c026d3;--teal:#0d9488;--warn:#d97706;--ok:#16a34a;--red:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e11;--card:#18181c;--fg:#f2f2f4;--mut:#9a9aa6;--bd:#2a2a31}}
*{box-sizing:border-box}
html{scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,sans-serif}
.top{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg);z-index:2}
.logo{font-weight:800;color:var(--acc)}
.pills{display:flex;background:var(--card);border:1px solid var(--bd);border-radius:999px;padding:3px;flex:1}
.pills a{flex:1;text-align:center;padding:5px 0;border-radius:999px;color:var(--mut);text-decoration:none;font-size:13px}
.pills a.on{background:var(--bg);color:var(--fg);font-weight:600;box-shadow:0 0 0 1px var(--bd)}
.lock{border:1px solid var(--bd);background:var(--card);border-radius:999px;padding:6px 10px;font-size:13px;color:var(--fg);position:relative;flex:none}
.lock summary{list-style:none;white-space:nowrap}
.lock summary::-webkit-details-marker{display:none}
.lockmenu{position:absolute;right:0;top:calc(100% + 6px);background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:6px;min-width:170px;z-index:10}
.lockmenu .btn{margin:0}
.offnote{margin:0;color:var(--mut);font-size:12px}
.offcfg{font-family:ui-monospace,"SF Mono","Roboto Mono",monospace;font-size:12px}
main{padding:4px 12px 40px}
h1{font-size:26px;margin:8px 0 2px}
h2{font-size:17px;margin:22px 4px 8px;display:flex;justify-content:space-between;align-items:baseline}
h2 small{font-size:12px;color:var(--mut);font-weight:400}
.sub{color:var(--mut);font-size:13px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;overflow:hidden}
.tile{padding:14px 16px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;align-items:flex-end;gap:8px}
.tile:first-child{border-top:0}
.lbl{font-size:13px;color:var(--mut)}
.num{font-size:30px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}
.note{font-size:12px;color:var(--mut)}
svg.spark{width:130px;height:40px;flex:none}
.receipt{margin:12px 12px 0;padding:10px 16px;background:var(--card);border:1px solid var(--teal);border-radius:14px;color:var(--teal);font-weight:600}
.eyebrow{margin:0 0 2px;color:var(--mut);font-size:13px}
.ask{padding:14px 16px;border-top:1px solid var(--bd)}
.ask:first-child{border-top:0}
.ask b{display:block;font-size:16px}
.ask p{margin:2px 0 10px;color:var(--mut);font-size:13px}
.ask .q{color:var(--fg);font-size:14px;margin:0 0 8px}
.answered{color:var(--ok)!important;margin:0 0 4px!important}
.link{border:0;background:none;color:var(--mut);text-decoration:underline;padding:0;font:inherit;font-size:13px}
.acts{display:flex;gap:6px;flex-wrap:wrap}
.btn{border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 16px;font-size:14px;margin-right:6px;font-family:inherit}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.reply{margin-top:8px}
.reply textarea{width:100%;padding:10px;border-radius:10px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);font:inherit}
.msgform{padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.msgform textarea{width:100%;padding:10px;border-radius:10px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);font:inherit}
.msgform input[type=file]{font-size:13px;color:var(--mut);max-width:100%}
.mlabel{margin:0;padding:10px 16px 2px;color:var(--mut);font-size:13px}
.msg{display:flex;gap:10px;padding:10px 16px;border-top:1px solid var(--bd);align-items:baseline;flex-wrap:wrap}
.msg:first-of-type{border-top:0}
.mtime{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;flex:none}
.mtext{flex:1 1 12em;min-width:0;font-size:14px}
.mimgs{display:flex;gap:6px}
img.mthumb{width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--bd);display:block}
details.bg{margin:8px 0;border-top:1px solid var(--bd);padding-top:6px}
details.bg summary{color:var(--mut)}
details.bg ul{margin:4px 0 8px;padding-left:20px;color:var(--mut);font-size:13px}
.qlist{list-style:none;margin:0;padding:0}
.qcard{display:flex;align-items:center;gap:10px;padding:12px 14px;border-top:1px solid var(--bd);flex-wrap:wrap}
.qcard:first-child{border-top:0}
.qcard.dragging{position:fixed;z-index:20;background:var(--card);border:1px solid var(--acc);border-radius:14px;margin:0;user-select:none;opacity:0.96}
.qph{list-style:none;border:2px dashed var(--bd);margin:4px 0}
.qhandle{color:var(--mut);font-size:18px;touch-action:none;padding:2px 2px;user-select:none;flex:none}
.qrank{color:var(--mut);width:18px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;flex:none}
.qtitle{flex:1 1 12em;min-width:0}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;flex:none}
.c-wait{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.c-run{background:color-mix(in srgb,var(--teal) 18%,transparent);color:var(--teal)}
.c-ready{background:color-mix(in srgb,var(--mut) 15%,transparent);color:var(--mut)}
.chip.bad{color:var(--red)}
.qbtns{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.qbtns button{min-height:32px;padding:2px 10px;font-size:12px;border-radius:999px;border:1px solid var(--bd);background:var(--card);color:var(--mut)}
.more{display:block;text-align:center;padding:12px;color:var(--acc);text-decoration:none;border-top:1px solid var(--bd);font-size:14px}
.agents{list-style:none;margin:0;padding:8px 14px}
.agent{display:flex;align-items:baseline;gap:8px;padding:8px 0;border-bottom:1px solid var(--bd);flex-wrap:wrap}
.agent:last-child{border-bottom:none}
.dot{width:10px;height:10px;border-radius:50%;align-self:center;flex:none}
.dot.ok{background:var(--teal)}
.dot.warn{background:var(--warn)}
.dot.bad{background:var(--red)}
.mono,.aid,.model{font-family:ui-monospace,"SF Mono","Roboto Mono",monospace;font-size:13px}
.model,.detail{color:var(--mut)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd);font-variant-numeric:tabular-nums}
th{color:var(--mut);font-weight:600}
tr:last-child td{border-bottom:none}
.merges,.incidents{margin:0;padding:8px 14px 8px 32px}
.merges li,.incidents li{margin:6px 0}
.mrow{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--bd)}
.mrow:last-child{border-bottom:none}
.bad{color:var(--red);font-weight:600}
.empty{color:var(--mut);padding:14px 16px;margin:0}
.na{color:var(--mut);font-style:italic;padding:14px 16px;margin:0}
</style>
</head>
<body>
${topBarHtml(tab, data.lockMinutesLeft, cfg)}
${receiptHtml(params.get("sent"), params)}
<main>
${body}
</main>
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

/** The POST reply target: the tab the owner was on (a hidden `tab` field; unknown = now, the default), then the receipt. */
function sentTo(tab: string, sent: string): string {
	const t = tab === "queue" || tab === "agents" || tab === "spend" ? tab : "now";
	return t === "now" ? `/?${sent}` : `/?tab=${t}&${sent}`;
}

/** The normal page (the GET layout) as a POST reply; the stale-answer reply is this with sent=stale. */
function pageRes(cfg: Config, source: RunSource, params: URLSearchParams): Response {
	const nonce = randomUUID().replaceAll("-", "");
	return new Response(renderPage(cfg, buildPageData(cfg, source), params, nonce), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
		},
	});
}

/** The last answer appended per plan, for the double-press guard (P8c): memory only, no file. */
const lastAnswerByPlan = new Map<string, { answer: string; ts: number }>();
const DOUBLE_PRESS_SEC = 10;

/** Appends the answer to the owner inbox unless this plan got the same trimmed answer in the last 10 s (P8c). */
function appendAnswer(plan: string, question: string, answer: string, login: string): void {
	const now = nowSec();
	const last = lastAnswerByPlan.get(plan);
	if (last !== undefined && last.answer === answer && now - last.ts < DOUBLE_PRESS_SEC) return;
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: now, plan, question, answer, login })}\n`);
	lastAnswerByPlan.set(plan, { answer, ts: now });
}

function handleAnswer(cfg: Config, source: RunSource, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const planFile = (fields.plan ?? "").trim();
	const answer = (fields.answer_text ?? "").trim() || (fields.answer ?? "").trim();
	if (!planFile || !answer) return wantsJson ? jsonFail("plan and answer are required", 400) : textRes("plan and answer are required", 400);
	if (answer.length > ANSWER_MAX) return wantsJson ? jsonFail(`answer is longer than ${ANSWER_MAX} chars`, 400) : textRes(`answer is longer than ${ANSWER_MAX} chars`, 400);
	const plan = activePlans(cfg.paths.queue_index).find(p => p.file === planFile);
	if (!plan) return wantsJson ? jsonFail("plan is not open and waiting", 409) : textRes("plan is not open and waiting", 409);
	if (plan.status !== "open" || !plan.waiting || !plan.waitingLine) {
		// Stale answer (P8b): Main cleared the question before the answer arrived; pass it on anyway.
		appendAnswer(planFile, "(already cleared)", answer, login);
		if (wantsJson) return jsonSent("stale", receiptText("stale", new URLSearchParams()));
		return pageRes(cfg, source, new URLSearchParams({ sent: "stale" }));
	}
	appendAnswer(planFile, plan.waitingLine, answer, login);
	if (wantsJson) return jsonSent("answer", receiptText("answer", new URLSearchParams()));
	return redirect(sentTo(fields.tab ?? "", "sent=answer"));
}

// ---- POST /message (plan P13): the owner's one-way note plus images, inboxed by id ----

async function handleMessage(req: Request, login: string, wantsJson: boolean): Promise<Response> {
	sweepOwnerMessages(nowSec());
	const form = await req.formData();
	let text = "";
	const files: File[] = [];
	for (const [key, value] of form.entries()) {
		if (key === "text" && typeof value === "string") text = value.trim();
		else if (key === "images" && typeof value !== "string") files.push(value);
	}
	const fail = (error: string): Response => (wantsJson ? jsonFail(error, 400) : textRes(error, 400));
	if (!text && !files.length) return fail("write a text or attach an image");
	if (text.length > MESSAGE_MAX) return fail(`text is longer than ${MESSAGE_MAX} chars`);
	if (files.length > MESSAGE_IMAGES_MAX) return fail(`at most ${MESSAGE_IMAGES_MAX} images per message`);
	const images: { bytes: Uint8Array; kind: string }[] = [];
	for (const file of files) {
		if (file.size > MESSAGE_IMAGE_MAX_BYTES) return fail("an image is larger than 10 MB");
		const data = new Uint8Array(await file.arrayBuffer());
		const kind = imageType(data);
		if (!kind) return fail("attachments must be PNG, JPEG, GIF or WEBP images — the type is read from the file itself");
		images.push({ bytes: data, kind });
	}
	const ts = nowSec();
	// The dir name starts with a whole-second ts: the sweep and the image route both parse it.
	const id = `${Math.floor(ts)}-${randomUUID().slice(0, 6)}`;
	const dir = `${ownerMessagesDir()}/${id}`;
	mkdirSync(dir, { recursive: true });
	const names: string[] = [];
	for (let i = 0; i < images.length; i++) {
		const name = `${i + 1}.${IMAGE_EXT[images[i]!.kind]}`;
		writeFileSync(`${dir}/${name}`, images[i]!.bytes);
		names.push(name);
	}
	writeFileSync(`${dir}/message.json`, `${JSON.stringify({ ts, text, login, images: names })}\n`);
	mkdirSync(stateDirPath(), { recursive: true });
	// The text stays out of owner-inbox.jsonl; Main reads message.json through the id (P14).
	appendFileSync(inboxPath(), `${JSON.stringify({ ts, kind: "message", id, login })}\n`);
	if (wantsJson) return jsonSent("message", receiptText("message", new URLSearchParams()));
	return redirect("/?sent=message");
}

/** Serves one stored message image. Both path pieces are shape-checked and the name must be in message.json — raw input never reaches a path join. */
function handleMessageImage(id: string, file: string): Response {
	if (!/^[0-9]+-[0-9a-f]{6}$/.test(id) || !/^[0-9]+\.(png|jpg|gif|webp)$/.test(file)) return textRes("not found", 404);
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(readFileSync(`${ownerMessagesDir()}/${id}/message.json`, "utf8")) as Record<string, unknown>;
	} catch {
		return textRes("not found", 404);
	}
	const names = Array.isArray(meta.images) ? meta.images.filter((n): n is string => typeof n === "string") : [];
	if (!names.includes(file)) return textRes("not found", 404);
	try {
		return new Response(readFileSync(`${ownerMessagesDir()}/${id}/${file}`), {
			headers: { "content-type": IMAGE_MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream" },
		});
	} catch {
		return textRes("not found", 404);
	}
}

function handleUnlock(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const minutes = fields.minutes ?? "";
	if (minutes !== "" && !/^\d+$/.test(minutes)) return wantsJson ? jsonFail("minutes must be a number", 400) : textRes("minutes must be a number", 400);
	const result = chatUnlock(minutes === "" ? "unlock" : `unlock ${minutes}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(
		inboxPath(),
		`${JSON.stringify({ ts: nowSec(), kind: "unlock", minutes: result.minutes, until: result.until, login })}\n`,
	);
	if (wantsJson) return jsonSent("unlock", receiptText("unlock", new URLSearchParams({ minutes: String(result.minutes) })));
	return redirect(sentTo(fields.tab ?? "", `sent=unlock&minutes=${result.minutes}`));
}

function handleLock(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const result = chatUnlock("lock", cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), kind: "lock", login })}\n`);
	if (wantsJson) return jsonSent("lock", receiptText("lock", new URLSearchParams()));
	return redirect(sentTo(fields.tab ?? "", "sent=lock"));
}

const TIERS: readonly Tier[] = ["strict", "opinionated", "full"];

// Autonomy tier from the phone page (plan 20261025_1940 P3): behind the same auth as every other
// route, written by the core chatTier with the owner's tapped name; a bad name is a 400 before
// the core is called, and the chat gate off redirects to the plain-words note like unlock/lock.
function handleTier(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
	const name = (fields.tier ?? "").trim().toLowerCase();
	if (!(TIERS as readonly string[]).includes(name)) return wantsJson ? jsonFail("tier must be strict, opinionated or full", 400) : textRes("tier must be strict, opinionated or full", 400);
	const result = chatTier(`tier ${name}`, cfg, `ui:${login}`, "ui");
	if (!result.applied) return wantsJson ? jsonFail("Refused — chat unlock is off", 400) : redirect(sentTo(fields.tab ?? "", "sent=unlock-off"));
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), kind: "tier", tier: result.tier, login })}\n`);
	if (wantsJson) return jsonSent("tier");
	return redirect(sentTo(fields.tab ?? "", `sent=tier&tier=${result.tier}`));
}

// ---- queue reorder (plan P4): the owner drags a card; INDEX.md is rewritten atomically ----

/**
 * The index text with its open-plan groups reordered: a group is a plan line plus the non-plan
 * lines (blank or `<!--` comment) attached above it, and the open groups — the first line of
 * each path in `openPaths`, in file order — are replaced by the groups of `order`, so every open
 * plan moves with its comment lines while every other plan line keeps its slot (a path listed
 * twice keeps both lines). Lines after the last plan keep the file's end. Returns null when an
 * order path is no longer in the file.
 */
function reorderedIndexText(index: string, order: string[], openPaths: ReadonlySet<string>): string | null {
	let text: string;
	try {
		text = readFileSync(index, "utf8");
	} catch {
		return null;
	}
	const groups: { path: string; lines: string[] }[] = [];
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
		groups.push({ path: resolve(process.cwd(), expandHome(norm.replace(/`/g, ""))), lines: [...pending, raw] });
		pending = [];
	}
	// The open slots in file order: the first line of each open path; a later duplicate of the
	// same path keeps its place like a non-open line, so a path listed twice keeps both lines.
	const byPath = new Map<string, number>();
	const slots: number[] = [];
	const seen = new Set<string>();
	for (const [i, g] of groups.entries()) {
		if (!byPath.has(g.path)) byPath.set(g.path, i);
		if (openPaths.has(g.path) && !seen.has(g.path)) {
			seen.add(g.path);
			slots.push(i);
		}
	}
	if (slots.length !== order.length) return null;
	const parts: string[] = [];
	let k = 0;
	for (let i = 0; i < groups.length; i++) {
		if (slots[k] === i) {
			const at = byPath.get(order[k] ?? "");
			if (at === undefined) return null;
			parts.push(...groups[at]!.lines);
			k++;
		} else {
			parts.push(...groups[i]!.lines);
		}
	}
	parts.push(...pending);
	return parts.join("\n");
}

function handleReorder(cfg: Config, fields: Record<string, string>, login: string, wantsJson: boolean): Response {
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
	// The page's drag and arrow buttons send this over fetch (accept: application/json) and read
	// the JSON reply; a no-JS form post still gets the 303. Errors follow the same split.
	const fail = (error: string, status: number): Response =>
		wantsJson ? Response.json({ ok: false, error }, { status }) : textRes(error, status);
	// One source of truth for the reorderable set: the open plans, the same list queueRows renders.
	const openPlans = activePlans(index).filter(p => p.status === "open");
	const openPaths = openPlans.map(p => p.file);
	const openPlan: Record<string, Plan> = Object.fromEntries(openPlans.map(p => [p.file, p]));
	if (!moved || !order.length) return fail("order and moved are required", 400);
	// 400: the posted order must be exactly the open plans the page renders now — no adds, drops or duplicates.
	if (new Set(order).size !== order.length) return fail("order lists a plan more than once", 400);
	const sortedOrder = [...order].sort();
	const sortedOpen = [...openPaths].sort();
	const sameSet = order.length === openPaths.length && sortedOrder.every((p, i) => p === sortedOpen[i]);
	if (!sameSet) return fail("order is not exactly the plans now on the page", 400);
	// 409: the order the page was rendered with must still be the open plans' current order.
	const stale = before.length !== openPaths.length || before.some((p, i) => p !== openPaths[i]);
	if (stale) return fail("the queue changed since the page loaded — reload and drag again", 409);
	// 409: the index is priority (I-20261025-208), so the posted order itself may not put a plan
	// above the open plan it waits on. Checked before any write: the index file and the reorder
	// inbox stay untouched, and the page's 409 branch shows the message and reloads the real order.
	const firstBlock = dependencyOrderProblems(order.map(o => openPlan[o]!))[0];
	if (firstBlock) return fail(`blocked: ${firstBlock}`, 409);
	const from = openPaths.indexOf(moved);
	const to = order.indexOf(moved);
	if (from === -1 || to === -1) return fail("moved is not one of the page's plans", 400);
	const newText = reorderedIndexText(index, order, new Set(openPaths));
	if (newText === null) return fail("the queue index no longer lists every open plan", 400);
	// Atomic write: a torn INDEX.md would break every reader, so temp file in the same dir + rename.
	const tmp = `${index}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, newText);
	renameSync(tmp, index);
	mkdirSync(stateDirPath(), { recursive: true });
	appendFileSync(inboxPath(), `${JSON.stringify({ ts: nowSec(), kind: "reorder", plan: moved, from: from + 1, to: to + 1, login })}\n`);
	if (wantsJson) return Response.json({ ok: true, to: to + 1 });
	return redirect(sentTo(fields.tab ?? "", `sent=reorder&to=${to + 1}`));
}

/** Starts the page. Refuses to start when ui.enabled is false or ui.owner_login is empty, and on the default hostname when tailscale does not answer. */
export function startOwnerUi(opts: OwnerUiOptions): OwnerUiServer {
	const { cfg, tailscale, source } = opts;
	// The double-press guard (P8c) is per-server memory: a fresh server starts empty, which also
	// keeps the tests (one server per test) hermetic.
	lastAnswerByPlan.clear();
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
							sweepOwnerMessages(nowSec());
							res = pageRes(cfg, source, url.searchParams);
							code = 200;
						} else if (req.method === "GET" && url.pathname.startsWith("/message-image/")) {
							const mim = /^\/message-image\/([^/]+)\/([^/]+)$/.exec(url.pathname);
							res = mim ? handleMessageImage(mim[1]!, mim[2]!) : textRes("not found", 404);
							code = res.status;
						} else if (req.method === "POST") {
							// The page's script asks for JSON on every POST (P11b); a no-JS form post gets today's 303s.
							const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
							if (url.pathname === "/message") {
								res = await handleMessage(req, login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/answer") {
								res = handleAnswer(cfg, source, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/unlock") {
								res = handleUnlock(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/lock") {
								res = handleLock(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/tier") {
								res = handleTier(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/reorder") {
								res = handleReorder(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else {
								res = textRes("not found", 404);
								code = 404;
							}
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
