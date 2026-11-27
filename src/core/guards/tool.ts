// Pre-tool guard checks: protected files, subagent rules/blockers/budgets, Main edit window, and Main call budget.

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Decision, RunSource, ToolEvent } from "../adapter.ts";
import { currentPlanner, currentTier, takeGo } from "../autonomy.ts";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { removalFlags, stagedDiff, type RemovalFlag } from "../diff-check.ts";
import { notifyProtectedPaths, notifySecretReadHit } from "../notify.ts";
import * as q from "../queue/lib.ts";
import type { Plan } from "../queue/lib.ts";
import { plannerSpawnPlan } from "./planner.ts";
import { matchReviewSpawn, readReviewSpawns, reviewLockProblem } from "./review.ts";
import { bypassLaunch, taskLaunch } from "./spawn.ts";
import {
	ALLOW,
	bypassRegExp,
	changedProjectFiles,
	deny,
	log,
	MAIN_CALLS_RESET_SEC,
	MAIN_PLAN_FILE,
	mainCallsCapOn,
	mainCallsExpired,
	mainEditLimit,
	mainStateDir,
	readStaffing,
	readWindow,
	recordMainReads,
	subCallCap,
	tuned,
	unlockUntilMs,
	updateWindow,
} from "./state.ts";

/** A raw target that names a plan: under a docs/plans/ directory, or a plan file name (YYYYMMDD_HHMM_*.md). */
function isPlanName(raw: string): boolean {
	return /(^|\/)docs\/plans\//.test(raw) || /^\d{8}_\d{4}_[^/]*\.md$/.test(raw.split("/").pop() ?? "");
}
const PLAN_WRITE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

function protectedHit(paths: string[], cfg: Config): string | null {
	const hit = q.protectedHit(paths, cfg.paths);
	if (hit) return hit;
	for (const p of paths) {
		for (const raw of cfg.guards.protected) {
			const g = q.expandHome(raw);
			if (g.endsWith("/") ? p.startsWith(g) || `${p}/` === g : p === g) return p;
		}
		// The user's config file and the configured notify secret files are guard surface too:
		// an agent that could rewrite them could point notify at its own webhook.
		if (notifyProtectedPaths(cfg).includes(p)) return p;
	}
	return null;
}

function runBlockers(plan: Plan, hit: string[], e: ToolEvent, cfg: Config): string | null {
	// A caller staffed on a different plan (staffing.json holds the task names, keyed by agentId)
	// only grazes this plan (I-20261028-111): its path blockers must judge the covered paths,
	// not every path the command names.
	const staffing = readStaffing(cfg.paths);
	const foreign = !(staffing[plan.file] ?? []).includes(e.agentId) && Object.entries(staffing).some(([f, names]) => f !== plan.file && names.includes(e.agentId));
	for (const b of plan.blockers) {
		try {
			execFileSync(b.script, b.args, {
				input: JSON.stringify({ tool: e.tool, input: e.input, cwd: e.cwd, agent: e.agent, repo: plan.repo, plan: plan.file, paths: hit, ...(foreign ? { foreign: true } : {}) }),
				encoding: "utf8",
				timeout: cfg.guards.blocker_timeout_ms,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			// P5c (plan 20261031_1207): the deny names the hit paths and the script's own output
			// (stdout+stderr, first 300 chars) so the worker can fix the named file instead of
			// retrying blind; the Error message is the last resort for a script with no output.
			const stdout = typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string" ? err.stdout.trim() : "";
			const stderr = typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string" ? err.stderr.trim() : "";
			const message = err instanceof Error ? err.message : String(err);
			const detail = `${stdout}\n${stderr}`.trim().slice(0, 300);
			const why = detail || `${path.basename(b.script)} failed (${message})`;
			return `blocked by plan ${path.basename(plan.file)} (${hit.join(", ")}): ${why}`;
		}
	}
	return null;
}

// Words a shell line may put before the tool: launchers, shells with -c, VAR=value, and a script path ending in main.ts.
const LAUNCHERS: Record<string, true> = { bun: true, run: true, neurastream: true, node: true, npx: true, bunx: true, env: true, sudo: true, nohup: true, exec: true, bash: true, sh: true, zsh: true, "-c": true };

// True when a command segment runs queue-close or queue-cancel: the tool is the segment's first word after launchers.
// Segments also split at $( and backticks, so substitutions and `sh -c "..."` bodies are checked too.
function runsCloser(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = (words[i] ?? "").split("/").pop() ?? "";
		return /^queue-(close|cancel)$/.test(cmd);
	});
}

