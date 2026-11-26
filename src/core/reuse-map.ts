// Reuse map (plan 20261122_1828_reuse_map P1): the opt-in Graphify code map a new plan's
// `## Reuse` must cite. Seam first — no harness names, unit tests inject a fake ReuseGraph,
// CLI tests put a fake `graphify` on a sandbox PATH. Off (config) means nothing here runs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, loadConfig, type Config } from "./config.ts";
import { checkEdited, setConfigKeys, yamlValue } from "./config-edit.ts";
import { writeAtomicSync, withFileLock } from "./file-lock.ts";
import { repoDirs } from "./setup-detect.ts";

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
	return `graphify ${GRAPHIFY_VERSION} is not on PATH (found: ${found.slice(0, 80)}) — install the pinned tool: uv tool install ${GRAPHIFY_PIN}`;
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

// --- P3 (plan 20261122_1828_reuse_map): the routines behind `neurastream reuse` ---

/** The pinned package spec; the only thing `reuse on` installs (double y; other names are typosquats). */
export const GRAPHIFY_PIN = `graphifyy==${GRAPHIFY_VERSION}`;

/** A stored repo path resolved against this HOME (`~/x` allowed, like the gate reads repos). */
function inHome(p: string, home: string): string {
	return path.resolve(p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
}

/**
 * The `reuse on` candidates: git repos with a docs/plans directory one level below the given
 * work roots, sorted, deduplicated. Walks with setup-detect's exported walk — no second one.
 */
export function reuseCandidates(workRoots: string[]): string[] {
	const repos = workRoots.flatMap((root) => repoDirs(root)).filter((repo) => existsSync(path.join(repo, "docs", "plans")));
	return [...new Set(repos.map((r) => path.resolve(r)))].toSorted();
}

// --- the per-repo footprint: one marked line in .git/info/exclude, removed by `reuse off` ---

const EXCLUDE_MARK = "# neurastream reuse map (neurastream reuse off removes this)";

/** The repo's info/exclude — `git rev-parse --git-path`, so a worktree resolves into its main .git. */
function excludeFile(repo: string): string | null {
	const rel = gitOut(repo, ["rev-parse", "--git-path", "info/exclude"]);
	return rel === null || !rel.trim() ? null : path.resolve(repo, rel.trim());
}

/** True when graphify-out/ is excluded — by our mark, or by an owner line written before `reuse on`. */
export function excludePresent(repo: string): boolean {
	try {
		const lines = readFileSync(excludeFile(repo) ?? "", "utf8").split("\n");
		return lines.includes(EXCLUDE_MARK) || lines.some((l) => l.trim() === `${GRAPH_DIR}/`);
	} catch {
		return false;
	}
}

/** Adds our marked exclude block; false when graphify-out/ is already excluded (idempotent). */
export function addExclude(repo: string): boolean {
	if (excludePresent(repo)) return false;
	const file = excludeFile(repo);
	if (file === null) return false;
	const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
	const base = cur === "" || cur.endsWith("\n") ? cur : `${cur}\n`;
	writeFileSync(file, `${base}${EXCLUDE_MARK}\n${GRAPH_DIR}/\n`);
	return true;
}

/** Removes our marked exclude block; an owner's own graphify-out/ line survives. */
export function removeExclude(repo: string): void {
	const file = excludeFile(repo);
	if (file === null) return;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return;
	}
	const lines = text.split("\n");
	const at = lines.indexOf(EXCLUDE_MARK);
	if (at < 0) return;
	const end = lines[at + 1]?.trim() === `${GRAPH_DIR}/` ? at + 2 : at + 1;
	lines.splice(at, end - at);
	writeFileSync(file, lines.join("\n"));
}

// --- install: uv, else pipx; never system pip, never sudo ---

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (dir === "") continue;
		try {
			if (statSync(path.join(dir, bin)).isFile()) return true;
		} catch {}
	}
	return false;
}

function spawnTool(tool: "uv" | "pipx", args: string[], env: NodeJS.ProcessEnv): { status: number | null; line: string } {
	const r = spawnSync(tool, args, { encoding: "utf8", env, timeout: BUILD_TIMEOUT_MS });
	const line = (r.stderr ?? "").trim().split("\n")[0] || (r.stdout ?? "").trim().split("\n")[0] || "(no output)";
	return { status: r.status, line };
}

