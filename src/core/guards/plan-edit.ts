// Plan edit verification: subagent Progress-only / planner-body / Findings / review rules, and Main read-evidence checks.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PlanEditEvent } from "../adapter.ts";
import { currentPlanner } from "../autonomy.ts";
import { heldByOther } from "../claims.ts";
import type { Config } from "../config.ts";
import { MAIN_ONLY_LINE } from "../plan-approval.ts";
import * as q from "../queue/lib.ts";
import { claimStoreFor } from "../team-client.ts";
import { plannerBody, plannerSpawnPlan } from "./planner.ts";
import { codeReviewProblem, matchReviewSpawn, readReviewSpawns, recordReviews, REVIEW_LINE, REVIEW_LOOKALIKE } from "./review.ts";
import {
	ALLOW,
	findingsValue,
	heldProblem,
	log,
	MAIN_PLAN_FILE,
	mainId,
	newlyTicked,
	newProgressEntries,
	readMainReads,
	type PlanEditDecision,
} from "./state.ts";

const GREP_LINE = /^([^\s:]+):\d+:/gm;

/**
 * The pre-draft warning (I-20261025-208): when Main reads a plan file (the read tool, or a result
 * whose first `path:line:` hit is the plan), the tool result gains one note naming the plan's
 * listed files that would fail the read check right now — before Main drafts an edit the guard
 * would refuse and throw away. Silence when every listed file is fresh in some checkout.
 */
export function planReadNote(tool: string, input: Record<string, unknown>, cwd: string, text: string, cfg: Config): string | undefined {
	let planPath = "";
	if (tool === "read" && typeof input.path === "string") planPath = path.resolve(cwd, q.expandHome(input.path));
	else {
		const first = [...text.matchAll(GREP_LINE)][0];
		if (first) {
			const base = typeof input.cwd === "string" ? path.resolve(cwd, q.expandHome(input.cwd)) : cwd;
			planPath = path.resolve(q.shellCwd(String(input.command ?? input.code ?? ""), base), first[1] ?? "");
		}
	}
	if (!planPath || !MAIN_PLAN_FILE.test(planPath)) return undefined;
	let plan: string;
	try {
		plan = readFileSync(planPath, "utf8");
	} catch {
		return undefined;
	}
	const stale = planReadProblems(plan, planPath, cfg)
		.filter(p => p.includes(" was not read by Main within "))
		.map(p => p.slice(0, p.indexOf(" was not read by Main within ")));
	if (!stale.length) return undefined;
	return `plan-guard: before you edit this plan, re-read: ${stale.join(", ")}`;
}

function mainOnlyLines(text: string): string {
	return text.split("\n").filter(l => MAIN_ONLY_LINE.test(l)).join("\n");
}

/**
 * plan-edit: after a subagent changed a plan, everything outside "## Progress" and every
 * Main-only line must be unchanged, and every Progress entry the edit adds must carry a
 * "Findings:" line (2026-10-24: a finding buried in a Progress note never became a plan);
 * `restore` hands back the untouched text for the caller to write (the original restored the
 * file itself before reporting).
 */
