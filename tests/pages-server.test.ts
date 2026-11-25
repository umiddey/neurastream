import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { reviewHash } from "../src/core/guards.ts";
import { injectPageNotes, notesStorePath, QUOTE_RELAY_SCRIPT } from "../src/core/page-notes.ts";
import { startPagesServer } from "../src/core/pages.ts";
import type { Tailscale } from "../src/core/tailscale.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const SELF_TAILNET = "100.64.0.1";
const OWNER_PEER = "100.64.0.9";
const OWNER = "owner@example.test";

const servers: { stop(): void }[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
});

function makeTailscale(overrides: Partial<Tailscale> = {}): Tailscale {
	return {
		ip4: () => SELF_TAILNET,
		dnsName: () => "box.example.test",
		whois: peer => (peer === OWNER_PEER || peer === SELF_TAILNET ? OWNER : null),
		logins: () => [OWNER],
		state: () => "running",
		...overrides,
	};
}

function makeCfg(root: string, opts: { allowThisMachine?: boolean; state?: string } = {}): Config {
	const cfg = loadConfig();
	cfg.pages.enabled = true;
	cfg.pages.dir = root;
	cfg.pages.port = 0;
	cfg.workspace.owner_login = OWNER;
	cfg.workspace.allow_this_machine = opts.allowThisMachine ?? false;
	if (opts.state) cfg.paths.queue_state = opts.state;
	return cfg;
}

/** Raw HTTP request allowing explicit Host and Origin headers (for DNS-rebinding tests). */
function rawReq(opts: {
	port: number;
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: Record<string, string | string[] | undefined>;
		body: string;
	}>();
	const req = request(
		{
			host: LOOPBACK,
			port: opts.port,
			method: opts.method ?? "GET",
			path: opts.path,
			headers: opts.headers,
		},
		res => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", chunk => {
				data += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		},
	);
	req.on("error", reject);
	if (opts.body !== undefined) req.write(opts.body);
	req.end();
	return promise;
}

function extractToken(html: string, sectionId: "ns-approve" | "ns-notes"): string {
	const match = new RegExp(`id="${sectionId}"[^>]*data-ns-token="([0-9a-f]{64})"`, "i").exec(html);
	return match?.[1] ?? "";
}

test("pages serves contained files and rejects unsafe paths and peers", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-test-"));
	dirs.push(root);
	writeFileSync(join(root, "index.html"), "<h1>ok</h1>");
	writeFileSync(join(root, "x.svg"), "<svg/>");
	writeFileSync(join(root, ".hidden"), "no");
	symlinkSync(join(root, "x.svg"), join(root, "link.svg"));
	const tailscale = makeTailscale({ dnsName: () => null });
	const cfg = makeCfg(root, { allowThisMachine: true });
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;

	let r = await fetch(`${base}/x.svg`);
	expect(r.status).toBe(200);
	expect(r.headers.get("content-type")).toContain("image/svg+xml");
	expect(r.headers.get("content-security-policy")).toBe("sandbox");
	expect(r.headers.get("x-content-type-options")).toBe("nosniff");

	r = await fetch(`${base}/x.svg`, { method: "HEAD" });
	expect(r.status).toBe(200);
	expect(r.headers.get("content-security-policy")).toBe("sandbox");
	expect(r.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await r.text()).toBe("");

	expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
	expect((await fetch(`${base}/%2e%2e%2fetc%2fpasswd`)).status).toBe(404);
	expect((await fetch(`${base}/.hidden`)).status).toBe(404);
	expect((await fetch(`${base}/link.svg`)).status).toBe(404);
});

test("pages denies non-tailnet peer and lists files without an index", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-test-"));
	dirs.push(root);
	writeFileSync(join(root, "diagram.html"), "ok");
	const tailscale = makeTailscale({ dnsName: () => null });
	const cfg = makeCfg(root, { allowThisMachine: true });

	const foreign = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => "8.8.8.8",
	});
	servers.push(foreign);
	expect((await fetch(`http://${LOOPBACK}:${foreign.port}/`)).status).toBe(403);

	const local = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(local);
	const res = await fetch(`http://${LOOPBACK}:${local.port}/`);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	const text = await res.text();
	expect(text).toContain("diagram.html");
	expect(text).not.toContain(root);
});

