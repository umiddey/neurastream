import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { Config } from "./config.ts";
import { isLoopback, isTailnet, type UiHttpServer } from "./owner-ui.ts";
import { appendPageNotes, openNoteIds } from "./page-notes.ts";
import { approvePlanFile, planForPage, readPagePlan } from "./plan-approval.ts";
import type { RunSource } from "./adapter.ts";
import type { Tailscale } from "./tailscale.ts";

export interface PagesServer { stop(): void; hostname: string; port: number }
export interface PagesOptions { cfg: Config; tailscale: Tailscale; source: RunSource; hostname?: string; port?: number; peerOf?: (req: Request, server: UiHttpServer) => string; root?: string }
const MIME: Record<string, string> = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".json":"application/json", ".txt":"text/plain; charset=utf-8", ".ico":"image/x-icon", ".woff2":"font/woff2", ".map":"application/json" };
function urlPart(value: string): string { return encodeURI(value).replaceAll("?", "%3F").replaceAll("#", "%23").replaceAll('"', "%22").replaceAll("'", "%27"); }
function plain(body: string, status: number): Response { return new Response(body, { status, headers: { "content-type":"text/plain; charset=utf-8" } }); }
export function startPagesServer(opts: PagesOptions): PagesServer {
 const hostname = opts.hostname ?? opts.tailscale.ip4();
 if (!hostname) throw new Error("pages: tailscale ip -4 did not answer");
 const root = resolve(opts.root ?? opts.cfg.pages.dir);
 const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
 const server = Bun.serve({ hostname, port: opts.port ?? opts.cfg.pages.port, async fetch(req, srv) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return plain("method not allowed", 405);
  const peer = peerOf(req, srv);
  const login = isLoopback(peer) ? null : isTailnet(peer) ? opts.tailscale.whois(peer) : null;
  if (!isLoopback(peer) && (!login || login !== opts.cfg.ui.owner_login)) return plain("forbidden", 403);
  const url = new URL(req.url);
  // The one POST a page may make (plan 20261026 P6): the notes its script collected become owner-inbox
  // rows Main delivers. Same origin only, so another site's tab cannot write to the inbox; nothing here
  // touches the page file, and a submit with no note text is refused.
  if (req.method === "POST") {
   // Approve from the plan's own page (plan 20261026 P9): the click records `Approved: <date> (<page>)`
   // in the plan recorded at publish. Only that plan, only from this page's origin, and never while a
   // note on the page has no answer.
   if (url.pathname === "/_approve") {
    if (req.headers.get("origin") !== `http://${req.headers.get("host")}`) return plain("forbidden: origin is not this page", 403);
    const page = url.searchParams.get("page") ?? "";
    const record = page === "" ? null : readPagePlan(root, page);
    if (record === null) return plain("not found: no plan is published as this page", 404);
    const open = openNoteIds(opts.cfg, page);
    if (open.length > 0) return Response.json({ error: `answer ${open.join(", ")} first` }, { status: 409 });
    const unproven = [...record.missing, ...record.thin];
    if (unproven.length > 0) return Response.json({ error: `the diagram is not complete (${unproven.slice(0, 3).join("; ")})` }, { status: 409 });
    const plan = record.plan;
    if (!existsSync(plan)) return plain("not found: the plan file is gone", 404);
    return Response.json({ approved: approvePlanFile(plan, page) });
   }
   if (url.pathname !== "/_notes") return plain("method not allowed", 405);
   if (req.headers.get("origin") !== `http://${req.headers.get("host")}`) return plain("forbidden: origin is not this page", 403);
   let body: unknown; try { body = await req.json(); } catch { return plain("bad request: not JSON", 400); }
   const stored = appendPageNotes(body, opts.cfg, login ?? "loopback");
   return stored === null ? plain("no notes to submit", 400) : Response.json({ stored });
  }
  // What the Approve bar asks on load: the notes still open on this page. A page with no plan has none.
  if (url.pathname === "/_approve") {
   const page = url.searchParams.get("page") ?? "";
   const record = page === "" ? null : readPagePlan(root, page);
   if (record === null) return plain("not found: no plan is published as this page", 404);
   return Response.json({ open: openNoteIds(opts.cfg, page), problems: [...record.missing, ...record.thin] });
  }
  let name = decodeURI(url.pathname.slice(1));
  if (name.includes("/") || name.includes("\\") || name === ".." || name.startsWith(".")) return plain("not found", 404);
  if (!name) {
   const index = resolve(root, "index.html");
   if (existsSync(index) && lstatSync(index).isFile()) name = "index.html";
   else {
    const files = existsSync(root) ? readdirSync(root, { withFileTypes:true }).filter(e => !e.name.startsWith(".") && e.isFile()).map(e => e.name) : [];
    const body = `<!doctype html><ul>${files.map(f => `<li><a href="/${urlPart(f)}">${f.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}</a></li>`).join("")}</ul>`;
    return new Response(req.method === "HEAD" ? null : body, { headers:{ "content-type":"text/html; charset=utf-8" } });
   }
  }
  const path = resolve(root, name);
  if (basename(path) !== name || !existsSync(path) || !lstatSync(path).isFile()) return plain("not found", 404);
  const type = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
  return new Response(req.method === "HEAD" ? null : readFileSync(path), { headers:{ "content-type":type, ...(type === "application/octet-stream" ? { "content-disposition":`attachment; filename*=UTF-8''${urlPart(name)}` } : {}) } });
 }});
 return { stop: () => server.stop(true), hostname, port: Number(server.port) };
}