export function checkPlanEdit(e: PlanEditEvent, cfg: Config): PlanEditDecision {
	if (e.agent === "main") return checkMainPlan(e, cfg);
	// planner mode P2 (b): the plan bound to this sub by its approved spawn (the `Planner role for`
	// line) is the planner agent's to write — body freedom, but never the Main-only lines, and the
	// header names its agent. Only while delegated: in main mode the spawn gate refused the
	// Planner-role brief, and the plain Progress-only rule holds.
	if (currentPlanner(cfg) === "delegated" && e.agentId !== undefined && plannerSpawnPlan(e.agentId, cfg.paths) === e.path) {
		if (mainOnlyLines(e.after) !== mainOnlyLines(e.before)) {
			log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (planner wrote a Main-only line)`);
			return {
				allow: false,
				reason: `plan-guard: the Main-only lines ("Status:", "WAITING on owner:", "Waits on:", "Cancelled by owner:", "False positive:") of ${e.path} are never a planner agent's. The file was restored.`,
				restore: { path: e.path, text: e.before || null },
			};
		}
		const name = e.agentId ?? "";
		// The header records the agent the owner picked, not the spawn instance: a `glm-3` spawn
		// satisfies `Planner: glm`, and the spawn form still works for plans written before this.
		const names = new Set([name, name.replace(/-\d+$/, "")]);
		const head = e.after.split(/^## /m)[0] ?? "";
		if (!head.split("\n").some((l) => l.trim().startsWith("Planner: ") && names.has(l.trim().slice("Planner: ".length).trim()))) {
			log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (no Planner header)`);
			return {
				allow: false,
				reason: `plan-guard: ${e.path} carries no "Planner: ${name}" header — a planner agent's plan names its agent above the first section. The file was restored.`,
				restore: { path: e.path, text: e.before || null },
			};
		}
	} else if (q.outsideProgress(e.after) !== q.outsideProgress(e.before) || mainOnlyLines(e.after) !== mainOnlyLines(e.before)) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path}`);
		return {
			allow: false,
			reason: `plan-guard: you changed ${e.path} outside your progress entries (only "## Progress" entries are yours; the "Status:", "WAITING on owner:", "Waits on:", "Cancelled by owner:" and "False positive:" lines are Main's, it marks a plan complete after reviewing your work). The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	const missing = newProgressEntries(e.before, e.after).filter(b => !findingsValue(b));
	if (missing.length) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (no Findings line)`);
		return {
			allow: false,
			reason: `plan-guard: ${missing.length === 1 ? "your new entry in" : `${missing.length} of your new entries in`} ${e.path} ${missing.length === 1 ? "has" : "have"} no "Findings:" line. End every new "## Progress" entry with "Findings: none", or "Findings: <one item per finding (bug, workaround, improvement — any repo), each with file:line evidence>", items separated by ";". The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	const loose = newProgressEntries(e.before, e.after).filter(b => REVIEW_LOOKALIKE.test(b) && !REVIEW_LINE.test(b));
	if (loose.length) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (review line)`);
		return {
			allow: false,
			reason: `plan-guard: a PLAN REVIEW or CODE REVIEW line in ${e.path} does not match "- [<date> <time> <name>: ]PLAN REVIEW|CODE REVIEW: PASS|FAIL — …". The file was restored.`,
			restore: { path: e.path, text: e.before },
		};
	}
	if (e.agent === "sub" && newProgressEntries(e.before, e.after).some(b => REVIEW_LINE.test(b)) && matchReviewSpawn(readReviewSpawns(cfg.paths), e.agentId ?? "")?.spawn.plan !== e.path) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} review line from a spawn that is not its named review spawn`);
		return { allow: false, reason: `plan-guard: a PLAN REVIEW or CODE REVIEW line counts only from the named review spawn of ${e.path}; the file was restored.`, restore: { path: e.path, text: e.before } };
	}
	recordReviews(e, cfg);
	return ALLOW;
}

