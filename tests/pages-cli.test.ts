import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPages } from "../src/cli/pages.ts";
import { loadConfig, configFile } from "../src/core/config.ts";
import { startPagesServer } from "../src/core/pages.ts";
import { pagesOn, publishPage } from "../src/core/pages-setup.ts";

// A full `bun test` must leave nothing under os.tmpdir() (plan 20261029_1530 P3).
const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("pages on preserves unrelated config and uses injected system runner",()=>{
 const home=mkdtempSync(join(tmpdir(),"pages-cli-")), file=configFile(home);mkdirSync(join(home,".config/neurastream"),{recursive:true});const original=`# keep
ui:
  enabled: false
  port: 7787
  owner_login: ""
`;writeFileSync(file,original);const calls:string[][]=[];
 DIRS.push(home);
 const result=pagesOn({home,port:9000,dir:"/tmp/public",tailscale:{ip4:()=>"100.64.0.1",dnsName:()=>"machine.example",whois:()=>null,logins:()=>[]},runner:args=>{calls.push(args);return{status:0,stderr:""}}});
 expect(result).toBe(0);const edited=readFileSync(file,"utf8");expect(edited).toContain("# keep");expect(edited).toContain("owner_login: \"\"");expect(edited).toContain("port: 9000");expect(calls).toEqual([["--user","daemon-reload"],["--user","enable","--now","neurastream-pages"]]);
});
test("publish refuses collisions and permits forced replacement",()=>{
 const dir=mkdtempSync(join(tmpdir(),"pages-pub-")), src=join(dir,"source.html"), out=join(dir,"public");
 DIRS.push(dir);writeFileSync(src,"one");expect(publishPage(src,"My Diagram",false,out)).toBe("my-diagram.html");writeFileSync(src,"two");expect(()=>publishPage(src,"My Diagram",false,out)).toThrow("exists");expect(publishPage(src,"My Diagram",true,out)).toBe("my-diagram.html");const published=readFileSync(join(out,"my-diagram.html"),"utf8");expect(published.startsWith("two")).toBe(true);expect(published).toContain("data-ns-page-notes");
});

