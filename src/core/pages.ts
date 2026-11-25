import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { RunSource } from "./adapter.ts";
import { nowSec } from "./clock.ts";
import type { Config } from "./config.ts";
import { authenticate, hostAllowlist, inboxPath, originIsHost, type UiHttpServer } from "./owner-ui.ts";
import { appendPageNotes, openNoteIds, QUOTE_RELAY_SCRIPT, stripInteractiveChrome } from "./page-notes.ts";
import { approvePlanFile, readPagePlan, type PagePlan } from "./plan-approval.ts";
import type { Tailscale } from "./tailscale.ts";

export interface PagesServer {
	stop(): void;
	hostname: string;
	port: number;
}

export interface PagesOptions {
	cfg: Config;
	tailscale: Tailscale;
	source: RunSource;
	hostname?: string;
	port?: number;
	peerOf?: (req: Request, server: UiHttpServer) => string;
	root?: string;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json",
};

/** Escape HTML special characters for safe interpolation into text or attributes. */
function esc(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** Percent-encode a filename for safe inclusion in URL paths and Content-Disposition headers. */
function urlPart(value: string): string {
	return encodeURI(value)
		.replaceAll("?", "%3F")
		.replaceAll("#", "%23")
		.replaceAll('"', "%22")
		.replaceAll("'", "%27");
}

/** Return a plain-text response with `X-Content-Type-Options: nosniff`. */
function plain(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

/** Return a JSON response with `X-Content-Type-Options: nosniff`. */
function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: { "x-content-type-options": "nosniff" },
	});
}

/**
 * Normalize a page name or path to its canonical filename so viewer-shell token minting and
 * POST verification agree across `/why.html`, `why.html`, `/`, and `index.html`.
 */
export function normalizePageName(raw: string): string {
	const stripped = raw.replace(/^\/+/, "");
	return stripped === "" ? "index.html" : stripped;
}

/** Sign an HMAC-SHA256 action token bound to a specific action and normalized page name. */
function signActionToken(secret: Buffer, action: "approve" | "notes", page: string): string {
	return createHmac("sha256", secret).update(`${action}\0${normalizePageName(page)}`).digest("hex");
}

/** Verify an HMAC-SHA256 action token in constant time for the given action and page name. */
function verifyActionToken(secret: Buffer, action: "approve" | "notes", page: string, token: string | null): boolean {
	if (!token || !/^[0-9a-f]{64}$/i.test(token)) return false;
	const expected = Buffer.from(signActionToken(secret, action, page), "hex");
	const received = Buffer.from(token, "hex");
	return expected.length === received.length && timingSafeEqual(expected, received);
}

type ResolvedStatic =
	| { ok: true; name: string; path: string }
	| { ok: false; status: 400 | 404; message: string };

/**
 * Safely decode and resolve a flat filename under `root`.
 * Catches malformed percent-encoding (400) and rejects traversal, hidden files, and symlinks (404).
 */
function resolveStaticFile(root: string, rawSegment: string): ResolvedStatic {
	let name: string;
	try {
		name = decodeURI(rawSegment);
	} catch {
		return { ok: false, status: 400, message: "bad request" };
	}
	if (!name || name.includes("/") || name.includes("\\") || name === ".." || name.startsWith(".") || name.includes("\0")) {
		return { ok: false, status: 404, message: "not found" };
	}
	const path = resolve(root, name);
	if (basename(path) !== name || !existsSync(path) || !lstatSync(path).isFile()) {
		return { ok: false, status: 404, message: "not found" };
	}
	return { ok: true, name, path };
}