// Main's plan text outside "## Progress" must rest on files Main read itself (planReadProblems).
// An empty `before` means the plan file did not exist yet; a refusal then deletes it.
function checkMainPlan(e: PlanEditEvent, cfg: Config): PlanEditDecision {
	// planner mode P2 (a): while delegated, Main plans nothing — a new plan file or a rewrite of
	// the text outside "## Progress" is the planner agent's work. Main keeps its Progress entries,
	// the Main-only lines (Status / WAITING on owner / Waits on / Cancelled by owner / False
	// positive) and the index; running the queue stays Main's.
	if (currentPlanner(cfg) === "delegated" && e.path !== cfg.paths.queue_index && plannerBody(e.after) !== plannerBody(e.before)) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (planner delegated)`);
		return {
			allow: false,
			reason: `plan-guard: planner is delegated — route the ask to the planner agent. ${e.before ? "The file was restored." : "The new file was removed."}`,
			restore: { path: e.path, text: e.before || null },
		};
	}
	// P3 (plan 20261027_1300): another Main's live claim on this plan refuses the edit, restored
	// like any refused plan edit. No claim — or this Main's own — edits freely. The chooser gets
	// `e.before` (the file on disk already holds the edit, so a team plan stays guarded while an
	// edit removes its header; the record rule covers it too).
	const holder = claimStoreFor(e.path, cfg, e.before).holder(e.path);
	if (holder !== null && "unreachable" in holder) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (team server ${holder.unreachable} unreachable)`);
		return {
			allow: false,
			reason: `plan-guard: ${heldProblem(e.path, holder)}; the file was restored.`,
			restore: { path: e.path, text: e.before || null },
		};
	}
	if (holder && heldByOther(holder, mainId())) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (held by Main ${holder.main})`);
		return {
			allow: false,
			reason: `plan-guard: ${heldProblem(e.path, holder)}; the file was restored.`,
			restore: { path: e.path, text: e.before || null },
		};
	}
	// A PLAN REVIEW or CODE REVIEW line (P6) is a review spawn's verdict (P4k): Main writes none, so its edit is restored.
	if (newProgressEntries(e.before, e.after).some(b => REVIEW_LINE.test(b))) {
		log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (Main wrote a review line)`);
		return {
			allow: false,
			reason: `plan-guard: a PLAN REVIEW or CODE REVIEW line is written only by the named review spawn of ${e.path}, never by Main. The file was restored.`,
			restore: { path: e.path, text: e.before || null },
		};
	}
	// P6 (plan 20261028_1600): with review.code on, ticking a phase needs a named review spawn's CODE REVIEW: PASS behind it — the recorded verdict counts, never Main's own line.
	if (cfg.review.code) {
		const ticks = newlyTicked(e.before, e.after);
		const problem = ticks.length ? codeReviewProblem(e.path, e.after, ticks, cfg.paths) : null;
		if (problem) {
			log(cfg.paths.plan_guard_log, `RESTORE ${e.path} (code review: ${ticks.join(", ")})`);
			return { allow: false, reason: problem, restore: { path: e.path, text: e.before || null } };
		}
	}
	if (q.outsideProgress(e.after) === q.outsideProgress(e.before)) {
		return ALLOW;
	}
	// A cited file Main did read lands in the list instead of the refusal (I-20261025-208): fix the
	// text first, then judge the fixed text like any other edit.
	const fix = autoListReads(e.after, e.path, cfg);
	const fixed = fix ? fix.text : e.after;
	// Refuse only what this edit adds: a problem the plan already had is not Main's doing now.
	// The missing-section problem is always refused: a plan with no read list has no evidence behind its text.
	const known = new Set(e.before ? planReadProblems(e.before, e.path, cfg) : []);
	const problems = planReadProblems(fixed, e.path, cfg).filter(p => p === NO_SECTION || !known.has(p));
	if (!problems.length) {
		if (!fix) return ALLOW;
		const list = fix.paths.join(", ");
		log(cfg.paths.plan_guard_log, `AUTO-LIST ${e.path}: ${list}`);
		return {
			allow: true,
			reason: "",
			rewrite: { path: e.path, text: fix.text },
			note: `plan-guard: added ${fix.paths.length} file(s) to "## Code read by Main": ${list}`,
		};
	}
	log(cfg.paths.plan_guard_log, `REFUSE-READ ${e.path}: ${problems.join("; ")}`);
	return {
		allow: false,
		reason: `plan-guard: ${e.path} cites code Main has not read for this plan:\n- ${problems.join("\n- ")}\nRead each file (read or grep it), list it under "## Code read by Main", then edit again. ${e.before ? "The file was restored." : "The new file was removed."}`,
		restore: { path: e.path, text: e.before || null },
	};
}

const READ_SECTION = /^## Code read by Main[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const LISTED_PATH = /`([^`\s]+)`/g;
const CITED_PATH = /((?:~\/|\/|\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]+):\d+/g;

const NO_SECTION = `no "## Code read by Main" section lists a file (list each file you read for this plan as a backticked path)`;

/** Read evidence behind a plan edit: section present, each listed path read within the window, no unlisted cited path. */
function planReadProblems(text: string, planPath: string, cfg: Config): string[] {
	const listed = [...(READ_SECTION.exec(text)?.[1] ?? "").matchAll(LISTED_PATH)].map(m => (m[1] ?? "").replace(/:[\d,+\- ]+$/, ""));
	if (!listed.length) return [NO_SECTION];
	const reads = readMainReads(cfg.paths);
	const maxMs = cfg.guards.plan_read_max_hours * 3_600_000;
	const problems: string[] = [];
	const named = new Set<string>();
	for (const p of listed) {
		const abs = planFile(p, planPath, text);
		named.add(abs);
		if (!isFile(abs)) problems.push(`${p} does not exist`);
		else if (!readWithin(abs, planPath, text, reads, maxMs)) problems.push(`${p} was not read by Main within ${cfg.guards.plan_read_max_hours} h`);
	}
	for (const [, cited = ""] of q.outsideProgress(text).matchAll(CITED_PATH)) {
		const abs = planFile(cited, planPath, text);
		if (abs.includes("/docs/plans/") || namedOrTwin(named, abs, planPath, text) || !isFile(abs)) continue;
		problems.push(`${cited} is cited but not listed under "## Code read by Main"`);
	}
	return problems;
}