const bin = (w: string | undefined) => (w ?? "").replace(/^["']+|["']+$/g, "").split("/").pop() ?? "";

// P5g (plan 20261027_0915): the shell text a call would really run — bash's command line, eval's
// !cmd shell-escape lines and the Bun.$/spawn arguments inside its code. Everything else in an
// input is prose or string data (a task brief, plan text, an eval cell that only names the page's
// words), and prose runs nothing.
function shellText(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	const code = input.code;
	if (typeof code !== "string") return "";
	const out: string[] = [];
	for (const m of code.matchAll(/^[ \t]*!(.+)$/gm)) out.push(m[1] ?? "");
	for (const m of code.matchAll(/(?<!\w)(?:Bun\.)?\$[ \t]*`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? "");
	for (const m of code.matchAll(/\b(?:Bun\.)?spawn(?:Sync)?[ \t]*\(([^)]*)/g))
		out.push(
			[...(m[1] ?? "").matchAll(/[`"']([^`"']*)[`"']/g)]
				.map(s => s[1] ?? "")
				.join(" "),
		);
	return out.join("\n");
}

// True when a command segment starts the owner page (plan 20261024_2230 P3c): `neurastream
// workspace` serves it and `systemctl --user start/restart/enable` of neurastream-workspace
// relaunches it — the owner's systemd moves, never an agent's, unlocked or not. P5g: the text is
// shellText's — only real shell commands, never prose. Segment splitting and launcher skipping
// match runsCloser, so `sh -c "neurastream workspace"` and `sudo systemctl --user ...` are seen.
// (The command and unit were `ui` before the workspace rename; that name is gone, no alias.)
function startsOwnerUi(input: Record<string, unknown>): boolean {
	const text = shellText(input);
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = bin(words[i]);
		if ((cmd === "workspace" && bin(words[i - 1]) === "neurastream") || (cmd === "neurastream" && bin(words[i + 1]) === "workspace")) return true;
		return (
			cmd === "systemctl" &&
			words.some(w => w === "--user") &&
			words.some(w => w === "start" || w === "restart" || w === "enable") &&
			words.some(w => bin(w) === "neurastream-workspace" || w.startsWith("neurastream-workspace."))
		);
	});
}

// True when a command segment runs `claim release <plan> --force` (plan 20261027_1300 P4): it
// frees another Main's claim, the owner's terminal move, refused for every agent. Segment
// splitting and launcher skipping match startsOwnerUi, so `sh -c "neurastream claim release x
// --force"` and `sudo neurastream claim release x --force` are seen too.
function forceClaimRelease(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const seq = words.slice(i).map(bin);
		if (seq[0] === "neurastream") seq.shift();
		return seq[0] === "claim" && seq.includes("release") && seq.includes("--force");
	});
}

