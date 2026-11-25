// HTML/CSS/JS rendering for the owner phone page and the team queue page.

import { randomUUID } from "node:crypto";
import type { RunSource } from "../adapter.ts";
import { currentTier, type Tier } from "../autonomy.ts";
import { strftime } from "../clock.ts";
import type { Config } from "../config.ts";
import { isFindingKind } from "../incidents.ts";
import { byText, urlValue, type KnowledgeEntry } from "../knowledge.ts";
import { ANSWER_MAX, esc, na, pageCsp, receiptText, TAB_IDS, TABS } from "./auth.ts";
import { buildPageData, type AgentRow, type CiRow, type IncidentRow, type MachineRow, type NowStats, type PageData, type PublishedPageRow, type QuestionRow, type QueueRow, type ScoresData, type TeamSection } from "./data.ts";
import { MESSAGE_MAX, runningMains, type MessageRow } from "./messages.ts";
import { noopResultsBuild, resultsTabHtml, type ResultsBuild } from "./results.ts";

const REFRESH_SEC = 20;

/** The "Tell Main" card: one textarea, image picks, a Send button — no chat thread. Under it, "Sent today": this view's messages newer than the keep window, newest first, thumbnails served from /message-image. */
function messageCard(messages: MessageRow[] | null, running: string[]): string {
	const form = `<form class="msgform" method="post" action="/message" enctype="multipart/form-data">
<textarea name="text" maxlength="${MESSAGE_MAX}" rows="3" placeholder="What Main should know — a fix, a link, a photo"></textarea>
<select name="to"><option value="">All</option>${running.map(id => `<option value="${esc(id)}">Main ${esc(id)}</option>`).join("")}</select>
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
	const bg = row.goal.length ? `<details class="bg" id="bg-${i}"><summary>Background</summary><ul>${goals}</ul></details>` : "";
	const ask = row.waitingAsk || row.waitingLine;
	const parts: string[] = [];
	if (ask) parts.push(`<p class="q"><b>Do</b> ${esc(ask)}</p>`);
	if (row.waitingBlocked || row.unblocks.length) {
		const extra = row.unblocks.length ? `also unblocks: ${row.unblocks.join(", ")}` : "";
		const stuck = [row.waitingBlocked, extra].filter(Boolean).join(" ");
		parts.push(`<p class="q"><b>Stuck until then</b> ${esc(stuck)}</p>`);
	}
	if (row.waitingWhy) parts.push(`<p class="q"><b>Why you</b> ${esc(row.waitingWhy)}</p>`);
	let said = "";
	if (row.answered) {
		const text = row.answered.answer;
		const quote = text.length > 80 ? `${text.slice(0, 80)}…` : text;
		const verb = text.toLowerCase() === "yes" || text.toLowerCase() === "no" ? "answered" : "replied";
		said = `<p class="answered">${row.answered.login ? esc(row.answered.login) : "You"} ${verb} "${esc(quote)}" · ${esc(strftime(row.answered.at, "%H:%M"))} — Main is on it</p>
<button type="button" class="replybtn link">change answer</button>`;
	}
	const question = ask.endsWith("?");
	const acts = row.answered
		? said
		: question
			? `<div class="acts">
<button class="btn pri" type="submit" name="answer" value="yes">Yes</button>
<button class="btn" type="submit" name="answer" value="no">No</button>
<button type="button" class="btn replybtn">Reply…</button>
</div>`
			: `<div class="acts">
<button class="btn pri" type="submit" name="answer" value="done">Done ✓</button>
<button type="button" class="btn replybtn">Reply…</button>
</div>`;
	return `<article class="ask">
<p class="eyebrow">${esc(row.repo)}</p>
<b>${esc(row.title)}</b>
${parts.join("\n")}
${bg}
<form method="post" action="/answer">
<input type="hidden" name="plan" value="${esc(row.plan)}">
${row.team ? `<input type="hidden" name="team" value="${esc(row.team)}">\n` : ""}<input type="hidden" name="tab" value="${esc(tab)}">
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

/** The queue list. `reorder` false is a team card (P4): no drag handle, no ↑/↓ buttons and no /reorder form — team order is the server's, not INDEX order. */
function queueHtml(rows: QueueRow[], tab: string, reorder = true): string {
	const handle = (r: QueueRow): string => `<span class="qhandle" title="Drag to reorder" aria-label="Drag ${esc(r.title)}">≡</span>
`;
	const btns = `<span class="qbtns"><button type="button" class="qmove" data-move="top">↑ top</button><button type="button" class="qmove" data-move="up">↑</button><button type="button" class="qmove" data-move="down">↓</button></span>`;
	const cards = rows
		.map(
			(r, i) => `<li class="qcard" data-plan="${esc(r.file)}">
${reorder ? handle(r) : ""}<span class="qrank">${i + 1}</span>
<span class="qtitle">${esc(r.title)}${r.summary ? `<span class="qsum">${esc(r.summary)}</span>` : ""}</span>
${r.holder ? `<span class="chip c-held">${r.holder === "team server unreachable" ? esc(r.holder) : `Main ${esc(r.holder)}`}</span>` : ""}<span class="chip ${r.state.startsWith("waits") ? "c-wait" : "c-ready"}">${esc(r.state)}</span>
${reorder ? btns : ""}
</li>`,
		)
		.join("\n");
	// before = the order this page was rendered with; the server refuses the move when the real
	// order has drifted (409), so a stale page can never reorder on a guess.
	const before = rows.map(r => r.file).join("\n");
	const form = `<form id="reorder-form" method="post" action="/reorder" hidden>
<input type="hidden" name="before" value="${esc(before)}">
<input type="hidden" name="order" value="">
<input type="hidden" name="moved" value="">
<input type="hidden" name="tab" value="${esc(tab)}">
</form>`;
	return `<ul class="qlist"${reorder ? ` id="qlist"` : ""}>
${cards}
</ul>
${reorder ? form : ""}`;
}

function ciHtml(rows: CiRow[]): string {
	return `<ul class="merges">${rows
		.map(r => `<li><span class="mono">${esc(r.mr)}</span> · ${r.tries} pipeline${r.tries === 1 ? "" : "s"} · ${esc(strftime(r.ts, "%m-%d %H:%M"))}</li>`)
		.join("")}</ul>`;
}

function incidentsHtml(rows: IncidentRow[], tab: string): string {
	return `<ul class="incidents">${rows
		.map(r => {
			const head = `<span class="mono">${esc(r.id)}</span> <span class="chip bad">${esc(r.kind)}</span> ${esc(r.summary)}${r.count > 1 ? ` · ${r.count}x` : ""}`;
			if (!isFindingKind(r.kind)) return `<li>${head}</li>`;
			const why = r.proposal === null ? `<em>Main has not said why yet</em>` : esc(r.proposal);
			return `<li>${head}<div class="sub">${why}</div>
<form method="post" action="/incident" class="inline">
<input type="hidden" name="id" value="${esc(r.id)}">
<input type="hidden" name="tab" value="${esc(tab)}">
<button class="btn" type="submit" name="choice" value="bug">It's a bug — plan it</button>
<button class="btn" type="submit" name="choice" value="false">False alarm</button>
</form></li>`;
		})
		.join("")}</ul>`;
}

function scoresHtml(d: ScoresData): string {
	const head = d.header.length ? `<thead><tr>${d.header.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>` : "";
	const body = d.rows.length ? `<tbody>${d.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>` : "";
	const table = head ? `<table>${head}${body}</table>` : "";
	const text = d.text.map(t => `<p>${esc(t)}</p>`).join("");
	return table + text;
}

function machineHtml(_cfg: Config, m: MachineRow): string {
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
	const pills = TABS.map(([id, label]) => `<a href="/?tab=${id}"${tab === id ? ` class="on"` : ""}>${label}</a>`).join("");
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

/**
 * Each team as its own card under the queue card (P4): its plans through queueHtml with
 * `reorder` off, then one question card per open WAITING line. A team the server did not answer
 * says so instead of showing a stale list. Nothing here counts in the "Needs you" tile.
 */
function teamCardsHtml(sections: TeamSection[] | null, tab: string): string {
	if (sections === null) return `<h2>Team queue</h2><div class="card">${na("Team queue")}</div>`;
	return sections
		.map(s => {
			const body = s.reachable ? (s.rows.length ? queueHtml(s.rows, tab, false) : `<p class="empty">No team plans</p>`) : `<p class="empty">team server ${esc(s.server)} unreachable</p>`;
			const asks = s.questions.map((row, i) => needCard(row, i, tab)).join("\n");
			return `<h2>Team ${esc(s.name)}</h2>
<div class="card">
${body}${asks ? `\n${asks}` : ""}
</div>`;
		})
		.join("\n");
}

function modelSpendTable(stats: NowStats | null): string {
	if (stats === null) return na("Spend");
	if (!stats.byModel.length) return `<p class="empty">No spend recorded in the last 24 hours</p>`;
	const rows = stats.byModel.map(m => `<tr><td>${esc(m.model)}</td><td>$${m.spend.toFixed(2)}</td><td>${m.runs}</td></tr>`).join("");
	return `<table><thead><tr><th>Model</th><th>Spend</th><th>Runs</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function receiptHtml(sent: string | null, params: URLSearchParams): string {
	if (!sent) return "";
	const text = receiptText(sent, params);
	return text === null ? "" : `<div class="receipt" role="status">${esc(text)}</div>`;
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
// Keep the tab in the address bar (receipts are one-time DOM, not a reloadable URL); the Results tab keeps y/x so the 20 s refresh renders the same selection.
if(location.search){var q=new URLSearchParams(location.search);var keep=new URLSearchParams();if(q.get("tab"))keep.set("tab",q.get("tab"));if(q.get("tab")==="results"){if(q.get("y"))keep.set("y",q.get("y"));if(q.get("x"))keep.set("x",q.get("x"));}var ks=keep.toString();history.replaceState(null,"",location.pathname+(ks?"?"+ks:""));}
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
qlist.addEventListener("pointerdown",function(e){var t=e.target;if(!t||!t.closest)return;var h=t.closest(".qhandle");if(h&&!drag){var card=t.closest(".qcard");if(card){e.preventDefault();dragging=true;var r=card.getBoundingClientRect();var ph=document.createElement("li");ph.className="qph";ph.style.height=r.height+"px";qlist.insertBefore(ph,card);card.classList.add("dragging");card.style.width=r.width+"px";card.style.left=r.left+"px";card.style.top=r.top+"px";drag={card:card,ph:ph,y0:e.clientY,y:e.clientY,id:e.pointerId,list:qlist,raf:0};try{h.setPointerCapture(e.pointerId);}catch(_){}requestAnimationFrame(dragFrame);}}});
}
}
function busy(){if(dragging)return true;var els=document.querySelectorAll("input:not([type=hidden]), textarea");for(var k=0;k<els.length;k++){if(els[k]===document.activeElement||els[k].value)return true;}return false;}
setInterval(function(){if(!busy()&&!swapping)refreshNow();},${REFRESH_SEC}000);
bindDetails(document);
bindPage();
})();`;

/**
 * The Knowledge tab: repo cards, one repo's topic cards, or one topic in a frame. The breadcrumb's
 * earlier segments link back — knowledge-base → every repo, `<repo>` → its topics. Topics are
 * read-only files at docs/knowledge/<topic>.html in a repo under the configured roots; the page
 * bytes come from /knowledge/<repo>/<topic> and there is no route that writes one.
 */
function knowledgeHtml(entries: KnowledgeEntry[], repo: string, topic: string, pages: PublishedPageRow[]): string {
	const repoHref = `/?tab=knowledge&repo=${urlValue(repo)}`;
	const crumb =
		repo === ""
			? ""
			: `<p class="sub"><a href="/?tab=knowledge">knowledge-base</a> / ${topic === "" ? esc(repo) : `<a href="${repoHref}">${esc(repo)}</a>`}${topic === "" ? "" : ` / ${esc(topic)}`}</p>`;
	if (entries.length === 0 && pages.length === 0) {
		return `<h1>Base</h1><div class="card"><p class="empty">Nothing here yet. Any repo under the configured roots counts: put a page in <span class="mono">docs/knowledge/</span> or publish one with <span class="mono">pages publish</span>, and it shows up here on the next reload.</p></div>`;
	}
	if (repo === "") {
		// One card per repo NAME (plan 20261029_1436 P2): a repo's knowledge topics and its published
		// pages share the card; a worktree's page was already tagged with the main checkout's name.
		const repos = new Map<string, { topics: KnowledgeEntry[]; pages: PublishedPageRow[] }>();
		const slot = (name: string) => {
			const r = repos.get(name) ?? { topics: [], pages: [] };
			repos.set(name, r);
			return r;
		};
		for (const e of entries) slot(e.repo).topics.push(e);
		for (const p of pages) slot(p.repo).pages.push(p);
		const rows = [...repos.entries()]
			.sort((a, b) => byText(a[0], b[0]))
			.map(([name, r]) => {
				const n = r.topics.length + r.pages.length;
				const newest = [...r.topics.map(e => e.updated), ...r.pages.map(p => p.published)].sort().at(-1)!.slice(0, 10);
				return `<div class="mrow"><a href="/?tab=knowledge&repo=${urlValue(name)}">${esc(name)}</a><span class="mono">${n} page${n === 1 ? "" : "s"} · ${newest}</span></div>`;
			})
			.join("");
		return `<h1>Base</h1><p class="sub">One card per repo: its <span class="mono">docs/knowledge/</span> pages and the pages Main published from it — tap a repo to open its list.</p><div class="card">${rows}</div>`;
	}
	const topics = entries.filter(e => e.repo === repo);
	const repoPages = pages.filter(p => p.repo === repo);
	if (topics.length === 0 && repoPages.length === 0) return `${crumb}<div class="card"><p class="empty">No repo named "${esc(repo)}" has a page under the configured roots.</p></div>`;
	if (topic === "") {
		const topicRows = topics
			.map(e => `<div class="mrow"><a href="${repoHref}&topic=${urlValue(e.topic)}">${esc(e.title)}</a><span class="mono">${e.updated.slice(0, 10)}</span></div>`)
			.join("");
		// Published pages after the topics, newest first (publishedPages sorts them that way).
		const pageRows = repoPages.map(p => `<div class="mrow"><a href="${p.url}">${esc(p.name)}</a><span class="mono">${p.published.slice(0, 10)}</span></div>`).join("");
		return `${crumb}<div class="card">${topicRows}${pageRows}</div>`;
	}
	const hit = topics.find(e => e.topic === topic);
	if (hit === undefined) return `${crumb}<div class="card"><p class="empty">No topic "${esc(topic)}" in ${esc(repo)}.</p></div>`;
	return `${crumb}<h1>${esc(hit.title)}</h1><div class="card"><iframe class="knowframe" sandbox="allow-scripts" title="${esc(hit.title)}" src="/knowledge/${urlValue(repo)}/${urlValue(topic)}"></iframe></div>`;
}

/** The owner page's stylesheet (P5 lift): one string shared by the phone page (renderPage) and the team page (renderTeamPage). */
const PAGE_CSS = `
:root{--bg:#f4f4f6;--card:#fff;--fg:#111;--mut:#6b6b76;--bd:#e4e4ea;--acc:#c026d3;--teal:#0d9488;--warn:#d97706;--ok:#16a34a;--red:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e11;--card:#18181c;--fg:#f2f2f4;--mut:#9a9aa6;--bd:#2a2a31}}
*{box-sizing:border-box}
html{scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,sans-serif}
.top{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg);z-index:2}
.logo{font-weight:800;color:var(--acc)}
.pills{display:flex;background:var(--card);border:1px solid var(--bd);border-radius:999px;padding:3px;flex:1;gap:3px;overflow-x:auto}
.pills a{flex:none;text-align:center;padding:5px 10px;border-radius:999px;color:var(--mut);text-decoration:none;font-size:13px;white-space:nowrap}
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
.qsum{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--mut);font-size:13px;font-weight:400}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;flex:none}
.c-wait{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.c-run{background:color-mix(in srgb,var(--teal) 18%,transparent);color:var(--teal)}
.c-ready{background:color-mix(in srgb,var(--mut) 15%,transparent);color:var(--mut)}
.c-held{background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--acc)}
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
.tscroll{overflow-x:auto}
td.mutcell{color:var(--mut)}
span.good{color:var(--ok);font-weight:600}
span.badv{color:var(--red);font-weight:600}
.rlinks{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:10px 14px 0;font-size:12px;color:var(--mut)}
.rlinks a{border:1px solid var(--bd);border-radius:999px;padding:3px 10px;color:var(--mut);text-decoration:none;background:var(--card)}
.rlinks a.on{color:var(--fg);background:var(--bg);font-weight:600;box-shadow:0 0 0 1px var(--bd)}
.rlegend{margin:0;padding:10px 14px 0;font-size:12px;color:var(--mut);display:flex;gap:12px}
.rchart{width:100%;height:auto;display:block;padding:4px 2px 8px}
.merges,.incidents{margin:0;padding:8px 14px 8px 32px}
.merges li,.incidents li{margin:6px 0}
.mrow{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--bd)}
.mrow:last-child{border-bottom:none}
.bad{color:var(--red);font-weight:600}
.empty{color:var(--mut);padding:14px 16px;margin:0}
.knowframe{display:block;width:100%;height:calc(100vh - 220px);min-height:360px;border:0;background:#fff}
.na{color:var(--mut);font-style:italic;padding:14px 16px;margin:0}
`;

/** The whole page as one HTML string. Exported for scripts/ui-preview.ts (no server). */
export function renderPage(cfg: Config, data: PageData, params: URLSearchParams, nonce: string): string {
	const req = params.get("tab") ?? "";
	// Server-rendered tabs: the pill links carry ?tab=; anything unknown renders Now.
	const tab = TAB_IDS.includes(req) ? req : "now";
	const needsBody =
		data.questions === null
			? na("Waiting on you")
			: data.questions.length
				? data.questions.map((row, i) => needCard(row, i, tab)).join("\n")
				: `<p class="empty">Nothing needs you right now</p>`;
	const working =
		data.agents === null ? na("Working now") : data.agents.length ? `<ul class="agents">${data.agents.map(agentRowHtml).join("")}</ul>` : `<p class="empty">No agents running</p>`;
	const scores = data.scores === null ? na("Agent scores") : scoresHtml(data.scores);
	const incidents = data.incidents === null ? na("Incidents") : data.incidents.length ? incidentsHtml(data.incidents, tab) : `<p class="empty">No open incidents</p>`;
	const merges = data.ci === null ? na("Merges") : data.ci.length ? ciHtml(data.ci) : `<p class="empty">No CI runs recorded</p>`;
	const machine = data.machine === null ? na("Machine") : machineHtml(cfg, data.machine);
	// P4: one card per team, under the queue card on the two tabs that show the queue.
	const teams = tab === "now" || tab === "queue" ? teamCardsHtml(data.teams ?? null, tab) : "";
	const body =
		tab === "now"
			? `${messageCard(data.messages, runningMains(cfg))}
<h1>Today</h1>
<p class="sub">What your agents did in the last 24 hours.</p>
<div class="card">
${tilesHtml(data)}
</div>
<h2>Needs you</h2>
<div class="card">
${needsBody}
</div>
${queueCard(data.queue, false, tab)}${teams ? `\n${teams}` : ""}`
			: tab === "queue"
				? `<h1>Queue</h1>
<p class="sub">Drag ≡ to sort — Main works by the new order on its next turn.</p>
${queueCard(data.queue, true, tab)}${teams ? `\n${teams}` : ""}`
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
					: tab === "knowledge"
						? `${data.knowledge === null ? na("Base") : knowledgeHtml(data.knowledge, params.get("repo") ?? "", params.get("topic") ?? "", data.pages ?? [])}`
						: tab === "spend"
							? `<h1>Spend</h1>
<p class="sub">List price over the last 24 hours.</p>
<div class="card">
${spendTileHtml(data)}
</div>
<h2>By model</h2>
<div class="card">
${modelSpendTable(data.stats)}
</div>`
							: resultsTabHtml(data.results, params);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>neurastream</title>
<link rel="icon" href="${FAVICON}">
<style>${PAGE_CSS}</style>
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

/** The normal page (the GET layout) as a POST reply; the stale-answer reply is this with sent=stale. */
export function pageRes(cfg: Config, source: RunSource, params: URLSearchParams, build: ResultsBuild = noopResultsBuild, pagesHost = "tailnet"): Response {
	const nonce = randomUUID().replaceAll("-", "");
	return new Response(renderPage(cfg, buildPageData(cfg, source, params.get("tab") ?? "", build, pagesHost), params, nonce), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": pageCsp(nonce),
		},
	});
}

/** What the team page shows: one team's section (shared with the phone page), its plans' approvals, members, and audit. */
export interface TeamPageData {
	team: string;
	login: string;
	admin: boolean;
	leader: boolean;
	adminLogin: string;
	section: TeamSection;
	plans: { id: string; relPath: string; title: string; approvals: string[] }[];
	members: string[];
	/** Newest first, already formatted; null for a viewer who may not read the audit. */
	audit: { at: string; login: string; route: string }[] | null;
}

/** The team page (P5): plain forms that POST to the team server's routes; no script, so no nonce. */
export function renderTeamPage(data: TeamPageData): string {
	const waiting = data.section.questions.length
		? data.section.questions.map(row => `<div class="ask"><b>${esc(row.title)}</b><p class="q">${esc(row.waitingAsk || row.waitingLine || "")}</p>${row.answered ? `<p class="answered">${row.answered.login ? esc(row.answered.login) : "You"} answered "${esc(row.answered.answer)}"</p>` : ""}<form method="post" action="/answer"><input type="hidden" name="plan" value="${esc(row.plan)}"><textarea name="answer_text" rows="2" required maxlength="2000"></textarea><div class="acts"><button class="btn pri" type="submit">Send</button></div></form></div>`).join("")
		: `<p class="empty">Nothing waiting</p>`;
	const approve = data.plans.length
		? data.plans.map(p => {
				const chip = p.approvals.length ? ` <span class="chip c-ready">approved by ${p.approvals.map(a => esc(a)).join(", ")}</span>` : "";
				const form = p.approvals.includes(data.login) ? "" : `<form method="post" action="/approve"><input type="hidden" name="plan" value="${esc(p.id)}"><button class="btn pri" type="submit">Approve</button></form>`;
				return `<div class="ask"><b>${esc(p.title)}</b><p>${esc(p.relPath)}${chip}</p>${form}</div>`;
			}).join("")
		: `<p class="empty">No team plans to approve</p>`;
	const ranking = data.plans.length
		? `<form method="post" action="/vote">${data.plans.map(p => `<div class="mrow"><span>${esc(p.title)}</span><input name="rank:${esc(p.id)}" inputmode="numeric" size="4" placeholder="rank"></div>`).join("")}<div class="acts"><button class="btn pri" type="submit">Save ranks</button></div></form>`
		: `<p class="empty">No team plans to rank</p>`;
	const override = data.leader && data.plans.length
		? `<h2>Override<small>leader: this order wins over the ranks</small></h2><div class="card"><form method="post" action="/override">${data.plans.map((p, i) => `<div class="mrow"><span>${esc(p.title)}</span><input name="pos:${esc(p.id)}" inputmode="numeric" size="4" value="${i + 1}"></div>`).join("")}<div class="acts"><button class="btn pri" type="submit">Save override</button></div></form></div>`
		: "";
	const members = data.members.map(m => {
		const remove = data.admin && m !== data.adminLogin ? `<form method="post" action="/member"><input type="hidden" name="op" value="remove"><input type="hidden" name="login" value="${esc(m)}"><button class="btn" type="submit">Remove</button></form>` : "";
		return `<div class="tile"><span>${esc(m)}</span>${remove}</div>`;
	}).join("");
	const addMember = data.admin ? `<form class="msgform" method="post" action="/member"><input type="hidden" name="op" value="add"><input name="login" required placeholder="login"><div class="acts"><button class="btn pri" type="submit">Add member</button></div></form>` : "";
	const audit = data.audit === null ? "" : `<h2>Audit<small>newest 20</small></h2><div class="card">${data.audit.slice(0, 20).map(a => `<div class="mrow"><span>${esc(a.at)} ${esc(a.login)}</span><span class="mono">${esc(a.route)}</span></div>`).join("") || `<p class="empty">No audit rows</p>`}</div>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>neurastream · team ${esc(data.team)}</title>
<link rel="icon" href="${FAVICON}">
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="top"><span class="logo">ns</span><span class="sub">Team ${esc(data.team)} · ${esc(data.login)}</span></div>
<main>
<h2>Queue<small>team order</small></h2>
<div class="card">${data.section.rows.length ? queueHtml(data.section.rows, "now", false) : `<p class="empty">No team plans</p>`}</div>
<h2>Rank<small>your order for the team</small></h2>
<div class="card">${ranking}</div>
${override}
<h2>Waiting</h2>
<div class="card">${waiting}</div>
<h2>Approve</h2>
<div class="card">${approve}</div>
<h2>Members</h2>
<div class="card">${members}${addMember}</div>
${audit}
</main>
</body>
</html>
`;
}
