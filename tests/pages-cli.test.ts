import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesOn, publishPage } from "../src/core/pages-setup.ts";
import { configFile } from "../src/core/config.ts";

test("pages on preserves unrelated config and uses injected system runner",()=>{
 const home=mkdtempSync(join(tmpdir(),"pages-cli-")), file=configFile(home);mkdirSync(join(home,".config/neurastream"),{recursive:true});const original=`# keep
ui:
  enabled: false
  port: 7787
  owner_login: ""
`;writeFileSync(file,original);const calls:string[][]=[];
 const result=pagesOn({home,port:9000,dir:"/tmp/public",tailscale:{ip4:()=>"100.64.0.1",dnsName:()=>"machine.example",whois:()=>null,logins:()=>[]},runner:args=>{calls.push(args);return{status:0,stderr:""}}});
 expect(result).toBe(0);const edited=readFileSync(file,"utf8");expect(edited).toContain("# keep");expect(edited).toContain("owner_login: \"\"");expect(edited).toContain("port: 9000");expect(calls).toEqual([["--user","daemon-reload"],["--user","enable","--now","neurastream-pages"]]);
});
test("publish refuses collisions and permits forced replacement",()=>{
 const dir=mkdtempSync(join(tmpdir(),"pages-pub-")), src=join(dir,"source.html"), out=join(dir,"public");writeFileSync(src,"one");expect(publishPage(src,"My Diagram",false,out)).toBe("my-diagram.html");writeFileSync(src,"two");expect(()=>publishPage(src,"My Diagram",false,out)).toThrow("exists");expect(publishPage(src,"My Diagram",true,out)).toBe("my-diagram.html");expect(readFileSync(join(out,"my-diagram.html"),"utf8")).toBe("two");
});
