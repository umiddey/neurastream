// A repo's own rules (plan 20261027_1530 P1): the AGENTS.md of the plan's repo, cut at
// rules.max_bytes, the plan's Worktree rules when they differ, the code-burden rule read from the
// template, and the per-session hash cache that keeps the same text out of a second turn.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { burdenRule, repoRules, rulesChanged } from "../src/core/repo-rules.ts";

const TMP = mkdtempSync(join(tmpdir(), "repo-rules-"));
const cfg = loadConfig({ home: join(TMP, "home"), env: {} });

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

let n = 0;

/** A repo with one plan, and its AGENTS.md when `agents` is text. */
function repo(agents: string | null, planExtra = ""): { root: string; plan: string } {
	const root = join(TMP, `repo${++n}`);
	mkdirSync(join(root, "docs/plans"), { recursive: true });
	const r = spawnSync("git", ["init", "-q"], { cwd: root });
	if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
	if (agents !== null) writeFileSync(join(root, "AGENTS.md"), agents);
	const plan = join(root, "docs/plans/20261027_toy.md");
	writeFileSync(plan, `# Toy plan\n\nWorktree: -\nBranch: feat/toy\n${planExtra}\n## Progress\nStatus: open\n`);
	return { root, plan };
}

test("found: the plan's repo AGENTS.md text, with its path", () => {
	const { root, plan } = repo("# our rules\n\n- No push.\n");
	expect(repoRules(cfg, plan)).toEqual({ path: join(root, "AGENTS.md"), text: "# our rules\n\n- No push.\n" });
});

test("missing: no AGENTS.md in the repo, no rules (null)", () => {
	const { plan } = repo(null);
	expect(repoRules(cfg, plan)).toBeNull();
});

test("oversize: text is cut at rules.max_bytes and one line names the file", () => {
	const { root, plan } = repo(`${"x".repeat(50)}\n`);
	const small = { ...cfg, rules: { max_bytes: 20 } };
	const rules = repoRules(small, plan);
	expect(rules?.text).toBe(`${"x".repeat(20)}\n…cut, read ${join(root, "AGENTS.md")}`);
});

test("worktree: the plan's Worktree AGENTS.md wins when it differs, the repo's when it does not", () => {
	const { root, plan } = repo("# main rules\n");
	const wt = join(TMP, "wt");
	mkdirSync(wt, { recursive: true });
	writeFileSync(join(wt, "AGENTS.md"), "# worktree rules\n");
	writeFileSync(plan, `# Toy plan\n\nWorktree: ${wt}\nBranch: feat/toy\n\n## Progress\nStatus: open\n`);
	expect(repoRules(cfg, plan)).toEqual({ path: join(wt, "AGENTS.md"), text: "# worktree rules\n" });
	writeFileSync(join(wt, "AGENTS.md"), "# main rules\n");
	expect(repoRules(cfg, plan)).toEqual({ path: join(root, "AGENTS.md"), text: "# main rules\n" });
});

test("burden rule: read from templates/AGENTS.md, not written in code", () => {
	const rule = burdenRule();
	expect(rule.startsWith("- Code is a burden:")).toBe(true);
	expect(rule).toContain("justify its keep");
});

test("rulesChanged: same text in the same session is not injected twice; an edit comes back once", () => {
	const path = join(TMP, "AGENTS.md");
	const session = `s${n}`;
	expect(rulesChanged(cfg, session, path, "one")).toBe(true);
	expect(rulesChanged(cfg, session, path, "one")).toBe(false);
	// Another session gets it too: the cache is per session, not global.
	expect(rulesChanged(cfg, `${session}b`, path, "one")).toBe(true);
	expect(rulesChanged(cfg, session, path, "two")).toBe(true);
	expect(rulesChanged(cfg, session, path, "two")).toBe(false);
	// A second file in the same session is its own entry.
	expect(rulesChanged(cfg, session, `${path}.b`, "two")).toBe(true);
});