// True when a command segment lands work on a remote (plan 20261025_1940 P2): `git push`,
// `glab mr merge`, `gh pr merge`. Segment splitting and launcher skipping match startsOwnerUi,
// so `sh -c "git push"`, `sudo git push` and chained pushes are seen too.
function landingCommand(input: Record<string, unknown>): boolean {
	const text = Object.values(input).filter((v): v is string => typeof v === "string").join("\n");
	return text.split(/&&|\|\||;|\||\n|\$\(|`/).some(seg => {
		const words = seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["'(]+|["')]+$/g, ""));
		let i = 0;
		while (i < words.length && (LAUNCHERS[words[i] ?? ""] === true || /^\w+=/.test(words[i] ?? "") || /(^|\/)main\.ts$/.test(words[i] ?? ""))) i++;
		const cmd = (words[i] ?? "").split("/").pop() ?? "";
		if (cmd === "git" && words[i + 1] === "push") return true;
		if (cmd === "glab" && words[i + 1] === "mr" && words[i + 2] === "merge") return true;
		if (cmd === "gh" && words[i + 1] === "pr" && words[i + 2] === "merge") return true;
		return false;
	});
}

// P5/P5c (plan 20261031_1207): the shell text a read-only fast path may never carry — a landing
// command (push / MR merge), git add or commit, npm publish, a bypass_spawn launch, or a MUTATING
// write. Landing and commit commands produce no write targets, so this text filter — not
// writeTargets — is what keeps them out of the review lock's shell allow and the blocker skip.
// One predicate for both callers; reviewLockProblem denies it, subRules keeps the blockers on it.
// The removal check uses the commit alternative only: `git add` stages; the check judges at commit.
const GIT_ADD_OR_COMMIT = /\bgit\s+(add|commit)\b/;
function writesShellText(input: Record<string, unknown>, cfg: Config): boolean {
	if (landingCommand(input)) return true;
	const text = q.withoutQuotedRedirects(Object.values(input).filter((v): v is string => typeof v === "string").join("\n"));
	if (GIT_ADD_OR_COMMIT.test(text) || /\bnpm\s+publish\b/.test(text)) return true;
	if (cfg.guards.bypass_spawn.some(entry => bypassRegExp(entry).test(text))) return true;
	return q.MUTATING.test(text);
}

// The read tool's stand-in for a value it hid. A file may hold one only where it is produced
// (secret-redact.ts) or exercised (its tests).
const PLACEHOLDER = "[REDACTED:";
const PLACEHOLDER_FILES = [/\/src\/core\/secret-redact\.ts$/, /\/tests\/secret-redact[^/]*\.test\.ts$/];
/** What a write/edit/ast_edit call would add: every text argument but the targets and the replaced text. */
function addedText(input: Record<string, unknown>): string {
	const skip = new Set(["path", "file", "cwd", "old_string", "old", "oldText", "i"]);
	return Object.entries(input)
		.filter(([key, value]) => typeof value === "string" && !skip.has(key))
		.map(([, value]) => value as string)
		.join("\n");
}

// P5g: tools whose string fields are content — a task brief, the text a write or edit adds — are
// prose, never reads; the notify-secret check scans only their path argument.
const PROSE_TOOLS: Record<string, true> = { task: true, write: true, edit: true, ast_edit: true };

// Only a tool call's path arguments — the paths it names as targets, not its prose fields.
function pathArgs(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["path", "file"]) if (typeof input[key] === "string") out[key] = input[key];
	return out;
}

// Subagent half of a tool call (the original plan-guard checkCall without the main return).
// `cap` is the sub's hard call cap: its recorded per-spawn budget, else the global sub_max_calls.
function subRules(e: ToolEvent, input: Record<string, unknown>, paths: string[], writes: string[], cfg: Config, cap: number): string | null {
	// P6 (plan 20261024_1915): a sub's `git commit` is scanned first — its staged diff must not add
	// the removal comments diff-check flags. Detected through GIT_ADD_OR_COMMIT (the predicate
	// writesShellText carries); the refusal goes back through checkTool's deny(). Git that cannot
	// be read fails open (write-check.ts: a broken scan never blocks). Main is not gated: only
	// subRules sees this. A staged diff has no subject yet, so the subject rule is the CLI's <rev>.
	if (cfg.guards.shell_tools.includes(e.tool)) {
		const git = GIT_ADD_OR_COMMIT.exec(q.withoutQuotedRedirects(Object.values(input).filter((v): v is string => typeof v === "string").join("\n")));
		if (git?.[1] === "commit") {
			let flags: RemovalFlag[] = [];
			try {
				flags = removalFlags(stagedDiff(e.cwd), "", cfg);
			} catch { /* no readable repo in this cwd: nothing to flag */ }
			if (flags.length)
				return (
					"git commit refused: the staged diff adds removal comments (reword or drop them, then re-stage):\n" +
					flags.map(f => `${f.file}:${f.line}: ${f.text}`).join("\n")
				);
		}
	}
	// Closing and cancelling are Main's decisions: a shell that runs the tool is refused; one that only names its path is not.
	if (cfg.guards.shell_tools.includes(e.tool) && runsCloser(input))
		return 'queue-close and queue-cancel are Main\'s; report in your plan\'s "## Progress" instead.';
	// The read tool prints a placeholder for a value it hid, never the value (I-20261027-158,
	// I-20261027-160: one copy silently broke the shipped config template). Writing that text back
	// is refused; the file that produces one and the tests that exercise it are the exceptions.
	if ((e.tool === "write" || e.tool === "edit" || e.tool === "ast_edit") && addedText(input).includes(PLACEHOLDER)) {
		const keeper = writes.length > 0 && writes.every(p => PLACEHOLDER_FILES.some(rx => rx.test(p)));
		if (!keeper)
			return "this is the read tool's redaction placeholder, not the real value; re-read the file raw or keep the original line";
	}
	// planner mode P2 (b): while delegated, every sub write to a plan path is refused except the
	// plan its brief named in the approved spawn's `Planner role for <plan path>` line (the
	// planner-spawns binding). A NEW plan file is invisible to the indexed-plan gate below
	// (isOrchestrationPath + planAt both false), so the refusal fires here — never by accident of
	// indexing — and covers shell redirects through writeTargets too.
	const delegatedPlanner = currentPlanner(cfg) === "delegated" ? plannerSpawnPlan(e.agentId, cfg.paths) : null;
	// I-20261102-27: the seam above also refused the REVIEW spawn, and a review spawn's only write
	// is its own PLAN REVIEW / CODE REVIEW line — so in delegated mode no plan could ever record a
	// PASS and no implementer could spawn. The named review spawn of a plan may still write that
	// plan; the REVIEW_LINE rule below then decides whether the line is its verdict.
	const delegatedReview = currentPlanner(cfg) === "delegated" ? (matchReviewSpawn(readReviewSpawns(cfg.paths), e.agentId ?? "")?.spawn.plan ?? null) : null;
	if (currentPlanner(cfg) === "delegated") {
		for (const p of writes) {
			if (!MAIN_PLAN_FILE.test(p) || p === delegatedPlanner) continue;
			if (delegatedReview && path.resolve(e.cwd, p) === path.resolve(delegatedReview)) continue;
			if (delegatedPlanner) return `planner is delegated — your Planner role names ${delegatedPlanner} only; ${p} is not yours to write.`;
			return `planner is delegated — plan files are the planner agent's; your brief carries no "Planner role for <plan path>" line, so ${p} is refused.`;
		}
	}
	const plans = q.activePlans(cfg.paths);
	if (e.calls >= cap) {
		// Plan edit targets come from writeTargets (write and structured/hashline edit)
		// with touchedPaths as fallback; plan reads match any read tool.
		const planEdit =
			(e.tool === "write" || e.tool === "edit") &&
			(writes.length > 0 ? writes.every(p => q.planAt(p, plans)) : paths.length > 0 && paths.every(p => q.planAt(p, plans)));
		const planRead = cfg.guards.read_tools.includes(e.tool) && paths.length > 0 && paths.every(p => q.planAt(p, plans));
		if (!planEdit && !planRead)
			return `call budget spent (${e.calls}/${cap}). Only reading and editing your plan's "## Progress" is allowed now: write what you did, what is verified, what is next, then end your run.`;
	}
	if (!plans.length || !paths.length) return null;
	for (const p of writes) {
		if (!q.isOrchestrationPath(p, plans, cfg.paths.queue_index)) continue;
		if (!q.planAt(p, plans)) {
			// planner mode P2 (b): the bound planner plan routes into checkPlanEdit (Planner header,
			// Main-only lines), it is not Main's — but only that path, and only while delegated.
			if (currentPlanner(cfg) === "delegated" && p === delegatedPlanner) continue;
			return `${p} belongs to Main (main index / blocker script); read it, never change it. Report instead.`;
		}
		if (e.tool !== "write" && e.tool !== "edit")
			return `${p} is a plan file: change its "## Progress" section only with the edit or write tool.`;
	}
	for (const plan of plans) {
		const hit = paths.filter(p => !q.isOrchestrationPath(p, plans, cfg.paths.queue_index) && q.planCovers(plan, p, plans));
		if (!hit.length) continue;
		// An invalid plan stops code writes, not reads and not the repair of plan files: refusing those
		// too left a planner unable to fix the very errors the guard named (writes are checked before
		// the file is valid, so no valid text could ever land).
		const readOnly = cfg.guards.read_tools.includes(e.tool) || (cfg.guards.shell_tools.includes(e.tool) && !writes.length && !writesShellText(input, cfg));
		const planRepair = writes.length > 0 && writes.every(w => q.planAt(w, plans));
		if (plan.errors.length && !readOnly && !planRepair) return `plan ${plan.file} is invalid (${plan.errors.join("; ")}). Stop and report to Main.`;
		// P5c (plan 20261031_1207): reads and read-only shell calls skip the phase-0 blockers — a
		// failing blocker used to deny every read of a covered path and send the worker back blind.
		// The shell filter is the review lock's (writesShellText), so landing text keeps its blocker.
		if (!readOnly && !planRepair) {
			const why = runBlockers(plan, hit, e, cfg);
			if (why) return why;
		}
	}
	return null;
}

