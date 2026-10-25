import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { defaultRunSource } from "../adapters/omp/sessions.ts";
import { loadConfig } from "../core/config.ts";
import { startPagesServer } from "../core/pages.ts";
import { pagesOff, pagesOn, publishPage, type Runner } from "../core/pages-setup.ts";
import { realTailscale, type Tailscale } from "../core/tailscale.ts";

export interface PagesDeps { home?: string; runner?: Runner; tailscale?: Tailscale }
export async function runPages(args: string[] = [], deps: PagesDeps = {}): Promise<number> {
 const home=deps.home ?? homedir();
 try {
  if(args[0]==="on") { let port:number|undefined,dir:string|undefined; for(let i=1;i<args.length;i++){if(args[i]==="--port")port=Number(args[++i]);else if(args[i]==="--dir")dir=args[++i];else return 2;} return pagesOn({home,runner:deps.runner,tailscale:deps.tailscale,port,dir}); }
  if(args[0]==="off"&&args.length===1)return pagesOff({home,runner:deps.runner});
  const cfg=loadConfig({home});
  if(args[0]==="serve"&&args.length===1){if(!cfg.pages.enabled)throw new Error("pages.enabled is false");startPagesServer({cfg,tailscale:deps.tailscale ?? realTailscale,source:defaultRunSource(cfg)});return new Promise<number>(()=>{});}
  if(args[0]==="publish"&&args[1]){let force=false,name:string|undefined;for(const arg of args.slice(2)){if(arg==="--force")force=true;else if(!name)name=arg;else return 2;}const n=publishPage(args[1],name,force,cfg.pages.dir);const host=(deps.tailscale ?? realTailscale).dnsName() ?? "tailnet";console.log(`http://${host}:${cfg.pages.port}/${encodeURIComponent(n)}`);return 0;}
  if(args[0]==="list"&&args.length===1){for(const f of readdirSync(cfg.pages.dir,{withFileTypes:true}).filter(e=>e.isFile()&&!e.name.startsWith(".")))console.log(f.name);return 0;}
 } catch(e){console.error(e instanceof Error?e.message:String(e));return 1;}
 console.error("usage: neurastream pages on [--port N] [--dir D] | off | serve | publish <file> [<name>] [--force] | list");return 2;
}
