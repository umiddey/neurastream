// P1 (plan 20261031_0917 plan_page_drilldown): a page published with --plan must be the
// architecture-drilldown template with only its DATA block edited; a page without --plan stays
// free. Red tests: the refusal cases fail until P2 lands and "not complete" fails until P7;
// the publish cases pin the behaviour the check must keep working.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publishPage } from "../src/core/pages-setup.ts";
import { NOTES_MARK } from "../src/core/page-notes.ts";

const TEMPLATE = resolve(import.meta.dir, "../templates/skills/architecture-drilldown/template.html");
// No phases, no backticked paths: the diagram check has nothing to ask for, so only the template
// check can refuse these pages.
const CLEAN_PLAN = "# Toy plan\n\nNo phases, no paths.\n";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function template(): string {
	return readFileSync(TEMPLATE, "utf8");
}
function sandbox(planText = CLEAN_PLAN): { src: string; out: string; plan: string } {
	const dir = mkdtempSync(join(tmpdir(), "plan-page-"));
	DIRS.push(dir);
	const out = join(dir, "public");
	const plan = join(dir, "plan.md");
	writeFileSync(plan, planText);
	return { src: join(dir, "page.html"), out, plan };
}

test("a plan page that is not the drilldown template is refused and nothing is published", () => {
	const { src, out, plan } = sandbox();
	writeFileSync(src, "<!doctype html><html><body><h1>plain</h1></body></html>");
	expect(() => publishPage(src, "plan-page", false, out, { plan })).toThrow(/architecture-drilldown/);
	expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
});

test("the template with only its DATA block edited publishes", () => {
	const { src, out, plan } = sandbox();
	writeFileSync(src, template().replace('nm:"Example Shop"', 'nm:"Toy System"'));
	expect(publishPage(src, "plan-page", false, out, { plan })).toBe("plan-page.html");
	expect(readFileSync(join(out, "plan-page.html"), "utf8")).toContain("Toy System");
});

test("the template with one engine line after END DATA edited is refused", () => {
	const { src, out, plan } = sandbox();
	writeFileSync(src, template().replace('const NS="http://www.w3.org/2000/svg";', 'const NS="http://example.invalid/svg";'));
	expect(() => publishPage(src, "plan-page", false, out, { plan })).toThrow(/architecture-drilldown/);
	expect(existsSync(join(out, "plan-page.html"))).toBe(false);
});

test("the template with a line before DATA edited is refused", () => {
	const { src, out, plan } = sandbox();
	writeFileSync(src, template().replace('<h1 id="title"></h1>', '<h1 id="title" data-touched></h1>'));
	expect(() => publishPage(src, "plan-page", false, out, { plan })).toThrow(/architecture-drilldown/);
	expect(existsSync(join(out, "plan-page.html"))).toBe(false);
});

test("a plain page without --plan stays free and publishes", () => {
	const { src, out } = sandbox();
	writeFileSync(src, "<!doctype html><html><body><h1>plain</h1></body></html>");
	expect(publishPage(src, "free-page", false, out)).toBe("free-page.html");
});

test("republishing a published plan page with its injected notes block is still accepted", () => {
	const { src, out, plan } = sandbox();
	writeFileSync(src, template());
	expect(publishPage(src, "plan-page", false, out, { plan })).toBe("plan-page.html");
	const shipped = join(out, "plan-page.html");
	expect(readFileSync(shipped, "utf8")).toContain(NOTES_MARK);
	expect(publishPage(shipped, "plan-page", false, out, { plan })).toBe("plan-page.html");
});

test("publish refuses a plan page whose diagram is not complete and writes nothing", () => {
	const { src, out, plan } = sandbox("# Toy\n\n## Phases\n- [ ] P1 ship `src/x.ts`\n");
	writeFileSync(src, template()); // the shipped DATA never names src/x.ts
	expect(() => publishPage(src, "incomplete", false, out, { plan })).toThrow(/diagram is not complete/);
	expect(existsSync(join(out, "incomplete.html"))).toBe(false);
});