/** Installs the pinned package with uv, else pipx; false (reason on err) when neither works. */
function installGraphify(env: NodeJS.ProcessEnv, err: (line: string) => void): boolean {
	for (const tool of ["uv", "pipx"] as const) {
		if (!onPath(tool, env)) continue;
		const r = spawnTool(tool, tool === "uv" ? ["tool", "install", GRAPHIFY_PIN] : ["install", GRAPHIFY_PIN], env);
		if (r.status === 0) return true;
		err(`reuse: ${tool} install failed (${r.status === null ? "timed out" : `exit ${r.status}`}): ${r.line.slice(0, 120)}`);
		return false;
	}
	err("reuse: graphify is not installed and neither uv nor pipx is on PATH — install uv or pipx, then rerun: neurastream reuse on");
	return false;
}

/** Uninstalls graphifyy with whichever of uv/pipx is present; true when done or nothing to do. */
function uninstallGraphify(env: NodeJS.ProcessEnv, err: (line: string) => void): boolean {
	for (const tool of ["uv", "pipx"] as const) {
		if (!onPath(tool, env)) continue;
		const r = spawnTool(tool, tool === "uv" ? ["tool", "uninstall", "graphifyy"] : ["uninstall", "graphifyy"], env);
		if (r.status === 0 || /not installed|nothing to uninstall|no such tool/i.test(r.line)) return true;
		err(`reuse: ${tool} uninstall failed (${r.status === null ? "timed out" : `exit ${r.status}`}): ${r.line.slice(0, 120)}`);
		return false;
	}
	return true;
}

/** What a reuse routine needs: where the config lives, the env for uv/pipx, and the terminal. */
export interface ReuseDeps {
	home: string;
	env: NodeJS.ProcessEnv;
	/** stdin and stdout are a terminal: `reuse on` asks y/N per candidate repo. */
	terminal: boolean;
	ask: (prompt: string) => string;
}

export interface ReuseOutcome {
	code: number;
	/** Normal output lines (stdout). */
	out: string[];
	/** Error and usage lines (stderr). */
	err: string[];
}

/**
 * `reuse on [<repo>...]`: map repos with graphify. With args, no prompt; without, a terminal
 * asks y/N per candidate repo and a non-terminal exits 2 listing the candidates, nothing
 * written. Installs the pinned tool (uv, else pipx) unless `graphify --version` already
 * matches. Per repo: the exclude line, then freshGraph (extract . --code-only with the
 * config's excludes, graph.json checked, stamp written). Any failure undoes this run's repos;
 * config.yml is written last and only then (enabled true, repos = old ∪ new), so a failure
 * leaves it byte-identical. Idempotent.
 */