/** Insert a block just before the final `</body>` tag, or append it if no closing body tag exists. */
function appendBeforeBodyClose(html: string, block: string): string {
	const at = html.toLowerCase().lastIndexOf("</body>");
	return at < 0 ? `${html}\n${block}\n` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

// Static viewer-shell client script: reads page name and action tokens from DOM data attributes
// so zero untrusted input is ever interpolated into JavaScript source.
const VIEWER_SHELL_SCRIPT = `(function(){
 var frame=document.getElementById("ns-frame");
 var panel=document.getElementById("ns-notes");
 var list=document.getElementById("ns-list");
 var fab=document.getElementById("ns-note-fab");
 var status=document.getElementById("ns-status");
 var addBtn=document.getElementById("ns-add");
 var pageName=panel?panel.dataset.nsPage||"":"";
 var notesToken=panel?panel.dataset.nsToken||"":"";
 var notes=[];
 function paint(){
  list.textContent="";
  notes.forEach(function(n,at){
   var row=document.createElement("div");row.className="ns-row";
   if(n.quote){var q=document.createElement("p");q.className="ns-quote";q.textContent="\\u201c"+n.quote+"\\u201d";row.appendChild(q);}
   var ta=document.createElement("textarea");ta.value=n.note;ta.placeholder="What about this passage?";
   ta.addEventListener("input",function(){notes[at].note=ta.value;notes[at].relayed=false;});
   var del=document.createElement("button");del.className="ns-quiet";del.type="button";del.textContent="Remove";
   del.addEventListener("click",function(){notes.splice(at,1);paint();});
   row.appendChild(ta);row.appendChild(del);list.appendChild(row);
  });
  panel.hidden=notes.length===0;
 }
 function addRow(quote,relayed){
  if(relayed){
   for(var i=notes.length-1;i>=0;i--){
    if(notes[i].relayed&&notes[i].note===""){notes[i].quote=quote;paint();return;}
   }
  }
  notes.push({quote:quote,note:"",relayed:Boolean(relayed)});
  paint();
  var boxes=list.querySelectorAll("textarea");
  if(boxes.length)boxes[boxes.length-1].focus();
 }
 window.addEventListener("message",function(ev){
  if(!frame||ev.source!==frame.contentWindow||ev.origin!=="null")return;
  var d=ev.data;
  if(!d||typeof d!=="object"||d.type!=="ns-quote"||typeof d.quote!=="string")return;
  var q=d.quote.replace(/\\s+/g," ").trim().slice(0,600);
  if(!q)return;
  addRow(q,true);
 });
 if(fab)fab.addEventListener("click",function(){addRow("",false);});
 if(addBtn)addBtn.addEventListener("click",function(){addRow("",false);});
 var hideBtn=document.getElementById("ns-hide");
 if(hideBtn)hideBtn.addEventListener("click",function(){panel.hidden=true;});
 var submitBtn=document.getElementById("ns-submit");
 if(submitBtn)submitBtn.addEventListener("click",function(){
  var keep=notes.filter(function(n){return n.note.trim()!=="";}).map(function(n){return {quote:n.quote,note:n.note};});
  if(keep.length===0){status.textContent="write a note first";return;}
  status.textContent="sending\\u2026";
  fetch("/_notes",{method:"POST",headers:{"content-type":"application/json","x-ns-token":notesToken},body:JSON.stringify({page:"/"+pageName,url:location.href,notes:keep})})
   .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
   .then(function(j){notes=[];paint();status.textContent="sent "+j.stored+" note(s)";})
   .catch(function(){status.textContent="not sent \\u2014 try again";});
 });
 var approveSec=document.getElementById("ns-approve");
 if(approveSec){
  var approvePage=approveSec.dataset.nsPlan||"";
  var approveToken=approveSec.dataset.nsToken||"";
  var btn=document.getElementById("ns-approve-btn");
  var astatus=document.getElementById("ns-approve-status");
  function setApprove(open,problems){
   var bad=problems||[];
   btn.disabled=open.length>0||bad.length>0;
   astatus.textContent=open.length>0?"Answer every note first ("+open.join(", ")+")":bad.length>0?"The diagram is not complete yet ("+bad.length+"): "+bad.slice(0,3).join("; "):"Approve and go \\u2014 the plan records it.";
  }
  fetch("/_approve?page="+encodeURIComponent(approvePage))
   .then(function(r){return r.json();})
   .then(function(d){setApprove(d.open||[],d.problems);})
   .catch(function(){setApprove(["?"],[]);});
  btn.addEventListener("click",function(){
   btn.disabled=true;
   fetch("/_approve?page="+encodeURIComponent(approvePage),{method:"POST",headers:{"content-type":"application/json","x-ns-token":approveToken},body:"{}"})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,body:d};});})
    .then(function(res){astatus.textContent=res.ok?res.body.approved:"Not approved: "+res.body.error;btn.disabled=!res.ok;})
    .catch(function(){astatus.textContent="Not approved: the pages server did not answer.";btn.disabled=false;});
  });
 }
})();`;

const VIEWER_SHELL_STYLE = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#f6f7f9}
#ns-frame{position:fixed;inset:0;width:100%;height:100%;border:0}
#ns-notes{position:fixed;inset-block-end:0;inset-inline-end:0;z-index:2147483000;width:min(420px,100vw);max-height:60vh;overflow:auto;font:13px/1.4 system-ui,sans-serif;background:#111c;color:#fff;backdrop-filter:blur(6px);border-start-start-radius:10px;padding:10px;box-sizing:border-box}
#ns-notes h2{margin:0 0 6px;font-size:13px;font-weight:600;opacity:.8}
#ns-notes .ns-row{border-top:1px solid #fff3;padding:6px 0}
#ns-notes .ns-quote{margin:0 0 4px;opacity:.75;font-style:italic;word-break:break-word}
#ns-notes textarea{width:100%;box-sizing:border-box;min-height:38px;font:inherit;color:#000;border-radius:6px;border:0;padding:6px}
#ns-notes .ns-actions{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
#ns-notes button{font:inherit;border:0;border-radius:6px;padding:6px 10px;background:#3b82f6;color:#fff}
#ns-notes button.ns-quiet{background:#fff2;color:#fff}
#ns-notes .ns-status{opacity:.8}
#ns-note-fab{position:fixed;inset-block-end:12px;inset-inline-end:12px;z-index:2147482999;font:12px system-ui,sans-serif;border:0;border-radius:6px;padding:6px 10px;background:#3b82f6;color:#fff}
#ns-approve{position:fixed;inset-block-start:0;inset-inline-end:0;z-index:2147483000;display:flex;gap:8px;align-items:center;padding:8px 10px;font:13px/1.4 system-ui,sans-serif;background:#111c;color:#fff;backdrop-filter:blur(6px);border-end-start-radius:8px}
#ns-approve button{font:inherit;border:0;border-radius:6px;padding:6px 12px;background:#16a34a;color:#fff}
#ns-approve button[disabled]{background:#fff3;color:#fff9}`;

/** Render the trusted outer viewer shell that iframes `/_raw/<name>` in an opaque sandbox. */
function renderViewerShell(opts: {
	name: string;
	nonce: string;
	notesToken: string;
	approveToken: string | null;
	planRecord: PagePlan | null;
	openNotes: string[];
}): string {
	const { name, nonce, notesToken, approveToken, planRecord, openNotes } = opts;
	const safeName = esc(name);
	let approveHtml = "";
	if (planRecord !== null && approveToken !== null) {
		const problems = [...planRecord.missing, ...planRecord.thin];
		const hint =
			openNotes.length > 0
				? `Answer every note first (${esc(openNotes.join(", "))})`
				: problems.length > 0
					? `The diagram is not complete yet (${problems.length}): ${esc(problems.slice(0, 3).join("; "))}`
					: "Approve and go";
		const disabled = openNotes.length === 0 && problems.length === 0 ? "" : " disabled";
		approveHtml = `<section id="ns-approve" data-ns-plan="${safeName}" data-ns-token="${approveToken}">
 <button id="ns-approve-btn" type="button"${disabled}>Approve</button><span id="ns-approve-status" class="ns-status">${hint}</span>
</section>`;
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title>
<style>${VIEWER_SHELL_STYLE}</style>
</head>
<body>
<iframe id="ns-frame" sandbox="allow-scripts" title="${safeName}" src="/_raw/${esc(urlPart(name))}"></iframe>
${approveHtml}
<section id="ns-notes" data-ns-page="${safeName}" data-ns-token="${notesToken}" hidden>
 <h2>Notes on this page</h2>
 <div id="ns-list"></div>
 <div class="ns-actions"><button id="ns-add" class="ns-quiet" type="button">Add note</button><button id="ns-submit" type="button">Submit all</button><button id="ns-hide" class="ns-quiet" type="button">Hide</button><span id="ns-status" class="ns-status"></span></div>
</section>
<button id="ns-note-fab" type="button">Add note</button>
<script nonce="${nonce}">${VIEWER_SHELL_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Start the pages HTTP server over Tailscale with owner authentication, DNS-rebinding Host
 * validation, HMAC-SHA256 action tokens, sandboxed raw HTML/SVG isolation, and a trusted
 * viewer shell for Approve and Notes actions.
 */
export function startPagesServer(opts: PagesOptions): PagesServer {
	const hostname = opts.hostname ?? opts.tailscale.ip4();
	if (!hostname) throw new Error("pages: tailscale ip -4 did not answer");
	const root = resolve(opts.root ?? opts.cfg.pages.dir);
	const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
	const hostAllowed = hostAllowlist(opts.tailscale, { allowLoopback: opts.cfg.workspace.allow_this_machine });
	const secret = randomBytes(32);

	const server = Bun.serve({
		hostname,
		port: opts.port ?? opts.cfg.pages.port,
		async fetch(req, srv) {
			const hostHeader = req.headers.get("host") ?? "";
			if (!hostAllowed(hostHeader, srv.port)) return plain("forbidden: host is not this page", 403);

			const auth = authenticate(opts.cfg, opts.tailscale, peerOf(req, srv));
			if (!auth.ok) return plain("forbidden", 403);

			if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
				return plain("method not allowed", 405);
			}

			const url = new URL(req.url);

			// Privileged write routes: require same-origin AND a valid per-page HMAC-SHA256 action token.
			if (req.method === "POST") {
				if (url.pathname === "/_approve") {
					if (!originIsHost(req.headers.get("origin"), hostHeader)) {
						return plain("forbidden: origin is not this page", 403);
					}
					const rawPage = url.searchParams.get("page") ?? "";
					const page = rawPage === "" ? "" : normalizePageName(rawPage);
					if (page === "" || !verifyActionToken(secret, "approve", page, req.headers.get("x-ns-token"))) {
						return plain("forbidden: invalid action token", 403);
					}
					const record = readPagePlan(root, page);
					if (record === null) return plain("not found: no plan is published as this page", 404);
					const open = openNoteIds(opts.cfg, page);
					if (open.length > 0) return json({ error: `answer ${open.join(", ")} first` }, 409);
					const unproven = [...record.missing, ...record.thin];
					if (unproven.length > 0) {
						return json({ error: `the diagram is not complete (${unproven.slice(0, 3).join("; ")})` }, 409);
					}
					const plan = record.plan;
					if (!existsSync(plan)) return plain("not found: the plan file is gone", 404);
					try {
						const approved = approvePlanFile(plan, page, opts.cfg.paths);
						// P5 (plan 20261031_0917): the tap must reach Main at once — one owner-inbox row, the same
						// direct append the message POST uses; never a page note, which would 409 the next tap.
						mkdirSync(opts.cfg.paths.queue_state, { recursive: true });
						appendFileSync(
							inboxPath(opts.cfg.paths),
							`${JSON.stringify({ ts: nowSec(), kind: "approval", page, plan, login: auth.login })}\n`,
						);
						return json({ approved });
					} catch (e) {
						return plain(`not approved: ${e instanceof Error ? e.message : String(e)}`, 500);
					}
				}

				if (url.pathname === "/_notes") {
					if (!originIsHost(req.headers.get("origin"), hostHeader)) {
						return plain("forbidden: origin is not this page", 403);
					}
					let body: unknown;
					try {
						body = await req.json();
					} catch {
						return plain("bad request: not JSON", 400);
					}
					const bodyPage =
						body !== null && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).page === "string"
							? ((body as Record<string, unknown>).page as string)
							: "";
					if (!verifyActionToken(secret, "notes", bodyPage, req.headers.get("x-ns-token"))) {
						return plain("forbidden: invalid action token", 403);
					}
					const stored = appendPageNotes(body, opts.cfg, auth.login);
					return stored === null ? plain("no notes to submit", 400) : json({ stored });
				}

				return plain("method not allowed", 405);
			}

			// What the Approve bar asks on load: the notes still open on this page. A page with no plan has none.
			if (url.pathname === "/_approve") {
				const rawPage = url.searchParams.get("page") ?? "";
				const page = rawPage === "" ? "" : normalizePageName(rawPage);
				const record = page === "" ? null : readPagePlan(root, page);
				if (record === null) return plain("not found: no plan is published as this page", 404);
				return json({ open: openNoteIds(opts.cfg, page), problems: [...record.missing, ...record.thin] });
			}

			// Sandboxed raw HTML content served into the viewer shell's opaque-origin iframe.
			if (url.pathname.startsWith("/_raw/")) {
				const resolved = resolveStaticFile(root, url.pathname.slice("/_raw/".length));
				if (!resolved.ok) return plain(resolved.message, resolved.status);
				if (extname(resolved.name).toLowerCase() !== ".html") return plain("not found", 404);
				const headers = {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": "sandbox allow-scripts",
					"x-content-type-options": "nosniff",
				};
				if (req.method === "HEAD") return new Response(null, { headers });
				const rawHtml = readFileSync(resolved.path, "utf8");
				const body = appendBeforeBodyClose(stripInteractiveChrome(rawHtml), QUOTE_RELAY_SCRIPT);
				return new Response(body, { headers });
			}

			// Root path: serve index.html via the trusted viewer shell if present, else a file index.
			let resolved: ResolvedStatic;
			if (url.pathname === "/") {
				const indexPath = resolve(root, "index.html");
				if (existsSync(indexPath) && lstatSync(indexPath).isFile()) {
					resolved = { ok: true, name: "index.html", path: indexPath };
				} else {
					const files = existsSync(root)
						? readdirSync(root, { withFileTypes: true })
								.filter(e => !e.name.startsWith(".") && e.isFile())
								.map(e => e.name)
						: [];
					const body = `<!doctype html><ul>${files.map(f => `<li><a href="/${esc(urlPart(f))}">${esc(f)}</a></li>`).join("")}</ul>`;
					return new Response(req.method === "HEAD" ? null : body, {
						headers: {
							"content-type": "text/html; charset=utf-8",
							"content-security-policy": "default-src 'none'; base-uri 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
							"x-content-type-options": "nosniff",
						},
					});
				}
			} else {
				resolved = resolveStaticFile(root, url.pathname.slice(1));
				if (!resolved.ok) return plain(resolved.message, resolved.status);
			}

			const ext = extname(resolved.name).toLowerCase();
			if (ext === ".html") {
				const nonce = randomBytes(16).toString("base64");
				const planRecord = readPagePlan(root, resolved.name);
				const notesToken = signActionToken(secret, "notes", resolved.name);
				const approveToken = planRecord === null ? null : signActionToken(secret, "approve", resolved.name);
				const headers = {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": `default-src 'none'; base-uri 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
					"x-content-type-options": "nosniff",
				};
				if (req.method === "HEAD") return new Response(null, { headers });
				const body = renderViewerShell({
					name: resolved.name,
					nonce,
					notesToken,
					approveToken,
					planRecord,
					openNotes: planRecord === null ? [] : openNoteIds(opts.cfg, resolved.name),
				});
				return new Response(body, { headers });
			}

			const type = MIME[ext] ?? "application/octet-stream";
			const headers: Record<string, string> = {
				"content-type": type,
				"x-content-type-options": "nosniff",
			};
			if (type === "image/svg+xml") {
				headers["content-security-policy"] = "sandbox";
			}
			if (type === "application/octet-stream") {
				headers["content-disposition"] = `attachment; filename*=UTF-8''${urlPart(resolved.name)}`;
			}
			return new Response(req.method === "HEAD" ? null : readFileSync(resolved.path), { headers });
		},
	});

	return { stop: () => server.stop(true), hostname, port: Number(server.port) };
}
