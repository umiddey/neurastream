// Brief-lint's incident rule (plan 20261022_2330 P5): a plan citing INCIDENT <id> must have a
// phase whose text says "fail-before" — its regression test has to fail on the old code. Every
// other rule of lint() must still pass for the positive cases, so the briefs below satisfy the
// full template (method read, acceptance, never push, find note, call budget).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefLint } from "../src/core/brief-lint.ts";
import { loadConfig, type Config } from "../src/core/config.ts";

const TMP = mkdtempSync(join(tmpdir(), "nsar-brieflint-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

// The paths rule requires every $HOME/... path a brief names to exist; the briefs below name
// method_read, so the sandbox home carries a stub of it.
mkdirSync(join(TMP, "home/projects"), { recursive: true });
writeFileSync(join(TMP, "home/projects/opus-implementer-method.md"), "method text\n");

const cfg: Config = loadConfig({ home: join(TMP, "home"), env: {} });

function brief(name: string, incidentId: string | null, failBefore: boolean): string {
	const p = join(TMP, name);
	mkdirSync(TMP, { recursive: true });
	writeFileSync(
		p,
		[
			`# ${name.replace(/\.md$/, "")}`,
			"",
			`Read ${cfg.brief.method_read} first.`,
			"",
			"## Goal",
			incidentId ? `Close the loop on ${incidentId}. INCIDENT ${incidentId}` : "Tighten a guard message.",
			"",
			"## Phases",
			incidentId && failBefore
				? `- [x] P1 detector gate, fail-before: the regression test fails on the old code — verify: \`true\``
				: `- [x] P1 detector gate — verify: \`true\``,
			"",
			"## Acceptance",
			"- bun run typecheck && bun test exit 0",
			"",
			"## Forbidden",
			"- never push, never open a PR",
			"",
			"## Notes",
			"`find` is broken: use grep/glob/read. Every test run goes through heavy-run.sh. Stop and report within ~100 tool calls.",
			"",
		].join("\n"),
	);
	return p;
}

test("a plan citing INCIDENT <id> with no fail-before phase is refused", () => {
	const rc = briefLint([brief("20261023_1200_nofailbefore.md", "I-20261023-1", false)], cfg);
	expect(rc).toBe(1);
});

test("the same plan with a fail-before phase passes; a plan without an INCIDENT id needs no fail-before", () => {
	expect(briefLint([brief("20261023_1300_withfailbefore.md", "I-20261023-1", true)], cfg)).toBe(0);
	expect(briefLint([brief("20261023_1400_noincident.md", null, false)], cfg)).toBe(0);
});

// The repo-specific brief rules moved from code to config (brief.repo_rules); the shipped
// default list is empty, so the same briefs stay clean without them.
function ruledBrief(name: string, title: string, bodyLine: string): string {
	const p = join(TMP, name);
	writeFileSync(
		p,
		[
			`# ${title}`,
			"",
			`Read ${cfg.brief.method_read} first.`,
			"",
			"## Goal",
			"Repo-ruled work.",
			"",
			"## Phases",
			"- [x] P1 thing — verify: `true`",
			"",
			"## Acceptance",
			"- bun run typecheck && bun test exit 0",
			"",
			"## Forbidden",
			"- never push, never open a PR",
			"",
			"## Notes",
			"`find` is broken: use grep/glob/read. Stop and report within ~100 tool calls.",
			bodyLine,
			"",
		].join("\n"),
	);
	return p;
}

test("brief.repo_rules fire from config; first and unless gate on the title line", () => {
	const rules: Config["brief"]["repo_rules"] = [
		{ match: "coverage", require: "witnessed probe", message: "coverage briefs must name their witnessed probe" },
		{ match: "legacy", first: "refactor", require: "regression test", message: "legacy refactor must name its regression test" },
		{ match: "legacy", unless: "plan only", require: "regression test", message: "legacy work must name its regression test" },
	];
	const ruled: Config = { ...cfg, brief: { ...cfg.brief, repo_rules: rules } };

	const clean = ruledBrief("20261023_1500_clean.md", "Tighten a guard message", "");
	expect(briefLint([clean], ruled)).toBe(0);
	const cov = ruledBrief("20261023_1501_cov.md", "Tighten a guard message", "coverage batch for the queue");
	expect(briefLint([cov], ruled)).toBe(1); // coverage rule fires; no witnessed probe in the brief
	const refactor = ruledBrief("20261023_1502_refactor.md", "Refactor the parser", "legacy import path stays");
	expect(briefLint([refactor], ruled)).toBe(1); // first: refactor matches, no regression test
	const planOnly = ruledBrief("20261023_1503_planonly.md", "Plan only: legacy audit", "legacy import path stays");
	expect(briefLint([planOnly], ruled)).toBe(0); // unless: plan only skips the legacy rule

	// the shipped default (no repo_rules) never fires on the same briefs
	expect(briefLint([cov], cfg)).toBe(0);
	expect(briefLint([refactor], cfg)).toBe(0);
	expect(briefLint([planOnly], cfg)).toBe(0);
});
