// Diagram coverage (plan 20261026_0930 P10): the diagram a plan page shows must carry every phase and
// every file or command the plan's phase lines name, every box that drills down holds 2+ kids, and a
// page whose check fails cannot be approved — `pages publish --plan` leaves the bar disabled and the
// server answers 409.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDiagram, diagramData, planItems } from "../src/core/diagram-check.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { publishPage } from "../src/core/pages-setup.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { startPagesServer } from "../src/core/pages.ts";
import { runDiagram } from "../src/cli/diagram.ts";

const LOOPBACK = [127, 0, 0, 1].join(".");
const servers: { stop(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.QUEUE_STATE;
});

const PLAN = `# Toy

## Phases
- [ ] P1 scan \`src/core/a.ts\`
- [x] P2 write \`tests/b.test.ts\`

## Progress
Status: open
`;

// Plan pages must be the drilldown template with only DATA edited (plan 20261031_0917 P2).
const TEMPLATE = readFileSync(join(import.meta.dir, "../templates/skills/architecture-drilldown/template.html"), "utf8");
function page(boxes: string): string {
	const a = TEMPLATE.indexOf("/* === DATA === */") + "/* === DATA === */".length, b = TEMPLATE.indexOf("/* === END DATA === */");
	return `${TEMPLATE.slice(0, a)}\nconst T={id:"root",nm:"toy",g:[2,1],kids:[\n${boxes}\n]};\n${TEMPLATE.slice(b)}`;
}

const FULL = page(
	`{id:"a",nm:"P1 scan",files:"src/core/a.ts",kids:[{id:"a1",nm:"read"},{id:"a2",nm:"list"}]},
 {id:"b",nm:"P2 write",files:"tests/b.test.ts",kids:[{id:"b1",nm:"write"},{id:"b2",nm:"check"}]}`,
);

test("diagramData: the literal up to its matching brace, braces inside strings included", () => {
	const html = page(`{id:"a",nm:"P1 {not a brace}",what:"{ still text"},{id:"b",nm:"P2"}`);
	const data = diagramData(html);
	expect(data?.startsWith("{")).toBe(true);
	expect(data?.endsWith("}")).toBe(true);
	expect(data).toContain("still text");
	expect(diagramData("<html><body>no data</body></html>")).toBe(null);
});

test("planItems: each phase and each path its line names, once", () => {
	const items = planItems(PLAN);
	expect(items.phases).toEqual(["P1", "P2"]);
	expect([...items.paths.keys()]).toEqual(["src/core/a.ts", "tests/b.test.ts"]);
	expect(items.paths.get("tests/b.test.ts")).toBe("P2");
});

test("check: a covering diagram is clean; a missing phase or path and a one-kid box are named", () => {
	expect(checkDiagram(FULL, PLAN)).toEqual({ missing: [], thin: [] });
	const half = page(`{id:"a",nm:"P1 scan",files:"src/core/a.ts",kids:[{id:"a1",nm:"read"},{id:"a2",nm:"list"}]},{id:"b",nm:"P2 write",kids:[{id:"b1",nm:"write"}]}`);
	const report = checkDiagram(half, PLAN);
	expect(report.missing).toEqual(["tests/b.test.ts (P2): named in the plan, in no box"]);
	expect(report.thin).toEqual(["b has 1 kid"]);
	const silent = page(`{id:"a",nm:"something else",kids:[{id:"a1",nm:"x"},{id:"a2",nm:"y"}]}`);
	const gap = checkDiagram(silent, PLAN);
	expect(gap.missing).toContain("P1: the phase is in no box");
	expect(gap.missing).toContain("P2: the phase is in no box");
	expect(checkDiagram("<html><body>nothing</body></html>", PLAN).missing[0]).toContain("no diagram data");
});

test("diagram check CLI: exit 2 on usage, 1 while something is missing, 0 when it covers", () => {
	const dir = mkdtempSync(join(tmpdir(), "diagram-check-cli-"));
	dirs.push(dir);
	const plan = join(dir, "plan.md");
	writeFileSync(plan, PLAN);
	writeFileSync(join(dir, "bad.html"), page(`{id:"a",nm:"P1",kids:[{id:"a1",nm:"x"},{id:"a2",nm:"y"}]}`));
	writeFileSync(join(dir, "good.html"), FULL);
	expect(runDiagram([])).toBe(2);
	expect(runDiagram(["check", join(dir, "bad.html")])).toBe(2);
	expect(runDiagram(["check", join(dir, "bad.html"), plan])).toBe(1);
	expect(runDiagram(["check", join(dir, "good.html"), plan])).toBe(0);
});

test("publish --plan: an incomplete diagram keeps Approve disabled and the server refuses it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "diagram-check-pub-"));
	dirs.push(dir);
	process.env.QUEUE_STATE = join(dir, "state");
	const cfg: Config = loadConfig({ file: join(dir, "missing.yml"), home: dir, env: {} });
	cfg.paths.queue_state = join(dir, "state");
	applyQueueEnv(cfg);
	cfg.pages.enabled = true;
	cfg.pages.dir = join(dir, "public");
	cfg.pages.port = 0;
	cfg.ui.owner_login = "owner@example.test";
	const plan = join(dir, "plan.md");
	writeFileSync(plan, PLAN);
	const src = join(dir, "toy-architecture.html");
	writeFileSync(src, page(`{id:"a",nm:"P1 scan",files:"src/core/a.ts",kids:[{id:"a1",nm:"read"},{id:"a2",nm:"list"}]}`));
	const out = join(dir, "public");
	// P7 (plan 20261031_0917): an incomplete diagram never publishes, so no link goes out that cannot be approved.
	expect(() => publishPage(src, "Toy", false, out, { plan })).toThrow(/diagram is not complete \(3\)/);
	expect(existsSync(join(out, "toy.html"))).toBe(false);
	const tailscale = { ip4: () => "", dnsName: () => null, whois: () => "owner@example.test", logins: () => [] };
	const server = startPagesServer({ cfg, tailscale, source: { listRuns: () => [], mainSession: () => null }, hostname: LOOPBACK, port: 0, root: out, peerOf: () => LOOPBACK });
	servers.push(server);
	const base = `http://${LOOPBACK}:${server.port}`;
	// The complete diagram publishes with the bar enabled, and the click records the plan's hash in the queue state.
	writeFileSync(src, FULL);
	expect(publishPage(src, "Toy", false, out, { plan })).toBe("toy.html");
	expect(readFileSync(join(out, "toy.html"), "utf8")).toContain("<button id=\"ns-approve-btn\" type=\"button\">Approve</button>");
	expect((await fetch(`${base}/_approve?page=toy.html`, { method: "POST", headers: { origin: base } })).status).toBe(200);
	expect(readFileSync(plan, "utf8")).not.toContain("Approved:"); // the plan file is never edited
	expect(JSON.parse(readFileSync(join(cfg.paths.queue_state, "plan-approvals.json"), "utf8")).approvals[plan].page).toBe("toy.html");
});
