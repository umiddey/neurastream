import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFile, loadConfig } from "../src/core/config.ts";
import { keyOf, wipRepos } from "../src/core/wip-roots.ts";
import { wipSnapshot } from "../src/core/wip-snapshot.ts";
import { wipBackup } from "../src/core/wip-backup.ts";
import { runWip } from "../src/cli/wip.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("nested repo at depth 2 found", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-nested-"));
	DIRS.push(root);
	const sub = join(root, "sub");
	const repo = join(sub, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.depth = 3;

	const repos = wipRepos(cfg);
	expect(repos).toEqual([repo]);
});

test("depth limit honoured", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-depth-"));
	DIRS.push(root);
	const deepRepo = join(root, "level1", "level2", "level3", "repo");
	mkdirSync(join(deepRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];

	cfg.wip.depth = 3;
	expect(wipRepos(cfg)).toEqual([]);

	cfg.wip.depth = 4;
	expect(wipRepos(cfg)).toEqual([deepRepo]);
});

test("repo entry found when root itself has .git", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-repo-entry-"));
	DIRS.push(root);
	const repo = join(root, "my-repo");
	mkdirSync(join(repo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [repo];

	expect(wipRepos(cfg)).toEqual([repo]);
});

test("node_modules skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-nm-"));
	DIRS.push(root);
	const nmRepo = join(root, "node_modules", "some-pkg");
	mkdirSync(join(nmRepo, ".git"), { recursive: true });
	const realRepo = join(root, "src-repo");
	mkdirSync(join(realRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];
	cfg.wip.depth = 3;

	expect(wipRepos(cfg)).toEqual([realRepo]);
});

test("never walks inside a found repo", () => {
	const root = mkdtempSync(join(tmpdir(), "wip-inside-repo-"));
	DIRS.push(root);
	const outerRepo = join(root, "outer");
	mkdirSync(join(outerRepo, ".git"), { recursive: true });
	const innerRepo = join(outerRepo, "inner");
	mkdirSync(join(innerRepo, ".git"), { recursive: true });

	const cfg = loadConfig({ home: root, file: join(root, "config.yml"), env: {} });
	cfg.wip.roots = [root];

	expect(wipRepos(cfg)).toEqual([outerRepo]);
});

test("empty roots message: wip-snapshot and wip-backup exit 0 and print advice", () => {
	const home = mkdtempSync(join(tmpdir(), "wip-roots-empty-"));
	DIRS.push(home);
	const cfg = loadConfig({ home, file: join(home, "config.yml"), env: {} });
	expect(cfg.wip.roots).toEqual([]);

	const linesSnap: string[] = [];
	const origLog = console.log;
	console.log = (s: string) => linesSnap.push(String(s));
	try {
		const code = wipSnapshot([], cfg);
		expect(code).toBe(0);
		expect(linesSnap).toEqual(["wip: no wip.roots set — run `neurastream wip add <path>`"]);
	} finally {
		console.log = origLog;
	}

	const linesBackup: string[] = [];
	console.log = (s: string) => linesBackup.push(String(s));
	try {
		const code = wipBackup([], cfg);
		expect(code).toBe(0);
		expect(linesBackup).toEqual(["wip: no wip.roots set — run `neurastream wip add <path>`"]);
	} finally {
		console.log = origLog;
	}
});

test("add/remove/list round-trip keeps comments", () => {
	const home = mkdtempSync(join(tmpdir(), "wip-cli-"));
	DIRS.push(home);
	const file = configFile(home);
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });

	const original = [
		"# Header comment",
		"paths:",
		'  home: "~"',
		"# Section comment for wip",
		"wip:",
		"  roots: []   # inline comment",
		"  depth: 3",
		"# Footer comment",
		"",
	].join("\n");
	writeFileSync(file, original);

	const listOutput: string[] = [];
	const origLog = console.log;
	console.log = (s: string) => listOutput.push(String(s));
	try {
		// List initially empty
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual([]);

		// Add /path/one
		expect(runWip(["add", "/path/one"], home)).toBe(0);
		const content1 = readFileSync(file, "utf8");
		expect(content1).toContain("# Header comment");
		expect(content1).toContain("# Section comment for wip");
		expect(content1).toContain("# Footer comment");
		expect(content1).toContain('roots: ["/path/one"]');

		// List shows /path/one
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/one"]);

		// Add /path/two
		expect(runWip(["add", "/path/two"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/one", "/path/two"]);

		// Remove /path/one
		expect(runWip(["remove", "/path/one"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual(["/path/two"]);

		// Remove /path/two
		expect(runWip(["remove", "/path/two"], home)).toBe(0);
		listOutput.length = 0;
		expect(runWip(["list"], home)).toBe(0);
		expect(listOutput).toEqual([]);

		// Comments survived the full round trip
		const finalContent = readFileSync(file, "utf8");
		expect(finalContent).toContain("# Header comment");
		expect(finalContent).toContain("# Section comment for wip");
		expect(finalContent).toContain("# Footer comment");
	} finally {
		console.log = origLog;
	}
});

test("keyOf resolves symlinks in home and path", () => {
	const base = mkdtempSync(join(tmpdir(), "wip-keyof-"));
	DIRS.push(base);
	const realHome = join(base, "real-home");
	const symHome = join(base, "sym-home");
	mkdirSync(join(realHome, "Work/demo-wt"), { recursive: true });
	symlinkSync(realHome, symHome);

	const key = keyOf(join(symHome, "Work/demo-wt"), symHome);
	expect(key).toBe("Work_demo-wt");
});