test("POST /_approve records the plan hash and leaves the plan unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-approve-"));
	dirs.push(root);
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	process.env.QUEUE_STATE = state;
	const cfg = makeCfg(root, { allowThisMachine: true, state });
	const plan = join(root, "20261027_toy.md");
	const original = "# Toy\n\n## Phases\n- [ ] P1 x\n";
	writeFileSync(plan, original);
	writeFileSync(join(root, "toy.html"), "<h1>toy</h1>");
	mkdirSync(join(root, ".meta"), { recursive: true });
	writeFileSync(join(root, ".meta", "toy.html.json"), JSON.stringify({ plan }));
	const tailscale = makeTailscale({ ip4: () => "", dnsName: () => null });
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;

	const shell = await (await fetch(`${base}/toy.html`)).text();
	const token = extractToken(shell, "ns-approve");
	expect(token).not.toBe("");

	const res = await fetch(`${base}/_approve?page=toy.html`, {
		method: "POST",
		headers: { origin: base, "x-ns-token": token },
	});
	expect(res.status).toBe(200);
	expect((await res.json()).approved).toBe("approved toy.html");
	expect(readFileSync(plan, "utf8")).toBe(original); // plan bytes unchanged
	const records = JSON.parse(readFileSync(join(state, "plan-approvals.json"), "utf8")) as { approvals: Record<string, unknown> };
	const rec = records.approvals[plan] as { hash: string; page: string };
	expect(rec.hash).toBe(reviewHash(original));
	expect(rec.page).toBe("toy.html");
});

// P5 (plan 20261031_0917): the approve tap must reach Main at once — exactly one owner-inbox row,
// kind "approval", naming the page and the plan — and must stay out of the page's notes store, so
// the tap opens no note and a second tap is not a 409.
test("POST /_approve writes one approval inbox row and leaves the notes store empty", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-approve-"));
	dirs.push(root);
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	process.env.QUEUE_STATE = state;
	const cfg = makeCfg(root, { allowThisMachine: true, state });
	const plan = join(root, "20261027_toy.md");
	writeFileSync(plan, "# Toy\n\n## Phases\n- [ ] P1 x\n");
	writeFileSync(join(root, "toy.html"), "<h1>toy</h1>");
	mkdirSync(join(root, ".meta"), { recursive: true });
	writeFileSync(join(root, ".meta", "toy.html.json"), JSON.stringify({ plan, missing: [], thin: [] }));
	const tailscale = makeTailscale({ ip4: () => "", dnsName: () => null });
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;

	const shell = await (await fetch(`${base}/toy.html`)).text();
	const token = extractToken(shell, "ns-approve");
	expect(token).not.toBe("");

	const approve = () =>
		fetch(`${base}/_approve?page=toy.html`, {
			method: "POST",
			headers: { origin: base, "x-ns-token": token },
		});
	expect((await approve()).status).toBe(200);
	const lines = existsSync(join(state, "owner-inbox.jsonl")) ? readFileSync(join(state, "owner-inbox.jsonl"), "utf8").split("\n") : [];
	const approvals = lines
		.filter(line => line.trim() !== "")
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(row => row.kind === "approval");
	expect(approvals).toHaveLength(1);
	expect(approvals[0]!.page).toBe("toy.html");
	expect(approvals[0]!.plan).toBe(plan);
	// the tap is not a page note: the store stays empty, so the second tap is not a 409
	expect(existsSync(notesStorePath(cfg, "toy.html"))).toBe(false);
	expect((await approve()).status).toBe(200);
});

