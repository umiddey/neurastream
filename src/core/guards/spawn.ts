// Spawn gates: plan gate, priority order, provider preference/claims, incident gate, team claims/caps, and checkSpawn.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Decision, RunSource, SpawnEvent } from "../adapter.ts";
import { currentPlanner, currentTier } from "../autonomy.ts";
import { lint } from "../brief-lint.ts";
import { heldByOther, type ClaimStore } from "../claims.ts";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { ownerSaid, readOwnerMessages, type OwnerMessage } from "../incidents.ts";
import { defaultRunner, type CommandRunner } from "../mr-sweep.ts";
import { approvalProblem } from "../plan-approval.ts";
import { outUntil, pinModel, providerOfModel, readOut } from "../provider-state.ts";
import * as q from "../queue/lib.ts";
import type { Plan } from "../queue/lib.ts";
import { claimStoreFor, pathId, routeTeam, teamDir, type TeamEntry } from "../team-client.ts";
import { plannerPlanProblem, plannerRolePlan, recordPlannerSpawn } from "./planner.ts";
import { isReviewSpawn, pendingWorkProblem, readMrCache, recordReviewSpawn, reviewPassProblem, reviewRole } from "./review.ts";
import {
	ALLOW,
	briefBudget,
	bypassRegExp,
	CANCEL_TODO,
	deny,
	heldProblem,
	log,
	mainId,
	openIncidentList,
	readSpawns,
	readStaffing,
	recordBudgets,
	recordSpawns,
	staffedPlans,
	tuned,
	unticked,
	type Spawner,
} from "./state.ts";

const RESEARCH_ASK = /\b(research|investigate|find where|map the code|read the code for)\b/i;
const PLAN_WRITE = /\b(write|writing|draft|drafting|author)\b[^\n]*\bplan\b/i;

/** The open plans the text names — a `Priority skip: <path> — <why>` line names a plan it does NOT run on (20261025_0215 P3), so only the remaining text decides. planGate's targeting, shared with the spawn verdict's brief-lint and cap notes (plan 20261031_1207 P4). */
function briefPlans(text: string, cfg: Config): Plan[] {
	const body = text.replace(/^\s*(?:[-*]\s+)?priority skip:.*$/gim, "");
	return q.activePlans(cfg.paths, cfg.review.agents).filter(p => body.includes(p.file));
}

// Plans an implementer brief may run on; returns [reason, null] or [null, plan files].
export function planGate(text: string, label: string, cfg: Config): [string | null, string[]] {
	const plans = q.activePlans(cfg.paths, cfg.review.agents);
	const unclosed = plans.filter(p => (p.status === "complete" || p.status === "cancelled") && !q.awaitingMerge(p, cfg.paths));
	if (unclosed.length)
		return [
			`${label}: ${unclosed.map(p => `${p.file} (${p.status})`).join(", ")} is still indexed. Verify it and run \`queue-close <plan>\` before any new spawn.`,
			[],
		];
	const named = briefPlans(text, cfg);
	if (!named.length)
		return [
			`${label}: an implementer needs an open plan. Name the plan's absolute path in the brief; the plan must be listed in ${cfg.paths.queue_index}.`,
			[],
		];
	if (RESEARCH_ASK.test(text) && PLAN_WRITE.test(text))
		return [
			`${label}: a brief must not ask for research for a plan to be written. Please never ever ever write a plan when another agent is doing the research or reading for you. Main reads the code for its plans itself.`,
			[],
		];
	// P5 (plan 20261031_0911): a landed open plan whose auto-close failed locks the queue — every
	// brief must name it, so the next spawn works on closing it instead of around it. A named
	// locked plan skips the unticked-phase checks below: its work has landed, the job is the close.
	const locked = plans.filter(p => p.status === "open" && q.autoCloseCandidate(p) && q.lastCloseFailed(p.file, cfg.paths));
	for (const s of locked) {
		if (named.some(n => n.file === s.file)) continue;
		return [
			`${label}: ${s.file} landed but its auto-close failed (${(q.lastCloseResult(s.file, cfg.paths) ?? "").replace(/^queue-close: /, "")}). The queue is locked on it: name this plan in the brief and fix the close before any other spawn.`,
			[],
		];
	}
	const spawns = readSpawns(cfg.paths);
	for (const p of named) {
		if (p.errors.length) return [`${label}: plan ${p.file} is not ready (${p.errors.join("; ")}).`, []];
		if (p.waiting) return [`${label}: plan ${p.file} is parked "WAITING on owner".`, []];
		if (p.status !== "open") return [`${label}: plan ${p.file} says "Status: ${p.status}".`, []];
		const cancelled = q.cancelledMatches(p, cfg.paths);
		if (cancelled.length) return [`${label}: plan ${p.file} ${q.cancelledProblem(p, cancelled[0]!, cfg.paths)}`, []];
		const before = spawns[p.file];
		if (before && before === q.sha(q.progressBody(p.text)))
			return [
				`${label}: plan ${p.file} has no new "## Progress" entry since the last agent ran on it. Write that run's progress (from its report) into the plan first.`,
				[],
			];
		const approval = approvalProblem(p.text, p.file, cfg.pages.dir, cfg.approval.since, cfg.paths);
		if (approval) return [approval, []];
		const open = unticked(p);
		// A locked plan's work has landed: closing it is the job, there is no phase left to tick.
		if (locked.some(l => l.file === p.file)) continue;
		if (!open.length) return [`${label}: plan ${p.file} has no unticked phase left.`, []];
		if (!open.some(id => new RegExp(`\\b${id}\\b`).test(text)))
			return [`${label}: the brief must name an unticked phase of ${p.file} (${open.join(", ")}).`, []];
	}
	return [null, named.map(p => p.file)];
}

