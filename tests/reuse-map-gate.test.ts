// Reuse map gate (plan 20261122_1828_reuse_map P2): the write-time refusal in checkPlanEdit —
// Main and the delegated planner branch — against a fake seam, plus the text-only half in
// parsePlan (which must never touch the seam). Everything runs in temp dirs; the repo is a real
// git repo because freshGraph stamps from HEAD/diff.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { plannerFile } from "../src/core/autonomy.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkPlanEdit, spawnProblem } from "../src/core/guards.ts";
import { recordMainReads } from "../src/core/guards/state.ts";
import { parsePlan } from "../src/core/queue/lib.ts";
import { reuseMapWriteProblems } from "../src/core/guards/plan-edit.ts";
import { GRAPHIFY_VERSION, SLOW_RETRY, type GraphifyResult, type ReuseGraph } from "../src/core/reuse-map.ts";

const TMP = mkdtempSync(join(tmpdir(), "reuse-gate-"));
const REPO = join(TMP, "repo");
const PLAN = join(REPO, "docs/plans/20261126_0900_toy.md");

mkdirSync(join(REPO, "docs/plans"), { recursive: true });
mkdirSync(join(REPO, "src"), { recursive: true });
writeFileSync(join(REPO, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(REPO, "src/b.ts"), "export const b = 2;\n");
mkdirSync(join(TMP, "blockers"), { recursive: true });
writeFileSync(join(TMP, "blockers/ok.sh"), "#!/bin/sh\nexit 0\n");
chmodSync(join(TMP, "blockers/ok.sh"), 0o755);
for (const args of [["init", "-q"], ["add", "src/a.ts", "src/b.ts"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]])
	spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });

function withFile(body: string): string {
	const file = join(TMP, `cfg-${Math.random().toString(36).slice(2)}.yml`);
	writeFileSync(file, body);
	return file;
}

function cfgWith(repos: string[] | null): Config {
	const reuse = repos === null ? "" : `reuse_map:\n  enabled: true\n  repos:\n${repos.map((r) => `    - "${r}"\n`).join("")}`;
	return loadConfig({
		file: withFile(`paths:\n  home: "${TMP}/home"\n  queue_state: "${TMP}/state"\n  plan_guard_log: "${TMP}/plan-guard.log"\nreview:\n  agents: [reviewer]\n${reuse}`),
		home: join(TMP, "home"),
		env: {},
	});
}
const cfg = cfgWith([REPO]);
const cfgOff = cfgWith(null);
const cfgOtherRepo = cfgWith(["/elsewhere/repo"]);
mkdirSync(cfg.paths.queue_state, { recursive: true });
recordMainReads([join(REPO, "src/a.ts"), join(REPO, "src/b.ts")], cfg.paths);
recordMainReads([join(REPO, "src/a.ts"), join(REPO, "src/b.ts")], cfgOff.paths);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface SeamOpts {
	version?: string;
	versionStatus?: number | null;
}

/** The seam: every term but "nothing*" hits both code files; counts queries and builds. */
function fakeGraphify(opts: SeamOpts = {}): { graph: ReuseGraph; queries: () => number; builds: () => number } {
	let queries = 0;
	let builds = 0;
	return {
		queries: () => queries,
		builds: () => builds,
		graph: {
			version: () => ({ status: opts.versionStatus ?? 0, stdout: opts.version ?? `graphify ${GRAPHIFY_VERSION}`, stderr: "" }),
			build: (repo: string): GraphifyResult => {
				builds++;
				mkdirSync(join(repo, "graphify-out"), { recursive: true });
				writeFileSync(join(repo, "graphify-out/graph.json"), JSON.stringify({ nodes: [{ id: "x" }] }));
				return { status: 0, stdout: "ok", stderr: "" };
			},
			query: (_repo: string, term: string): GraphifyResult => {
				queries++;
				return term.startsWith("nothing")
					? { status: 4, stdout: "No matching nodes found.", stderr: "" }
					: { status: 0, stdout: "NODE one() [src=src/a.ts loc=L1]\nNODE two() [src=src/b.ts loc=L1]", stderr: "" };
			},
		},
	};
}