/** A plan-cited path: absolute, else under the plan's Worktree (when set) or its repo root. */
function planFile(p: string, planPath: string, text: string): string {
	const home = q.expandHome(p);
	if (path.isAbsolute(home)) return home;
	const roots = planRoots(planPath, text);
	const root = roots.find(r => isFile(path.join(r, home))) ?? roots[roots.length - 1]!;
	return path.join(root, home);
}

/** The roots a plan-relative path resolves against: the plan's Worktree (when set), then its repo (the text before /docs/plans/, so a docs/plans/<subdir>/ plan still resolves repo-relative paths against <repo>). */
function planRoots(planPath: string, text: string): string[] {
	const wt = /^Worktree:\s*(\S+)/m.exec(text)?.[1];
	const cut = planPath.indexOf("/docs/plans/");
	const repo = cut >= 0 ? planPath.slice(0, cut) : path.dirname(path.dirname(path.dirname(planPath)));
	return wt && wt !== "-" ? [wt, repo] : [repo];
}

/** The same repo-relative file under the plan's other root (Worktree ↔ main checkout), or null when `abs` sits under neither. */
function twinFile(abs: string, planPath: string, text: string): string | null {
	const roots = planRoots(planPath, text);
	for (const root of roots) {
		const prefixed = root.endsWith("/") ? root : `${root}/`;
		if (!abs.startsWith(prefixed)) continue;
		for (const other of roots) {
			if (other === root) continue;
			return `${other.endsWith("/") ? other : `${other}/`}${abs.slice(prefixed.length)}`;
		}
	}
	return null;
}

/** Main read this file within the window — at the resolved path or at its twin under the plan's other root (I-20261025-208 evidence: the same file read in the main checkout must cover its Worktree copy). */
function readWithin(abs: string, planPath: string, text: string, reads: Record<string, string>, maxMs: number): boolean {
	const cutoff = Date.now() - maxMs;
	const fresh = (f: string) => Date.parse(reads[f] ?? "") >= cutoff;
	if (fresh(abs)) return true;
	const twin = twinFile(abs, planPath, text);
	return twin !== null && fresh(twin);
}

/** The resolved path, or its twin under the plan's other root, is already in the set (cited-vs-listed matches files, not spellings). */
function namedOrTwin(named: Set<string>, abs: string, planPath: string, text: string): boolean {
	if (named.has(abs)) return true;
	const twin = twinFile(abs, planPath, text);
	return twin !== null && named.has(twin);
}

/**
 * Cited paths (outside Progress) Main read within the window but the list omits: returns the plan
 * text with one `- \`<path as cited>\`` line appended to "## Code read by Main" (the section is
 * created before "## Progress" when missing), or null when nothing qualifies. Never-read citations
 * stay out: they are refused like today.
 */
function autoListReads(text: string, planPath: string, cfg: Config): { text: string; paths: string[] } | null {
	const reads = readMainReads(cfg.paths);
	const maxMs = cfg.guards.plan_read_max_hours * 3_600_000;
	const covered = new Set<string>();
	for (const p of [...(READ_SECTION.exec(text)?.[1] ?? "").matchAll(LISTED_PATH)].map(m => (m[1] ?? "").replace(/:[\d,+\- ]+$/, "")))
		covered.add(planFile(p, planPath, text));
	const added: string[] = [];
	const seen = new Set<string>();
	for (const [, cited = ""] of q.outsideProgress(text).matchAll(CITED_PATH)) {
		const abs = planFile(cited, planPath, text);
		if (abs.includes("/docs/plans/") || seen.has(cited) || !isFile(abs)) continue;
		if (namedOrTwin(covered, abs, planPath, text)) continue;
		if (!readWithin(abs, planPath, text, reads, maxMs)) continue;
		seen.add(cited);
		covered.add(abs);
		added.push(cited);
	}
	if (!added.length) return null;
	const lines = added.map(p => `- \`${p}\``);
	const m = READ_SECTION.exec(text);
	let out: string;
	if (m && m[1] !== undefined) {
		// Append after the section's last entry, ahead of the blank lines before the next heading.
		const bodyStart = m.index + m[0].length - m[1].length;
		const at = bodyStart + m[1].replace(/\s+$/, "").length;
		out = `${text.slice(0, at)}\n${lines.join("\n")}${text.slice(at)}`;
	} else {
		// No section yet: create it right before "## Progress" (or at the end when that is missing too).
		const at = text.search(/^## Progress\b/m);
		const block = `## Code read by Main\n${lines.join("\n")}\n\n`;
		out = at === -1 ? `${text}${block}` : `${text.slice(0, at)}${block}${text.slice(at)}`;
	}
	return { text: out, paths: added };
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}