// --- priority: index order is priority (plan 20261025_0215_index_priority) ---

export interface PrioritySkip {
	plan: string;
	why: string;
}

export interface PriorityOutcome {
	/** Refusal text, without the caller's label prefix. */
	problem?: string;
	/** Skip lines the brief justified; the caller logs each, then allows. */
	skips?: PrioritySkip[];
	/** No job info was available: the gate never refuses. */
	unknown?: boolean;
}

const SKIP_LINE = /^\s*(?:[-*]\s+)?priority skip:\s*(.+?)\s+[—–-]\s*(.+?)\s*$/gim;

/** One plan is idle when a subagent could start on it right now: open, no owner hold, not awaiting merge, no template errors, an unticked phase left, and not waiting on another open plan of the active index. */
function priorityIdle(p: Plan, plans: Plan[], paths?: Pick<q.QueuePaths, "queue_state">): boolean {
	if (p.waitsOn.some(f => plans.some(w => w.file === f && w.status === "open"))) return false;
	return p.status === "open" && !p.waiting && !(paths ? q.awaitingMerge(p, paths) : false) && !p.errors.length && unticked(p).length > 0;
}

/**
 * Pure priority gate: for the brief's named plans, every higher plan in index order that is idle
 * and unstaffed needs proof before a lower plan takes a free slot; otherwise the spawn is refused.
 * Proof is either the higher plan's own `Waits on: <plan>` line for a plan still open in the index
 * (then it is not idle at all) or a `Priority skip: <path> — owner: "<words>"` line whose quoted
 * words (≥ 4, normalised) appear in one of `messages` (the owner's recorded words of the last
 * 24 h; `now` is the current unix seconds). A higher plan whose branch carries an open MR in the
 * cached forge list (fresh within `review.mr_cache_minutes`; the one list the main-start sweep
 * and pendingWorkProblem maintain — never queried here) is landing, not idle: no proof needed.
 * A stale cache proves nothing, so the refusal stands (I-20261029-435). In tier full (`cfg`) a
 * `Priority skip: <path> — Main: "<reason>"` line with ≥ 4 words is proof too; without `cfg` the
 * refusal behaviour is the pre-tier one. Any other skip line is refused.
 * `staffed === undefined` means the caller had no running-job info (CLI spawn without it): never
 * refuse. Plans already named by this call never block it.
 */
export function priorityProblem(plans: Plan[], named: string[], staffed: string[] | undefined, brief: string, messages: OwnerMessage[] = [], now: number = nowSec(), cfg?: Config): PriorityOutcome | null {
	if (staffed === undefined) return { unknown: true };
	const namedRanks = named.map(f => plans.findIndex(p => p.file === f)).filter(n => n >= 0);
	if (!namedRanks.length) return null;
	const higher = plans.slice(0, Math.min(...namedRanks));
	const tier = cfg ? currentTier(cfg) : "opinionated";
	const skipLines: Record<string, string> = {};
	for (const m of brief.matchAll(SKIP_LINE)) {
		const plan = (m[1] ?? "").trim();
		const why = (m[2] ?? "").trim();
		if (plan && why) skipLines[plan] = why;
	}
	const skips: PrioritySkip[] = [];
	const cache = cfg ? readMrCache(cfg.paths) : { at: 0, repos: {} };
	const fresh = cfg ? now - cache.at < cfg.review.mr_cache_minutes * 60 : false;
	for (let i = 0; i < higher.length; i++) {
		const p = higher[i]!;
		if (!priorityIdle(p, plans, cfg?.paths) || staffed.includes(p.file)) continue;
		if (fresh && p.branch && (cache.repos[p.repo] ?? []).some(mr => mr.branch === p.branch)) continue;
		const why = skipLines[p.file];
		// Tier full (20261025_1940 P2): Main's own >= 4-word reason is proof enough; every other
		// tier refuses it exactly as before — only the owner's recorded words let a skip through.
		const mainWhy = tier === "full" ? why?.match(/^Main:\s*"(.+)"\s*$/) : undefined;
		if (why && mainWhy && mainWhy[1]!.trim().split(/\s+/).length >= 4) {
			skips.push({ plan: p.file, why });
			continue;
		}
		const quote = why?.match(/^owner:\s*"(.+)"\s*$/);
		if (why && quote && ownerSaid(quote[1]!, messages, now)) {
			skips.push({ plan: p.file, why });
			continue;
		}
		return { problem: `higher plan ${p.file} (rank ${i + 1}) is idle; a skip needs the owner's words (Priority skip: ${p.file} — owner: "<quote>") or a "Waits on: ${p.file}" line in that plan` };
	}
	return skips.length ? { skips } : null;
}

