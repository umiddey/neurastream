// Plan approval from the plan's own page (plan 20261026_0930 P9): a plan with a page in Base is
// approved there — the bar records `Approved: <date> (<page>)` — and main-guard refuses a spawn on it
// until then, unless the plan says `Approval: self — owner: "<his words>"`. A built thing has notes
// only: no bar, no approve route.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approvalProblem, approvalLine, isApproved, planForPage, recordApproval } from "../src/core/plan-approval.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { appendPageNotes, notesAnswersPath } from "../src/core/page-notes.ts";
import { publishPage } from "../src/core/pages-setup.ts";
import { startPagesServer } from "../src/core/pages.ts";

const REPO = dirname(dirname(import.meta.path));
const LOOPBACK = [127, 0, 0, 1].join(".");
const servers: { stop(): void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	delete process.env.QUEUE_STATE;
});

test("the line: replace what is there, otherwise add it above the first section", () => {
	const plan = "# P\n\nWorktree: -\n\n## Goal\n- x\n";
	expect(isApproved(plan)).toBe(false);
	expect(recordApproval(plan, "why.html", new Date("2026-10-27"))).toContain("Approved: 2026-10-27 (why.html)\n\n## Goal");
	const twice = recordApproval(recordApproval(plan, "why.html", new Date("2026-10-27")), "why2.html", new Date("2026-10-28"));
	expect(twice).toContain("Approved: 2026-10-28 (why2.html)");
	expect(twice.match(/^Approved:/gm)?.length).toBe(1);
	expect(isApproved(twice)).toBe(true);
	expect(isApproved('- Approval: self \u2014 owner: "just do it"\n')).toBe(true);
	expect(isApproved("Approval: self\n")).toBe(false); // his words are the exception's condition
	expect(approvalLine("why.html", new Date("2026-10-27"))).toBe("Approved: 2026-10-27 (why.html)");
});

test("approvalProblem: only a plan with a page in Base is gated", () => {
	const dir = mkdtempSync(join(tmpdir(), "plan-approval-meta-"));
	const pages = join(dir, "pages");
	mkdirSync(pages, { recursive: true });
	const plan = join(dir, "20261027_toy.md");
	writeFileSync(plan, "# Toy\n\n## Phases\n- [ ] P1 x\n");
	expect(approvalProblem(readFileSync(plan, "utf8"), plan, pages)).toBe(null); // no page: not gated
	mkdirSync(join(pages, ".meta"), { recursive: true });
	writeFileSync(join(pages, ".meta", "toy.html.json"), JSON.stringify({ plan }));
	expect(planForPage(pages, "toy.html")).toBe(plan);
	const why = approvalProblem(readFileSync(plan, "utf8"), plan, pages);
	expect(why).toContain('has no "Approved:" line');
	expect(why).toContain("toy.html");
	expect(approvalProblem(`${readFileSync(plan, "utf8")}\nApproved: 2026-10-27 (toy.html)\n`, plan, pages)).toBe(null);
	expect(approvalProblem('# Toy\n\nApproval: self \u2014 owner: "do it yourself"\n', plan, pages)).toBe(null);
});

function setup(): { dir: string; cfg: Config; pages: string } {
	const dir = mkdtempSync(join(tmpdir(), "plan-approval-"));
	process.env.QUEUE_STATE = join(dir, "state");
	const cfg = loadConfig({ file: join(dir, "missing.yml"), home: dir, env: {} });
	cfg.paths.queue_state = join(dir, "state");
	const pages = join(dir, "public");
	cfg.pages.enabled = true;
	cfg.pages.dir = pages;
	cfg.pages.port = 0;
	cfg.ui.owner_login = "owner@example.test";
	return { dir, cfg, pages };
}

test("publish --plan: the bar is on a plan page, absent on a built thing, and it drops on a republish without one", () => {
	const { dir, pages } = setup();
	const plan = join(dir, "20261027_toy.md");
	writeFileSync(plan, "# Toy\n\n## Phases\n- [ ] P1 x\n");
	const html = join(dir, "toy-architecture.html");
	writeFileSync(html, "<html><body><p>diagram</p></body></html>");
	expect(publishPage(html, "Toy", false, pages, { plan })).toBe("toy.html");
	const page = readFileSync(join(pages, "toy.html"), "utf8");
	expect(page).toContain('id="ns-approve"');
	expect(page).toContain(">Approve</button>"); // nothing is open: it starts enabled
	expect(page).toContain('data-ns-plan="toy.html"');
	// A built thing carries notes only.
	writeFileSync(join(dir, "cost.html"), "<html><body><p>built</p></body></html>");
	expect(publishPage(join(dir, "cost.html"), "Cost", false, pages)).toBe("cost.html");
	expect(readFileSync(join(pages, "cost.html"), "utf8")).not.toContain('id="ns-approve"');
	// A plan page republished without --plan loses the bar; it comes back with it.
	expect(publishPage(html, "Toy", true, pages)).toBe("toy.html");
	expect(readFileSync(join(pages, "toy.html"), "utf8")).not.toContain('id="ns-approve"');
	expect(publishPage(html, "Toy", true, pages, { plan })).toBe("toy.html");
	expect(readFileSync(join(pages, "toy.html"), "utf8")).toContain('id="ns-approve"');
});

