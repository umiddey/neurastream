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

// Plans cite worktrees removed after their phases land: the whole-file path scan then fails on
// history. For a file with a `## Phases` heading only the live parts are scanned — header lines,
// Goal, Forbidden, Blockers, unticked phase lines, Done check; ticked phase lines and the history
// sections (Code read by Main, Progress, Background) are skipped. A plain brief (no `## Phases`)
// is still checked whole.
const GONE = join(TMP, "home", "projects", "gone-wt", "src", "deep", "gone.ts");

function captureLint(files: string[], c: Config = cfg): { rc: number; out: string } {
	const chunks: string[] = [];
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		return { rc: briefLint(files, c), out: chunks.join("") };
	} finally {
		process.stdout.write = orig;
	}
}

type Slot = "ticked" | "unticked" | "goal" | "done" | "read" | "progress" | "background";

// A valid plan skeleton (passes every other rule); GONE — a path that is never created — goes into
// exactly the one slot under test.
function planWith(name: string, slot: Slot): string {
	const phase =
		slot === "ticked" ? `- [x] P1 old work — verify: \`cat ${GONE}\``
		: slot === "unticked" ? `- [ ] P1 open work — verify: \`cat ${GONE}\``
		: "- [x] P1 landed work — verify: `true`";
	const lines = [
		`# ${name.replace(/\.md$/, "")}`,
		"",
		"## Goal",
		"Land the live-sections fix. Stop and report within ~60 calls.",
		...(slot === "goal" ? [`Read ${GONE} for context.`, ""] : [""]),
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		phase,
		"",
		"## Done check",
		"`bun test exit 0`",
		...(slot === "done" ? [GONE, ""] : [""]),
		...(slot === "read" ? ["## Code read by Main", `- ${GONE}`, ""] : []),
		...(slot === "background" ? ["## Background", `Old worktree note citing ${GONE}.`, ""] : []),
		"## Progress",
		"Status: open",
		...(slot === "progress" ? [`- 2026-10-24 21:00: read ${GONE}. Findings: none`, ""] : [""]),
	];
	const p = join(TMP, name);
	writeFileSync(p, lines.join("\n"));
	return p;
}

test("a plan's ticked phase line is history: its missing path does not fail", () => {
	expect(captureLint([planWith("20261024_2110_ticked.md", "ticked")]).rc).toBe(0);
});

test("a plan's Code read by Main section is history: its missing path does not fail", () => {
	expect(captureLint([planWith("20261024_2111_read.md", "read")]).rc).toBe(0);
});

test("a plan's Progress section is history: its missing path does not fail", () => {
	expect(captureLint([planWith("20261024_2112_progress.md", "progress")]).rc).toBe(0);
});

test("a plan's Background section is history: its missing path does not fail", () => {
	expect(captureLint([planWith("20261024_2113_background.md", "background")]).rc).toBe(0);
});

test("a plan's unticked phase line is live: its missing path fails", () => {
	const { rc, out } = captureLint([planWith("20261024_2120_unticked.md", "unticked")]);
	expect(rc).toBe(1);
	expect(out).toContain(GONE);
});

test("a plan's Goal is live: its missing path fails", () => {
	const { rc, out } = captureLint([planWith("20261024_2121_goal.md", "goal")]);
	expect(rc).toBe(1);
	expect(out).toContain(GONE);
});

test("a plan's Done check is live: its missing path fails", () => {
	const { rc, out } = captureLint([planWith("20261024_2122_done.md", "done")]);
	expect(rc).toBe(1);
	expect(out).toContain(GONE);
});

test("a plain brief without Phases is still checked whole", () => {
	const p = join(TMP, "20261024_2130_plain.md");
	writeFileSync(
		p,
		[
			"# 20261024_2130_plain",
			"",
			"## Goal",
			"Ship a small script fix. Stop and report within ~60 calls.",
			`Read ${GONE} for context.`,
			"",
			"## Forbidden",
			"- never push",
			"",
			"## Done check",
			"`bun test exit 0`",
			"",
		].join("\n"),
	);
	const { rc, out } = captureLint([p]);
	expect(rc).toBe(1);
	expect(out).toContain(GONE);
});

// --- P4/P4b (plan 20261028_1600): MR naming, main-checkout plan paths, blocker scope ---

test("a brief naming an MR in prose is refused; the MR !N: line passes", () => {
	const prose = captureLint([
		brief("20261028_1500_mr_prose.md", null, false, cfg, ["Finish the work pushed as MR !211 first."]),
	]);
	expect(prose.rc).toBe(1);
	expect(prose.out).toContain("MR !211 is named in prose");
	const line = brief("20261028_1501_mr_line.md", null, false, cfg, [
		"MR !211: the e2 classification half — this task: only the export half",
	]);
	expect(briefLint([line], cfg)).toBe(0);
});

