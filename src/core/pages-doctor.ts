import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configFile, loadConfig } from "./config.ts";
import { PAGES_UNIT_TEMPLATE, type Runner } from "./pages-setup.ts";

export function pagesDoctor(home=homedir(), runner:Runner=args=>{const r=spawnSync("systemctl",args,{encoding:"utf8"});return{status:r.status,stderr:r.stderr??""}}): string[] {
 const warnings:string[]=[];let cfg;
 try{cfg=loadConfig({home,file:configFile(home)});}catch(e){return [`pages config invalid: ${e instanceof Error?e.message:String(e)}`];}
 if(cfg.pages.enabled){if(!existsSync(cfg.pages.dir))warnings.push(`pages directory missing: ${cfg.pages.dir}`);if(!existsSync(join(home,".config/systemd/user/neurastream-pages.service"))||!existsSync(PAGES_UNIT_TEMPLATE))warnings.push("pages unit file missing");const result=runner(["--user","is-active","neurastream-pages"]);if(result.status!==0)warnings.push("neurastream-pages unit is not active");}
 if(existsSync(cfg.pages.dir)){try{if(readdirSync(cfg.pages.dir).some(name=>{try{return lstatSync(join(cfg.pages.dir,name)).isSymbolicLink();}catch{return false;}}))warnings.push("pages directory contains a symlink");}catch{}}
 return warnings;
}