/** Load staffing and the owner's recorded words, run the pure priority gate and log its outcome; the refusal comes back with the caller's label, or null. P8 (I-20261031-353): the plans a Main-authored brief reviews drop out first — a plan waiting for its reviewer is not a priority slot, so a call naming only reviewed plans passes with no skip line; implementer plans keep the gate. */
function priorityGate(named: string[], runningJobs: string[] | undefined, brief: string, cfg: Config, label: string, agent: string, spawner: Spawner): string | null {
	const implementer = named.filter(f => !isReviewSpawn(f, brief, agent, cfg, spawner));
	const outcome = priorityProblem(q.activePlans(cfg.paths), implementer, runningJobs === undefined ? undefined : staffedPlans(readStaffing(cfg.paths), runningJobs), brief, readOwnerMessages(cfg.paths), nowSec(), cfg);
	if (outcome?.unknown) log(cfg.paths.guard_log, "PRIORITY unknown jobs");
	for (const s of outcome?.skips ?? []) log(cfg.paths.guard_log, `PRIORITY skip ${s.plan}: ${s.why}`);
	return outcome?.problem ? `${label}: ${outcome.problem}` : null;
}

/**
 * The owner's pick order (plan 20261025_1700 P3): refuse a later `ledger.prefer` agent while an
 * earlier one is free and under its provider cap, unless the brief carries "Pick note: <why>".
 * Free comes from the pin's provider and provider-out.jsonl (absence of a record is free);
 * "under its cap" counts the caller's running jobs whose label embeds the higher agent's name —
 * a caller without job info counts 0, erring toward the owner's order, which Pick note unlocks.
 */
export function preferProblem(agent: string, brief: string, runningJobs: readonly string[] | undefined, cfg: Config): string | null {
	const prefer = cfg.ledger.prefer;
	if (!prefer.length) return null;
	const mine = prefer.indexOf(agent);
	if (mine <= 0) return null; // the first pick, or an agent the order does not name
	if (/\bPick note:/i.test(brief)) return null;
	for (let j = 0; j < mine; j++) {
		const higher = prefer[j]!;
		const provider = providerOfModel(pinModel(cfg, higher));
		if (provider === null || outUntil(cfg, provider) !== null) continue; // unknown or out
		const running = (runningJobs ?? []).filter(l => l.toLowerCase().includes(higher.toLowerCase())).length;
		if (running >= cfg.ledger.max_running_per_provider) continue; // the higher pick is at its provider cap
		return `${higher} is ahead of ${agent} in ledger.prefer and free (under its provider cap) — spawn ${higher}, or add "Pick note: <why>" to the brief.`;
	}
	return null;
}

/** P4 (plan 20261031_1207): `agent-ledger --cap`'s FULL line at spawn time — the agent's provider already runs its full share of live subagents. Counted from the caller's running job labels, the live data preferProblem counts (a caller without job info counts 0). */
function ledgerCapProblem(agent: string, runningJobs: readonly string[] | undefined, cfg: Config): string | null {
	const provider = providerOfModel(pinModel(cfg, agent));
	if (provider === null || outUntil(cfg, provider) !== null) return null;
	const sharers = [agent, ...cfg.ledger.prefer.filter(a => providerOfModel(pinModel(cfg, a)) === provider)];
	const running = (runningJobs ?? []).filter(l => sharers.some(n => l.toLowerCase().includes(n.toLowerCase()))).length;
	if (running < cfg.ledger.max_running_per_provider) return null;
	return `provider ${provider} is at its cap (${running} live of ${cfg.ledger.max_running_per_provider} running); stop or wait for one before spawning more.`;
}

/**
 * The one spawn verdict (plan 20261031_1207 P4): every refusal in one numbered list, so Main fixes
 * all of them in one round trip. The named plans' brief-lint errors and the provider-cap note (the
 * advice Main gathered by hand through `brief-lint` and `agent-ledger --cap`) ride along on an
 * already-refused spawn — alone they never refuse: real plans carry lint nits, and a full provider
 * is the prefer order's to weigh, not a gate of its own.
 */
