// Reuse map core (plan 20261122_1828_reuse_map P1): the parsers on every query exit, the line
// helpers, and freshGraph's rebuild rules against a fake seam in a sandbox git repo.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	GRAPHIFY_VERSION,
	checkedCite,
	citedQuotes,
	freshGraph,
	hasBareChecked,
	isMapOrNoneLine,
	mapLine,
	noneLine,
	parseMapLine,
	parseNoneLine,
	searchTerms,
	type GraphifyResult,
	type ReuseGraph,
	type TermResult,
} from "../src/core/reuse-map.ts";

const FIXTURES = join(import.meta.dir, "fixtures/graphify");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

const roots: string[] = [];
afterAll(() => {
	for (const repo of roots) rmSync(repo, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
	const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A throwaway git repo with two code files and a README (the .md the stamp must ignore). */
function sandboxRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "neurastream-reuse-map-"));
	roots.push(repo);
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, "src/b.ts"), "export const b = 2;\n");
	writeFileSync(join(repo, "README.md"), "# t\n");
	git(["init", "-q"], repo);
	git(["add", "src/a.ts", "src/b.ts", "README.md"], repo);
	git(["commit", "-qm", "init"], repo);
	return repo;
}

/** A fake seam: build writes a readable graph.json (or fails with buildStatus) and counts calls. */
function fakeGraphify(opts: { buildStatus?: number | null } = {}): { graph: ReuseGraph; builds: () => number } {
	let builds = 0;
	const build = (repo: string): GraphifyResult => {
		builds++;
		if (opts.buildStatus !== undefined) return { status: opts.buildStatus, stdout: "", stderr: "boom\n" };
		mkdirSync(join(repo, "graphify-out"), { recursive: true });
		writeFileSync(join(repo, "graphify-out/graph.json"), JSON.stringify({ nodes: [{ id: "src_a_a" }] }));
		return { status: 0, stdout: "wrote graph.json", stderr: "" };
	};
	return {
		builds: () => builds,
		graph: {
			version: () => ({ status: 0, stdout: `graphify ${GRAPHIFY_VERSION}`, stderr: "" }),
			build,
			query: () => ({ status: 0, stdout: "", stderr: "" }),
		},
	};
}

describe("searchTerms parsers", () => {
	test("exit 0 is a hit with the src= files, exit 3 a hit with the candidate files, exit 4 none", () => {
		const repo = sandboxRepo();
		const outs: Record<string, GraphifyResult> = {
			loader: { status: 0, stdout: fixture("query-exit-0.stdout"), stderr: fixture("query-exit-0.stderr") },
			unique_loader: { status: 3, stdout: fixture("query-exit-3.stdout"), stderr: fixture("query-exit-3.stderr") },
			zzz_nothing: { status: 4, stdout: fixture("query-exit-4.stdout"), stderr: fixture("query-exit-4.stderr") },
		};
		const graph: ReuseGraph = { ...fakeGraphify().graph, query: (_repo, term) => outs[term]! };
		const res = searchTerms(graph, repo, ["loader", "unique_loader", "zzz_nothing"], new Map());
		expect(res[0]).toEqual({ status: "hit", files: ["src/a.py", "src/b.py"] });
		expect(res[1]).toEqual({ status: "hit", files: ["src/a.py", "src/c.py"] });
		expect(res[2]).toEqual({ status: "none", files: [] });
	});

	test("an unexpected exit and a timeout are problems naming the term, never silent passes", () => {
		const repo = sandboxRepo();
		const graph: ReuseGraph = {
			...fakeGraphify().graph,
			query: (_repo, term) =>
				term === "boom"
					? { status: 1, stdout: "", stderr: "graph.json: no such file\n" }
					: { status: null, stdout: "", stderr: "" },
		};
		const res = searchTerms(graph, repo, ["boom", "slow"], new Map());
		expect(res[0]?.problem).toMatch(/graphify query "boom" exited 1: graph\.json: no such file/);
		expect(res[1]?.problem).toMatch(/graphify query "slow" timed out/);
		expect(res[0]?.status).toBe("none");
	});

	test("results are memoised by (repo, graph mtime, term): one query spawn across calls", () => {
		const repo = sandboxRepo();
		let queries = 0;
		const graph: ReuseGraph = {
			...fakeGraphify().graph,
			query: () => {
				queries++;
				return { status: 0, stdout: "NODE x() [src=src/a.py loc=L1]", stderr: "" };
			},
		};
		const memo = new Map<string, TermResult>();
		searchTerms(graph, repo, ["t1"], memo);
		searchTerms(graph, repo, ["t1", "t1"], memo);
		expect(queries).toBe(1);
		searchTerms(graph, repo, ["t1"], new Map());
		expect(queries).toBe(2);
	});
});