// Main's edit limit (20261025_1940 P2): the cap follows the autonomy tier — autonomy.strict_edit_limit
// in strict, guards.main_edit_limit in opinionated, none in full. Window starts at the first counted
// change, resets after main_window_min minutes and at every owner message. State lives in the queue
// state dir so one-shot CLI processes share the window (the original kept it in extension memory for
// one session).
function editWindow(e: ToolEvent, input: Record<string, unknown>, cfg: Config): Decision {
	const files = changedProjectFiles(e.tool, input, e.cwd, cfg);
	if (!files.length) return ALLOW;
	const tier = currentTier(cfg);
	if (tier === "full") return ALLOW; // no cap: Main works unattended
	const limit = mainEditLimit(cfg, tier);
	const limitName = tier === "strict" ? "autonomy.strict_edit_limit" : "owner limit";
	const now = Date.now();
	return updateWindow(cfg.paths, (w) => {
		if (w.used.length && now - w.windowStart >= cfg.guards.main_window_min * 60_000) w.used = [];
		if (w.used.length >= limit) {
			const mins = Math.ceil((w.windowStart + cfg.guards.main_window_min * 60_000 - now) / 60_000);
			log(cfg.paths.guard_log, `BLOCK tool=${e.tool} after ${w.used.length} edits (tier ${tier}): ${files.join(",")} rule=main.edit-window`);
			return {
				write: false,
				result: deny(
					`main-guard: tier ${tier} — Main already changed project files ${w.used.length} times in this ${cfg.guards.main_window_min}-minute window ` +
						`(${limitName} ${limit}; resets in ${mins} min). Main writes plans, not code: put the work in a plan ` +
						`(listed in ${cfg.paths.queue_index}, phase-0 blockers first) and spawn an implementer. Changes so far: ${w.used.join(", ")}`,
					"main.edit-window",
				),
			};
		}
		if (!w.used.length) w.windowStart = now;
		w.used.push(`${e.tool}:${files[0]!}`);
		const left = limit - w.used.length;
		if (left <= 2) {
			return {
				write: true,
				result: {
					allow: true,
					reason: "",
					inject: `main-guard: tier ${tier} — ${left} project-file change(s) left in this ${cfg.guards.main_window_min}-minute window; then delegate.`,
				},
			};
		}
		return { write: true, result: ALLOW };
	});
}

