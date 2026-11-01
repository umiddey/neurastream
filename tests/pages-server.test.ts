import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { startPagesServer } from "../src/core/pages.ts";
import { notesStorePath } from "../src/core/page-notes.ts";
import { reviewHash } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
const LOOPBACK = [127, 0, 0, 1].join(".");
const servers: {stop():void}[]=[];
const dirs:string[]=[];
afterEach(()=>{for(const s of servers.splice(0))s.stop();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});for(const k of Object.keys(process.env))if(k.startsWith("QUEUE_"))delete process.env[k];});
test("pages serves contained files and rejects unsafe paths and peers",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pages-test-"));dirs.push(root);writeFileSync(join(root,"index.html"),"<h1>ok</h1>");writeFileSync(join(root,"x.svg"),"<svg/>");writeFileSync(join(root,".hidden"),"no");symlinkSync(join(root,"x.svg"),join(root,"link.svg"));
 const tailscale={ip4:()=>"100.64.0.1",dnsName:()=>null,whois:()=>"owner@example.test",logins:()=>[]};const cfg=loadConfig();cfg.pages.enabled=true;cfg.pages.dir=root;cfg.pages.port=0;cfg.ui.owner_login="owner@example.test";
 const server=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:"127.0.0.1",port:0,root,peerOf:()=>"127.0.0.1"});servers.push(server);const base=`http://127.0.0.1:${server.port}`;
 let r=await fetch(base+"/x.svg");expect(r.status).toBe(200);expect(r.headers.get("content-type")).toContain("image/svg+xml");
 r=await fetch(base+"/x.svg",{method:"HEAD"});expect(r.status).toBe(200);expect(await r.text()).toBe("");
 expect((await fetch(base+"/",{method:"POST"})).status).toBe(405);expect((await fetch(base+"/%2e%2e%2fetc%2fpasswd")).status).toBe(404);expect((await fetch(base+"/.hidden")).status).toBe(404);expect((await fetch(base+"/link.svg")).status).toBe(404);
});
test("pages denies non-tailnet peer and lists files without an index",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pages-test-"));dirs.push(root);writeFileSync(join(root,"diagram.html"),"ok");const cfg=loadConfig();cfg.pages.enabled=true;cfg.pages.dir=root;cfg.pages.port=0;cfg.ui.owner_login="owner@example.test";
 const tailscale={ip4:()=>"100.64.0.1",dnsName:()=>null,whois:()=>"owner@example.test",logins:()=>[]};const server=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:"127.0.0.1",port:0,root,peerOf:()=>"8.8.8.8"});servers.push(server);expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
 const local=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:"127.0.0.1",port:0,root,peerOf:()=>"127.0.0.1"});servers.push(local);const text=await (await fetch(`http://127.0.0.1:${local.port}/`)).text();expect(text).toContain("diagram.html");expect(text).not.toContain(root);
});

test("POST /_approve records the plan hash and leaves the plan unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pages-approve-"));
	dirs.push(root);
	const state = join(root, "state");
	mkdirSync(state, { recursive: true });
	process.env.QUEUE_STATE = state;
	const cfg = loadConfig();
	cfg.pages.enabled = true;
	cfg.pages.dir = root;
	cfg.pages.port = 0;
	cfg.ui.owner_login = "owner@example.test";
	cfg.paths.queue_state = state;
	applyQueueEnv(cfg);
	const plan = join(root, "20261027_toy.md");
	const original = "# Toy\n\n## Phases\n- [ ] P1 x\n";
	writeFileSync(plan, original);
	mkdirSync(join(root, ".meta"), { recursive: true });
	writeFileSync(join(root, ".meta", "toy.html.json"), JSON.stringify({ plan }));
	const tailscale = { ip4: () => "", dnsName: () => null, whois: () => "owner@example.test", logins: () => [] };
	const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: LOOPBACK, port: 0, root, peerOf: () => LOOPBACK });
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;
	const res = await fetch(`${base}/_approve?page=toy.html`, { method: "POST", headers: { origin: base } });
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
	const cfg = loadConfig();
	cfg.pages.enabled = true;
	cfg.pages.dir = root;
	cfg.pages.port = 0;
	cfg.ui.owner_login = "owner@example.test";
	cfg.paths.queue_state = state;
	applyQueueEnv(cfg);
	const plan = join(root, "20261027_toy.md");
	writeFileSync(plan, "# Toy\n\n## Phases\n- [ ] P1 x\n");
	mkdirSync(join(root, ".meta"), { recursive: true });
	writeFileSync(join(root, ".meta", "toy.html.json"), JSON.stringify({ plan, missing: [], thin: [] }));
	const tailscale = { ip4: () => "", dnsName: () => null, whois: () => "owner@example.test", logins: () => [] };
	const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: LOOPBACK, port: 0, root, peerOf: () => LOOPBACK });
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;
	const approve = () => fetch(`${base}/_approve?page=toy.html`, { method: "POST", headers: { origin: base } });
	expect((await approve()).status).toBe(200);
	const lines = existsSync(join(state, "owner-inbox.jsonl")) ? readFileSync(join(state, "owner-inbox.jsonl"), "utf8").split("\n") : [];
	const approvals = lines.filter(line => line.trim() !== "").map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.kind === "approval");
	expect(approvals).toHaveLength(1);
	expect(approvals[0]!.page).toBe("toy.html");
	expect(approvals[0]!.plan).toBe(plan);
	// the tap is not a page note: the store stays empty, so the second tap is not a 409
	expect(existsSync(notesStorePath(cfg, "toy.html"))).toBe(false);
	expect((await approve()).status).toBe(200);
});
