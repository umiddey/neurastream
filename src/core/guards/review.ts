// Plan/code review gates, review spawn locking, open-MR cache, and pending-work checks.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PlanEditEvent, ToolEvent } from "../adapter.ts";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { withFileLock, writeAtomicSync } from "../file-lock.ts";
import { defaultRunner, listOpenMrs, mentioned, type CommandRunner, type OpenMr } from "../mr-sweep.ts";
import { reviewHash } from "../plan-approval.ts";
import * as q from "../queue/lib.ts";
import { unlandedRows } from "../wip-check.ts";
import { findingsValue, log, newProgressEntries, progressEntries, type Spawner } from "./state.ts";

// --- plan review gate state (plan 20261028_1600): the open-MR cache beside the edit window ---

export interface MrCache {
	at: number;
	repos: Record<string, OpenMr[]>;
}

function mrCacheFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "mr-cache.json");
}

export function readMrCache(paths: Pick<q.QueuePaths, "queue_state">): MrCache {
	try {
		const c = JSON.parse(readFileSync(mrCacheFile(paths), "utf8")) as MrCache;
		if (typeof c.at === "number" && c.repos && typeof c.repos === "object") return c;
	} catch {}
	return { at: 0, repos: {} };
}

export function writeMrCache(c: MrCache, cfg: Config): void {
	const file = mrCacheFile(cfg.paths);
	try {
		withFileLock(`${file}.lock`, () => {
			writeAtomicSync(file, JSON.stringify(c, null, 1));
		});
	} catch (err) {
		log(cfg.paths.guard_log, `cannot write ${file}: ${err}`);
	}
}

// --- plan review gate state (plan 20261028_1600): the reviewer PASS record beside the edit window ---

export interface PlanReview {
	verdict: "PASS" | "FAIL";
	hash: string;
	finding: string;
	at: number;
	by?: string;
}

/** A CODE REVIEW record (P6): the plan phase ids (P1, P4a, …) the entry names, for the tick gate. */
export interface CodeReview extends PlanReview {
	phases: string[];
}

function planReviewsFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "plan-reviews.json");
}

export function readPlanReviews(paths: Pick<q.QueuePaths, "queue_state">): Record<string, PlanReview> {
	try {
		const r = JSON.parse(readFileSync(planReviewsFile(paths), "utf8")) as { reviews?: Record<string, PlanReview> };
		if (r.reviews && typeof r.reviews === "object") return r.reviews;
	} catch {}
	return {};
}

export function readCodeReviews(paths: Pick<q.QueuePaths, "queue_state">): Record<string, CodeReview> {
	try {
		const r = JSON.parse(readFileSync(planReviewsFile(paths), "utf8")) as { code?: Record<string, CodeReview> };
		if (r.code && typeof r.code === "object") return r.code;
	} catch {}
	return {};
}

function writePlanReviewsUnlocked(reviews: Record<string, PlanReview>, code: Record<string, CodeReview>, cfg: Config): void {
	const file = planReviewsFile(cfg.paths);
	try {
		writeAtomicSync(file, JSON.stringify({ reviews, code }, null, 1));
	} catch (err) {
		log(cfg.paths.plan_guard_log, `cannot write ${file}: ${err}`);
	}
}

/** The progress entry that records a review — PLAN for the spawn gate, CODE for the phase tick gate (P6); only a subagent's edit can carry one. The verdict is the match, never a substring. The time may carry a `~` and a zone word (`~23:35 CET`); the author segment may carry a note (`Rev (re-verify): `) because the recorded name comes from the spawn, never from the line. */
export const REVIEW_LINE = /^- (?:\d{4}-\d{2}-\d{2} ~?\d{2}:\d{2}(?: [A-Z]{2,5})? [^:\n]+?: )?(PLAN|CODE) REVIEW: (PASS|FAIL)\b/;
/** Any entry that opens like a review line; one that REVIEW_LINE does not match is restored, not recorded. */
export const REVIEW_LOOKALIKE = /^- (?:\d{4}-\d{2}-\d{2} ~?\d{2}:\d{2}(?: [A-Z]{2,5})? [^:\n]+?: )?(PLAN|CODE) REVIEW\b/;

/**
 * P2 (plan 20261028_1600): a spawn on a plan needs a recorded reviewer PASS whose hash still
 * matches the plan text — progress-only edits keep a PASS valid, any other change expires it,
 * a FAIL is denied with its first finding. A review spawn itself — an agent from review.agents
 * whose brief has the `Plan review: <plan>` line — is exempt when Main launches it. P5 removed
 * the cutover: every named plan is gated. review.plan: false skips the gate (P6); an empty
 * review.agents list no longer turns it off.
 */
