// P6 (plan 20261024_1915): the removal check — src/core/diff-check.ts's pure scan over a unified
// diff plus the `neurastream diff-check` CLI and the labels.removal_* config keys' fail-open
// regex handling. The plan-guard commit refusal (the staged-diff gate, Main exempt) lives in
// tests/guards.test.ts.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { removalFlags } from "../src/core/diff-check.ts";

const REPO = dirname(dirname(import.meta.path));

// A sandbox HOME with no config.yml: the merged config is exactly the template defaults.
function sandboxConfig(): Config {
	return loadConfig({ home: mkdtempSync(join(tmpdir(), "ns-diffcheck-home-")), env: {} });
}

// A sandbox HOME whose config overrides labels.removal_comment_patterns with `patterns` (a YAML flow list).
function homeWithPatterns(patterns: string): string {
	const home = mkdtempSync(join(tmpdir(), "ns-diffcheck-bad-"));
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`labels:\n  repos: []\n  removal_comment_patterns: ${patterns}\n`,
	);
	return home;
}

// A unified diff of src/a.ts gaining one comment line between two existing lines.
const COMMENT_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	" export const a = 1;",
	"+// removed old helper",
	" export const b = 2;",
].join("\n");

// The same file gaining a plain code line: not a comment, so without a removal subject it passes.
const CODE_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	" export const a = 1;",
	"+export const previously = 2;",
	" export const b = 2;",
].join("\n");

const PURE_DELETION_DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1111111..2222222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,3 +1,2 @@",
	" export const a = 1;",
	"-// removed old helper",
	" export const b = 2;",
].join("\n");

// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
function envWithoutQueue(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
}

describe("removalFlags (pure)", () => {
	test("an added comment line matching a removal pattern is flagged with its new-file line", () => {
		expect(removalFlags(COMMENT_DIFF, "feat: add b", sandboxConfig())).toEqual([
			{ file: "src/a.ts", line: 2, text: "// removed old helper" },
		]);
	});

	test("a pure deletion passes: removed and context lines never flag", () => {
		expect(removalFlags(PURE_DELETION_DIFF, "chore: cleanup", sandboxConfig())).toEqual([]);
	});

	test("an added non-comment line is not flagged without a removal subject", () => {
		expect(removalFlags(CODE_DIFF, "feat: add b", sandboxConfig())).toEqual([]);
	});

	test("a removal subject flags every added non-blank line, code included", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1111111..2222222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,4 @@",
			" export const a = 1;",
			"+helper();",
			"+",
			"+export const b = 2;",
		].join("\n");
		expect(removalFlags(diff, "remove old helper", sandboxConfig())).toEqual([
			{ file: "src/a.ts", line: 2, text: "helper();" },
			{ file: "src/a.ts", line: 4, text: "export const b = 2;" },
		]);
	});

	test("the ^chore: remove subject matches too; an unrelated subject does not", () => {
		expect(removalFlags(CODE_DIFF, "chore: remove leftovers", sandboxConfig()).map(f => f.text)).toEqual(["export const previously = 2;"]);
		expect(removalFlags(CODE_DIFF, "feat: add previously", sandboxConfig())).toEqual([]);
	});

	test("hunk headers drive the line numbers across hunks and files", () => {
		const diff = [
			"diff --git a/src/one.ts b/src/one.ts",
			"index 1111111..2222222 100644",
			"--- a/src/one.ts",
			"+++ b/src/one.ts",
			"@@ -10,3 +10,4 @@",
			" const keep = 1;",
			"+// no longer used",
			" const keep2 = 2;",
			"diff --git a/src/two.ts b/src/two.ts",
			"index 3333333..4444444 100644",
			"--- a/src/two.ts",
			"+++ b/src/two.ts",
			"@@ -40,2 +40,3 @@",
			" const a = 1;",
			"+// was deleted elsewhere",
			" const b = 2;",
		].join("\n");
		expect(removalFlags(diff, "", sandboxConfig())).toEqual([
			{ file: "src/one.ts", line: 11, text: "// no longer used" },
			{ file: "src/two.ts", line: 41, text: "// was deleted elsewhere" },
		]);
	});
});

