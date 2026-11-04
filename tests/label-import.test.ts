import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Episode } from "../src/core/episodes.ts";
import { importWhytrailLabels } from "../src/core/label-import.ts";
import { labelLedgerPath } from "../src/core/labels.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "ns-label-import-"));
	dirs.push(dir);
	return dir;
}

function episode(id: string, plan: string): Episode {
	return { id, agent: id.split(":")[0]!, model: "model", plan, phase: "P2", repo: "", commits: [], runId: id.split(":")[0]!, briefRef: null, acceptedAt: null, rework: false };
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
	git("init", "-q");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	writeFileSync(join(dir, "file.txt"), "x\n");
	git("add", "file.txt");
	git("commit", "-qm", "init");
}

/** The cards.jsonl path the import must snapshot, resolved exactly like whytrail's own repoContext. */
function cardsPath(repo: string): string {
	const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
	return join(common.replace(/\/\.git$/, "").replace(/\/$/, ""), ".whytrail", "cards.jsonl");
}

function seedCards(repo: string, content: string): string {
	const path = cardsPath(repo);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	return path;
}

/** A stub `whytrail` on PATH: emits ROWS as its labels --json output and runs PROBE lines first. */
function stubBin(dir: string, rows: string, probe: string = ""): string {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, "whytrail");
	writeFileSync(stub, `#!/bin/sh\nPATH="/usr/bin:/bin:$PATH"\n${probe}\nprintf '%s\\n' '${rows}'\n`);
	chmodSync(stub, 0o755);
	return bin;
}

const A_PLAN = () => join(sandbox(), "plans", "A.md");

test("a bad plan by B flips that plan's episodes bad with B's goal line, cards untouched, child env pinned", () => {
	const state = sandbox();
	const plan = A_PLAN();
	const probe = join(state, "probe.txt");
	const repo = join(state, "repo");
	initRepo(repo);
	const cards = seedCards(repo, "seed\n");
	const bin = stubBin(state, '[{"plan":"A","label":"bad","by":"B","goal":"fix the goal line"}]',
		`{ env | grep -c '^OPENROUTER_API_KEY='; echo "HOME=$HOME"; ls -A "$HOME" | wc -l; } > '${probe}'`);
	const episodes = [episode("agentA:plan:P2", plan), episode("agentB:plan:P2", plan), episode("agentC:plan:P2", join(sandbox(), "plans", "C.md"))];
	const appended = importWhytrailLabels(repo, state, episodes, 42, { path: bin });
	expect(appended).toHaveLength(2);
	expect(appended[0]).toMatchObject({ episode: "agentA:plan:P2", label: "bad", reason: "fix the goal line", party: "none", found_by: "B" });
	expect(appended[1]).toMatchObject({ episode: "agentB:plan:P2", label: "bad" });
	expect(readFileSync(labelLedgerPath(state), "utf8").split("\n").filter(l => l.trim()).length).toBe(2);
	expect(readFileSync(cards, "utf8")).toBe("seed\n");
	const lines = readFileSync(probe, "utf8").split("\n");
	expect(lines[0]).toBe("0");
	expect(lines[1]).not.toBe(`HOME=${process.env.HOME}`);
	expect(lines[1]!.startsWith("HOME=")).toBe(true);
	expect(lines[2]!.trim()).toBe("0");
});

test("a good plan flips its episodes good", () => {
	const state = sandbox();
	const plan = A_PLAN();
	const repo = join(state, "repo");
	initRepo(repo);
	const bin = stubBin(state, '[{"plan":"A","label":"good"}]');
	const appended = importWhytrailLabels(repo, state, [episode("agentA:plan:P2", plan)], 42, { path: bin });
	expect(appended).toHaveLength(1);
	expect(appended[0]).toMatchObject({ episode: "agentA:plan:P2", label: "good", party: "none" });
	expect(appended[0]!.found_by).toBeUndefined();
});

test("an open plan adds no line", () => {
	const state = sandbox();
	const repo = join(state, "repo");
	initRepo(repo);
	const bin = stubBin(state, '[{"plan":"A","label":"open"}]');
	importWhytrailLabels(repo, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin });
	expect(existsSync(labelLedgerPath(state))).toBe(false);
});

test("a plan with no episodes adds no line", () => {
	const state = sandbox();
	const repo = join(state, "repo");
	initRepo(repo);
	const bin = stubBin(state, '[{"plan":"ZZZ","label":"bad","by":"B","goal":"g"}]');
	importWhytrailLabels(repo, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin });
	expect(existsSync(labelLedgerPath(state))).toBe(false);
});

test("whytrail missing is one clear error and the ledger stays unchanged", () => {
	const state = sandbox();
	const repo = join(state, "repo");
	initRepo(repo);
	const bin = join(state, "empty-bin");
	mkdirSync(bin, { recursive: true });
	expect(() => importWhytrailLabels(repo, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin })).toThrow(/whytrail/);
	expect(existsSync(labelLedgerPath(state))).toBe(false);
});

test("a linked-worktree run leaves the main checkout's cards identical while the ledger is updated", () => {
	const state = sandbox();
	const main = join(state, "main");
	initRepo(main);
	const worktree = join(state, "wt");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree, "-b", "wt"], { stdio: "ignore" });
	const cards = seedCards(main, "seed\n");
	const bin = stubBin(state, '[{"plan":"A","label":"bad","by":"B","goal":"g"}]', `printf 'junk\\n' >> '${cards}'`);
	const appended = importWhytrailLabels(worktree, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin });
	expect(appended).toHaveLength(1);
	expect(readFileSync(cards, "utf8")).toBe("seed\n");
});

test("the same junk-writing stub with --repo at the main checkout and a different process cwd still restores", () => {
	const state = sandbox();
	const main = join(state, "main");
	initRepo(main);
	const cards = seedCards(main, "seed\n");
	const bin = stubBin(state, '[{"plan":"A","label":"bad","by":"B","goal":"g"}]', `printf 'junk\\n' >> '${cards}'`);
	importWhytrailLabels(main, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin });
	expect(readFileSync(cards, "utf8")).toBe("seed\n");
});

test("a stub that writes and then fails restores the cards and appends nothing", () => {
	const state = sandbox();
	const repo = join(state, "repo");
	initRepo(repo);
	const cards = seedCards(repo, "seed\n");
	const bin = join(state, "bin");
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, "whytrail");
	writeFileSync(stub, `#!/bin/sh\nprintf 'junk\\n' >> '${cards}'\nprintf '%s\\n' '[{"plan":"A","label":"bad","by":"B","goal":"g"}]'\nexit 1\n`);
	chmodSync(stub, 0o755);
	expect(() => importWhytrailLabels(repo, state, [episode("agentA:plan:P2", A_PLAN())], 42, { path: bin })).toThrow(/whytrail/);
	expect(readFileSync(cards, "utf8")).toBe("seed\n");
	expect(existsSync(labelLedgerPath(state))).toBe(false);
});