test("security: loopback and own tailnet IP peers are rejected with 403 when allow_this_machine is false", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-sec-auth-"));
	dirs.push(root);
	writeFileSync(join(root, "index.html"), "<h1>ok</h1>");
	const tailscale = makeTailscale();
	const cfg = makeCfg(root, { allowThisMachine: false });

	let currentPeer = LOOPBACK;
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => currentPeer,
	});
	servers.push(server);
	const tailnetHost = `${SELF_TAILNET}:${server.port}`;

	// Loopback Host is rejected when allow_this_machine is false.
	expect((await rawReq({ port: server.port, path: "/", headers: { host: `${LOOPBACK}:${server.port}` } })).status).toBe(403);
	// Even with a valid tailnet Host header, loopback peer is rejected.
	expect((await rawReq({ port: server.port, path: "/", headers: { host: tailnetHost } })).status).toBe(403);
	// Own tailnet IP peer (local process curling own tailnet IP) is rejected.
	currentPeer = SELF_TAILNET;
	expect((await rawReq({ port: server.port, path: "/", headers: { host: tailnetHost } })).status).toBe(403);
	// Owner's remote tailnet peer succeeds with valid tailnet or MagicDNS Host.
	currentPeer = OWNER_PEER;
	expect((await rawReq({ port: server.port, path: "/", headers: { host: tailnetHost } })).status).toBe(200);
	expect((await rawReq({ port: server.port, path: "/", headers: { host: `box.example.test:${server.port}` } })).status).toBe(200);
});