describe("fail-open config regexes", () => {
	test("a regex that does not compile is skipped; a compiling one beside it still flags", () => {
		const bad = loadConfig({ home: homeWithPatterns("['([bad', '\\bremoved\\b']"), env: {} });
		expect(removalFlags(COMMENT_DIFF, "", bad)).toEqual([{ file: "src/a.ts", line: 2, text: "// removed old helper" }]);
	});

	test("every pattern failing to compile flags nothing and never throws", () => {
		const bad = loadConfig({ home: homeWithPatterns("['([bad']"), env: {} });
		expect(removalFlags(COMMENT_DIFF, "", bad)).toEqual([]);
	});
});

describe("diff-check CLI", () => {
	const HOME = join(tmpdir(), "ns-diffcheck-cli-home");

	function git(dir: string, args: string[]): void {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...envWithoutQueue(), HOME } });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	}

	function repo(): string {
		const dir = mkdtempSync(join(tmpdir(), "ns-diffcheck-repo-"));
		git(dir, ["init", "-q"]);
		git(dir, ["config", "user.email", "t@example.invalid"]);
		git(dir, ["config", "user.name", "t"]);
		writeFileSync(join(dir, "helper.txt"), "kept line\nold helper\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "base"]);
		return dir;
	}

	function diffCli(args: string[], cwd: string): { code: number; out: string; err: string } {
		const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "diff-check", ...args], {
			cwd,
			encoding: "utf8",
			env: { ...envWithoutQueue(), HOME },
		});
		return { code: r.status ?? 1, out: r.stdout.trim(), err: r.stderr.trim() };
	}

	test("--staged exits 1 and prints file:line: text for a staged removal comment", () => {
		rmSync(HOME, { recursive: true, force: true });
		const dir = repo();
		writeFileSync(join(dir, "helper.txt"), "kept line\nold helper\n# removed old helper\n");
		git(dir, ["add", "-A"]);
		const r = diffCli(["--staged"], dir);
		expect(r.code).toBe(1);
		expect(r.out).toBe("helper.txt:3: # removed old helper");
		rmSync(dir, { recursive: true, force: true });
	});

	test("--staged exits 0 on a pure deletion", () => {
		const dir = repo();
		writeFileSync(join(dir, "helper.txt"), "kept line\n");
		git(dir, ["add", "-A"]);
		const r = diffCli(["--staged"], dir);
		expect(r.code).toBe(0);
		expect(r.out).toBe("");
		rmSync(dir, { recursive: true, force: true });
	});

	test("<rev> applies the commit subject: a removal commit flags its added non-blank lines", () => {
		const dir = repo();
		writeFileSync(join(dir, "helper.txt"), "kept line\nold helper\ncallOldHelper();\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "remove old helper"]);
		const r = diffCli(["HEAD"], dir);
		expect(r.code).toBe(1);
		expect(r.out).toBe("helper.txt:3: callOldHelper();");
		rmSync(dir, { recursive: true, force: true });
	});

	test("bad usage exits 2: no argument, both --staged and a rev, an unknown flag", () => {
		const dir = repo();
		expect(diffCli([], dir).code).toBe(2);
		expect(diffCli(["--staged", "HEAD"], dir).code).toBe(2);
		expect(diffCli(["--future"], dir).code).toBe(2);
		rmSync(dir, { recursive: true, force: true });
	});

	test("outside a git repo the failure is reported, never read as clean", () => {
		const bare = mkdtempSync(join(tmpdir(), "ns-diffcheck-bare-"));
		const r = diffCli(["--staged"], bare);
		expect(r.code).toBe(1);
		expect(r.err).not.toBe("");
		rmSync(bare, { recursive: true, force: true });
	});
});