function spawnVerdict(agent: string, problems: string[], lintFiles: string[], runningJobs: readonly string[] | undefined, cfg: Config): string | null {
	if (!problems.length) return null;
	const advice: string[] = [];
	for (const f of new Set(lintFiles)) {
		try {
			for (const e of lint(f, cfg).errs) advice.push(`${f}: ${e}`);
		} catch {} // an unreadable plan's refusal is planGate's to name
	}
	const cap = ledgerCapProblem(agent, runningJobs, cfg);
	if (cap) advice.push(cap);
	const all = [...problems, ...advice];
	return `${agent}: ${all.length} ${all.length === 1 ? "problem" : "problems"}:\n${all.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
}

/**
 * Who is rate-limited comes from live data (plan 20261025_1700 P1): refuse a brief that asserts a
 * provider shown free by providerStatus is rate-limited — named directly or through a prefer
 * agent's pin. providerStatus lists only providers with a record, so a never-recorded provider is
 * not protected here; a past-tense mention does not match, because the claim must say "is …".
 */
export function providerClaimProblem(text: string, cfg: Config): string | null {
	const recorded = new Set(readOut(cfg).map(r => r.provider));
	const free = (provider: string | null): boolean => provider !== null && recorded.has(provider) && outUntil(cfg, provider) === null;
	const names = new Map<string, string>();
	for (const p of cfg.ledger.providers) if (free(p)) names.set(p, p);
	for (const agent of cfg.ledger.prefer) {
		const provider = providerOfModel(pinModel(cfg, agent));
		if (free(provider) && !names.has(agent) && provider !== null) names.set(agent, provider);
	}
	if (!names.size || !/\bis\b/i.test(text)) return null;

	const m = new RegExp(`\\b(${[...names.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b[^.\\n]{0,80}?\\b(?:is|are)\\s+(?:still\\s+|now\\s+)?(?:rate[ -]?limited|rate limiting|throttled|out until|limited)`, "i").exec(text);
	if (!m) return null;
	const hit = [...names.entries()].find(([n]) => n.toLowerCase() === (m[1] ?? "").toLowerCase());
	if (hit === undefined) return null;
	const [name, provider] = hit;
	return `${name === provider ? provider : `${name} (provider ${provider})`} is free per the recorded provider state — do not claim it is rate-limited; read the providers line from agent-ledger --cap.`;
}

/**
 * While an owner-correction incident (source "realtime") is open, a launch must be fix work: its
 * brief (or a plan the brief names) cites `INCIDENT <id>` of an open one. Notes from worker
 * findings/traces never refuse a spawn (plan 20261031_1207 P2). Returns the refusal reason, or
 * null; `label` names the log line.
 */
export function incidentSpawnProblem(label: string, brief: string, namedPlans: string[], cfg: Config): string | null {
	const open = openIncidentList(cfg).filter(i => i.source === "realtime");
	if (!open.length) return null;
	const texts = [brief];
	for (const f of namedPlans) {
		try {
			texts.push(readFileSync(f, "utf8"));
		} catch {}
	}
	const remaining = open.filter(i => !texts.some(t => t.includes(`INCIDENT ${i.id}`)));
	if (!remaining.length) return null;
	const ids = remaining.map(i => i.id).join(", ");
	log(cfg.paths.guard_log, `BLOCK ${label}: open incidents: ${ids}`);
	return (
		`open incident(s) ${ids} must be acted on before other work. Write a plan that contains "INCIDENT <id>" ` +
		`(listed in ${cfg.paths.queue_index}) and record it: \`neurastream incident plan <id> <plan.md>\`, or dismiss the ` +
		'incident: `neurastream incident dismiss <id> --why "<text>"`. Fix work goes through: name that plan in the brief.'
	);
}

/** A spawn's identity for the team cap: its named agents, and whether any spawned agent has no name (the cap cannot count it). */
export interface SpawnIdent {
	agentIds: string[];
	unnamed: boolean;
	runs?: RunSource;
}

/** A plan file and the team it routes to. */
export interface RoutedTeam {
	team: TeamEntry;
	file: string;
}

function routedTeams(files: string[], cfg: Config): RoutedTeam[] {
	const out: RoutedTeam[] = [];
	for (const file of files) {
		const team = routeTeam(file, cfg, undefined, defaultRunner);
		if (team) out.push({ team, file });
	}
	return out;
}

/** Epoch seconds at local midnight: the start of the cap's day. */
function dayStartSec(): number {
	const d = new Date(nowSec() * 1000);
	d.setHours(0, 0, 0, 0);
	return d.getTime() / 1000;
}

/** Agent ids recorded against a team's plans since `since`, from its spawns.jsonl rows; a corrupt row counts for nothing. */
function teamAgentsSince(cfg: Config, team: TeamEntry, since: number): Set<string> {
	const ids = new Set<string>();
	let text: string;
	try {
		text = readFileSync(path.join(teamDir(cfg, team), "spawns.jsonl"), "utf8");
	} catch {
		return ids;
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line) as { agentId?: unknown; at?: unknown };
			if (typeof row.agentId === "string" && typeof row.at === "number" && row.at >= since) ids.add(row.agentId);
		} catch {}
	}
	return ids;
}