describe("line helpers", () => {
	test("mapLine round-trips through parseMapLine with cite = min(min_cited, files)", () => {
		expect(parseMapLine(mapLine(["t1", "t2"], ["a.ts", "b.ts"], 2))).toEqual({ terms: ["t1", "t2"], files: ["a.ts", "b.ts"], cite: 2 });
		expect(parseMapLine(mapLine(["t1"], ["a.ts", "b.ts", "c.ts"], 2))?.cite).toBe(2);
		expect(parseMapLine(mapLine(["t1"], ["a.ts"], 2))?.cite).toBe(1);
		expect(parseMapLine("- new: gate — checked: src/a.ts:1 \"x\"")).toBeNull();
	});

	test("noneLine round-trips through parseNoneLine", () => {
		expect(parseNoneLine(noneLine(["t1", "t2", "t3"]))).toEqual({ terms: ["t1", "t2", "t3"] });
		expect(parseNoneLine("- new: none — checked: src/a.ts:1")).toBeNull();
	});

	test("isMapOrNoneLine tells the map-gate lines from plain reuse lines", () => {
		expect(isMapOrNoneLine(mapLine(["t"], ["a.ts"], 2))).toBe(true);
		expect(isMapOrNoneLine(noneLine(["t1", "t2", "t3"]))).toBe(true);
		expect(isMapOrNoneLine("- new: gate — checked: src/a.ts:1 \"x\"")).toBe(false);
	});

	test("checkedCite parses back through citedQuotes; a checked: without a quote is bare", () => {
		const line = `- new: gate — ${checkedCite("src/a.ts", 3, "export const a = 1;")} — reuse: the helper`;
		expect(citedQuotes(line)).toEqual([{ file: "src/a.ts", n: 3, quote: "export const a = 1;" }]);
		expect(hasBareChecked(line)).toBe(false);
		expect(hasBareChecked("- new: gate — checked: src/a.ts:3 — reuse: the helper")).toBe(true);
	});
});

describe("freshGraph", () => {
	test("a missing graph builds first, then a fresh stamp skips the rebuild", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		expect(freshGraph(repo, [], fake.graph)).toEqual([]);
		expect(fake.builds()).toBe(1);
		expect(freshGraph(repo, [], fake.graph)).toEqual([]);
		expect(fake.builds()).toBe(1);
	});

	test("a commit rebuilds (stale by head/diff)", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		freshGraph(repo, [], fake.graph);
		writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
		git(["add", "src/a.ts"], repo);
		git(["commit", "-qm", "change a"], repo);
		expect(freshGraph(repo, [], fake.graph)).toEqual([]);
		expect(fake.builds()).toBe(2);
	});

	test("a dirty code file rebuilds without a commit", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		freshGraph(repo, [], fake.graph);
		writeFileSync(join(repo, "src/b.ts"), "export const b = 3;\n");
		freshGraph(repo, [], fake.graph);
		expect(fake.builds()).toBe(2);
	});

	test("a foreign graph.json rewrite rebuilds (the mtime is in the stamp)", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		freshGraph(repo, [], fake.graph);
		writeFileSync(join(repo, "graphify-out/graph.json"), JSON.stringify({ nodes: [{ id: "foreign" }] }));
		freshGraph(repo, [], fake.graph);
		expect(fake.builds()).toBe(2);
	});

	test("an unparseable graph.json rebuilds", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		freshGraph(repo, [], fake.graph);
		writeFileSync(join(repo, "graphify-out/graph.json"), "{not json");
		freshGraph(repo, [], fake.graph);
		expect(fake.builds()).toBe(2);
	});

	test("an .md-only change does not rebuild", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify();
		freshGraph(repo, [], fake.graph);
		writeFileSync(join(repo, "README.md"), "# changed\n");
		expect(freshGraph(repo, [], fake.graph)).toEqual([]);
		expect(fake.builds()).toBe(1);
	});

	test("a failed extract is a one-line problem naming the repo, never a silent pass", () => {
		const repo = sandboxRepo();
		const fake = fakeGraphify({ buildStatus: 1 });
		expect(freshGraph(repo, [], fake.graph)).toHaveLength(1);
		expect(freshGraph(repo, [], fake.graph)[0]).toMatch(/graphify extract failed in .* \(exit 1\): boom/);
		expect(freshGraph(repo, [], fake.graph)[0]).toMatch(/neurastream reuse off/);
	});

	test("a directory that is not a git repository is refused with the fix", () => {
		const repo = mkdtempSync(join(tmpdir(), "neurastream-reuse-map-nogit-"));
		roots.push(repo);
		const fake = fakeGraphify();
		expect(freshGraph(repo, [], fake.graph)[0]).toMatch(/is not a git repository — run `neurastream reuse on`/);
		expect(fake.builds()).toBe(0);
	});
});
