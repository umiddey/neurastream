// Reuse map (plan 20261122_1828_reuse_map P1): the opt-in Graphify code map a new plan's
// `## Reuse` must cite. Seam first — no harness names, unit tests inject a fake ReuseGraph,
// CLI tests put a fake `graphify` on a sandbox PATH. Off (config) means nothing here runs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeAtomicSync, withFileLock } from "./file-lock.ts";

/** The only pinned mapping tool (PyPI `graphifyy`; other `graphify*` names are typosquats). */
export const GRAPHIFY_VERSION = "0.9.100";

/** Terms per map/none line: each is one `graphify query` spawn, so a bloated line is capped (reviewer 2026-11-26). */
export const MAX_TERMS = 8;

/** Distinct terms a none line must search before "none to reuse" counts (plan Done 3). */
export const NONE_TERMS_MIN = 3;

/** A repo-relative path as the map names it: no leading ./, no double slashes. */
export function normRel(p: string): string {
	return path.posix.normalize(p.replace(/^\.\//, ""));
}

/** `graphify query` and `--version` bounds; a build (`extract . --code-only`) may take 10 minutes. */
const QUERY_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 600_000;

const GRAPH_DIR = "graphify-out";
const STAMP_FILE = path.join(GRAPH_DIR, ".neurastream-stamp");
const LOCK_FILE = path.join(GRAPH_DIR, ".neurastream.lock");

/** The argv-runner result; same shape as pages-setup.ts's RunnerResult (status, stderr, stdout). */
export interface GraphifyResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/**
 * The external CLI seam: real one spawns `graphify` in the repo (each term its own argv item,
 * never a shell); tests inject fakes.
 */
export interface ReuseGraph {
	version(): GraphifyResult;
	build(repo: string, exclude: string[]): GraphifyResult;
	query(repo: string, term: string): GraphifyResult;
}

function runGraphify(repo: string, args: string[], timeoutMs: number): GraphifyResult {
	const r = spawnSync("graphify", args, { cwd: repo || undefined, encoding: "utf8", timeout: timeoutMs });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const realGraphify: ReuseGraph = {
	version: () => runGraphify("", ["--version"], QUERY_TIMEOUT_MS),
	build: (repo, exclude) =>
		runGraphify(repo, ["extract", ".", "--code-only", ...exclude.flatMap((g) => ["--exclude", g])], BUILD_TIMEOUT_MS),
	query: (repo, term) => runGraphify(repo, ["query", term, "--budget", "2000"], QUERY_TIMEOUT_MS),
};

/** Null when graphify is the pinned version on PATH; else the one-line install fix. */
export function versionProblem(graph: ReuseGraph = realGraphify): string | null {
	const r = graph.version();
	const found = r.stdout.trim() || r.stderr.trim().split("\n")[0] || "(no output)";
	if (r.status === 0 && found === `graphify ${GRAPHIFY_VERSION}`) return null;
	return `graphify ${GRAPHIFY_VERSION} is not on PATH (found: ${found.slice(0, 80)}) — install the pinned tool: uv tool install graphifyy==0.9.100`;
}

// --- line helpers: the exact strings a plan's `## Reuse` must carry when the map is on ---

/** `- map: graphify "t1", "t2" → a.ts, b.ts — cite: N` (N = min(minCited, files)). */
export function mapLine(terms: string[], files: string[], minCited: number): string {
	return `- map: graphify ${terms.map((w) => `"${w}"`).join(", ")} → ${files.join(", ")} — cite: ${Math.min(minCited, files.length)}`;
}

/** `- new: none to reuse — searched: "t1", "t2", "t3"` */
export function noneLine(terms: string[]): string {
	return `- new: none to reuse — searched: ${terms.map((w) => `"${w}"`).join(", ")}`;
}

/** `checked: <path>:<n> "<exact text>"` — the citation every `new:` line carries under the map gate. */
export function checkedCite(file: string, n: number, text: string): string {
	return `checked: ${file}:${n} "${text}"`;
}

// --- parsers (text only; never a graphify run) ---

export interface ParsedMapLine {
	terms: string[];
	files: string[];
	cite: number;
}

export interface ParsedNoneLine {
	terms: string[];
}

const QUOTED_WORD = /"([^"]*)"/g;

/** Parses a `- map: graphify "t1", "t2" → a.ts, b.ts — cite: N` line; null when the line is not one. */
export function parseMapLine(line: string): ParsedMapLine | null {
	const m = /^-?\s*map:\s*graphify\s+(.+?)\s*→\s*(.+?)\s*—\s*cite:\s*(\d+)\s*$/.exec(line.trim());
	if (!m) return null;
	const terms = [...(m[1] ?? "").matchAll(QUOTED_WORD)].map((q) => q[1] ?? "").filter(Boolean);
	const files = (m[2] ?? "")
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	if (!terms.length || !files.length) return null;
	return { terms, files, cite: Number(m[3]) };
}

/** Parses a `- new: none to reuse — searched: "t1", "t2", "t3"` line; null when the line is not one. */
export function parseNoneLine(line: string): ParsedNoneLine | null {
	const m = /^-?\s*new:\s*none to reuse\s*—\s*searched:\s*(.+)$/.exec(line.trim());
	if (!m) return null;
	const terms = [...(m[1] ?? "").matchAll(QUOTED_WORD)].map((q) => q[1] ?? "").filter(Boolean);
	return terms.length ? { terms } : null;
}

/** True for either map-gate line: such a Reuse section follows the map rule, not the plain checked: rule. */
export function isMapOrNoneLine(line: string): boolean {
	return parseMapLine(line) !== null || parseNoneLine(line) !== null;
}

export interface CitedQuote {
	file: string;
	n: number;
	quote: string;
}

/** Every `checked: <path>:<n> "<quote>"` citation on a line, in order. */
export function citedQuotes(line: string): CitedQuote[] {
	return [...line.matchAll(/checked:\s*`?([^`\s—"]+):(\d+)`?\s+"([^"]*)"/g)].map((m) => ({
		file: m[1] ?? "",
		n: Number(m[2]),
		quote: m[3] ?? "",
	}));
}

/** A `checked:` citation on the line without a `"<quote>"` part — the map gate requires the quote. */
export function hasBareChecked(line: string): boolean {
	return [...line.matchAll(/checked:\s*[^—]*/g)].some((m) => !m[0]?.includes('"'));
}

// --- searchTerms: one `graphify query <term>` per term, memoised by (repo, graph mtime, term) ---

export interface TermResult {
	status: "hit" | "none";
	/** Repo-relative files the term matched; on an ambiguous hit, the candidates named. */
	files: string[];
	/** Set when graphify failed or named no files: the one-line problem, never a silent pass. */
	problem?: string;
}

const queryMemo = new Map<string, TermResult>();

/** Files a query stdout names: `src=<file>` NODE attributes, or the candidate paths of an `Ambiguous:` refusal. */
export function filesFromQuery(stdout: string): string[] {
	const matches = stdout.includes("Ambiguous:")
		? [...stdout.matchAll(/^  (\S+)$/gm)].map((m) => m[1] ?? "")
		: [...stdout.matchAll(/\bsrc=(\S+)/g)].map((m) => m[1] ?? "");
	return [...new Set(matches.filter(Boolean))];
}

/**
 * Exit 0 = hit; exit 3 = several (an `Ambiguous:` refusal listing candidate files — still a hit);
 * exit 4 = none; anything else, a timeout or output naming no files is a problem.
 */
function termResult(term: string, r: GraphifyResult): TermResult {
	if (r.status === 0 || r.status === 3) {
		const files = filesFromQuery(r.stdout);
		if (files.length) return { status: "hit", files };
		return { status: "none", files: [], problem: `graphify query "${term}" exited ${r.status} without naming files` };
	}
	if (r.status === 4) return { status: "none", files: [] };
	const why = r.status === null ? "timed out" : `exited ${r.status}`;
	const line = firstLine(r.stderr) || firstLine(r.stdout);
	return { status: "none", files: [], problem: `graphify query "${term}" ${why}${line ? `: ${line}` : ""}` };
}

function firstLine(text: string): string {
	return (text.trim().split("\n")[0] ?? "").slice(0, 120);
}

export function searchTerms(graph: ReuseGraph, repo: string, terms: string[], memo: Map<string, TermResult> = queryMemo): TermResult[] {
	return terms.map((term) => {
		const key = `${repo}|${graphMtime(repo)}|${term}`;
		const hit = memo.get(key);
		if (hit) return hit;
		const result = termResult(term, graph.query(repo, term));
		memo.set(key, result);
		return result;
	});
}

function graphMtime(repo: string): number {
	try {
		return statSync(path.join(repo, GRAPH_DIR, "graph.json")).mtimeMs;
	} catch {
		return 0;
	}
}

// --- freshGraph: the map, rebuilt on demand under the graphify-out lock ---

function gitOut(repo: string, args: string[]): string | null {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	return r.status === 0 ? (r.stdout ?? "") : null;
}

/**
 * The freshness stamp: HEAD sha + sha256 of `git diff HEAD` and the untracked names — both
 * without `*.md` and graphify-out/ (code-only ingests non-md files under docs/, so only `.md`
 * is excluded) — plus graph.json's mtime, so a foreign `update`/hook rewrite counts as stale.
 * Null when the repo is not a git repository.
 */
export function reuseStamp(repo: string): string | null {
	const head = gitOut(repo, ["rev-parse", "HEAD"]);
	if (head === null) return null;
	const diff = gitOut(repo, ["diff", "HEAD", "--", ":(exclude)*.md", ":(exclude)graphify-out"]) ?? "";
	const untracked = gitOut(repo, ["ls-files", "--others", "--exclude-standard", "--", ":(exclude)*.md", ":(exclude)graphify-out"]) ?? "";
	const code = createHash("sha256").update(`${diff}\n${untracked}`).digest("hex");
	return `${head.trim()}\n${code}\n${graphMtime(repo)}`;
}

function readStamp(repo: string): string | null {
	try {
		return readFileSync(path.join(repo, STAMP_FILE), "utf8").trim();
	} catch {
		return null;
	}
}

function parseableGraph(graphFile: string): boolean {
	if (!existsSync(graphFile)) return false;
	try {
		const g: unknown = JSON.parse(readFileSync(graphFile, "utf8"));
		if (typeof g !== "object" || g === null || !("nodes" in g)) return false;
		return Array.isArray(g.nodes);
	} catch {
		return false;
	}
}

/**
 * The repo's code map, current before this returns: `extract . --code-only` runs when graph.json
 * is missing or unparseable or the freshness stamp differs (a commit, dirty code, or a foreign
 * rewrite of graph.json — its mtime is in the stamp). Under the graphify-out lock; any failure is
 * a one-line problem, never a silent pass.
 */
export function freshGraph(repo: string, exclude: string[], graph: ReuseGraph = realGraphify): string[] {
	const graphFile = path.join(repo, GRAPH_DIR, "graph.json");
	if (reuseStamp(repo) === null) return [`graphify: ${repo} is not a git repository — run \`neurastream reuse on\` from a git repo`];
	if (readStamp(repo) === reuseStamp(repo) && parseableGraph(graphFile)) return [];
	mkdirSync(path.join(repo, GRAPH_DIR), { recursive: true });
	return withFileLock(path.join(repo, LOCK_FILE), () => {
		// Another holder may have built while this call waited for the lock: re-check before building.
		if (readStamp(repo) === reuseStamp(repo) && parseableGraph(graphFile)) return [];
		const r = graph.build(repo, exclude);
		if (r.status !== 0) {
			const why = r.status === null ? "timed out" : `exit ${r.status}`;
			const line = firstLine(r.stderr) || firstLine(r.stdout);
			return [`graphify extract failed in ${repo} (${why})${line ? `: ${line}` : ""} — fix the error or run \`neurastream reuse off\``];
		}
		if (!parseableGraph(graphFile))
			return [`graphify extract wrote no readable ${GRAPH_DIR}/graph.json in ${repo} — rerun \`graphify extract . --code-only\` there`];
		writeAtomicSync(path.join(repo, STAMP_FILE), `${reuseStamp(repo) ?? ""}\n`);
		return [];
	});
}