test("server: approve is refused while a note is open, then it records the line in the plan", async () => {
	const { dir, cfg, pages } = setup();
	const plan = join(dir, "20261027_toy.md");
	writeFileSync(plan, "# Toy\n\n## Phases\n- [ ] P1 x\n");
	// A diagram that covers the plan: its one phase in a box, the path its line names, 2+ kids per box.
	const html = join(dir, "toy-architecture.html");
	writeFileSync(html, '<html><body><p>toy</p><script>const T={id:"root",nm:"toy",kids:[{id:"a",nm:"P1 do the thing",files:"src/a.ts",kids:[{id:"a1",nm:"x"},{id:"a2",nm:"y"}]},{id:"b",nm:"later",kids:[{id:"b1",nm:"z"},{id:"b2",nm:"w"}]}]};</script></body></html>');
	expect(publishPage(html, "Toy", false, pages, { plan })).toBe("toy.html");
	appendPageNotes({ page: "/toy.html", notes: [{ quote: "level 3", note: "label it" }] }, cfg, "owner-login");
	const tailscale = { ip4: () => "", dnsName: () => null, whois: () => "owner@example.test", logins: () => [] };
	const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: LOOPBACK, port: 0, root: pages, peerOf: () => LOOPBACK });
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;
	expect(await (await fetch(`${base}/_approve?page=toy.html`)).json()).toEqual({ open: ["n1"], problems: [] });
	let res = await fetch(`${base}/_approve?page=toy.html`, { method: "POST", headers: { origin: base } });
	expect(res.status).toBe(409);
	expect(readFileSync(plan, "utf8")).not.toContain("Approved:");
	writeFileSync(notesAnswersPath(cfg, "toy.html"), JSON.stringify({ n1: "labelled level 3" }));
	res = await fetch(`${base}/_approve?page=toy.html`, { method: "POST", headers: { origin: base } });
	expect(res.status).toBe(200);
	expect((await res.json()).approved ?? "").toMatch(/^Approved: \d{4}-\d{2}-\d{2} \(toy.html\)$/);
	expect(readFileSync(plan, "utf8")).toContain("Approved: ");
	expect(await (await fetch(`${base}/_approve?page=toy.html`)).json()).toEqual({ open: [], problems: [] });
	// A page with no plan has no approve route, and a foreign origin cannot write one.
	expect((await fetch(`${base}/_approve?page=nothing.html`)).status).toBe(404);
});

test("main-guard: a spawn is refused on an unapproved plan page and passes on the line or the self line", () => {
	const home = mkdtempSync(join(tmpdir(), "plan-approval-guard-"));
	const agent = join(home, ".omp/agent");
	const toy = join(home, "projects/toy");
	const state = join(home, ".local/state/queue");
	const pages = join(home, ".local/share/neurastream/pages");
	for (const d of [join(toy, "docs/plans"), join(agent, "blockers"), join(agent, "notes"), join(home, ".config/neurastream"), state, join(pages, ".meta")])
		mkdirSync(d, { recursive: true });
	const plan = join(toy, "docs/plans/20261027_toy.md");
	const body = "# Toy plan\n\nWorktree: -\nBranch: feat/toy\n\n## Goal\n- Toy.\n\n## Forbidden\n- Never skip tests.\n\n## Blockers\n- toy-blocker\n\n## Phases\n- [ ] P1 do the thing — verify: `test -f src/a.ts`\n\n## Done check\n`test -f src/a.ts`\n\n## Progress\nStatus: open\n\n- Started.\n";
	writeFileSync(plan, body);
	writeFileSync(join(agent, "INDEX.md"), `${plan}\n`);
	writeFileSync(join(agent, "notes/subagents.md"), "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(agent, "CANCELLED.md"), "");
	writeFileSync(join(pages, ".meta", "toy.html.json"), JSON.stringify({ plan }));
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  work_roots: ["${toy}"]
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "notes/subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
pages:
  enabled: false
  dir: "${pages}"
`,
	);
	// A real blocker script the plan can name: the plan gate checks it exists and is executable.
	writeFileSync(join(agent, "blockers/toy-blocker"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(agent, "blockers/toy-blocker"), 0o755);
	spawnSync("git", ["init", "-q"], { cwd: toy });
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_"))), HOME: home };
	const ask = (): { code: number; reason: string } => {
		const brief = `Plan: ${plan}\nP1 do the thing.`;
		const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", "spawn", "--json"], {
			input: JSON.stringify({ agent: "toy-worker", brief, invocationKind: "task", cwd: toy }),
			encoding: "utf8",
			env,
		});
		const out = r.stdout.trim().split("\n").pop() ?? "{}";
		const d = JSON.parse(out) as { allow?: boolean; reason?: string };
		return { code: r.status ?? 1, reason: d.reason ?? "" };
	};
	const refused = ask();
	expect(refused.code).not.toBe(0);
	expect(refused.reason).toContain('has no "Approved:" line');
	writeFileSync(plan, `${body}\n${approvalLine("toy.html", new Date("2026-10-27"))}\n`);
	expect(ask().code).toBe(0);
	writeFileSync(plan, `${body}\nApproval: self \u2014 owner: "do it on your own"\n`);
	expect(ask().code).toBe(0);
	rmSync(home, { recursive: true, force: true });
});
