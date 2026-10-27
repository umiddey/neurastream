// Page notes (plan 20261026_0930 P6): `pages publish` injects one style block, one panel and one
// script into an HTML artifact, so the owner can select or right-click a passage he is reading and
// leave a note about that quote. "Submit all" posts them to the pages server, which appends one
// owner-inbox row per note — the file Main already delivers as a user message. The page never
// changes itself: notes are outbound only, and nothing on it is editable.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { expandHome } from "./queue/lib.ts";

/** Marks the injected block, so a second publish (or a page that already carries one) stays single. */
export const NOTES_MARK = "data-ns-page-notes";

const STYLE = `<style ${NOTES_MARK}>
 #ns-notes{position:fixed;inset-block-end:0;inset-inline-end:0;z-index:2147483000;width:min(420px,100vw);max-height:60vh;overflow:auto;font:13px/1.4 system-ui,sans-serif;background:#111c;color:#fff;backdrop-filter:blur(6px);border-start-start-radius:10px;padding:10px;box-sizing:border-box}
 #ns-notes h2{margin:0 0 6px;font-size:13px;font-weight:600;opacity:.8}
 #ns-notes .ns-row{border-top:1px solid #fff3;padding:6px 0}
 #ns-notes .ns-quote{margin:0 0 4px;opacity:.75;font-style:italic;word-break:break-word}
 #ns-notes textarea{width:100%;box-sizing:border-box;min-height:38px;font:inherit;color:#000;border-radius:6px;border:0;padding:6px}
 #ns-notes .ns-actions{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
 #ns-notes button{font:inherit;border:0;border-radius:6px;padding:6px 10px;background:#3b82f6;color:#fff}
 #ns-notes button.ns-quiet{background:#fff2;color:#fff}
 #ns-notes .ns-status{opacity:.8}
 #ns-note-fab{position:fixed;z-index:2147483000;font:12px system-ui,sans-serif;border:0;border-radius:6px;padding:6px 10px;background:#3b82f6;color:#fff;display:none}
 #ns-approve{position:fixed;inset-block-start:0;inset-inline-end:0;z-index:2147483000;display:flex;gap:8px;align-items:center;padding:8px 10px;font:13px/1.4 system-ui,sans-serif;background:#111c;color:#fff;backdrop-filter:blur(6px);border-end-start-radius:8px}
 #ns-approve button{font:inherit;border:0;border-radius:6px;padding:6px 12px;background:#16a34a;color:#fff}
 #ns-approve button[disabled]{background:#fff3;color:#fff9}
</style>`;

const PANEL = `<section id="ns-notes" ${NOTES_MARK} hidden>
 <h2>Notes on this page</h2>
 <div id="ns-list"></div>
 <div class="ns-actions"><button id="ns-submit" type="button">Submit all</button><button id="ns-hide" class="ns-quiet" type="button">Hide</button><span id="ns-status" class="ns-status"></span></div>
</section>
<button id="ns-note-fab" type="button">Add note</button>`;

// No backticks or interpolation in here: the block is injected verbatim into the artifact.
const SCRIPT = `<script ${NOTES_MARK}>(function(){
 var panel=document.getElementById("ns-notes"),list=document.getElementById("ns-list"),fab=document.getElementById("ns-note-fab"),status=document.getElementById("ns-status");
 var notes=[];
 function quote(){var s=window.getSelection();return s?s.toString().replace(/\\s+/g," ").trim().slice(0,600):"";}
 function paint(){
  list.textContent="";
  notes.forEach(function(n,at){
   var row=document.createElement("div");row.className="ns-row";
   var q=document.createElement("p");q.className="ns-quote";q.textContent="\\u201c"+n.quote+"\\u201d";
   var ta=document.createElement("textarea");ta.value=n.note;ta.placeholder="What about this passage?";
   ta.addEventListener("input",function(){notes[at].note=ta.value;});
   var del=document.createElement("button");del.className="ns-quiet";del.type="button";del.textContent="Remove";
   del.addEventListener("click",function(){notes.splice(at,1);paint();});
   row.appendChild(q);row.appendChild(ta);row.appendChild(del);list.appendChild(row);
  });
  panel.hidden=notes.length===0;
 }
 function add(text){notes.push({quote:text,note:""});paint();var boxes=list.querySelectorAll("textarea");if(boxes.length)boxes[boxes.length-1].focus();}
 document.addEventListener("mouseup",function(e){
  if(panel.contains(e.target))return;
  var text=quote();
  if(!text){fab.style.display="none";return;}
  var r=window.getSelection().getRangeAt(0).getBoundingClientRect();
  fab.style.left=Math.max(8,Math.min(window.innerWidth-100,r.left))+"px";
  fab.style.top=Math.max(8,r.top-38)+"px";
  fab.style.display="block";fab.dataset.quote=text;
 });
 fab.addEventListener("click",function(){fab.style.display="none";add(fab.dataset.quote||"");});
 document.addEventListener("contextmenu",function(e){
  var text=quote();
  if(!text||panel.contains(e.target))return;
  e.preventDefault();add(text);
 });
 document.getElementById("ns-hide").addEventListener("click",function(){panel.hidden=true;});
 document.getElementById("ns-submit").addEventListener("click",function(){
  var keep=notes.filter(function(n){return n.note.trim()!=="";});
  if(keep.length===0){status.textContent="write a note first";return;}
  status.textContent="sending\\u2026";
  fetch("/_notes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({page:location.pathname,url:location.href,notes:keep})})
   .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
   .then(function(j){notes=[];paint();status.textContent="sent "+j.stored+" note(s)";})
   .catch(function(){status.textContent="not sent \\u2014 try again";});
 });
})();</script>`;