export function reviewPassProblem(named: string[], brief: string, agent: string, cfg: Config, spawner: Spawner): string | null {
	if (!cfg.review.plan) return null; // P6: review.plan: false skips the PASS gate; an empty review.agents list no longer does
	const reviews = readPlanReviews(cfg.paths);
	for (const file of named) {
		if (isReviewSpawn(file, brief, agent, cfg, spawner)) continue;
		const rec = reviews[file];
		if (!rec) return `plan ${file} has no current reviewer PASS. Spawn a reviewer with templates/plan-review-brief.md.`;
		if (rec.verdict === "FAIL")
			return `plan ${file} has no current reviewer PASS (FAIL: ${rec.finding || "no finding recorded"}). Spawn a reviewer with templates/plan-review-brief.md.`;
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {}
		if (rec.hash !== reviewHash(text))
			return `plan ${file} has no current reviewer PASS (changed since review). Spawn a reviewer with templates/plan-review-brief.md.`;
	}
	return null;
}

/** A subagent's `PLAN REVIEW` or `CODE REVIEW` (P6) entry records the review of the plan it edited; Main's edit path never reaches this. */
export function recordReviews(e: PlanEditEvent, cfg: Config): void {
	const entries = newProgressEntries(e.before, e.after).filter(b => REVIEW_LINE.test(b));
	if (!entries.length) return;
	// Lock order: review-spawns.json.lock -> plan-reviews.json.lock (strictly acyclic).
	withFileLock(`${reviewSpawnsFile(cfg.paths)}.lock`, () => {
		const spawns = readReviewSpawns(cfg.paths);
		const found = matchReviewSpawn(spawns, e.agentId ?? "");
		if (!found) return;
		const { name, spawn } = found;
		withFileLock(`${planReviewsFile(cfg.paths)}.lock`, () => {
			const reviews = readPlanReviews(cfg.paths);
			const code = readCodeReviews(cfg.paths);
			for (const block of entries) {
				const kind = REVIEW_LINE.exec(block)![1];
				const repeat = spawn.verdicts > 0;
				spawn.verdicts++;
				const at = nowSec();
				// Judged against the plan as the spawn first saw it (P4k): a plan that moved during the review cannot pass.
				const record: PlanReview = repeat
					? { verdict: "FAIL", hash: spawn.hash, finding: "review spawn wrote 2 verdicts", at, by: name }
					: reviewHash(e.after) !== spawn.hash
						? { verdict: "FAIL", hash: spawn.hash, finding: "plan changed during review", at, by: name }
						: { verdict: REVIEW_LINE.exec(block)![2] === "PASS" ? "PASS" : "FAIL", hash: spawn.hash, finding: findingsValue(block) ?? "", at, by: name };
				// A CODE REVIEW record covers only the phases the verdict names before its Findings line: a phase in the Findings text ("see P2") is a reference, not coverage; an entry without a Findings line covers nothing.
				if (kind === "CODE") {
					const head = block.slice(0, Math.max(block.indexOf("Findings:"), 0));
					code[e.path] = { ...record, phases: [...new Set([...head.matchAll(/\bP\d+[a-z]?\b/g)].map(m => m[0]))] };
				} else reviews[e.path] = record;
			}
			writePlanReviewsUnlocked(reviews, code, cfg);
		});
		writeReviewSpawnsUnlocked(spawns, cfg.paths);
	});
}

/** P4k backstop, at a sub agent's end: a named review spawn whose PLAN REVIEW line reached no edit (a path the write targets miss) is recorded here. Returns Main's note when the spawn wrote no verdict at all. */
export function reviewSpawnEnd(agentId: string, cfg: Config): string | null {
	const found = matchReviewSpawn(readReviewSpawns(cfg.paths), agentId);
	if (!found || found.spawn.verdicts > 0) return null;
	const { name, spawn } = found;
	const after = readPlanText(spawn.plan);
	if (newProgressEntries(spawn.text, after).some(b => REVIEW_LINE.test(b))) {
		recordReviews({ path: spawn.plan, before: spawn.text, after, agent: "sub", agentId: name }, cfg);
		return null;
	}
	return `${name} wrote no verdict on ${spawn.plan}.`;
}

/** P4f: a `Plan review: <plan>` brief from Main, by a configured review agent (the exemption from the plan gate). */
export function isReviewSpawn(file: string, brief: string, agent: string, cfg: Config, spawner: Spawner): boolean {
	const reviewLines = brief.split("\n").filter(l => l.startsWith("Plan review:"));
	return spawner === "main" && cfg.review.agents.includes(agent) && reviewLines.some(l => l.slice("Plan review:".length).trim() === file);
}