/** The team token cap (plan P6b2 d): a refusal when a capped team's calls today reach its max_share of all calls today. Null when no team is capped or it is under. */
export function teamCapProblem(teams: RoutedTeam[], spawn: SpawnIdent, cfg: Config): string | null {
	const capped = teams.flatMap(({ team }) => (team.max_share === undefined ? [] : [{ team, cap: team.max_share }]));
	const [first] = capped;
	if (first === undefined) return null;
	if (!spawn.runs) return `team ${first.team.name} sets max_share: the cap cannot be computed without a run source`;
	const since = dayStartSec();
	const runs = spawn.runs.listRuns(since);
	const total = runs.reduce((sum, r) => sum + r.calls, 0);
	if (total === 0) return null;
	for (const { team, cap } of capped) {
		const ids = teamAgentsSince(cfg, team, since);
		const mine = runs.filter((r) => ids.has(r.id)).reduce((sum, r) => sum + r.calls, 0);
		if (mine / total >= cap) return `team ${team.name} cap reached: ${mine} of ${total} calls today (max_share ${cap}); team plans wait until local midnight`;
	}
	return null;
}

/** Records each named agent against each team plan it spawned on, one spawns.jsonl row each, so the cap counts its calls. Rows are written only for team plans. */
function recordTeamSpawns(teams: RoutedTeam[], agentIds: string[], cfg: Config): void {
	if (agentIds.length === 0) return;
	for (const { team, file } of teams) {
		const planId = pathId(team, cfg, file, defaultRunner);
		if (planId === null) continue;
		const dir = teamDir(cfg, team);
		const at = nowSec();
		const rows = agentIds.map((agentId) => `${JSON.stringify({ planId, agentId, at })}\n`).join("");
		try {
			mkdirSync(dir, { recursive: true });
			appendFileSync(path.join(dir, "spawns.jsonl"), rows);
		} catch (err) {
			log(cfg.paths.guard_log, `cannot record team spawn for ${team.name}: ${err}`);
		}
	}
}

/**
 * The spawn claim gate (plan 20261027_1300 P3): a spawn on a plan claims it for this Main first;
 * another Main's live claim refuses the launch — a sub's launch too, once its Main no longer
 * holds the claim. Returns the refusal, or null.
 */
function claimGate(files: string[], cfg: Config, spawn: SpawnIdent): string | null {
	const teams = routedTeams(files, cfg);
	const uncountable = teams.find(({ team }) => team.max_share !== undefined);
	if (spawn.unnamed && uncountable) {
		return `team ${uncountable.team.name} sets max_share: name this agent (tasks[].name) so its calls count against the team cap`;
	}
	const mine = mainId();
	// With the chooser each file has its own store; `fresh` carries the store beside each file,
	// so a fresh claim is released through the store that took it (a team claim released through
	// the file store would be a silent no-op that outlives the refusal until the TTL).
	const fresh: { file: string; store: ClaimStore }[] = [];
	// A refusal leaves the store as it found it: claims this call newly created are released
	// again through the store that took each one; a claim this Main already held before the
	// call stays.
	const releaseFresh = (): void => {
		for (const g of fresh) g.store.release(g.file, mine);
	};
	for (const f of files) {
		const store = claimStoreFor(f, cfg);
		const h = store.holder(f);
		// Fail closed: an unreachable server refuses the spawn and leaves no claim this call took.
		if (h !== null && "unreachable" in h) {
			releaseFresh();
			return heldProblem(f, h);
		}
		const heldBefore = h !== null && !heldByOther(h, mine);
		const c = store.claim(f, mine);
		if ("unreachable" in c) {
			// The outage started between holder() and claim(): release what this call took.
			releaseFresh();
			return heldProblem(f, c);
		}
		if ("heldBy" in c) {
			releaseFresh();
			return heldProblem(f, c.heldBy);
		}
		if (!heldBefore) fresh.push({ file: f, store });
	}
	const capped = teamCapProblem(teams, spawn, cfg);
	if (capped) {
		releaseFresh();
		return capped;
	}
	recordTeamSpawns(teams, spawn.agentIds, cfg);
	return null;
}

