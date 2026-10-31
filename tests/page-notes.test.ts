// Page notes (plan 20261026_0930 P6): publish injects the block once, the page's "Submit all" posts
// to the pages server, and each note becomes one owner-inbox row carrying page, quote and note.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { appendPageNotes, injectPageNotes, NOTES_MARK } from "../src/core/page-notes.ts";
import { publishPage } from "../src/core/pages-setup.ts";
import { startPagesServer } from "../src/core/pages.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const servers: { stop(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.QUEUE_STATE;
});

function marks(html: string): number {
	return html.split(NOTES_MARK).length - 1;
}

test("inject: one style, one panel and one script, before </body>, and never twice", () => {
	const page = "<!doctype html><html><body><h1>diagram</h1></body></html>";
	const once = injectPageNotes(page);
	expect(marks(once)).toBe(3); // style, panel, script
	expect(once).toContain("<h1>diagram</h1>");
	expect(once.indexOf(NOTES_MARK)).toBeLessThan(once.lastIndexOf("</body>"));
	expect(injectPageNotes(once)).toBe(once);
	const bare = injectPageNotes("<h1>no body tag</h1>");
	expect(bare.startsWith("<h1>no body tag</h1>")).toBe(true);
	expect(marks(bare)).toBe(3);
});

test("publish: every HTML artifact carries the block; a republish of the same source needs no --force", () => {
	const dir = mkdtempSync(join(tmpdir(), "page-notes-pub-"));
	dirs.push(dir);
	const src = join(dir, "source.html");
	const out = join(dir, "public");
	writeFileSync(src, '<!doctype html><html><body><p>why</p></body></html>');
	expect(publishPage(src, "Why", false, out)).toBe("why.html");
	const published = readFileSync(join(out, "why.html"), "utf8");
	expect(marks(published)).toBe(3);
	expect(published).toContain("<p>why</p>");
	expect(publishPage(src, "Why", false, out)).toBe("why.html"); // injected content equals: no collision
	const txt = join(dir, "notes.txt");
	writeFileSync(txt, "plain");
	expect(publishPage(txt, undefined, false, out)).toBe("notes.txt");
	expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("plain"); // only HTML gets the block
});

test("inbox: ids run n1, n2, … per page and an empty submit stores nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "page-notes-inbox-"));
	dirs.push(dir);
	const inbox = join(dir, "owner-inbox.jsonl");
	const cfg = loadConfig({ file: join(dir, "missing.yml"), home: dir, env: {} });
	cfg.paths.queue_state = dir;
	expect(appendPageNotes({ page: "/a.html", notes: [] }, cfg, "owner@example.test")).toBeNull();
	expect(appendPageNotes({ page: "/a.html", notes: [{ quote: "q", note: "   " }] }, cfg, "owner@example.test")).toBeNull();
	expect(existsSync(inbox)).toBe(false);
	expect(appendPageNotes({ page: "/a.html", url: "http://x/a.html", notes: [{ quote: "too slow", note: "fix the timing" }] }, cfg, "owner@example.test", 1_700_000_000)).toBe(1);
	expect(appendPageNotes({ page: "/a.html", notes: [{ quote: "b", note: "second" }] }, cfg, "owner@example.test", 1_700_000_060)).toBe(1);
	expect(appendPageNotes({ page: "/b.html", notes: [{ quote: "c", note: "other page" }] }, cfg, "owner@example.test", 1_700_000_120)).toBe(1);
	const rows = readFileSync(inbox, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
	expect(rows.map(r => r.id)).toEqual(["n1", "n2", "n1"]);
	expect(rows[0]).toMatchObject({ kind: "page-note", page: "/a.html", quote: "too slow", note: "fix the timing", url: "http://x/a.html", login: "owner@example.test" });
});

