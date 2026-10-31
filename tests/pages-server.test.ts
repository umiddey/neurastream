import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { startPagesServer } from "../src/core/pages.ts";
const servers: {stop():void}[]=[];
const dirs:string[]=[];
afterEach(()=>{for(const s of servers.splice(0))s.stop();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
test("pages serves contained files and rejects unsafe paths and peers",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pages-test-"));dirs.push(root);writeFileSync(join(root,"index.html"),"<h1>ok</h1>");writeFileSync(join(root,"x.svg"),"<svg/>");writeFileSync(join(root,".hidden"),"no");symlinkSync(join(root,"x.svg"),join(root,"link.svg"));
 const tailscale={ip4:()=>"100.64.0.1",dnsName:()=>null,whois:()=>"owner@example.test",logins:()=>[],state:()=>"running" as const};const cfg=loadConfig();cfg.pages.enabled=true;cfg.pages.dir=root;cfg.pages.port=0;cfg.ui.owner_login="owner@example.test";
 const server=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:"127.0.0.1",port:0,root,peerOf:()=>"127.0.0.1"});servers.push(server);const base=`http://127.0.0.1:${server.port}`;
 let r=await fetch(base+"/x.svg");expect(r.status).toBe(200);expect(r.headers.get("content-type")).toContain("image/svg+xml");
 r=await fetch(base+"/x.svg",{method:"HEAD"});expect(r.status).toBe(200);expect(await r.text()).toBe("");
 expect((await fetch(base+"/",{method:"POST"})).status).toBe(405);expect((await fetch(base+"/%2e%2e%2fetc%2fpasswd")).status).toBe(404);expect((await fetch(base+"/.hidden")).status).toBe(404);expect((await fetch(base+"/link.svg")).status).toBe(404);
});
test("pages denies non-tailnet peer and lists files without an index",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pages-test-"));dirs.push(root);writeFileSync(join(root,"diagram.html"),"ok");const cfg=loadConfig();cfg.pages.enabled=true;cfg.pages.dir=root;cfg.pages.port=0;cfg.ui.owner_login="owner@example.test";
 const tailscale={ip4:()=>"100.64.0.1",dnsName:()=>null,whois:()=>"owner@example.test",logins:()=>[],state:()=>"running" as const};const server=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:[127,0,0,1].join("."),port:0,root,peerOf:()=>"8.8.8.8"});servers.push(server);expect((await fetch(`http://${[127,0,0,1].join(".")}:${server.port}/`)).status).toBe(403);
 const local=startPagesServer({cfg,tailscale,source:{listRuns:()=>[],mainSession:()=>null},hostname:"127.0.0.1",port:0,root,peerOf:()=>"127.0.0.1"});servers.push(local);const text=await (await fetch(`http://127.0.0.1:${local.port}/`)).text();expect(text).toContain("diagram.html");expect(text).not.toContain(root);
});