/** Reason to refuse a `task` brief, or null; `files` receives the plans to record, `budgets` every named task's call budget (null = none), `staffing` each plan's named tasks of this call, `runningJobs` the caller's running job labels (undefined = no job info). Every refusal lands in one numbered verdict (plan 20261031_1207 P4). */
export function spawnProblem(
	input: Record<string, unknown>,
	cfg: Config,
	files: string[] = [],
	budgets: Record<string, number | null> = {},
	staffing: Record<string, string[]> = {},
	runningJobs?: string[],
	runner: CommandRunner = defaultRunner,
	spawner: Spawner = "main",
): string | null {
	const roles: Record<string, string | null> = {};
	const plannerRoles: Record<string, string> = {};
	const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
	const context = String(input?.context ?? "");
	const allowed = q.allowedAgents(cfg.paths.subagents);
	const shared = briefBudget(context);
	const problems: string[] = [];
	const named: Record<string, number | null> = {};
	for (const t of tasks) {
		const agent = String(t?.agent ?? "task");
		const label = String(t?.name ?? agent);
		const text = `${context}\n${String(t?.task ?? "")}`;
		// The role line belongs to the task's own brief (the adapter keys the spawn's brief by it);
		// a mention in the shared context names no one's role.
		const plannerFor = plannerRolePlan(String(t?.task ?? ""));
		// planner mode P2 (c): a Planner-role brief is refused while the mode is main — the switch
		// is the owner's (`planner delegated`). While delegated the planner spawn skips the open-plan
		// gates below (the plan it names does not exist yet — writing it is the spawn's job), but the
		// ## Allowed deny still holds, and it needs a name to key its role.
		if (plannerFor && currentPlanner(cfg) === "main") {
			problems.push(`${label}: planner mode is main — a Planner-role spawn needs the owner's \`planner delegated\` switch.`);
			continue;
		}
		const plannerBad = plannerFor ? plannerPlanProblem(plannerFor) : null;
		if (plannerBad) {
			problems.push(`${label}: ${plannerBad}`);
			continue;
		}
		if (plannerFor && !t?.name) {
			problems.push(`${label}: a planner spawn needs a name (the task name keys its planner role).`);
			continue;
		}
		if (plannerFor) {
			if (!allowed.has(agent)) {
				problems.push(`${label}: agent "${agent}" is not in "## Allowed" of ${cfg.paths.subagents} (no expensive or unpinned models).`);
				continue;
			}
			plannerRoles[label] = plannerFor;
			continue;
		}
		if (!allowed.has(agent)) {
			problems.push(`${label}: agent "${agent}" is not in "## Allowed" of ${cfg.paths.subagents} (no expensive or unpinned models).`);
			continue;
		}
		const [why, plans] = planGate(text, label, cfg);
		if (why) {
			problems.push(why);
			continue;
		}
		// P3 (plan 20261028_1600): the task tool is the live spawn path; every task carries its own
		// pending-work check, before the call-wide gates below. The task's own `Call budget:` line
		// wins over the shared context's.
		const role = reviewRole(t?.name, plans, text, agent, cfg, spawner);
		const taskProblems = [
			pendingWorkProblem(plans, text, cfg, runner),
			role.problem,
			reviewPassProblem(plans, text, agent, cfg, spawner),
		];
		const budget = briefBudget(String(t?.task ?? "")) ?? shared;
		if (budget !== null) {
			if (!t?.name) taskProblems.push(`${label}: "Call budget: ${budget}" needs a task name (the budget is keyed by it).`);
			else if (budget < 10 || budget > cfg.guards.sub_max_calls_cap)
				taskProblems.push(`call budget ${budget} is outside the allowed range 10..${cfg.guards.sub_max_calls_cap}.`);
		}
		const own = taskProblems.filter((p): p is string => p !== null).map(p => (p.startsWith(`${label}:`) ? p : `${label}: ${p}`));
		if (own.length) {
			problems.push(...own);
			continue;
		}
		if (t?.name) {
			roles[label] = role.plan;
			named[label] = budget;
			for (const f of plans) staffing[f] = [...(staffing[f] ?? []), label];
		}
		files.push(...plans);
	}
	Object.assign(budgets, named);
	// Who is limited and who goes first come from live data and ledger.prefer (plan 20261025_1700
	// P3): the same rules checkSpawn applies to single-spawn events, per task.
	const joined = `${context}\n${tasks.map(t => String(t?.task ?? "")).join("\n")}`;
	const claim = providerClaimProblem(joined, cfg);
	if (claim) problems.push(claim);
	for (const t of tasks) {
		const pick = preferProblem(String(t?.agent ?? "task"), `${context}\n${String(t?.task ?? "")}`, runningJobs, cfg);
		if (pick) problems.push(`${String(t?.name ?? t?.agent ?? "task")}: ${pick}`);
	}
	// Priority gate (20261025_0215 P3): once per `task` call, over the plans this call names; the
	// skip lines may sit in the shared context or any task text.
	const gate = priorityGate(
		files,
		runningJobs,
		joined,
		cfg,
		String((tasks[0] && (tasks[0].name ?? tasks[0].agent)) ?? "task"),
		String((tasks[0] && tasks[0].agent) ?? "task"),
		spawner,
	);
	if (gate) problems.push(gate);
	const inc = incidentSpawnProblem("spawn", JSON.stringify(input), files, cfg);
	if (inc) problems.push(inc);
	const verdict = spawnVerdict(
		String((tasks[0] && (tasks[0].name ?? tasks[0].agent)) ?? "task"),
		problems,
		files.length ? files : briefPlans(joined, cfg).map(p => p.file),
		runningJobs,
		cfg,
	);
	if (verdict) return verdict;
	for (const [name, plan] of Object.entries(roles)) recordReviewSpawn(name, plan, cfg.paths);
	for (const [name, plan] of Object.entries(plannerRoles)) recordPlannerSpawn(name, plan, cfg.paths);
	return null;
}