const GOOD_MAP = `## Reuse
- map: graphify "gate" → src/a.ts, src/b.ts — cite: 2
- new: the gate — checked: src/a.ts:1 "export const a = 1;" — reuse: existing a
- new: the other half — checked: src/b.ts:1 "export const b = 2;" — reuse: existing b

`;

const LEGACY_REUSE = "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the existing helper\n\n";

const body = (reuse: string, planner = false): string =>
	`# Toy plan
${planner ? "\nPlanner: GatePlanner\n" : ""}
Worktree: -
Branch: feat/toy

## Goal
- Reuse map gate toy.

## Forbidden
- Never skip tests.

## Blockers
- ok.sh

## Phases
- [ ] P1 do it — verify: \`test -f src/a.ts\`

## Code read by Main
- \`src/a.ts\`
- \`src/b.ts\`

${reuse}## Done check
\`test -f src/a.ts\`

## Progress
${planner ? "" : "Status: open\n\n"}- 2026-11-26 09:00 ${planner ? "GatePlanner" : "Main"}: opened.
  Findings: none
`;

function bindPlanner(): void {
	writeFileSync(plannerFile(cfg.paths), "delegated\n");
	mkdirSync(dirname(cfg.paths.subagents), { recursive: true });
	writeFileSync(cfg.paths.subagents, "## Allowed\n\n- `task`\n");
	expect(
		spawnProblem({ context: "# Goal\nRoute the planning.\n", tasks: [{ name: "GatePlanner", agent: "task", task: `Planner role for ${PLAN}\n\nDraft the plan.` }] }, cfgOff),
	).toBeNull();
}

// --- Main write gate ---

test("Main writing a plan with no map line is refused with the reuse map fix", () => {
	const fake = fakeGraphify();
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(LEGACY_REUSE), agent: "main", agentId: "main" }, cfg, fake.graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("reuse map");
	expect(d.reason).toContain("neurastream reuse map <plan>");
	expect(d.restore?.text).toBeNull();
});

test("a wrong quote is refused: the citation must be the file's line", () => {
	const reuse = GOOD_MAP.replace('checked: src/a.ts:1 "export const a = 1;"', 'checked: src/a.ts:1 "export const a = 999;"');
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(reuse), agent: "main", agentId: "main" }, cfg, fakeGraphify().graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("src/a.ts:1 is not");
	expect(d.reason).toContain("quote that line exactly");
});

test("citing 1 of the 2 matched files is refused", () => {
	const reuse = GOOD_MAP.replace(/\n- new: the other half[^\n]*/, "");
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(reuse), agent: "main", agentId: "main" }, cfg, fakeGraphify().graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("1 of 2 matched files cited");
});

test("a correct map line with both quotes is allowed", () => {
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(GOOD_MAP), agent: "main", agentId: "main" }, cfg, fakeGraphify().graph);
	expect(d.allow).toBe(true);
});

