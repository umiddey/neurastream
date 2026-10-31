import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFile, loadConfig } from "./config.ts";
import { repoKey } from "./knowledge.ts";
import { injectPageNotes, type NotesGate } from "./page-notes.ts";
import { recordPagePlan } from "./plan-approval.ts";
import { checkDiagram } from "./diagram-check.ts";
import { gitRaw } from "./proc.ts";
import { recordPublish } from "./pages-expiry.ts";
import { realTailscale, type Tailscale } from "./tailscale.ts";
import { checkEdited, setConfigKeys } from "./config-edit.ts";
const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGES_UNIT_TEMPLATE = join(HERE, "../../templates/systemd/neurastream-pages.service");
export interface RunnerResult { status: number | null; stderr: string }
export type Runner = (args: string[]) => RunnerResult;
export const systemRunner: Runner = args => { const r = spawnSync("systemctl", args, { encoding:"utf8" }); return { status:r.status, stderr:r.stderr ?? "" }; };
export interface Setup { home?: string; runner?: Runner; tailscale?: Tailscale }
export function pagesOn(opts: Setup & { port?: number; dir?: string }): number {
 const home = opts.home ?? homedir(), runner = opts.runner ?? systemRunner, ts = opts.tailscale ?? realTailscale;
 const file = configFile(home), old = existsSync(file) ? readFileSync(file,"utf8") : null; const cfg = loadConfig({ home });
 const port = opts.port ?? cfg.pages.port, dir = opts.dir ?? cfg.pages.dir;
const edited = setConfigKeys(old, { "pages.enabled": "true", "pages.port": String(port), "pages.dir": JSON.stringify(dir) });
if (!checkEdited(edited, home, msg => console.error(msg))) return 1;
mkdirSync(dirname(file), { recursive:true }); writeFileSync(file, edited);
 mkdirSync(dir, { recursive:true });
 mkdirSync(join(home,".config/systemd/user"),{recursive:true}); copyFileSync(PAGES_UNIT_TEMPLATE, join(home,".config/systemd/user/neurastream-pages.service"));
 for (const args of [["--user","daemon-reload"],["--user","enable","--now","neurastream-pages"]]) { const r=runner(args); if(r.status!==0){console.error(r.stderr);return 1;} }
 const dns=ts.dnsName(); console.log(`pages: http://${dns ?? ts.ip4() ?? "<tailnet>"}:${port}/`); return 0;
}
export function pagesOff(opts: Setup = {}): number {
 const home=opts.home ?? homedir(), runner=opts.runner ?? systemRunner, file=configFile(home), old=existsSync(file)?readFileSync(file,"utf8"):null;
const cfg=loadConfig({home}); const edited=setConfigKeys(old,{"pages.enabled":"false","pages.port":String(cfg.pages.port),"pages.dir":JSON.stringify(cfg.pages.dir)});
if(!checkEdited(edited,home,msg=>console.error(msg))) return 1; writeFileSync(file,edited);
 const r=runner(["--user","stop","neurastream-pages"]); if(r.status!==0){console.error(r.stderr);return 1;} return 0;
}
/**
 * The repo a published page belongs to (plan 20261029_1436 P1): `--repo` wins; otherwise the file's
 * directory resolved to its main checkout — `git rev-parse --path-format=absolute --git-common-dir`
 * is absolute, so a file in the main checkout itself names the checkout, not a relative ".git" —
 * and the checkout's parent named by knowledge.ts's one repo rule, so a linked worktree's page
 * lands under the main checkout's name. Outside any repo: "other".
 */
export function repoForPublish(file: string, explicit?: string): string {
	if (explicit) return explicit;
	const top = gitRaw(dirname(resolve(file)), ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (top.code !== 0 || top.stdout === "") return "other";
	return repoKey(dirname(top.stdout));
}
/** Everything a publish carries besides the file: expiry, the notes gate and, on a plan page, the plan. */
export interface PublishOptions {
	keep?: boolean;
	keepDays?: number;
	now?: Date;
	notes?: NotesGate;
	/** The plan this page approves (P9). A page without one is a built thing: notes only, no Approve bar. */
	plan?: string;
	/** The repo the page belongs to in the pages meta (Base tab); resolved by the CLI when absent. */
	repo?: string;
}

export function publishPage(file: string, name: string | undefined, force: boolean, dir: string, opts: PublishOptions = {}): string {
 const keep = opts.keep ?? false, keepDays = opts.keepDays ?? 15, now = opts.now ?? new Date(), notes = opts.notes;
 const source=basename(file), base=(name ?? source.slice(0,source.length-extname(source).length)).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
 const targetName=base+extname(source).toLowerCase(), target=join(dir,targetName); mkdirSync(dir,{recursive:true});
 // A page with a note still unanswered is not published (plan 20261026 P8): the owner's note id must
 // get an answer before the page moves on. Publishing then shows each answer by its note and closes it.
 const open = notes?.open(targetName) ?? [];
 // A plan page is only approvable when its diagram covers the plan (plan 20261026 P10), so the check
 // runs here, at publish, and its findings travel with the page.
 let diagram: { missing: string[]; thin: string[] } | null = null;
 if (opts.plan !== undefined) {
  if (extname(source).toLowerCase() !== ".html") throw new Error(`pages: --plan needs an HTML artifact, not ${source}`);
  diagram = checkDiagram(readFileSync(file, "utf8"), readFileSync(opts.plan, "utf8"));
 }
 const approve = opts.plan === undefined || diagram === null ? undefined : { page: targetName, open, problems: [...diagram.missing, ...diagram.thin] };
 if(open.length>0) throw new Error(`pages: ${targetName} has ${open.length} open note(s) (${open.join(", ")}); answer each one before publishing (see \`neurastream notes check ${targetName}\`)`);
 // An HTML artifact carries the notes block from publish on (plan 20261026 P6): one style, one panel,
 // one script, injected once — a page that already carries it, or a second publish, stays single.
 const raw = readFileSync(file);
 const content = extname(source).toLowerCase() === ".html" ? Buffer.from(injectPageNotes(raw.toString("utf8"), notes?.answered(targetName) ?? [], approve), "utf8") : raw;
 if(existsSync(target)){const b=readFileSync(target); if(content.equals(b)){recordPublish(dir,targetName,keep,keepDays,now,opts.repo);notes?.settle(targetName);return targetName;} if(!force) throw new Error(`pages: ${targetName} exists with different content (use --force)`);}
 writeFileSync(target, content); recordPublish(dir,targetName,keep,keepDays,now,opts.repo);
 if(opts.plan !== undefined && diagram !== null) recordPagePlan(dir, targetName, { plan: opts.plan, missing: diagram.missing, thin: diagram.thin });
 notes?.settle(targetName); return targetName;
}
