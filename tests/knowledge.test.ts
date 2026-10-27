import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "../src/core/config.ts";
import { knowledgeManifest, knowledgeManifestPath, scanKnowledge } from "../src/core/knowledge.ts";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function gitInit(dir: string, remote?: string): void {
	spawnSync("git", ["init", "-q", dir]);
	spawnSync("git", ["-C", dir, "config", "user.email", "k@test"]);
	spawnSync("git", ["-C", dir, "config", "user.name", "k"]);
	if (remote) spawnSync("git", ["-C", dir, "remote", "add", "origin", remote]);
}

function commitAll(dir: string, msg: string): void {
	spawnSync("git", ["-C", dir, "add", "-A"]);
	spawnSync("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

function cfgFor(root: string, state: string): Config {
	return {
		knowledge: { roots: [root], max_age_s: 300 },
		paths: { queue_state: state },
	} as Config;
}

test("scanKnowledge lists topics with titles and skips repos without docs/knowledge", () => {
	const root = mkdtempSync(join(tmpdir(), "ns-know-"));
	roots.push(root);
	const withTopics = join(root, "alpha-app");
	const bare = join(root, "no-docs");
	mkdirSync(join(withTopics, "docs", "knowledge"), { recursive: true });
	mkdirSync(bare, { recursive: true });
	writeFileSync(join(withTopics, "docs", "knowledge", "one.html"), "<!doctype html><title>First topic</title><p>x</p>");
	writeFileSync(join(withTopics, "docs", "knowledge", "two.html"), "<html><head><title>Second</title></head></html>");
	gitInit(withTopics, "https://gitlab.com/org/alpha-app.git");
	commitAll(withTopics, "topics");
	gitInit(bare);
	commitAll(bare, "empty");
	const entries = scanKnowledge([root], Date.now());
	expect(entries.map(e => `${e.repo}/${e.topic}`)).toEqual(["alpha-app/one", "alpha-app/two"]);
	expect(entries[0]!.title).toBe("First topic");
	expect(entries[1]!.title).toBe("Second");
});

test("scanKnowledge uses directory name when origin is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "ns-know-"));
	roots.push(root);
	const repo = join(root, "local-only");
	mkdirSync(join(repo, "docs", "knowledge"), { recursive: true });
	writeFileSync(join(repo, "docs", "knowledge", "x.html"), "<title>T</title>");
	gitInit(repo);
	commitAll(repo, "t");
	expect(scanKnowledge([root], Date.now())[0]!.repo).toBe("local-only");
});

test("scanKnowledge skips linked worktrees", () => {
	const root = mkdtempSync(join(tmpdir(), "ns-know-"));
	roots.push(root);
	const main = join(root, "main-repo");
	const wt = join(root, "wt-checkout");
	mkdirSync(join(main, "docs", "knowledge"), { recursive: true });
	writeFileSync(join(main, "docs", "knowledge", "only.html"), "<title>Main</title>");
	gitInit(main, "git@github.com:acme/main-repo.git");
	commitAll(main, "topic");
	spawnSync("git", ["-C", main, "worktree", "add", wt, "-q"]);
	const entries = scanKnowledge([root], Date.now());
	expect(entries.map(e => e.repo)).toEqual(["main-repo"]);
});

test("knowledgeManifest reuses fresh cache and rebuilds when stale", () => {
	const root = mkdtempSync(join(tmpdir(), "ns-know-"));
	const state = mkdtempSync(join(tmpdir(), "ns-know-state-"));
	roots.push(root, state);
	const repo = join(root, "cached");
	mkdirSync(join(repo, "docs", "knowledge"), { recursive: true });
	writeFileSync(join(repo, "docs", "knowledge", "a.html"), "<title>A</title>");
	gitInit(repo);
	commitAll(repo, "a");
	const cfg = cfgFor(root, state);
	const t0 = 1_700_000_000;
	const first = knowledgeManifest(cfg, t0);
	expect(first).toHaveLength(1);
	const path = knowledgeManifestPath(cfg);
	expect(existsSync(path)).toBe(true);
	writeFileSync(join(repo, "docs", "knowledge", "b.html"), "<title>B</title>");
	commitAll(repo, "b");
	const cached = knowledgeManifest(cfg, t0 + 10);
	expect(cached).toHaveLength(1);
	const rebuilt = knowledgeManifest(cfg, t0 + 400);
	expect(rebuilt.map(e => e.topic).sort()).toEqual(["a", "b"]);
});

test("unreadable roots are skipped without throwing", () => {
	expect(scanKnowledge(["/nonexistent-root-xyz"], Date.now())).toEqual([]);
});