test("security: DNS-rebinding Host header is rejected with 403 even with matching Origin", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-sec-host-"));
	dirs.push(root);
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	writeFileSync(join(root, "why.html"), "<h1>why</h1>");
	const tailscale = makeTailscale();
	const cfg = makeCfg(root, { allowThisMachine: false, state });
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => OWNER_PEER,
	});
	servers.push(server);

	const evilHost = `evil.example:${server.port}`;
	const getRes = await rawReq({ port: server.port, path: "/why.html", headers: { host: evilHost } });
	expect(getRes.status).toBe(403);

	const postRes = await rawReq({
		port: server.port,
		method: "POST",
		path: "/_notes",
		headers: {
			host: evilHost,
			origin: `http://${evilHost}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ page: "/why.html", notes: [{ quote: "q", note: "n" }] }),
	});
	expect(postRes.status).toBe(403);
});

test("security: action tokens enforce page binding, action binding, and page-name normalization", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-sec-tok-"));
	dirs.push(root);
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	const cfg = makeCfg(root, { allowThisMachine: true, state });
	const planA = join(root, "plan-a.md");
	const planB = join(root, "plan-b.md");
	writeFileSync(planA, "# A\n\n## Phases\n- [ ] P1 a\n");
	writeFileSync(planB, "# B\n\n## Phases\n- [ ] P1 b\n");
	writeFileSync(join(root, "a.html"), "<h1>A</h1>");
	writeFileSync(join(root, "b.html"), "<h1>B</h1>");
	writeFileSync(join(root, "why.html"), "<h1>Why</h1>");
	writeFileSync(join(root, "index.html"), "<h1>Index</h1>");
	mkdirSync(join(root, ".meta"), { recursive: true });
	writeFileSync(join(root, ".meta", "a.html.json"), JSON.stringify({ plan: planA, missing: [], thin: [] }));
	writeFileSync(join(root, ".meta", "b.html.json"), JSON.stringify({ plan: planB, missing: [], thin: [] }));

	const tailscale = makeTailscale();
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;

	const shellA = await (await fetch(`${base}/a.html`)).text();
	const approveA = extractToken(shellA, "ns-approve");
	const notesA = extractToken(shellA, "ns-notes");
	const shellWhy = await (await fetch(`${base}/why.html`)).text();
	const notesWhy = extractToken(shellWhy, "ns-notes");
	const shellIndex = await (await fetch(`${base}/`)).text();
	const notesIndex = extractToken(shellIndex, "ns-notes");
	expect(approveA).not.toBe("");
	expect(notesA).not.toBe("");
	expect(notesWhy).not.toBe("");
	expect(notesIndex).not.toBe("");
	expect(extractToken(shellWhy, "ns-approve")).toBe(""); // non-plan page mints no approve token

	// Missing token -> 403
	expect((await fetch(`${base}/_approve?page=a.html`, { method: "POST", headers: { origin: base } })).status).toBe(403);
	expect(
		(
			await fetch(`${base}/_notes`, {
				method: "POST",
				headers: { origin: base, "content-type": "application/json" },
				body: JSON.stringify({ page: "/why.html", notes: [{ quote: "q", note: "n" }] }),
			})
		).status,
	).toBe(403);

	// Wrong page token -> 403
	expect(
		(await fetch(`${base}/_approve?page=b.html`, { method: "POST", headers: { origin: base, "x-ns-token": approveA } })).status,
	).toBe(403);
	expect(
		(
			await fetch(`${base}/_notes`, {
				method: "POST",
				headers: { origin: base, "content-type": "application/json", "x-ns-token": notesA },
				body: JSON.stringify({ page: "/why.html", notes: [{ quote: "q", note: "n" }] }),
			})
		).status,
	).toBe(403);

	// Wrong action token (notes token on /_approve, approve token on /_notes) -> 403
	expect(
		(await fetch(`${base}/_approve?page=a.html`, { method: "POST", headers: { origin: base, "x-ns-token": notesA } })).status,
	).toBe(403);
	expect(
		(
			await fetch(`${base}/_notes`, {
				method: "POST",
				headers: { origin: base, "content-type": "application/json", "x-ns-token": approveA },
				body: JSON.stringify({ page: "/a.html", notes: [{ quote: "q", note: "n" }] }),
			})
		).status,
	).toBe(403);

	// Normalized page name match: token minted for "why.html" accepts body.page "/why.html"
	const okNotes = await fetch(`${base}/_notes`, {
		method: "POST",
		headers: { origin: base, "content-type": "application/json", "x-ns-token": notesWhy },
		body: JSON.stringify({ page: "/why.html", notes: [{ quote: "q", note: "good" }] }),
	});
	expect(okNotes.status).toBe(200);

	// Normalized index match: token minted on GET / ("index.html") accepts body.page "/"
	const okIndex = await fetch(`${base}/_notes`, {
		method: "POST",
		headers: { origin: base, "content-type": "application/json", "x-ns-token": notesIndex },
		body: JSON.stringify({ page: "/", notes: [{ quote: "q", note: "home" }] }),
	});
	expect(okIndex.status).toBe(200);
});

test("security: /_raw isolates HTML, strips duplicate chrome, preserves #ns-answered, and rejects traversal/symlinks/bad URIs", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-sec-raw-"));
	dirs.push(root);
	const baked = injectPageNotes(
		"<!doctype html><html><body><p>untrusted body</p></body></html>",
		[{ id: "n1", quote: "old quote", note: "fix it", answer: "fixed in P2" }],
		{ page: "plan.html", open: [] },
	);
	writeFileSync(join(root, "plan.html"), baked);
	writeFileSync(join(root, "x.svg"), "<svg><script>alert(1)</script></svg>");
	writeFileSync(join(root, ".secret.html"), "<h1>secret</h1>");
	symlinkSync(join(root, "plan.html"), join(root, "link.html"));

	const tailscale = makeTailscale();
	const cfg = makeCfg(root, { allowThisMachine: true });
	const server = startPagesServer({
		cfg,
		tailscale,
		source: { listRuns: () => [], mainSession: () => null },
		hostname: LOOPBACK,
		port: 0,
		root,
		peerOf: () => LOOPBACK,
	});
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;

	// Viewer shell wraps /_raw/plan.html in an opaque sandbox iframe with per-request CSP nonce.
	const shellRes = await fetch(`${base}/plan.html`);
	expect(shellRes.status).toBe(200);
	const shellCsp = shellRes.headers.get("content-security-policy") ?? "";
	const nonce = /script-src 'nonce-([^']+)'/.exec(shellCsp)?.[1] ?? "";
	expect(nonce).not.toBe("");
	expect(shellCsp).toContain("base-uri 'none'");
	expect(shellCsp).toContain("frame-ancestors 'none'");
	expect(shellRes.headers.get("x-content-type-options")).toBe("nosniff");
	const shellHtml = await shellRes.text();
	expect(shellHtml).toContain('<iframe id="ns-frame" sandbox="allow-scripts" title="plan.html" src="/_raw/plan.html"></iframe>');
	expect(shellHtml).not.toContain("allow-same-origin");
	expect(shellHtml).toContain(`<script nonce="${nonce}">`);
	// Inline viewer shell script must parse cleanly as JavaScript and check ev.source + ev.origin === "null".
	const scriptBody = new RegExp(`<script nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">([\\s\\S]*?)<\\/script>`).exec(shellHtml)?.[1] ?? "";
	expect(scriptBody).not.toBe("");
	expect(() => new Function(scriptBody)).not.toThrow();
	expect(scriptBody).toContain('ev.source!==frame.contentWindow||ev.origin!=="null"');

	// /_raw/plan.html serves opaque sandbox CSP, strips interactive chrome, preserves #ns-answered, appends quote relay.
	const rawRes = await fetch(`${base}/_raw/plan.html`);
	expect(rawRes.status).toBe(200);
	expect(rawRes.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
	expect(rawRes.headers.get("content-security-policy")).not.toContain("allow-same-origin");
	expect(rawRes.headers.get("x-content-type-options")).toBe("nosniff");
	const rawBody = await rawRes.text();
	expect(rawBody).toContain("<p>untrusted body</p>");
	expect(rawBody).toContain('id="ns-answered"');
	expect(rawBody).toContain("fixed in P2");
	expect(rawBody).not.toContain('id="ns-approve"');
	expect(rawBody).not.toContain('id="ns-notes"');
	expect(rawBody).not.toContain('id="ns-note-fab"');
	expect(rawBody).toContain("ns-quote");

	// HEAD /_raw/plan.html returns same headers with empty body.
	const headRaw = await fetch(`${base}/_raw/plan.html`, { method: "HEAD" });
	expect(headRaw.status).toBe(200);
	expect(headRaw.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
	expect(await headRaw.text()).toBe("");

	// /_raw rejects traversal, hidden files, symlinks, and non-HTML files.
	expect((await fetch(`${base}/_raw/%2e%2e%2fetc%2fpasswd`)).status).toBe(404);
	expect((await fetch(`${base}/_raw/.secret.html`)).status).toBe(404);
	expect((await fetch(`${base}/_raw/link.html`)).status).toBe(404);
	expect((await fetch(`${base}/_raw/x.svg`)).status).toBe(404);

	// Malformed percent-encoding returns 400 instead of throwing 500 on both /<name> and /_raw/<name>.
	expect((await rawReq({ port: server.port, path: "/%E0%A4%A", headers: { host: `${LOOPBACK}:${server.port}` } })).status).toBe(400);
	expect((await rawReq({ port: server.port, path: "/_raw/%E0%A4%A", headers: { host: `${LOOPBACK}:${server.port}` } })).status).toBe(400);

	// .svg is served with strict sandbox CSP (no allow-scripts, no allow-same-origin).
	const svgRes = await fetch(`${base}/x.svg`);
	expect(svgRes.status).toBe(200);
	expect(svgRes.headers.get("content-security-policy")).toBe("sandbox");
	expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");

	// Filenames containing `&` are HTML-escaped in iframe src attributes.
	writeFileSync(join(root, "a&copy.html"), "<p>amp</p>");
	const ampShell = await (await fetch(`${base}/a&copy.html`)).text();
	expect(ampShell).toContain('src="/_raw/a&amp;copy.html"');
});

test("security: QUOTE_RELAY_SCRIPT handles missing window.parent safely and relays selected text when framed", () => {
	const scriptBody = /<script>([\s\S]*?)<\/script>/.exec(QUOTE_RELAY_SCRIPT)?.[1] ?? "";
	expect(scriptBody).not.toBe("");

	const listeners: Record<string, (() => void)[]> = {};
	const document = {
		addEventListener: (type: string, fn: () => void) => {
			(listeners[type] ??= []).push(fn);
		},
	};
	// Stub DOM where window.parent is undefined (like unit-test DOMs) must never throw.
	const unframedWindow = { getSelection: () => ({ toString: () => "hello world" }) };
	new Function("document", "window", scriptBody)(document, unframedWindow);
	expect(() => listeners.mouseup![0]!()).not.toThrow();

	// When framed, selection relays { type: "ns-quote", quote } to parent.
	const posted: { msg: unknown; target: string }[] = [];
	const framedListeners: Record<string, (() => void)[]> = {};
	const framedDoc = {
		addEventListener: (type: string, fn: () => void) => {
			(framedListeners[type] ??= []).push(fn);
		},
	};
	const parent = {
		postMessage: (msg: unknown, target: string) => {
			posted.push({ msg, target });
		},
	};
	const framedWindow = { parent, getSelection: () => ({ toString: () => "  quoted   passage  " }) };
	new Function("document", "window", scriptBody)(framedDoc, framedWindow);
	framedListeners.mouseup![0]!();
	expect(posted).toEqual([{ msg: { type: "ns-quote", quote: "quoted passage" }, target: "*" }]);
});