export function reuseOn(args: string[], deps: ReuseDeps, graph: ReuseGraph = realGraphify): ReuseOutcome {
	const out: string[] = [];
	const err: string[] = [];
	const cfg = loadConfig({ home: deps.home, env: deps.env });
	const have = new Set(cfg.reuse_map.repos.map((r) => inHome(r, deps.home)));
	let repos: string[];
	if (args.length) {
		repos = args.map((a) => inHome(a, deps.home));
		const bad = repos.filter((r) => !existsSync(path.join(r, ".git")));
		if (bad.length) {
			for (const r of bad) err.push(`reuse: ${r} is not a git repository`);
			err.push("usage: neurastream reuse on [<repo>...]");
			return { code: 2, out, err };
		}
	} else {
		const candidates = reuseCandidates(cfg.paths.work_roots.map((w) => inHome(w, deps.home))).filter((r) => !have.has(r));
		if (!candidates.length) {
			out.push("reuse: no unmapped repos with docs/plans under paths.work_roots — pass one: neurastream reuse on <repo>");
			return { code: 0, out, err };
		}
		if (!deps.terminal) {
			err.push("reuse: no repos given and stdin is not a terminal — pass them: neurastream reuse on <repo>...");
			err.push("candidates:");
			for (const c of candidates) err.push(`  ${c}`);
			return { code: 2, out, err };
		}
		repos = [];
		for (const c of candidates) if (/^y(es)?$/i.test(deps.ask(`Map ${c} with graphify? [y/N] `).trim())) repos.push(c);
		if (!repos.length) {
			out.push("reuse: nothing selected — nothing changed");
			return { code: 0, out, err };
		}
	}
	// The pinned tool: install only when the version check fails. Still nothing on disk.
	if (versionProblem(graph) !== null && !installGraphify(deps.env, (l) => err.push(l))) return { code: 1, out, err };
	// Per repo; every failure undoes everything this run touched — config included (it is last).
	const touched: { repo: string; exclude: boolean; graphDir: boolean; stamp: boolean }[] = [];
	const undo = (): void => {
		for (const t of touched.toReversed()) {
			if (t.exclude) removeExclude(t.repo);
			if (!t.graphDir) rmSync(path.join(t.repo, GRAPH_DIR), { recursive: true, force: true });
			else if (!t.stamp) rmSync(path.join(t.repo, STAMP_FILE), { force: true });
		}
	};
	for (const repo of repos) {
		const graphDir = existsSync(path.join(repo, GRAPH_DIR));
		const stamp = existsSync(path.join(repo, STAMP_FILE));
		touched.push({ repo, exclude: addExclude(repo), graphDir, stamp });
		const problems = freshGraph(repo, cfg.reuse_map.exclude, graph);
		if (problems.length) {
			undo();
			for (const p of problems) err.push(`reuse: ${p}`);
			err.push("reuse: rolled back — nothing mapped, config.yml unchanged");
			return { code: 1, out, err };
		}
		out.push(`mapped ${repo} (map built, stamp written)`);
	}
	const union = [...cfg.reuse_map.repos];
	for (const r of repos) if (!union.some((u) => inHome(u, deps.home) === r)) union.push(r);
	const file = configFile(deps.home);
	const edited = setConfigKeys(
		existsSync(file) ? readFileSync(file, "utf8") : null,
		{ "reuse_map.enabled": yamlValue(true), "reuse_map.repos": yamlValue(union) },
	);
	if (!checkEdited(edited, deps.home, (l) => err.push(l))) {
		undo();
		err.push("reuse: the edited config would not load — rolled back, config.yml unchanged");
		return { code: 1, out, err };
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, edited);
	out.push(`reuse map on: ${union.length} repo(s) — new plans in them must cite the map under ## Reuse (off: neurastream reuse off)`);
	return { code: 0, out, err };
}

/**
 * `reuse off [--purge]`: removes our exclude line in every mapped repo (an owner's own
 * graphify-out/ line survives), then writes enabled false / repos [] — config last, after the
 * repo work. --purge also deletes each repo's graphify-out/ and uninstalls graphifyy.
 */
export function reuseOff(args: string[], deps: ReuseDeps): ReuseOutcome {
	const purge = args.includes("--purge");
	const unknown = args.find((a) => a !== "--purge");
	if (unknown) return { code: 2, out: [], err: [`reuse: unknown flag ${unknown}`, "usage: neurastream reuse off [--purge]"] };
	const out: string[] = [];
	const err: string[] = [];
	const cfg = loadConfig({ home: deps.home, env: deps.env });
	if (!cfg.reuse_map.enabled && !cfg.reuse_map.repos.length) {
		out.push("reuse map is already off");
		return { code: 0, out, err };
	}
	for (const r of cfg.reuse_map.repos) {
		const repo = inHome(r, deps.home);
		removeExclude(repo);
		if (purge) rmSync(path.join(repo, GRAPH_DIR), { recursive: true, force: true });
		out.push(`${purge ? "purged" : "unmapped"} ${repo}`);
	}
	const file = configFile(deps.home);
	const edited = setConfigKeys(
		existsSync(file) ? readFileSync(file, "utf8") : null,
		{ "reuse_map.enabled": yamlValue(false), "reuse_map.repos": yamlValue([]) },
	);
	if (!checkEdited(edited, deps.home, (l) => err.push(l))) {
		err.push("reuse: the edited config would not load — config.yml unchanged, repos still mapped");
		return { code: 1, out, err };
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, edited);
	if (purge && !uninstallGraphify(deps.env, (l) => err.push(l))) return { code: 1, out, err };
	out.push(`reuse map off${purge ? " (graphify-out deleted, graphifyy uninstalled)" : ""}`);
	return { code: 0, out, err };
}

export interface GraphState {
	/** graph.json's age in ms; null when there is none. */
	ageMs: number | null;
	/** The stamp matches HEAD + dirty code + graph mtime: freshGraph would not rebuild. */
	fresh: boolean;
	/** The repo is a git repository (worktrees included). */
	git: boolean;
	/** graph.json exists and parses as a node list. */
	readable: boolean;
}