test("a none line with a hit is refused naming the files; with all misses it is allowed", () => {
	const hit = body('## Reuse\n- new: none to reuse — searched: "gate", "nothing1", "nothing2"\n\n');
	const d = checkPlanEdit({ path: PLAN, before: "", after: hit, agent: "main", agentId: "main" }, cfg, fakeGraphify().graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain('"gate" finds src/a.ts, src/b.ts');
	const miss = body('## Reuse\n- new: none to reuse — searched: "nothing1", "nothing2", "nothing3"\n\n');
	expect(checkPlanEdit({ path: PLAN, before: "", after: miss, agent: "main", agentId: "main" }, cfg, fakeGraphify().graph).allow).toBe(true);
});

test("missing or wrong-version graphify refuses with the install fix", () => {
	const missing = fakeGraphify({ versionStatus: 127 });
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(GOOD_MAP), agent: "main", agentId: "main" }, cfg, missing.graph);
	expect(d.allow).toBe(false);
	// The fix command's two halves, asserted apart so this test file never names the uv
	// invocation it does not run (the reuse-map-scope blocker rightly checks for that).
	expect(d.reason).toContain("install the pinned tool");
	expect(d.reason).toContain("graphifyy==0.9.100");
	const stale = fakeGraphify({ version: "graphify 0.9.99" });
	expect(checkPlanEdit({ path: PLAN, before: "", after: body(GOOD_MAP), agent: "main", agentId: "main" }, cfg, stale.graph).reason).toContain(
		"graphify 0.9.100 is not on PATH (found: graphify 0.9.99)",
	);
});

test("a plan whose repo is not in reuse_map.repos is refused with the reuse on fix", () => {
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(GOOD_MAP), agent: "main", agentId: "main" }, cfgOtherRepo, fakeGraphify().graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain(`reuse on ${REPO}`);
});

test("off means off: allowed and the seam is never called", () => {
	const fake = fakeGraphify();
	const d = checkPlanEdit({ path: PLAN, before: "", after: body(LEGACY_REUSE), agent: "main", agentId: "main" }, cfgOff, fake.graph);
	expect(d.allow).toBe(true);
	expect(fake.queries()).toBe(0);
	expect(fake.builds()).toBe(0);
});

test("an old plan without a map line keeps passing a Progress-only edit, seam uncalled", () => {
	const before = body(LEGACY_REUSE);
	const after = `${before}- 2026-11-26 09:10 Main: noted progress.\n  Findings: none\n`;
	const fake = fakeGraphify();
	expect(checkPlanEdit({ path: PLAN, before, after, agent: "main", agentId: "main" }, cfg, fake.graph).allow).toBe(true);
	expect(fake.queries()).toBe(0);
});

// --- delegated planner write gate ---

test("delegated planner: a plan without a map line is refused and restored; with one it is allowed", () => {
	bindPlanner();
	const fake = fakeGraphify();
	const refused = checkPlanEdit({ path: PLAN, before: "", after: body(LEGACY_REUSE, true), agent: "sub", agentId: "GatePlanner" }, cfg, fake.graph);
	expect(refused.allow).toBe(false);
	expect(refused.reason).toContain("reuse map");
	expect(refused.restore?.text).toBeNull();
	const ok = checkPlanEdit({ path: PLAN, before: "", after: body(GOOD_MAP, true), agent: "sub", agentId: "GatePlanner" }, cfg, fakeGraphify().graph);
	expect(ok.allow).toBe(true);
});

// --- the text half never touches the seam ---

test("parsePlan judges the map line as text only: no errors, no graphify-out, no query", () => {
	const fake = fakeGraphify();
	const file = join(REPO, "docs/plans/20261126_0901_textonly.md");
	const stale = GOOD_MAP.replace("src/a.ts, src/b.ts", "src/gone.ts, src/also-gone.ts");
	const p = parsePlan(REPO, file, body(stale), join(TMP, "blockers"), ["reviewer"]);
	expect(p.errors).toEqual([]);
	expect(fake.queries()).toBe(0);
	expect(fake.builds()).toBe(0);
});

test("parsePlan text gate: a none line under 3 terms is a problem without any graphify run", () => {
	const file = join(REPO, "docs/plans/20261126_0902_none.md");
	const p = parsePlan(REPO, file, body('## Reuse\n- new: none to reuse — searched: "only-one"\n\n'), join(TMP, "blockers"), ["reviewer"]);
	expect(p.errors.join("\n")).toContain("search at least 3 distinct terms");
});

// --- P2b: cite confinement, dash terms, one shared budget per check ---