/**
 * A `task` launch: the cancel check, the spawn gates, then the records. Main's and a sub's launch
 * both come through here (plan 20261028_1600 P4i). Returns the refusal, or null.
 */
export function taskLaunch(input: Record<string, unknown>, cfg: Config, runningJobs: string[] | undefined, spawner: Spawner, runs?: RunSource): string | null {
	const pending = q.cancelPending(cfg.paths);
	if (pending) {
		log(cfg.paths.guard_log, `BLOCK spawn: cancel pending (${pending.words})`);
		return `${CANCEL_TODO} Flagged: "${pending.words}"`;
	}
	// P4 (plan 20261031_1207): spawnProblem's verdict now carries the incident check too, so one
	// deny lists every problem.
	const files: string[] = [];
	const budgets: Record<string, number | null> = {};
	const staffing: Record<string, string[]> = {};
	const why = spawnProblem(input, cfg, files, budgets, staffing, runningJobs, defaultRunner, spawner);
	if (why) {
		log(cfg.paths.guard_log, `BLOCK spawn: ${why}`);
		return why;
	}
	const inc = incidentSpawnProblem("spawn", JSON.stringify(input), files, cfg);
	if (inc) return inc;
	const spawned: unknown[] = Array.isArray(input.tasks) ? input.tasks : [];
	const names = spawned.map((t) => (t as { name?: unknown } | null)?.name);
	const held = claimGate(files, cfg, {
		agentIds: names.filter((n): n is string => typeof n === "string" && n !== ""),
		unnamed: names.some((n) => typeof n !== "string" || n === ""),
		runs,
	});
	if (held) {
		log(cfg.paths.guard_log, `BLOCK spawn: ${held}`);
		return held;
	}
	recordSpawns(files, cfg.paths, staffing);
	recordBudgets(budgets, cfg.paths);
	return null;
}

/**
 * A shell launch of a bypass_spawn agent: the cancel check, the plan gate, the review PASS, the
 * incidents, then the record. Main's and a sub's launch both come through here (plan 20261028_1600 P4i).
 */
export function bypassLaunch(command: string, cfg: Config, spawner: Spawner, runs?: RunSource): string | null {
	for (const entry of cfg.guards.bypass_spawn) {
		if (!bypassRegExp(entry).test(command)) continue;
		const pending = q.cancelPending(cfg.paths);
		if (pending) {
			log(cfg.paths.guard_log, `BLOCK bypass launch: cancel pending (${pending.words})`);
			return `${CANCEL_TODO} Flagged: "${pending.words}"`;
		}
		const [why, named] = planGate(command, entry, cfg);
		if (why) {
			log(cfg.paths.guard_log, `BLOCK bypass launch: ${why}`);
			return why;
		}
		const review = reviewPassProblem(named, command, "", cfg, spawner);
		if (review) {
			log(cfg.paths.guard_log, `BLOCK bypass launch: ${review}`);
			return review;
		}
		const inc = incidentSpawnProblem("bypass launch", command, named, cfg);
		if (inc) return inc;
		// I-20261031-280: a bypass launch takes the claims like every other spawn, as its last
		// refusal before the record.
		const held = claimGate(named, cfg, { agentIds: [], unnamed: true, runs });
		if (held) {
			log(cfg.paths.guard_log, `BLOCK bypass launch: ${held}`);
			return held;
		}
		if (named.length) recordSpawns(named, cfg.paths);
	}
	return null;
}

/**
 * spawn: the allow-list, task-only and open-plan gates for one implementer launch. Covers both
 * original paths (the extension spawn event and a `task` tool call); the brief names the plan.
 */
