// Brief-lint rules. The shipped default config carries no team rules: a method read and a find note
// are required only when a config sets them (brief.method_marker, brief.repo_rules). The incident rule
// (plan 20261022_2330 P5) applies to every config: a plan citing
// INCIDENT <id> must have a phase whose text says "fail-before" — its regression test has to fail on
// the old code.

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

// A team's method file: referenced only by the config that sets brief.method_marker.
mkdirSync(join(TMP, "home/projects"), { recursive: true });
writeFileSync(join(TMP, "home/projects/team-method.md"), "method text\n");

const cfg: Config = loadConfig({ home: join(TMP, "home"), env: {} });
const team: Config = {
	...cfg,
	brief: { ...cfg.brief, method_marker: "team-method.md", method_read: "$HOME/projects/team-method.md" },
};

function brief(name: string, incidentId: string | null, failBefore: boolean, c: Config = cfg, extra: string[] = []): string {
	const p = join(TMP, name);
	mkdirSync(TMP, { recursive: true });
	const lines = [
		`# ${name.replace(/\.md$/, "")}`,
		"",
		...(c.brief.method_read ? [`Read ${c.brief.method_read} first.`, ""] : []),
		"## Goal",
		incidentId ? `Close the loop on ${incidentId}. INCIDENT ${incidentId}` : "Tighten a guard message.",
		"",
		"## Phases",
		incidentId && failBefore
			? "- [x] P1 detector gate, fail-before: the regression test fails on the old code — verify: `true`"
			: "- [x] P1 detector gate — verify: `true`",
		"",
		"## Acceptance",
		"- bun run typecheck && bun test exit 0",
		"",
		"## Forbidden",
		"- never push, never open a PR",
		"",
		"## Notes",
		"Stop and report within ~100 tool calls.",
		...extra,
		"",
	];
	writeFileSync(p, lines.join("\n"));
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

test("the shipped default config carries no team rules and names the package heavy-run", () => {
	expect(cfg.brief.method_marker).toBe("");
	expect(cfg.brief.method_read).toBe("");
	expect(cfg.brief.heavy_marker).toBe("heavy-run");
	expect(cfg.brief.heavy_path).toBe("heavy-run");
	expect(cfg.brief.repo_rules).toEqual([]);
});

test("default config: a brief with no method read and no find note passes", () => {
	const p = brief("20261023_1600_default.md", null, false, cfg, ["Run the full suite through heavy-run before reporting."]);
	expect(briefLint([p], cfg)).toBe(0);
});

test("default config: a run-raw or run-batch mention is not a heavy trigger", () => {
	const p = brief("20261023_1610_runraw.md", null, false, cfg, ["Replay the sample with run-raw.sh and run-batch.sh."]);
	expect(briefLint([p], cfg)).toBe(0);
});

test("default config: a coverage batch needs no Probe line", () => {
	const p = brief("20261023_1620_coverage.md", null, false, cfg, ["Coverage batch: test-map the 255 claims in one pass."]);
	expect(briefLint([p], cfg)).toBe(0);
});

test("a config that sets method_marker still requires the method read", () => {
	expect(briefLint([brief("20261023_1700_nomethod.md", null, false, cfg)], team)).toBe(1);
	expect(briefLint([brief("20261023_1701_method.md", null, false, team)], team)).toBe(0);
});

test("a repo_rules entry (match '.', require find.*broken) reproduces the find note", () => {
	const rules: Config["brief"]["repo_rules"] = [
		{ match: ".", require: "find.*broken", message: "missing: '`find` is broken: use grep/glob/read' note" },
	];
	const finder: Config = { ...cfg, brief: { ...cfg.brief, repo_rules: rules } };
	expect(briefLint([brief("20261023_1800_nofind.md", null, false, cfg)], finder)).toBe(1);
	expect(briefLint([brief("20261023_1801_find.md", null, false, cfg, ["`find` is broken: use grep/glob/read."])], finder)).toBe(0);
});

// The repo-specific brief rules live in config (brief.repo_rules); the shipped default list is empty,
// so the same briefs stay clean without them.
function ruledBrief(name: string, title: string, bodyLine: string): string {
	const p = join(TMP, name);
	writeFileSync(
		p,
		[
			`# ${title}`,
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
			"Stop and report within ~100 tool calls.",
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