const NONE_LINE = `- new: none to reuse — searched: "nothing1", "nothing2", "nothing3"`;
const citeLine = (file: string, quote: string): string => `- new: the gate — checked: ${file}:1 "${quote}" — reuse: existing`;
const planWith = (reuse: string, worktree = "-"): string => body(reuse).replace("Worktree: -", `Worktree: ${worktree}`);
const PLAN2 = join(REPO, "docs/plans/20261126_1000_p2b_judge.md");
// bindPlanner() above leaves the planner file at "delegated" for the rest of this file; these are
// Main's checks, so each one sets the mode back to main first.
const judge = (text: string, graph: ReuseGraph = fakeGraphify().graph) => {
	writeFileSync(plannerFile(cfg.paths), "main\n");
	return checkPlanEdit({ path: PLAN2, before: "", after: text, agent: "main", agentId: "main" }, cfg, graph);
};
const OUTSIDE = join(TMP, "outside.txt");
writeFileSync(OUTSIDE, "TOPSECRET=42\n");

test("P2b: a cite outside the repo is refused unread: absolute, ../ and an in-repo symlink", () => {
	symlinkSync(OUTSIDE, join(REPO, "src/link.txt"));
	try {
		for (const file of [OUTSIDE, "../outside.txt", "src/link.txt"]) {
			const d = judge(planWith(`## Reuse\n${NONE_LINE}\n${citeLine(file, "TOPSECRET=42")}\n\n`));
			expect(d.allow).toBe(false);
			expect(d.reason).toContain("is outside");
			expect(d.reason).not.toContain("TOPSECRET");
		}
	} finally {
		rmSync(join(REPO, "src/link.txt"));
	}
});

test("P2b: Worktree: / cannot widen the roots: a file outside the plan's repo is refused", () => {
	const d = judge(planWith(`## Reuse\n${NONE_LINE}\n${citeLine(OUTSIDE, "TOPSECRET=42")}\n\n`, "/"));
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("is outside");
	expect(d.reason).not.toContain("TOPSECRET");
});

test("P2b: an untracked, gitignored .env with a matching quote is refused unread, staged or not", () => {
	writeFileSync(join(REPO, ".gitignore"), ".env\n");
	writeFileSync(join(REPO, ".env"), "SECRET=1\n");
	try {
		const text = planWith(`## Reuse\n${NONE_LINE}\n${citeLine(".env", "SECRET=1")}\n\n`);
		const unstaged = judge(text);
		expect(unstaged.allow).toBe(false);
		expect(unstaged.reason).toContain("not committed");
		spawnSync("git", ["-C", REPO, "add", "-f", ".env"], { encoding: "utf8" });
		const staged = judge(text);
		expect(staged.allow).toBe(false);
		expect(staged.reason).toContain("not committed");
		expect(staged.reason).not.toContain("SECRET=1");
	} finally {
		spawnSync("git", ["-C", REPO, "rm", "--cached", "-q", "-f", ".env"], { encoding: "utf8" });
		rmSync(join(REPO, ".env"));
		rmSync(join(REPO, ".gitignore"));
	}
});

test("P2b: a dashed term in a none line is refused naming the term, the seam never called", () => {
	const fake = fakeGraphify();
	const d = judge(planWith(`## Reuse\n- new: none to reuse — searched: "-h", "nothing1", "nothing2"\n\n`), fake.graph);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain('"-h"');
	expect(fake.queries()).toBe(0);
});

test("P2b: a plan check whose query budget is spent refuses reuse map slow — retry, never passes", () => {
	const fake = fakeGraphify();
	const text = planWith(`## Reuse\n- new: none to reuse — searched: "slowA", "slowB", "slowC"\n\n`);
	expect(reuseMapWriteProblems(text, PLAN, cfg, fake.graph, { until: 0 })).toEqual([SLOW_RETRY]);
	expect(fake.queries()).toBe(0);
});