test("a plan (Progress section) may mention an MR in prose", () => {
	const p = join(TMP, "20261028_1502_plan_mr.md");
	writeFileSync(
		p,
		[
			"# 20261028_1502_plan_mr",
			"",
			"## Goal",
			"- Never redo work already pushed as MR !211. Stop and report within ~60 calls.",
			"",
			"## Forbidden",
			"- never push",
			"",
			"## Phases",
			"- [ ] P1 gate — verify: `true`",
			"",
			"## Done check",
			"`true`",
			"",
			"## Progress",
			"Status: open",
			"",
		].join("\n"),
	);
	expect(briefLint([p], cfg)).toBe(0);
});

// --- P4/P4b (plan 20261028_1600): MR naming, main-checkout plan paths, blocker scope ---

const ROOT = join(TMP, "home", "projects", "toy");
const WT = join(TMP, "home", "wt-toy");
const BLOCKERS = join(TMP, "home", ".omp", "agent", "blockers");
const PLAN_BASE = "20261028_1400_scoped.md";
const scopeCfg: Config = loadConfig({
	home: join(TMP, "home"),
	env: { MAIN_GUARD_ROOTS: ROOT, QUEUE_BLOCKERS: BLOCKERS },
});

function scopeFixture(): void {
	mkdirSync(join(ROOT, "docs/plans"), { recursive: true });
	mkdirSync(join(WT, "docs/plans"), { recursive: true });
	mkdirSync(join(WT, "src/core"), { recursive: true });
	mkdirSync(join(WT, "tests"), { recursive: true });
	mkdirSync(BLOCKERS, { recursive: true });
	const plan = [
		"# scoped plan",
		"",
		"## Goal",
		"- Stay in scope. Stop and report within ~60 calls.",
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- scope.sh",
		"",
		"## Phases",
		"- [ ] P1 gate — verify: `true`",
		"",
		"## Done check",
		"`true`",
		"",
		"## Progress",
		"Status: open",
		"",
	].join("\n");
	writeFileSync(join(ROOT, "docs/plans", PLAN_BASE), plan);
	writeFileSync(join(WT, "docs/plans", PLAN_BASE), plan);
	writeFileSync(join(WT, "src/core/guards.ts"), "export const x = 1;\n");
	writeFileSync(join(WT, "src/core/brief-lint.ts"), "export const y = 1;\n");
	writeFileSync(join(WT, "tests/one.test.ts"), "test('x', () => {});\n");
	writeFileSync(join(BLOCKERS, "scope.sh"), "#!/bin/sh\nALLOWED='^(src/core/guards\\.ts|tests/one\\.test\\.ts)$'\nexit 0\n");
}

// A brief that satisfies every other rule and names one file under the toy worktree.
function scopeBrief(name: string, body: string): string {
	const p = join(TMP, name);
	writeFileSync(
		p,
		[
			"# " + name.replace(/\.md$/, ""),
			"",
			"## Goal",
			"- Work the scoped plan. Stop and report within ~60 calls.",
			"",
			body,
			"",
			"## Forbidden",
			"- never push",
			"",
			"## Acceptance",
			"- exit 0",
			"",
		].join("\n"),
	);
	return p;
}

test("a brief naming the plan copy in a worktree is refused; the main checkout path passes", () => {
	scopeFixture();
	const noPlan = captureLint([scopeBrief("20261028_1510_no_plan.md", "Read more of the plan someday.")], scopeCfg);
	expect(noPlan.rc).toBe(1);
	expect(noPlan.out).toContain("no line names the plan's absolute path in its main checkout");
	const wtCopy = captureLint(
		[scopeBrief("20261028_1511_wt_copy.md", `Plan: ${join(WT, "docs/plans", PLAN_BASE)} has the phases.`)],
		scopeCfg,
	);
	expect(wtCopy.rc).toBe(1);
	expect(wtCopy.out).toContain("worktree path");
	const mainCopy = scopeBrief("20261028_1512_main_copy.md", `Plan: ${join(ROOT, "docs/plans", PLAN_BASE)} has the phases.`);
	expect(briefLint([mainCopy], scopeCfg)).toBe(0);
});

test("a src/tests path the plan's blocker ALLOWED regex rejects is refused", () => {
	scopeFixture();
	const inScope = scopeBrief(
		"20261028_1520_in_scope.md",
		[`Plan: ${join(ROOT, "docs/plans", PLAN_BASE)} has the phases.`, `Touch ${join(WT, "src/core/guards.ts")} only.`].join("\n"),
	);
	expect(briefLint([inScope], scopeCfg)).toBe(0);
	const outScope = captureLint(
		[
			scopeBrief(
				"20261028_1521_out_scope.md",
				[`Plan: ${join(ROOT, "docs/plans", PLAN_BASE)} has the phases.`, `Touch ${join(WT, "src/core/brief-lint.ts")} too.`].join("\n"),
			),
		],
		scopeCfg,
	);
	expect(outScope.rc).toBe(1);
	expect(outScope.out).toContain("scope.sh does not allow src/core/brief-lint.ts");
});