/** One closed note with the answer Main gave it: shown on the page next to the quote (P8). */
export interface AnsweredNote {
	id: string;
	quote: string;
	note: string;
	answer: string;
}

const ANSWERED_RE = /<section id="ns-answered"[\s\S]*?<\/section>\n?/i;
const APPROVE_RE = /<section id="ns-approve"[\s\S]*?<\/section>\n?/i;

/** What the Approve bar needs: the page it approves and the notes still open on it (P9). */
export interface ApproveChrome {
	page: string;
	open: string[];
}

/** The Approve bar, on a page published from a plan: the notes panel beside it is the same page. */
function approveBlock(chrome: ApproveChrome): string {
	const page = esc(chrome.page);
	const hint = chrome.open.length === 0 ? "Approve and go" : `Answer every note first (${esc(chrome.open.join(", "))})`;
	const disabled = chrome.open.length === 0 ? "" : " disabled";
	return `<section id="ns-approve" ${NOTES_MARK} data-ns-plan="${page}">
 <button id="ns-approve-btn" type="button"${disabled}>Approve</button><span id="ns-approve-status" class="ns-status">${hint}</span>
 <script>(function(){var page="${page}",btn=document.getElementById("ns-approve-btn"),status=document.getElementById("ns-approve-status");
  function set(open){btn.disabled=open.length>0;status.textContent=open.length>0?"Answer every note first ("+open.join(", ")+")":"Approve and go \u2014 the plan records it.";}
  fetch("/_approve?page="+encodeURIComponent(page)).then(function(r){return r.json();}).then(function(d){set(d.open||[]);}).catch(function(){set(["?"]);});
  btn.addEventListener("click",function(){btn.disabled=true;fetch("/_approve?page="+encodeURIComponent(page),{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){return r.json().then(function(d){return {ok:r.ok,body:d};});}).then(function(res){status.textContent=res.ok?"Approved: "+res.body.approved:"Not approved: "+res.body.error;btn.disabled=!res.ok;}).catch(function(){status.textContent="Not approved: the pages server did not answer.";btn.disabled=false;});});
 })();</script>
</section>`;
}