/** P4f: the review role of one task: the plan it reviews (null for other spawns). A review spawn needs a name, the name keys its lock, and it reviews one plan. */
export function reviewRole(name: string | undefined, named: string[], brief: string, agent: string, cfg: Config, spawner: Spawner): { plan: string | null; problem: string | null } {
	const reviewed = named.filter(f => isReviewSpawn(f, brief, agent, cfg, spawner));
	if (reviewed.length > 1) return { plan: null, problem: "a review spawn reviews one plan; split the spawn." };
	if (reviewed.length && !name) return { plan: null, problem: "a review spawn needs a name (the task name keys its review lock)." };
	if (reviewed.length && !/^Scope: whole plan\s*$/m.test(brief)) return { plan: null, problem: "a review spawn reviews the whole plan: add the line `Scope: whole plan` to the brief (every unticked phase, one pass; no per-phase reviews)." };
	const plan = reviewed[0] ?? null;
	if (plan) {
		const rec = readPlanReviews(cfg.paths)[plan];
		if (rec?.verdict === "PASS" && rec.hash === reviewHash(readPlanText(plan)))
			return { plan: null, problem: `plan ${plan} already has a current reviewer PASS (by ${rec.by}); a second review is waste. Change the plan text, or spawn the implementer.` };
	}
	return { plan, problem: null };
}

/** P4f/P4k: the named review spawns, spawn name → its review role: the plan, the plan text and hash as the spawn first saw them, and the verdicts it wrote (review-spawns.json in the state dir). */
export interface ReviewSpawn {
	plan: string;
	text: string;
	hash: string;
	verdicts: number;
}

function reviewSpawnsFile(paths: Pick<q.QueuePaths, "queue_state">): string {
	return path.join(paths.queue_state, "review-spawns.json");
}