export function checkSpawn(e: SpawnEvent, cfg: Config, runner: CommandRunner = defaultRunner, runs?: RunSource): Decision {
	return tuned(checkSpawnRules(e, cfg, runner, runs), cfg);
}

function checkSpawnRules(e: SpawnEvent, cfg: Config, runner: CommandRunner = defaultRunner, runs?: RunSource): Decision {
	const pending = q.cancelPending(cfg.paths);
	if (pending) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: cancel pending (${pending.words}) rule=spawn.cancel-pending`);
		return deny(`main-guard: ${CANCEL_TODO} Flagged: "${pending.words}"`, "spawn.cancel-pending");
	}
	const allowed = q.allowedAgents(cfg.paths.subagents);
	if (!allowed.has(e.agent))
		return deny(`main-guard: ${e.agent}: agent "${e.agent}" is not in "## Allowed" of ${cfg.paths.subagents} (no expensive or unpinned models).`, "spawn.agent-allowed");
	if (e.invocationKind !== "task")
		return deny("main-guard: spawn implementers with the task tool (the plan gate checks its brief).", "spawn.task-tool");
	// P4 (plan 20261031_1207): every gate's refusal lands in one numbered verdict; nothing
	// short-circuits, so Main sees all the problems in one round trip.
	const problems: string[] = [];
	// planner mode P2 (c): a Planner-role brief is refused while the mode is main — the switch is
	// the owner's (`planner delegated`). While delegated the planner spawn skips the open-plan
	// gates (the plan it names does not exist yet — writing it is the spawn's job) and its role
	// binds to the spawn name at the tail; a planner spawn needs that name.
	const plannerFor = plannerRolePlan(e.brief);
	const delegatedPlanner = plannerFor !== null && currentPlanner(cfg) === "delegated";
	if (plannerFor && !delegatedPlanner)
		problems.push(`${e.agent}: planner mode is main — a Planner-role spawn needs the owner's \`planner delegated\` switch.`);
	else if (delegatedPlanner && plannerPlanProblem(plannerFor)) problems.push(`${e.agent}: ${plannerPlanProblem(plannerFor)}`);
	else if (delegatedPlanner && !e.name) problems.push(`${e.agent}: a planner spawn needs a name (the task name keys its planner role).`);
	const [why, named] = delegatedPlanner ? [null, [] as string[]] : planGate(e.brief, e.agent, cfg);
	if (why) problems.push(why);
	const gate = priorityGate(named, e.runningJobs, e.brief, cfg, e.agent, e.agent, "main");
	if (gate) problems.push(gate);
	const pendingWork = pendingWorkProblem(named, e.brief, cfg, runner);
	if (pendingWork) problems.push(pendingWork);
	const role = reviewRole(e.name, named, e.brief, e.agent, cfg, "main");
	if (role.problem) problems.push(role.problem);
	const review = reviewPassProblem(named, e.brief, e.agent, cfg, "main");
	if (review) problems.push(review);
	const inc = incidentSpawnProblem(`spawn ${e.agent}`, e.brief, named, cfg);
	if (inc) problems.push(inc);
	const claim = providerClaimProblem(e.brief, cfg);
	if (claim) problems.push(`${e.agent}: ${claim}`);
	const pick = preferProblem(e.agent, e.brief, e.runningJobs, cfg);
	if (pick) problems.push(`${e.agent}: ${pick}`);
	const verdict = spawnVerdict(e.agent, problems, named.length ? named : briefPlans(e.brief, cfg).map(p => p.file), e.runningJobs, cfg);
	if (verdict) {
		for (const p of problems) {
			if (p === role.problem) log(cfg.paths.plan_guard_log, `BLOCK ${e.agent} ${e.name ?? "(unnamed)"} review spawn: ${p} rule=spawn.verdict`);
			else log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${p} rule=spawn.verdict`);
		}
		return deny(`main-guard: ${verdict}`, "spawn.verdict");
	}
	const held = claimGate(named, cfg, { agentIds: e.name ? [e.name] : [], unnamed: !e.name, runs });
	if (held) {
		log(cfg.paths.guard_log, `BLOCK spawn ${e.agent}: ${held} rule=spawn.claim-held`);
		return deny(`main-guard: ${held}`, "spawn.claim-held");
	}
	// The owner's pick order and live provider state (plan 20261025_1700 P3), before the spawn records.
	const staffing: Record<string, string[]> = {};
	for (const f of named) staffing[f] = [e.agent];
	recordSpawns(named, cfg.paths, staffing);
	if (e.name) recordReviewSpawn(e.name, role.plan, cfg.paths);
	// planner mode P2 (b): the approved planner spawn binds its name to the plan its brief named.
	if (delegatedPlanner && e.name && plannerFor) recordPlannerSpawn(e.name, plannerFor, cfg.paths);
	return ALLOW;
}