const tailscale = { ip4: () => "100.64.0.1", dnsName: () => "machine.example", whois: () => null, logins: () => [] as string[] };
async function logged(run: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
 const lines: string[] = [];
 const orig = console.log;
 console.log = (line: string) => lines.push(String(line));
 try { return { code: await run(), lines }; }
 finally { console.log = orig; }
}
// Regression (2026-10-27): `publish --force <file>` read `--force` as the file (ENOENT copyfile
// '--force') because args[1] was pinned as the file and only args.slice(2) was scanned for flags.
test("publish parses --force/--keep and the name in any position", async () => {
	const home = mkdtempSync(join(tmpdir(), "pages-cli-flags-"));
	DIRS.push(home);
	const src = join(home, "source.html");
	writeFileSync(src, "one");
	const clock = () => new Date("2026-10-27T12:00:00.000Z");
	// --force before the file: the file must not be read as "--force"
	const first = await logged(() => runPages(["publish", "--force", src], { home, tailscale, clock }));
	expect(first.code).toBe(0);
	expect(first.lines[0]).toBe("http://machine.example:7788/source.html");
	// trailing flag still replaces an existing page
	writeFileSync(src, "two");
	expect(await runPages(["publish", src, "--force"], { home, tailscale, clock })).toBe(0);
	const shipped=readFileSync(join(loadConfig({ home, env: {} }).pages.dir, "source.html"), "utf8");expect(shipped.startsWith("two")).toBe(true);expect(shipped).toContain("data-ns-page-notes");
	// flags and the optional name mixed in any order
	const named = await logged(() => runPages(["publish", "--keep", src, "diagram"], { home, tailscale, clock }));
	expect(named.code).toBe(0);
	expect(named.lines[1]).toBe("kept");
	expect(readFileSync(join(loadConfig({ home, env: {} }).pages.dir, "diagram.html"), "utf8")).toContain("data-ns-page-notes");
	// more than file + name is still a usage error
	expect(await runPages(["publish", src, "a", "b"], { home, tailscale, clock })).toBe(2);
	expect(existsSync(join(loadConfig({ home, env: {} }).pages.dir, "a.html"))).toBe(false);
});
test("publish without keep lists an expiry date, and --keep on a republish flips it to kept", async () => {
 const home = mkdtempSync(join(tmpdir(), "pages-cli-keep-"));
 DIRS.push(home);
 const src = join(home, "source.html");
 writeFileSync(src, "<h1>a</h1>");
 const now = new Date("2026-10-25T12:00:00.000Z");
 const clock = () => now;
 const published = await logged(() => runPages(["publish", src], { home, tailscale, clock }));
 expect(published.code).toBe(0);
 expect(published.lines).toEqual(["http://machine.example:7788/source.html", "expires 2026-11-09"]);
 expect((await logged(() => runPages(["list"], { home, tailscale, clock }))).lines).toEqual(["source.html  other  expires 2026-11-09"]);
 const kept = await logged(() => runPages(["publish", src, "--keep"], { home, tailscale, clock }));
 expect(kept.lines[1]).toBe("kept");
 expect((await logged(() => runPages(["list"], { home, tailscale, clock }))).lines).toEqual(["source.html  other  kept"]);
});
// P1 (plan 20261029_1436): every publish records the page's repo in the pages meta — the file's
// repo resolved to its main checkout (a linked worktree's page belongs to the main checkout's
// name, never the worktree dir name), "other" outside any repo, --repo wins.
function git(args: string[], cwd: string): void {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

test("publish records the repo: main checkout name, worktree maps to it, no repo is other, --repo wins", async () => {
	const home = mkdtempSync(join(tmpdir(), "pages-cli-repo-"));
	const main = mkdtempSync(join(tmpdir(), "pages-main-checkout-"));
	git(["init", "-q"], main);
	git(["remote", "add", "origin", "https://example.com/acme/widgets.git"], main);
	git(["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], main);
	const wtParent = mkdtempSync(join(tmpdir(), "pages-wt-parent-"));
	const wt = join(wtParent, "neighbor-wt"); // deliberately not named widgets
	git(["worktree", "add", "-q", wt, "HEAD"], main);
	const now = new Date("2026-10-29T12:00:00.000Z");
	const clock = () => now;
	writeFileSync(join(main, "a.html"), "<h1>a</h1>");
	expect(await runPages(["publish", join(main, "a.html")], { home, tailscale, clock })).toBe(0);
	writeFileSync(join(wt, "b.html"), "<h1>b</h1>");
	expect(await runPages(["publish", join(wt, "b.html")], { home, tailscale, clock })).toBe(0);
	const bare = mkdtempSync(join(tmpdir(), "pages-no-repo-"));
	writeFileSync(join(bare, "c.html"), "<h1>c</h1>");
	expect(await runPages(["publish", join(bare, "c.html")], { home, tailscale, clock })).toBe(0);
	expect(await runPages(["publish", join(main, "a.html"), "--repo", "acme-override", "--force"], { home, tailscale, clock })).toBe(0);
	expect(await runPages(["publish", join(main, "a.html"), "--repo", ""], { home, tailscale, clock })).toBe(2);
	const lines = (await logged(() => runPages(["list"], { home, tailscale, clock }))).lines.toSorted();
	expect(lines).toEqual([
		"a.html  acme-override  expires 2026-11-13",
		"b.html  widgets  expires 2026-11-13",
		"c.html  other  expires 2026-11-13",
	]);
});

test("list removes an expired page and the server answers 404", async () => {
 const home = mkdtempSync(join(tmpdir(), "pages-cli-gone-"));
 DIRS.push(home);
 const src = join(home, "source.html");
 writeFileSync(src, "gone");
 let now = new Date("2026-10-25T12:00:00.000Z");
 expect(await runPages(["publish", src, "diagram"], { home, tailscale, clock: () => now })).toBe(0);
 now = new Date("2026-11-10T12:00:00.000Z");
 expect((await logged(() => runPages(["list"], { home, tailscale, clock: () => now }))).lines).toEqual([]);
 const cfg = loadConfig({ home, env: {} });
 expect(existsSync(join(cfg.pages.dir, "diagram.html"))).toBe(false);
 cfg.ui.owner_login = "owner@example.test";
 const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: "127.0.0.1", port: 0, root: cfg.pages.dir, peerOf: () => "127.0.0.1" });
 try { expect((await fetch(`http://127.0.0.1:${server.port}/diagram.html`)).status).toBe(404); }
 finally { server.stop(); }
});