export function readReviewSpawns(paths: Pick<q.QueuePaths, "queue_state">): Record<string, ReviewSpawn> {
	try {
		const parsed = JSON.parse(readFileSync(reviewSpawnsFile(paths), "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeReviewSpawnsUnlocked(spawns: Record<string, ReviewSpawn>, paths: Pick<q.QueuePaths, "queue_state">): void {
	writeAtomicSync(reviewSpawnsFile(paths), `${JSON.stringify(spawns, null, 2)}\n`);
}

function readPlanText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** Set (plan) or drop (null) a named spawn's review role; a non-review spawn under the same name drops it. */
export function recordReviewSpawn(name: string, plan: string | null, paths: Pick<q.QueuePaths, "queue_state">): void {
	withFileLock(`${reviewSpawnsFile(paths)}.lock`, () => {
		const spawns = readReviewSpawns(paths);
		if (plan) {
			const text = readPlanText(plan);
			spawns[name] = { plan, text, hash: reviewHash(text), verdicts: 0 };
		} else delete spawns[name];
		writeReviewSpawnsUnlocked(spawns, paths);
	});
}

/** The review role an agent id belongs to: its spawn name, or the name without a -<digits> suffix (a sub agent's id, plan P4f gap). */
export function matchReviewSpawn(spawns: Record<string, ReviewSpawn>, agentId: string): { name: string; spawn: ReviewSpawn } | null {
	for (const name of [agentId, agentId.replace(/-\d+$/, "")]) {
		const spawn = Object.hasOwn(spawns, name) ? spawns[name] : undefined;
		if (spawn && typeof spawn.plan === "string") return { name, spawn };
	}
	return null;
}

/** P4f: the secret-read deny: credential dirs under a home, and env files. Shell text expands `~` to the process home (queue lib) while config points at the sandbox home in tests, so both roots are judged; they are the same directory in production. */
function secretPath(p: string, cfg: Config, cwd: string): boolean {
	const abs = path.resolve(cwd, p.startsWith("~/") ? path.join(cfg.paths.home, p.slice(2)) : p);
	const base = path.basename(abs);
	if (base.startsWith(".env") || base.endsWith(".env")) return true;
	return [cfg.paths.home, homedir()].some(home =>
		[".config", ".ssh", ".gnupg", ".aws"].some(d => abs.startsWith(path.join(path.resolve(home), d) + path.sep)),
	);
}

// P7 (plan 20261028_1600): option tokens that write or execute on an otherwise allowed command;
// `-w`/`--web` are denied on gh/glab segments only (they open a browser), `-c` only right after
// `git` (config injection, e.g. core.pager=sh).
const SHELL_DENY_OPTS = ["--output", "--pre", "--ext-diff", "--textconv", "--open-files-in-pager", "--exec", "-O"];

/** P7 (plan 20261028_1600): why a review spawn's bash command is not allowed, or null. Single
 * line, no `$(`/backtick/`<(`/`>(`, no `>` outside quotes (quoted text stripped the way
 * withoutQuotedRedirects does), and every `|`/`&&`/`||`/`;`/`&` segment starts with a
 * review.shell_allow entry followed by a word boundary. */
function reviewShellProblem(command: string, cfg: Config): string | null {
	if (/[\r\n]/.test(command)) return "a multi-line command";
	if (command.includes("`") || command.includes("$(") || command.includes("<(") || command.includes(">(")) return "command substitution";
	if (q.withoutQuotedRedirects(command).includes(">")) return "a shell redirect";
	for (const raw of command.split(/&&|\|\||[|;&]/)) {
		const seg = raw.trim();
		const toks = seg.split(/\s+/);
		const pre = cfg.review.shell_allow.find(p => seg.startsWith(p) && (seg.length === p.length || /\s/.test(seg.charAt(p.length))));
		if (!pre) return `${toks[0] || "an empty segment"} is not a review.shell_allow command`;
		const opt = toks.find(t => SHELL_DENY_OPTS.some(o => t === o || t.startsWith(`${o}=`)));
		if (opt) return `the writing/executing option ${opt}`;
		if ((toks[0] === "gh" || toks[0] === "glab") && toks.some(t => t === "-w" || t === "--web")) return "gh/glab --web opens a browser";
		if (toks.some((t, i) => i > 0 && t === "-c" && toks[i - 1] === "git")) return "git -c config injection";
	}
	return null;
}

/** P4f: a named review spawn may read, use todo, and edit only its own plan. Shell, spawn, cancel and MCP tools are denied; so are secret reads. */
export function reviewLockProblem(e: ToolEvent, cfg: Config): string | null {
	const plan = matchReviewSpawn(readReviewSpawns(cfg.paths), e.agentId ?? "")?.spawn.plan ?? null;
	if (!plan) return null;
	const input = e.input ?? {};
	if (cfg.guards.write_tools.includes(e.tool)) {
		const writes = [...(e.writes ?? []), ...q.writeTargets(e.tool, input, e.cwd, cfg.paths, [])];
		if (writes.length && writes.every(w => path.resolve(e.cwd, w) === path.resolve(plan))) return null;
		return `review spawn ${e.agentId} may edit only its plan ${plan}.`;
	}
	if (cfg.guards.read_tools.includes(e.tool) || e.tool === "todo") {
		const reads = [...(e.paths ?? []), ...q.touchedPaths(e.tool, input, e.cwd)];
		return reads.some(p => secretPath(p, cfg, e.cwd)) ? `review spawn ${e.agentId} may not read credentials or env files.` : null;
	}
	// P7 (plan 20261028_1600): the reviewer's shell is an allow list, not a ban list — eval never
	// (it runs code), and bash only when every |/&&/||/;/& segment starts with a review.shell_allow
	// command: single-line, no substitution or redirect characters, no writing/executing option
	// tokens. The secret-path deny stays. (I-20261031-348: the old MUTATING ban missed
	// fs.renameSync-style writes; I-20261031-350: a reviewer's shell ran anything unlisted.)
	if (cfg.guards.shell_tools.includes(e.tool)) {
		if (e.tool === "eval")
			return `review spawn ${e.agentId} may not run eval; use the read tools or a bash command from review.shell_allow.`;
		const problem = reviewShellProblem(String(input.command ?? ""), cfg);
		if (problem) return `review spawn ${e.agentId} may run only review.shell_allow commands: ${problem}.`;
		const reads = [...(e.paths ?? []), ...q.touchedPaths(e.tool, input, e.cwd)];
		return reads.some(p => secretPath(p, cfg, e.cwd)) ? `review spawn ${e.agentId} may not read credentials or env files.` : null;
	}
	return `review spawn ${e.agentId} may only read, use todo, and edit its plan; ${e.tool} is denied.`;
}

/** The brief names pending work the P3 way: `MR !N: <what it holds> — this task: <why not overlapping>` (GitHub `#N`), `Branch <name>: …`. */
export function briefNamesPending(brief: string, prefix: "MR" | "Branch", token: string): boolean {
	const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${prefix} ${esc}:[^\\n]*this task:`, "im").test(brief);
}

/** The branch a linked worktree has checked out, or null. */
function worktreeBranch(wt: string | null, run: CommandRunner): string | null {
	if (!wt) return null;
	const r = run(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], {});
	return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * P3 (plan 20261028_1600): done-but-not-merged work must be named by the brief before a spawn
 * runs on its plan. (a) open MRs of the plan's repo that the plan mentions (mr-sweep's lister and
 * `mentioned`; the list is cached `review.mr_cache_minutes`); (b) the plan's `Branch:` line or its
 * worktree's checked-out branch when wip-check reports it UNLANDED — still enforced when the forge
 * is unreachable, whose degrade skips only (a), like the sweep. A repo with no origin remote has
 * no merge target: both checks skip it with one guard-log line.
 */
export function pendingWorkProblem(named: string[], brief: string, cfg: Config, run: CommandRunner = defaultRunner): string | null {
	const plans = q.activePlans(cfg.paths).filter(p => named.includes(p.file));
	if (!plans.length) return null;
	const cache = readMrCache(cfg.paths);
	const fresh = nowSec() - cache.at < cfg.review.mr_cache_minutes * 60;
	const openMrs = new Map<string, OpenMr[]>();
	const hasOrigin = new Set<string>();
	let cacheDirty = false;
	for (const repo of new Set(plans.map(p => p.repo))) {
		if (fresh && cache.repos[repo]) {
			openMrs.set(repo, cache.repos[repo]);
			hasOrigin.add(repo);
			continue;
		}
		const listed = listOpenMrs(repo, run);
		if (!listed.ok) {
			log(cfg.paths.guard_log, `pending-work: ${repo}: ${listed.why}; the open-MR check is skipped`);
			if (listed.why !== "no origin remote") hasOrigin.add(repo); // forge down still enforces (b)
			continue;
		}
		openMrs.set(repo, listed.mrs);
		hasOrigin.add(repo);
		cache.repos[repo] = listed.mrs;
		cacheDirty = true;
	}
	if (cacheDirty) writeMrCache({ at: nowSec(), repos: cache.repos }, cfg);
	const unlanded = hasOrigin.size ? new Set(unlandedRows(run(["wip-check"], {}).stdout).map(r => r.branch)) : null;
	for (const p of plans) {
		// (a) only MRs the plan itself mentions are pending work here: the sweep already flags
		// unmentioned open MRs as UNTRACKED for the whole queue.
		for (const mr of openMrs.get(p.repo) ?? []) {
			if (!mentioned(mr.token, mr.branch, [p.text]) || briefNamesPending(brief, "MR", mr.token)) continue;
			return `plan ${p.file} has pending work MR ${mr.token} not merged; say in the brief what it already holds and why this task does not redo it ("MR ${mr.token}: <what it holds> — this task: <why not overlapping>").`;
		}
		if (!unlanded || !hasOrigin.has(p.repo)) continue;
		for (const b of [p.branch, worktreeBranch(p.worktree, run)]) {
			if (!b || !unlanded.has(b) || briefNamesPending(brief, "Branch", b)) continue;
			return `plan ${p.file} has pending work branch ${b} not merged; say in the brief what it already holds and why this task does not redo it ("Branch ${b}: <what it holds> — this task: <why not overlapping>").`;
		}
	}
	return null;
}

/** P6 (plan 20261028_1600): the refusal for ticking `ids` with review.code on. Each phase needs a recorded CODE REVIEW: PASS from a named review spawn (the `code` map of plan-reviews.json), and its entry must still be the plan's last Progress entry naming the phase — last by the entry's `<YYYY-MM-DD HH:MM>` stamp, not file order (live plans are newest-first or appended): implementer work after the review voids it. */
export function codeReviewProblem(file: string, after: string, ids: string[], paths: Pick<q.QueuePaths, "queue_state">): string | null {
	const rec = readCodeReviews(paths)[file];
	// toSorted is stable: ties and unstamped entries ("") keep file order.
	const entries = progressEntries(after)
		.map(b => [b, /^\s*-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(b)?.[1] ?? ""] as const)
		.toSorted((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
		.map(([b]) => b);
	for (const id of ids) {
		const last = entries.findLast(b => new RegExp(`\\b${id}\\b`).test(b));
		const valid = last !== undefined && REVIEW_LINE.test(last) && REVIEW_LINE.exec(last)![1] === "CODE" && REVIEW_LINE.exec(last)![2] === "PASS";
		if (!(rec?.verdict === "PASS" && rec.phases.includes(id) && valid))
			return `plan-guard: phase ${id} was ticked but has no current CODE REVIEW: PASS from a review spawn after its last implementer entry — spawn a code reviewer or set review.code: false. The file was restored.`;
	}
	return null;
}