function mainTool(e: ToolEvent, input: Record<string, unknown>, cfg: Config, runs?: RunSource): Decision {
	if (e.tool === "task") {
		const why = taskLaunch(input, cfg, e.runningJobs, "main", runs);
		return why ? deny(`main-guard: ${why}`, "main.task-launch") : ALLOW;
	}
	if (cfg.guards.shell_tools.includes(e.tool)) {
		// Strict landing gate (20261025_1940 P2, P5): in tier strict every push/merge waits for the
		// owner's approve phrase (autonomy.go_phrase, default "go push"); the landing that consumes
		// it goes through. Opinionated and full keep today's allowance. Owner-only rules above are
		// untouched.
		if (landingCommand(input) && currentTier(cfg) === "strict" && !takeGo(cfg)) {
			log(cfg.paths.guard_log, "BLOCK landing: tier strict, no approve phrase rule=main.push-merge");
			return deny(`main-guard: tier strict — type "${cfg.autonomy.go_phrase}" to approve one push/merge`, "main.push-merge");
		}
		const command = String(input?.command ?? input?.code ?? "");
		const why = bypassLaunch(command, cfg, "main", runs);
		if (why) return deny(`main-guard: ${why}`, "main.bypass-launch");
	}
	return editWindow(e, input, cfg);
}