/** A mapped repo's graph state, for `reuse status` and doctor — never a build, never a query. */
export function graphState(repo: string, now: number = Date.now()): GraphState {
	const stamp = reuseStamp(repo);
	const graphFile = path.join(repo, GRAPH_DIR, "graph.json");
	let ageMs: number | null = null;
	try {
		ageMs = now - statSync(graphFile).mtimeMs;
	} catch {}
	return { ageMs, git: stamp !== null, fresh: stamp !== null && readStamp(repo) === stamp, readable: parseableGraph(graphFile) };
}

/**
 * `reuse status [--json]`: the tool version and each mapped repo's graph age and fresh/stale.
 * Exit 1 on a problem: the tool missing or another version, a repo no longer a git repository,
 * a missing or unparseable graph. Stale-but-readable is a state, not a problem — the gate
 * rebuilds it at the next plan write.
 */
export function reuseStatus(args: string[], deps: ReuseDeps, graph: ReuseGraph = realGraphify): ReuseOutcome {
	const json = args.includes("--json");
	const unknown = args.find((a) => a !== "--json");
	if (unknown) return { code: 2, out: [], err: [`reuse: unknown flag ${unknown}`, "usage: neurastream reuse status [--json]"] };
	const cfg = loadConfig({ home: deps.home, env: deps.env });
	if (!cfg.reuse_map.enabled)
		return {
			code: 0,
			out: json ? [JSON.stringify({ enabled: false, repos: [], problems: [] })] : ["reuse map: off (turn on: neurastream reuse on <repo>)"],
			err: [],
		};
	const problems: string[] = [];
	const vp = versionProblem(graph);
	if (vp) problems.push(vp);
	const repos = cfg.reuse_map.repos.map((r) => {
		const repo = inHome(r, deps.home);
		const st = graphState(repo);
		if (!st.git) problems.push(`${repo} is not a git repository any more — neurastream reuse off removes it`);
		else if (!st.readable) problems.push(`${repo} has no readable ${GRAPH_DIR}/graph.json — the gate rebuilds it at the next plan write`);
		return { repo, fresh: st.fresh, ageSec: st.ageMs === null ? null : Math.round(st.ageMs / 1000) };
	});
	if (json)
		return {
			code: problems.length ? 1 : 0,
			out: [JSON.stringify({ enabled: true, version: vp ? null : GRAPHIFY_VERSION, problems, repos }, null, 2)],
			err: [],
		};
	const out = [vp ?? `graphify ${GRAPHIFY_VERSION} on PATH`];
	for (const r of repos) {
		const age = r.ageSec === null ? "no graph" : `${Math.max(1, r.ageSec)}s old`;
		out.push(`${r.repo}: ${r.fresh ? "fresh" : "stale"}, ${age}`);
	}
	for (const p of problems) out.push(`problem: ${p}`);
	return { code: problems.length ? 1 : 0, out, err: [] };
}

/**
 * The doctor's lines (printed beside tailscale's): off is one ok line and
 * never touches the seam; on, a version other than the pin, a repo that stopped being a git
 * repository, and a missing or unparseable graph are problems; stale is only reported.
 */
export function reuseMapDoctor(cfg: Config, graph: ReuseGraph = realGraphify): { ok: string[]; problems: string[] } {
	if (!cfg.reuse_map.enabled) return { ok: ["reuse map: off"], problems: [] };
	const ok: string[] = [];
	const problems: string[] = [];
	const vp = versionProblem(graph);
	if (vp) problems.push(`reuse map: ${vp}`);
	else ok.push(`reuse map: graphify ${GRAPHIFY_VERSION}, ${cfg.reuse_map.repos.length} repo(s)`);
	for (const r of cfg.reuse_map.repos) {
		const repo = inHome(r, cfg.paths.home);
		const st = graphState(repo);
		if (!st.git) problems.push(`reuse map: ${repo} is not a git repository any more — neurastream reuse off removes it`);
		else if (!st.readable) problems.push(`reuse map: ${repo} has no readable ${GRAPH_DIR}/graph.json — the gate rebuilds it at the next plan write`);
		else ok.push(`reuse map: ${repo} ${st.fresh ? "fresh" : "stale"}`);
	}
	return { ok, problems };
}
