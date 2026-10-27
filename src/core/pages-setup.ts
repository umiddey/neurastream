import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile, loadConfig } from "./config.ts";
import { injectPageNotes } from "./page-notes.ts";
import { recordPublish } from "./pages-expiry.ts";
import { realTailscale, type Tailscale } from "./tailscale.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGES_UNIT_TEMPLATE = join(HERE, "../../templates/systemd/neurastream-pages.service");
export interface RunnerResult { status: number | null; stderr: string }
export type Runner = (args: string[]) => RunnerResult;
export const systemRunner: Runner = args => { const r = spawnSync("systemctl", args, { encoding:"utf8" }); return { status:r.status, stderr:r.stderr ?? "" }; };
export interface Setup { home?: string; runner?: Runner; tailscale?: Tailscale }
function editBlock(text: string | null, values: { enabled: boolean; port: number; dir: string }): string {
 const fresh = ["pages:", `  enabled: ${values.enabled}`, `  port: ${values.port}`, `  dir: "${values.dir.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`];
 if (text === null) return `${fresh.join("\n")}\n`;
 const lines = text.split("\n");
 let start = -1;
 for (let i = 0; i < lines.length; i++) if (/^pages\s*:(\s*(?:#.*)?)?$/.test(lines[i] ?? "")) { start = i; break; }
 if (start < 0) return `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${fresh.join("\n")}\n`;
 let end = start + 1;
 while (end < lines.length && (lines[end] === "" || /^[ \t]/.test(lines[end]!))) end++;
 const setKey = (key: string, value: string): void => {
  const re = new RegExp(`^([ \\t]+)${key}\\s*:.*$`);
  for (let i = start + 1; i < end; i++) if (re.test(lines[i]!)) { lines[i] = lines[i]!.replace(re, `$1${key}: ${value}`); return; }
  let at = start + 1;
  for (let i = start + 1; i < end; i++) if (lines[i]!.trim() !== "") at = i + 1;
  lines.splice(at, 0, `  ${key}: ${value}`); end++;
 };
 setKey("enabled", String(values.enabled)); setKey("port", String(values.port)); setKey("dir", `"${values.dir.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
 return lines.join("\n");
}
export function pagesOn(opts: Setup & { port?: number; dir?: string }): number {
 const home = opts.home ?? homedir(), runner = opts.runner ?? systemRunner, ts = opts.tailscale ?? realTailscale;
 const file = configFile(home), old = existsSync(file) ? readFileSync(file,"utf8") : null; const cfg = loadConfig({ home });
 const port = opts.port ?? cfg.pages.port, dir = opts.dir ?? cfg.pages.dir;
 const edited = editBlock(old, { enabled:true, port, dir }); mkdirSync(dirname(file), { recursive:true }); writeFileSync(file, edited);
 mkdirSync(dir, { recursive:true });
 mkdirSync(join(home,".config/systemd/user"),{recursive:true}); copyFileSync(PAGES_UNIT_TEMPLATE, join(home,".config/systemd/user/neurastream-pages.service"));
 for (const args of [["--user","daemon-reload"],["--user","enable","--now","neurastream-pages"]]) { const r=runner(args); if(r.status!==0){console.error(r.stderr);return 1;} }
 const dns=ts.dnsName(); console.log(`pages: http://${dns ?? ts.ip4() ?? "<tailnet>"}:${port}/`); return 0;
}
export function pagesOff(opts: Setup = {}): number {
 const home=opts.home ?? homedir(), runner=opts.runner ?? systemRunner, file=configFile(home), old=existsSync(file)?readFileSync(file,"utf8"):null;
 const cfg=loadConfig({home}); writeFileSync(file,editBlock(old,{enabled:false,port:cfg.pages.port,dir:cfg.pages.dir}));
 const r=runner(["--user","stop","neurastream-pages"]); if(r.status!==0){console.error(r.stderr);return 1;} return 0;
}
export function publishPage(file: string, name: string | undefined, force: boolean, dir: string, keep = false, keepDays = 15, now = new Date()): string {
 const source=basename(file), base=(name ?? source.slice(0,source.length-extname(source).length)).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
 const targetName=base+extname(source).toLowerCase(), target=join(dir,targetName); mkdirSync(dir,{recursive:true});
 // An HTML artifact carries the notes block from publish on (plan 20261026 P6): one style, one panel,
 // one script, injected once — a page that already carries it, or a second publish, stays single.
 const raw = readFileSync(file);
 const content = extname(source).toLowerCase() === ".html" ? Buffer.from(injectPageNotes(raw.toString("utf8")), "utf8") : raw;
 if(existsSync(target)){const b=readFileSync(target); if(content.equals(b)){recordPublish(dir,targetName,keep,keepDays,now);return targetName;} if(!force) throw new Error(`pages: ${targetName} exists with different content (use --force)`);}
 writeFileSync(target, content); recordPublish(dir,targetName,keep,keepDays,now); return targetName;
}