// Main's per-turn call cap (plan 20261028_1545 P2): the sub call-cap shape — warn at
// main_warn_calls, hard stop at main_max_calls — over calls counted in the window state file
// since the last real owner prompt or Main's terminal hand-back. The file, not the adapter's
// session memory, is the counter: one-shot CLI calls and a reloaded plugin must see the same
// count, and the reset points (checkInject here, the adapter's terminal agent_end) already write
// this file. Off in tier full (same gate as editWindow) and at main_max_calls 0.

/** The per-turn call cap applies to this call: on, not tier full, and the tool is not exempt. */
function mainCallApplies(e: ToolEvent, cfg: Config): boolean {
	return mainCallsCapOn(cfg, currentTier(cfg)) && !cfg.guards.main_call_exempt_tools.includes(e.tool);
}

/** Refusal once this turn has spent main_max_calls, or null. */
function mainCallStop(e: ToolEvent, cfg: Config): string | null {
	if (!mainCallApplies(e, cfg)) return null;
	const w = readWindow(cfg.paths);
	if (w.mainCalls >= cfg.guards.main_max_calls && !mainCallsExpired(w))
		return `main-guard: call ${w.mainCalls}/${cfg.guards.main_max_calls} since the owner's last message or your last hand-back (guards.main_max_calls); the count starts over ${Math.ceil((MAIN_CALLS_RESET_SEC - (nowSec() - (w.mainCallsStart ?? 0))) / 60)} min from now. End your turn with the answer, or spawn an implementer.`;
	return null;
}

/** Count one allowed, non-exempt call; returns the warn-band inject at main_warn_calls, "" below it. */
function mainCallWarn(e: ToolEvent, cfg: Config): string {
	if (!mainCallApplies(e, cfg)) return "";
	return updateWindow(cfg.paths, (w) => {
		if (w.mainCalls === 0 || mainCallsExpired(w)) {
			w.mainCalls = 0;
			w.mainCallsStart = nowSec();
		}
		w.mainCalls += 1;
		const warn =
			w.mainCalls >= cfg.guards.main_warn_calls
				? `main-guard: call ${w.mainCalls}/${cfg.guards.main_max_calls} this turn (guards.main_warn_calls). End your turn with the answer, or spawn an implementer.`
				: "";
		return { write: true, result: warn };
	});
}

/**
 * pre-tool: plan-guard checkCall for subs (protected files, budget, plan-edit rules, blockers)
 * plus, for Main, the spawn gates and the project-file edit window.
 */
export function checkTool(e: ToolEvent, cfg: Config, runs?: RunSource): Decision {
	return tuned(checkToolRules(e, cfg, runs), cfg);
}