// Phone long-press fires selectionchange but never mouseup/contextmenu, so the fab must show on
// selectionchange too — and both triggers share ONE position, under the selection, so it never
// jumps (the phone's copy menu sits above it). The injected script is driven with a stub DOM.
test("phone: selectionchange shows the fab under the selection, mouseup the same spot, cleared hides it", () => {
	const m = new RegExp(`<script ${NOTES_MARK}>([\\s\\S]*?)<\\/script>`).exec(injectPageNotes("<!doctype html><html><body><p>diagram</p></body></html>"));
	if (m === null) throw new Error("no page-notes script in the injected page");
	const rect = { left: 30, top: 60, right: 260, bottom: 84 };
	const sel = { toString: () => "the diagram", getRangeAt: () => ({ getBoundingClientRect: () => rect }) };
	let cleared = false;
	const listeners: Record<string, ((e?: unknown) => void)[]> = {};
	const spare = { style: {}, dataset: {}, contains: () => false, addEventListener() {}, textContent: "", hidden: false };
	const panel = { style: {}, dataset: {}, contains: () => false, addEventListener() {}, textContent: "", hidden: false };
	const fab = { style: {} as Record<string, string>, dataset: {} as Record<string, string>, contains: () => false, addEventListener() {}, textContent: "", hidden: false };
	const document = {
		addEventListener: (type: string, fn: (e?: unknown) => void) => {
			(listeners[type] ??= []).push(fn);
		},
		getElementById: (id: string) => (id === "ns-notes" ? panel : id === "ns-note-fab" ? fab : spare),
	};
	const window = { getSelection: () => (cleared ? { toString: () => "" } : sel), innerWidth: 900 };
	new Function("document", "window", m[1]!)(document, window);
	listeners.selectionchange![0]!(); // long-press: selection exists, no mouse events ever fire
	expect(fab.style.display).toBe("block");
	expect(fab.dataset.quote).toBe("the diagram");
	expect(parseInt(fab.style.top!, 10)).toBeGreaterThanOrEqual(rect.bottom); // under the selection
	const left = fab.style.left;
	const top = fab.style.top;
	listeners.mouseup![0]!({ target: {} }); // desktop drag: the same spot, the button never jumps
	expect(fab.style.left).toBe(left);
	expect(fab.style.top).toBe(top);
	cleared = true;
	listeners.selectionchange![0]!(); // selection gone: the fab goes with it
	expect(fab.style.display).toBe("none");
});

test("pages server: POST /_notes stores quote, note and url; empty submit and a foreign origin are refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "page-notes-serve-"));
	const state = mkdtempSync(join(tmpdir(), "page-notes-state-"));
	dirs.push(root, state);
	process.env.QUEUE_STATE = state;
	writeFileSync(join(root, "why.html"), injectPageNotes("<html><body><p>diagram</p></body></html>"));
	const cfg = loadConfig({ file: join(root, "missing.yml"), home: root, env: {} });
	cfg.paths.queue_state = state;
	cfg.pages.enabled = true;
	cfg.pages.dir = root;
	cfg.pages.port = 0;
	cfg.ui.owner_login = "owner@example.test";
	const tailscale = { ip4: () => "", dnsName: () => null, whois: () => "owner@example.test", logins: () => [] };
	const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: LOOPBACK, port: 0, root, peerOf: () => LOOPBACK });
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;
	const served = await (await fetch(`${base}/why.html`)).text();
	expect(marks(served)).toBe(3);
	const body = { page: "/why.html", url: `${base}/why.html`, notes: [{ quote: "diagram", note: "label the boxes" }] };
	let res = await fetch(`${base}/_notes`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ stored: 1 });
	const inbox = join(state, "owner-inbox.jsonl");
	const row = JSON.parse(readFileSync(inbox, "utf8").trim()) as Record<string, unknown>;
	expect(row).toMatchObject({ kind: "page-note", id: "n1", page: "/why.html", quote: "diagram", note: "label the boxes", url: `${base}/why.html` });
	res = await fetch(`${base}/_notes`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ page: "/why.html", notes: [] }) });
	expect(res.status).toBe(400);
	expect(await res.text()).toContain("no notes to submit");
	res = await fetch(`${base}/_notes`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(body) });
	expect(res.status).toBe(403);
	res = await fetch(`${base}/other`, { method: "POST", headers: { origin: base }, body: "{}" });
	expect(res.status).toBe(405);
	expect((await fetch(`${base}/why.html`, { method: "PUT" })).status).toBe(405);
	expect(readFileSync(inbox, "utf8").trim().split("\n").length).toBe(1); // nothing else was stored
});
