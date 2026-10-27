import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { getAdapter } from "../adapters/index.ts";
import { loadConfig } from "../core/config.ts";
import { readExpiry, sweepPages } from "../core/pages-expiry.ts";
import { startPagesServer } from "../core/pages.ts";
import { pageNotesGate } from "../core/page-notes.ts";
import { pagesOff, pagesOn, publishPage, type Runner } from "../core/pages-setup.ts";
import { realTailscale, type Tailscale } from "../core/tailscale.ts";

export interface PagesDeps { home?: string; runner?: Runner; tailscale?: Tailscale; clock?: () => Date }
const HOUR_MS = 60 * 60 * 1000;
export async function runPages(args: string[] = [], deps: PagesDeps = {}): Promise<number> {
 const home = deps.home ?? homedir();
 const clock = deps.clock ?? (() => new Date());
 try {
  if (args[0] === "on") { let port: number | undefined, dir: string | undefined; for (let i = 1; i < args.length; i++) { if (args[i] === "--port") port = Number(args[++i]); else if (args[i] === "--dir") dir = args[++i]; else return 2; } return pagesOn({ home, runner: deps.runner, tailscale: deps.tailscale, port, dir }); }
  if (args[0] === "off" && args.length === 1) return pagesOff({ home, runner: deps.runner });
  const cfg = loadConfig({ home });
  if (args[0] === "serve" && args.length === 1) {
   if (!cfg.pages.enabled) throw new Error("pages.enabled is false");
   sweepPages(cfg.pages.dir, cfg.pages.keep_days, clock());
   startPagesServer({ cfg, tailscale: deps.tailscale ?? realTailscale, source: getAdapter(cfg).runSource(cfg) });
   setInterval(() => { try { sweepPages(cfg.pages.dir, cfg.pages.keep_days, clock()); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); } }, HOUR_MS);
   return new Promise<number>(() => {});
  }
  if (args[0] === "publish" && args[1]) {
   let force = false, keep = false, plan: string | undefined;
   const rest: string[] = [];
   for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force") force = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--plan") plan = args[++i] ?? "";
    else rest.push(arg);
   }
   if (plan === "") { console.error("pages publish: --plan needs the plan file"); return 2; }
   // file first, then the optional name; flags may sit anywhere (2026-10-27: `--force <file>` used
   // to be read as file "--force" because only args.slice(2) was scanned)
   const file = rest[0];
   const name = rest[1];
   if (!file || rest.length > 2) return 2;
   const now = clock();
   sweepPages(cfg.pages.dir, cfg.pages.keep_days, now);
   const n = publishPage(file, name, force, cfg.pages.dir, { keep, keepDays: cfg.pages.keep_days, now, notes: pageNotesGate(cfg), plan });
   const host = (deps.tailscale ?? realTailscale).dnsName() ?? "tailnet";
   console.log(`http://${host}:${cfg.pages.port}/${encodeURIComponent(n)}`);
   const expires = readExpiry(cfg.pages.dir)[n]?.expires;
   console.log(expires ? `expires ${expires.slice(0, 10)}` : "kept");
   return 0;
  }
  if (args[0] === "list" && args.length === 1) {
   sweepPages(cfg.pages.dir, cfg.pages.keep_days, clock());
   const map = readExpiry(cfg.pages.dir);
   for (const f of readdirSync(cfg.pages.dir, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith("."))) {
    const expires = map[f.name]?.expires;
    console.log(`${f.name}  ${expires ? `expires ${expires.slice(0, 10)}` : "kept"}`);
   }
   return 0;
  }
 } catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1; }
 console.error("usage: neurastream pages on [--port N] [--dir D] | off | serve | publish <file> [<name>] [--force] [--keep] | list");
 return 2;
}