function esc(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function answeredBlock(notes: AnsweredNote[]): string {
	if (notes.length === 0) return "";
	const rows = notes
		.map(n => `<div class="ns-row"><p class="ns-quote">${esc(n.id)} \u00b7 \u201c${esc(n.quote)}\u201d</p><p class="ns-note">${esc(n.note)}</p><p class="ns-answer"><strong>Answer:</strong> ${esc(n.answer)}</p></div>`)
		.join("");
	return `<section id="ns-answered" ${NOTES_MARK}><h2>Answered notes</h2>${rows}</section>`;
}

/** Append the block before `</body>` when there is one; an unchanged block leaves the html alone. */
function withTail(html: string, block: string): string {
	if (block === "") return html;
	const at = html.toLowerCase().lastIndexOf("</body>");
	return at < 0 ? `${html}\n${block}\n` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

/** Swap a block in place, append it before `</body>` when the page has none, drop it when empty. */
function replaceOrAppend(html: string, re: RegExp, block: string): string {
	const at = re.exec(html);
	if (at === null) return block === "" ? html : withTail(html, block);
	return `${html.slice(0, at.index)}${block === "" ? "" : `${block}\n`}${html.slice(at.index + at[0].length)}`;
}

/**
 * The artifact with the notes block injected once, before `</body>` when there is one. A page that
 * already carries it keeps its style, panel and script and refreshes the answered list and, on a
 * plan page, the Approve bar — a built-thing republish drops a bar that no longer belongs there.
 */
export function injectPageNotes(html: string, answered: AnsweredNote[] = [], approve?: ApproveChrome): string {
	const answers = answeredBlock(answered);
	const bar = approve === undefined ? "" : approveBlock(approve);
	if (html.includes(NOTES_MARK)) return replaceOrAppend(replaceOrAppend(html, APPROVE_RE, bar), ANSWERED_RE, answers);
	return withTail(html, `${STYLE}\n${PANEL}\n${bar === "" ? "" : `${bar}\n`}${answers === "" ? "" : `${answers}\n`}${SCRIPT}`);
}

function str(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function readRows(file: string): Record<string, unknown>[] {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const row = asRecord(JSON.parse(line) as unknown);
		if (row !== null) out.push(row);
	}
	return out;
}

/** A page name as one safe file name: `/why.html` and `why.html` are the same page. */
function pageSlug(page: string): string {
	const clean = page.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return clean === "" ? "index" : clean;
}

function notesDir(cfg: Config): string {
	return join(expandHome(cfg.paths.queue_state), "page-notes");
}

export function notesStorePath(cfg: Config, page: string): string {
	return join(notesDir(cfg), `${pageSlug(page)}.jsonl`);
}

export function notesAnswersPath(cfg: Config, page: string): string {
	return join(notesDir(cfg), `${pageSlug(page)}.answers.json`);
}

export interface PageNote {
	id: string;
	quote: string;
	note: string;
	url: string;
	ts: number;
}

export function readNotes(cfg: Config, page: string): PageNote[] {
	return readRows(notesStorePath(cfg, page)).flatMap(rec => {
		const id = str(rec.id, 40);
		if (id === "") return [];
		return [{ id, quote: str(rec.quote, 2000), note: str(rec.note, 4000), url: str(rec.url, 1000), ts: typeof rec.ts === "number" ? rec.ts : 0 }];
	});
}

/** Main's answer file for the page: one entry per note id. Ids without an entry are open. */
export function readAnswers(cfg: Config, page: string): Record<string, string> {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = asRecord(JSON.parse(readFileSync(notesAnswersPath(cfg, page), "utf8")) as unknown);
	} catch {
		return {};
	}
	const out: Record<string, string> = {};
	if (parsed === null) return out;
	for (const [id, answer] of Object.entries(parsed)) {
		const text = str(answer, 4000);
		if (text !== "") out[id] = text;
	}
	return out;
}

/** The note ids with no answer yet — what `neurastream notes check` exits 1 on. */
export function openNoteIds(cfg: Config, page: string): string[] {
	const answers = readAnswers(cfg, page);
	return readNotes(cfg, page)
		.map(n => n.id)
		.filter(id => answers[id] === undefined);
}

/** The page's notes with the answer beside each, in note order, for the published page. */
export function answeredNotes(cfg: Config, page: string): AnsweredNote[] {
	const answers = readAnswers(cfg, page);
	return readNotes(cfg, page).flatMap(n => {
		const answer = answers[n.id];
		return answer === undefined ? [] : [{ id: n.id, quote: n.quote, note: n.note, answer }];
	});
}

/** Publishing closes the old notes: they are archived and the answer file is spent. */
export function settleNotes(cfg: Config, page: string, now = Math.floor(Date.now() / 1000)): void {
	const store = notesStorePath(cfg, page);
	if (existsSync(store)) renameSync(store, join(notesDir(cfg), `${pageSlug(page)}.${now}.answered.jsonl`));
	try {
		unlinkSync(notesAnswersPath(cfg, page));
	} catch {}
}

/** What `pages publish` needs from the notes: what is open, what to show, and what to close. */
export interface NotesGate {
	open(page: string): string[];
	answered(page: string): AnsweredNote[];
	settle(page: string): void;
}

export function pageNotesGate(cfg: Config): NotesGate {
	return { open: page => openNoteIds(cfg, page), answered: page => answeredNotes(cfg, page), settle: page => settleNotes(cfg, page) };
}

/** The next id for this page; the counter survives the archive, so an id is never reused. */
function nextNoteId(cfg: Config, page: string): number {
	let n = 0;
	try {
		const parsed = Number(readFileSync(join(notesDir(cfg), `${pageSlug(page)}.count`), "utf8").trim());
		if (Number.isInteger(parsed) && parsed >= 0) n = parsed;
	} catch {}
	return n + 1;
}

/**
 * One inbox row per submitted note (`kind: "page-note"`, stable id n1, n2, … per page) and the
 * number stored; null when the submit carries no note text at all. The same rows go to the page's
 * store, which `notes check` and the publish gate read.
 */
export function appendPageNotes(body: unknown, cfg: Config, login: string, now = Math.floor(Date.now() / 1000)): number | null {
	const rec = asRecord(body) ?? {};
	const page = str(rec.page, 500) === "" ? "/" : str(rec.page, 500);
	const url = str(rec.url, 1000);
	const rows: { quote: string; note: string }[] = [];
	for (const item of Array.isArray(rec.notes) ? rec.notes : []) {
		const one = asRecord(item) ?? {};
		const note = str(one.note, 4000);
		if (note) rows.push({ quote: str(one.quote, 2000), note });
	}
	if (rows.length === 0) return null;
	let id = nextNoteId(cfg, page);
	const stored = rows.map(row => ({ ts: now, id: `n${id++}`, page, url, quote: row.quote, note: row.note, login }));
	const inbox = join(expandHome(cfg.paths.queue_state), "owner-inbox.jsonl");
	const store = notesStorePath(cfg, page);
	mkdirSync(dirname(store), { recursive: true });
	appendFileSync(store, `${stored.map(r => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(notesDir(cfg), `${pageSlug(page)}.count`), `${id - 1}\n`);
	appendFileSync(inbox, `${stored.map(r => JSON.stringify({ ...r, kind: "page-note" })).join("\n")}\n`);
	return rows.length;
}