function checkToolRules(e: ToolEvent, cfg: Config, runs?: RunSource): Decision {
	const lock = e.agent === "sub" ? reviewLockProblem(e, cfg) : null;
	if (lock) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} review lock: ${lock} rule=tool.review-lock`);
		return deny(`plan-guard: ${lock}`, "tool.review-lock");
	}
	if (cfg.guards.skip_tools.includes(e.tool)) return ALLOW;
	const input = e.input ?? {};
	// Starting the owner page (plan 20261024_2230 P3c) is the owner's systemd move, never an
	// agent's, unlocked or not: refused plan-guard style like a protected-file write.
	if (cfg.guards.shell_tools.includes(e.tool) && startsOwnerUi(input)) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} ui-start: ${String(input.command ?? "")} rule=tool.ui-start`);
		return deny(
			"plan-guard: starting the owner page (neurastream workspace, or systemctl --user start/restart/enable of neurastream-workspace) is the owner's move, not an agent's.",
			"tool.ui-start",
		);
	}
	// claim release --force frees another Main's claim (plan 20261027_1300 P4): the owner's
	// terminal move, refused for every agent like the ui-start, plan-guard style.
	if (cfg.guards.shell_tools.includes(e.tool) && forceClaimRelease(input)) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} claim-force: ${String(input.command ?? "")} rule=tool.claim-force`);
		return deny("plan-guard: claim release --force frees another Main's claim; that is the owner's move, in a terminal.", "tool.claim-force");
	}
	// The caller may know paths the text search cannot see (structured edits); union, never shrink.
	const paths: string[] = [];
	for (const p of [...(e.paths ?? []), ...q.touchedPaths(e.tool, input, e.cwd)]) if (!paths.includes(p)) paths.push(p);
	const writes: string[] = [];
	const relative: string[] = [];
	for (const p of [...(e.writes ?? []), ...q.writeTargets(e.tool, input, e.cwd, cfg.paths, relative)]) if (!writes.includes(p)) writes.push(p);
	// A relative plan path resolves against cwd to a file that does not exist, so the plan gate never
	// sees the edit (plan 20261028_1600 P4j). A plan is named by its absolute path, for every agent.
	const relPlan = PLAN_WRITE_TOOLS[e.tool] ? relative.find(isPlanName) : undefined;
	if (relPlan) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} relative plan path: ${relPlan} rule=tool.relative-plan`);
		return deny(`plan-guard: use the absolute plan path, not ${relPlan}. The plan gate cannot see a relative one.`, "tool.relative-plan");
	}
	// Notify secrets: no agent, main or sub, reads a webhook URL — with or without the unlock.
	// A call that changes a secret is not a read: its target goes through the protected-write
	// rule above, so the owner's unlock covers it like any guard file. P5g: the scan reads real
	// read targets only — naming a secret-shaped glob in a task brief or in plan text is prose,
	// not a read — so prose tools (task, write/edit) scan just their path argument, while every
	// other tool keeps the whole-input scan (glob/grep patterns arrive through it).
	const secretPaths: string[] = [];
	for (const p of [...(e.paths ?? []), ...q.touchedPaths(e.tool, PROSE_TOOLS[e.tool] === true ? pathArgs(input) : input, e.cwd)])
		if (!secretPaths.includes(p)) secretPaths.push(p);
	const secretHit = notifySecretReadHit(secretPaths.filter(p => !writes.includes(p)), cfg);
	if (secretHit) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} notify secret: ${secretHit} rule=tool.notify-secret`);
		return deny(`plan-guard: ${secretHit} is a notify secret path. Only the owner touches the webhook files, in a terminal.`, "tool.notify-secret");
	}
	// Main writes its own rollover note unattended (the note turn has nobody to ask). Only a Write
	// of a .md directly in <state>/rollover/ is exempt; shell writes, subagents and relaunch.json stay refused.
	const rolloverDir = path.join(mainStateDir(cfg), "rollover");
	const openWrites =
		e.agent === "main" && e.tool === "write"
			? writes.filter(p => !(path.extname(p) === ".md" && path.dirname(path.resolve(p)) === rolloverDir))
			: writes;
	const hit = protectedHit(openWrites, cfg);
	if (hit && unlockUntilMs(cfg) === null) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} protected: ${hit} rule=tool.protected`);
		// The plan index (plan 20261031_0911 P2) is guard surface like the rest, but unlike the
		// others an agent has a sanctioned way to change it: the queue add/move CLI through
		// writeIndex. Name it, so the refusal says what to do instead of naming the unlock.
		const viaQueue = hit === cfg.paths.queue_index ? ` Plans enter the index or move within it through \`neurastream queue add\` / \`neurastream queue move\`.` : "";
		return deny(
			`plan-guard: ${hit} is a protected guard file. Only the owner changes it (unlock: \`touch ${cfg.paths.unlock}\` in a terminal${
				cfg.guards.chat_unlock ? `, or type \`unlock ${cfg.guards.unlock_minutes}\` in chat` : ""
			}, valid ${cfg.guards.unlock_minutes} min).${viaQueue}`,
			"tool.protected",
		);
	}
	if (e.agent === "main") {
		// The plan-text checks (checkPlanEdit) see only edit/write results; a shell redirect,
		// sed -i or heredoc into a plan would skip them, so plans change through edit/write only.
		const shellPlan = e.tool !== "write" && e.tool !== "edit" ? writes.find(p => MAIN_PLAN_FILE.test(p)) : undefined;
		if (shellPlan) {
			log(cfg.paths.plan_guard_log, `BLOCK main tool=${e.tool} shell write to plan ${shellPlan} rule=tool.shell-plan`);
			return deny(`plan-guard: ${shellPlan} is a plan file: change it with the edit or write tool (close or cancel it with queue-close / queue-cancel).`, "tool.shell-plan");
		}
		const stop = mainCallStop(e, cfg);
		if (stop) {
			log(cfg.paths.guard_log, `BLOCK tool=${e.tool} after ${readWindow(cfg.paths).mainCalls} calls this turn rule=main.call-budget`);
			return deny(stop, "main.call-budget");
		}
		const d = mainTool(e, input, cfg, runs);
		if (!d.allow) return d;
		const warn = mainCallWarn(e, cfg);
		// A task brief names paths it does not read; only the other tools' paths count as reads.
		if (e.tool !== "task") recordMainReads(paths.filter(p => !writes.includes(p)), cfg.paths);
		return warn ? { ...d, inject: d.inject ? `${d.inject}\n${warn}` : warn } : d;
	}
	const cap = subCallCap(e.agentId, cfg);
	const why = subRules(e, input, paths, writes, cfg, cap);
	if (why) {
		log(cfg.paths.plan_guard_log, `BLOCK sub:${e.agentId} tool=${e.tool} ${why} rule=sub.rule`);
		return deny(`plan-guard: ${why}`, "sub.rule");
	}
	// A sub's own launch passes the same spawn gates as Main's (plan 20261028_1600 P4i).
	let launch: string | null = null;
	if (e.tool === "task") launch = taskLaunch(input, cfg, e.runningJobs, "sub", runs);
	else if (cfg.guards.shell_tools.includes(e.tool)) launch = bypassLaunch(String(input?.command ?? input?.code ?? ""), cfg, "sub", runs);
	if (launch) {
		log(cfg.paths.plan_guard_log, `BLOCK ${e.agent}:${e.agentId} tool=${e.tool} ${launch} rule=sub.launch`);
		return deny(`plan-guard: ${launch}`, "sub.launch");
	}
	const n = e.calls + 1;
	// The warn band has the global width (sub_max_calls - sub_warn_calls) ending at the cap;
	// unbudgeted subs keep sub_warn_calls exactly.
	const warn = cap === cfg.guards.sub_max_calls ? cfg.guards.sub_warn_calls : Math.max(1, cap - (cfg.guards.sub_max_calls - cfg.guards.sub_warn_calls));
	if (n >= warn && n < cap)
		return {
			allow: true,
			reason: "",
			inject: `plan-guard: call ${n}/${cap}. Update your plan's "## Progress" now (done, verified, next); at ${cap} only that edit is allowed.`,
		};
	return ALLOW;
}
