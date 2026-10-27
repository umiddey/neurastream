// Page notes (plan 20261026_0930 P6): `pages publish` injects one style block, one panel and one
// script into an HTML artifact, so the owner can select or right-click a passage he is reading and
// leave a note about that quote. "Submit all" posts them to the pages server, which appends one
// owner-inbox row per note — the file Main already delivers as a user message. The page never
// changes itself: notes are outbound only, and nothing on it is editable.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** The artifact with the notes block injected once, before `</body>` when there is one. */
export function injectPageNotes(html: string): string {
	if (html.includes(NOTES_MARK)) return html;
	const block = `${STYLE}\n${PANEL}\n${SCRIPT}`;
	const at = html.toLowerCase().lastIndexOf("</body>");
	if (at < 0) return `${html}\n${block}\n`;
	return `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

function str(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** How many notes the inbox already holds for this page, so the next ids continue the count. */
function notesOnPage(inbox: string, page: string): number {
	let text = "";
	try {
		text = readFileSync(inbox, "utf8");
	} catch {
		return 0;
	}
	let n = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line) as Record<string, unknown>;
			if (rec.kind === "page-note" && rec.page === page) n++;
		} catch {}
	}
	return n;
}

/**
 * One inbox row per submitted note (`kind: "page-note"`, stable id n1, n2, … per page) and the
 * number stored; null when the submit carries no note text at all.
 */
export function appendPageNotes(body: unknown, inbox: string, login: string, now = Math.floor(Date.now() / 1000)): number | null {
	const rec = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const page = str(rec.page, 500);
	const url = str(rec.url, 1000);
	const rows: { quote: string; note: string }[] = [];
	for (const item of Array.isArray(rec.notes) ? rec.notes : []) {
		const one = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		const note = str(one.note, 4000);
		if (note) rows.push({ quote: str(one.quote, 2000), note });
	}
	if (rows.length === 0) return null;
	let id = notesOnPage(inbox, page);
	mkdirSync(dirname(inbox), { recursive: true });
	const lines = rows.map(row => JSON.stringify({ ts: now, kind: "page-note", id: `n${++id}`, page, url, quote: row.quote, note: row.note, login }));
	appendFileSync(inbox, `${lines.join("\n")}\n`);
	return rows.length;
}
