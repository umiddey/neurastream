// Page data builders: one pure typed-row builder per source; rendering reads only these.

import { readFileSync, statfsSync, statSync } from "node:fs";
import os from "node:os";
import { basename } from "node:path";
import type { RunSource } from "../adapter.ts";
import type { Unreachable } from "../claims.ts";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { cpuCount } from "../host.ts";
import { isFindingKind, openIncidents } from "../incidents.ts";
import { knowledgeManifest, urlValue, type KnowledgeEntry } from "../knowledge.ts";
import { readMetricEvents } from "../metrics.ts";
import { publishedPages } from "../pages-expiry.ts";
import { activePlans, expandHome, type Plan, type QueuePaths } from "../queue/lib.ts";
import { summaryHolder, teamPlans, teamViews, type TeamPlanRow, type TeamView } from "../team-client.ts";
import { recheckHolds, staleFiles, type HoldRunner } from "../waiting-check.ts";
import { inboxPath, recentOwnerMessages, type MessageRow } from "./messages.ts";
import { noopResultsBuild, resultsView, type ResultsBuild, type ResultsView } from "./results.ts";

export interface QuestionRow {
	plan: string;
	title: string;
	repo: string;
	waitingLine: string;
	/** What to do, from the WAITING line. */
	waitingAsk: string;
	/** What stays stuck until then, or null. */
	waitingBlocked: string | null;
	/** Why Main cannot do it, or null. */
	waitingWhy: string | null;
	/** Titles of other open plans whose Waits on names this plan. */
	unblocks: string[];
	goal: string[];
	waitingMin: number;
	/** The last answer this plan already got (from the owner inbox, so the card can say so; for a team plan, the newest server answer). */
	answered: { answer: string; at: number; login?: string } | null;
	/** The team this card belongs to; `plan` is then the server plan id, not a local path (P4). */
	team?: string;
}

/** The newest inbox record that carries an answer for this plan, if any. A missing or torn inbox is simply "no answer". */
function lastAnswerFor(plan: string, paths: Pick<QueuePaths, "queue_state">): { answer: string; at: number } | null {
	let lines: string[];
	try {
		lines = readFileSync(inboxPath(paths), "utf8").split("\n");
	} catch {
		return null;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (!line) continue;
		try {
			const rec = JSON.parse(line) as Record<string, unknown>;
			if (rec.plan === plan && typeof rec.answer === "string" && rec.answer) return { answer: rec.answer, at: Number(rec.ts) || 0 };
		} catch {}
	}
	return null;
}

export interface AgentRow {
	id: string;
	model: string;
	detail: string;
	minutes: number;
	status: string;
}

export interface QueueRow {
	repo: string;
	file: string;
	title: string;
	status: string;
	waiting: boolean;
	/** `Summary:` header, else the first Goal bullet with a leading Owner/INCIDENT prefix cut off. */
	summary: string | null;
	/** The Main id holding this plan's claim, else null (P5 multi-main). */
	holder: string | null;
	/** Chip text: waits you, waits on a plan, not started, phase K of N, or all N done. */
	state: string;
}

export interface CiRow {
	mr: string;
	tries: number;
	ts: number;
}

export interface IncidentRow {
	id: string;
	kind: string;
	summary: string;
	count: number;
	/** Main's latest written reason for a finding incident; null when none or not a finding. */
	proposal: string | null;
}

/** A markdown table from the ranking board plus every non-table line, kept in order. */
export interface ScoresData {
	header: string[];
	rows: string[][];
	text: string[];
}

export interface MachineRow {
	freeGb: number;
	diskMin: number;
	load: number;
	loadMax: number;
	cores: number;
}

export function questionRows(cfg: Config, run?: HoldRunner): QuestionRow[] {
	const now = Date.now();
	const plans = activePlans(cfg.paths);
	const stale = staleFiles(recheckHolds(cfg, plans, run));
	return plans
		.filter(p => p.waiting && p.status === "open" && p.waitingLine && !stale.has(p.file))
		.map(p => {
			let waitingMin = 0;
			try {
				waitingMin = Math.max(0, Math.round((now - statSync(p.file).mtimeMs) / 60_000));
			} catch {}
			return {
				plan: p.file,
				title: p.title,
				repo: basename(p.repo),
				waitingLine: p.waitingLine ?? "",
				waitingAsk: p.waitingAsk ?? p.waitingLine ?? "",
				waitingBlocked: p.waitingBlocked,
				waitingWhy: p.waitingWhy,
				unblocks: plans.filter(o => o.status === "open" && o.file !== p.file && o.waitsOn.includes(p.file)).map(o => o.title),
				goal: p.goal,
				waitingMin,
				answered: lastAnswerFor(p.file, cfg.paths),
			};
		});
}

export function agentRows(cfg: Config, source: RunSource): AgentRow[] {
	const cut = nowSec() - cfg.ledger.default_hours * 3600;
	return source
		.listRuns(cut)
		.filter(r => r.status === "running" || r.status === "waiting")
		.map(r => ({
			id: r.id,
			model: r.model.slice(r.model.lastIndexOf("/") + 1),
			detail: r.statusDetail,
			minutes: r.startedAt === null ? 0 : Math.max(0, Math.round((nowSec() - r.startedAt) / 60)),
			status: r.status,
		}));
}

/** Cut a leading `Owner (…):` or `INCIDENT <id>` prefix off a Goal bullet used as the card line. */
function goalSummary(line: string): string {
	let s = line.trim();
	for (;;) {
		const next = s.replace(/^Owner\s*\([^)]*\):\s*/, "").replace(/^INCIDENT\s+\S+\.?\s*/, "").trim();
		if (next === s) return s;
		s = next;
	}
}

function queueState(p: Plan, plans: Plan[]): string {
	if (p.waiting) return "waits you";
	const target = p.waitsOn[0];
	if (target) {
		const title = plans.find(w => w.file === target)?.title ?? target.split("/").pop()?.replace(/\.md$/, "") ?? target;
		return `waits on ${title}`;
	}
	const { done, total } = p.phases;
	if (done === total && total > 0) return `all ${total} done · checking`;
	if (!p.started) return `not started · 0/${total}`;
	return `phase ${Math.min(done + 1, total)} of ${total}`;
}

export function queueRows(cfg: Config, views?: Map<string, TeamView | Unreachable>): QueueRow[] {
	const plans = activePlans(cfg.paths).filter(p => p.status === "open");
	const claims = summaryHolder(cfg, {}, views);
	return plans.map(p => {
		const holder = claims.holder(p.file);
		return {
			repo: basename(p.repo),
			file: p.file,
			title: p.title,
			status: p.status ?? "?",
			waiting: p.waiting,
			summary: p.summary ?? (goalSummary(p.goal[0] ?? "") || null),
			state: queueState(p, plans),
			holder: holder === null ? null : "unreachable" in holder ? "team server unreachable" : holder.main,
		};
	});
}

/** One team's card on the phone page: its plans as queue rows and its open WAITING lines. */
export interface TeamSection {
	name: string;
	server: string;
	/** False when the team server did not answer: the card says so instead of listing plans. */
	reachable: boolean;
	rows: QueueRow[];
	questions: QuestionRow[];
}

/**
 * The team half of the phone page (P4): each team's already-read view mapped to the page's own
 * row types, so the render stays one shape. A plan is a QueueRow whose `file` is the server id
 * (team order is not INDEX order, so no drag and no /reorder) and whose state is queueState over
 * the team's own parsed plans; each open plan with a WAITING line is a QuestionRow whose newest
 * server answer fills `answered`. Sends nothing.
 */
export function teamSections(cfg: Config, views: Map<string, TeamView | Unreachable>): TeamSection[] {
	return cfg.teams.map(team => {
		const view = views.get(team.name);
		if (view === undefined || "unreachable" in view) return { name: team.name, server: team.server, reachable: false, rows: [], questions: [] };
		return teamSection(team.name, team.server, teamPlans(cfg, team, view));
	});
}

/** One reachable team's card from its parsed plans: the phone page and the team page both build it here. */
export function teamSection(name: string, server: string, plans: TeamPlanRow[]): TeamSection {
	const parsed = plans.map(p => p.plan);
	const rows: QueueRow[] = plans.map(p => ({
		repo: p.relPath,
		file: p.id,
		title: p.plan.title,
		status: p.plan.status ?? "?",
		waiting: p.plan.waiting,
		summary: p.plan.summary ?? (goalSummary(p.plan.goal[0] ?? "") || null),
		holder: p.holder ? `${p.holder.main} (${p.holder.login})` : null,
		state: queueState(p.plan, parsed),
	}));
	const questions: QuestionRow[] = plans
		.filter(p => p.plan.status === "open" && p.plan.waiting && p.plan.waitingLine)
		.map(p => {
			const first = p.answered;
			return {
				plan: p.id,
				team: name,
				title: p.plan.title,
				repo: p.relPath,
				waitingLine: p.plan.waitingLine ?? "",
				waitingAsk: p.plan.waitingAsk ?? p.plan.waitingLine ?? "",
				waitingBlocked: p.plan.waitingBlocked,
				waitingWhy: p.plan.waitingWhy,
				unblocks: [],
				goal: p.plan.goal,
				waitingMin: 0,
				answered: first ? { answer: first.answer, at: first.time, login: first.login } : null,
			};
		});
	return { name, server, reachable: true, rows, questions };
}

export function ciRows(cfg: Config): CiRow[] {
	return readMetricEvents(cfg)
		.filter(e => e.type === "ci")
		.slice(-10)
		.reverse()
		.map(e => ({ mr: String(e.mr), tries: Number(e.tries), ts: Number(e.ts) }));
}

export function incidentRows(cfg: Config): IncidentRow[] {
	return openIncidents(cfg).map(i => ({
		id: i.id,
		kind: i.kind,
		summary: i.summary,
		count: i.count,
		proposal: isFindingKind(i.kind) ? (i.proposal?.why ?? null) : null,
	}));
}

export function scoresData(cfg: Config): ScoresData {
	const out: ScoresData = { header: [], rows: [], text: [] };
	for (const raw of readFileSync(cfg.paths.ranking_board, "utf8").split("\n")) {
		const line = raw.trim();
		if (line.startsWith("|") && line.endsWith("|")) {
			const cells = line.slice(1, -1).split("|").map(c => c.trim());
			if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
			if (!out.header.length) out.header = cells;
			else out.rows.push(cells);
		} else if (line) {
			out.text.push(line);
		}
	}
	return out;
}

export function machineRow(cfg: Config): MachineRow {
	const st = statfsSync(expandHome(cfg.machine.disk_path));
	const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
	const load = os.loadavg()[0] ?? 0;
	const cores = cpuCount();
	const loadMax = cfg.machine.load_max > 0 ? cfg.machine.load_max : cores + cfg.machine.load_over_cores;
	return { freeGb, diskMin: cfg.machine.disk_min_gb, load, loadMax, cores };
}

/** The numbers behind the top tiles: everything in the last 24 h plus the open-plan count. */
export interface NowStats {
	/** Total list-price spend over the last 24 h. */
	spend24: number;
	/** The "main" kind's share of spend24. */
	mainSpend: number;
	/** The "sub" kind's share of spend24. */
	agentSpend: number;
	/** Runs seen in the last 24 h. */
	runs24: number;
	/** Of those, the ones still running. */
	running: number;
	/** Of those, the ones that died. */
	died: number;
	/** Spend per hour over the last 24 h: 24 buckets, oldest → newest. */
	spendByHour: number[];
	/** Runs started per hour over the last 24 h: 24 buckets, oldest → newest. */
	runsByHour: number[];
	/** Spend and run count per short model name (after the last /), costliest first. */
	byModel: { model: string; spend: number; runs: number }[];
	/** Open plans in INDEX.md. */
	openPlans: number;
}

/**
 * Pure tile math over `source.listRuns(now - 86400)`: a run is in the window when its
 * bucket time — `startedAt`, else `lastWriteAt` — is newer than exactly 24 h ago, and it
 * counts in the hourly bucket of that time. The run source pre-filters by its own mtime,
 * so the strict window check here is the one rule that decides.
 */
export function nowStats(cfg: Config, source: RunSource, now: number): NowStats {
	const cut = now - 86400;
	const spendByHour = Array.from({ length: 24 }, () => 0);
	const runsByHour = Array.from({ length: 24 }, () => 0);
	const models = new Map<string, { spend: number; runs: number }>();
	let spend24 = 0;
	let mainSpend = 0;
	let agentSpend = 0;
	let runs24 = 0;
	let running = 0;
	let died = 0;
	for (const r of source.listRuns(cut)) {
		const ts = r.startedAt ?? r.lastWriteAt;
		if (ts <= cut) continue;
		spend24 += r.cost;
		runs24++;
		if (r.kind === "main") mainSpend += r.cost;
		else agentSpend += r.cost;
		if (r.status === "running") running++;
		if (r.status === "died") died++;
		// A future clock (skew) clamps into the newest bucket, never out of the array.
		const hoursAgo = Math.min(23, Math.max(0, Math.floor((now - ts) / 3600)));
		const at = 23 - hoursAgo;
		spendByHour[at]! += r.cost;
		runsByHour[at]! += 1;
		const short = r.model.slice(r.model.lastIndexOf("/") + 1);
		const m = models.get(short) ?? { spend: 0, runs: 0 };
		m.spend += r.cost;
		m.runs += 1;
		models.set(short, m);
	}
	const byModel = [...models.entries()].map(([model, v]) => ({ model, spend: v.spend, runs: v.runs })).sort((a, b) => b.spend - a.spend);
	// The tile counts the open plans the queue card renders; a holder read here would ask every
	// team server a second time on a page that already read one view per team (P4).
	return { spend24, mainSpend, agentSpend, runs24, running, died, spendByHour, runsByHour, byModel, openPlans: activePlans(cfg.paths).filter(p => p.status === "open").length };
}

// ---- page assembly: one unreadable source never takes the page down ----

/** One published page row for the Base tab: the pages-server link is built once, at data build. */
export interface PublishedPageRow { name: string; repo: string; published: string; url: string }

export interface PageData {
	questions: QuestionRow[] | null;
	agents: AgentRow[] | null;
	queue: QueueRow[] | null;
	ci: CiRow[] | null;
	incidents: IncidentRow[] | null;
	scores: ScoresData | null;
	machine: MachineRow | null;
	/** Repo-local HTML explainers from the knowledge manifest; null when unreadable. */
	knowledge: KnowledgeEntry[] | null;
	/** Published pages (plan 20261029_1436 P2), newest first, with their pages-server URL; null when unreadable. */
	pages: PublishedPageRow[] | null;
	/** The 24 h tile numbers; null when the run source is unreadable. */
	stats: NowStats | null;
	/** Each team's card, built from one already-read view per team (P4); absent or null when the views could not be read. */
	teams?: TeamSection[] | null;
	/** The Results tab's saved numbers and build state; absent on every other tab. The numbers come from a background process (computeResults), never from the request. */
	results?: ResultsView | null;
	/** The owner's messages newer than the keep window, newest first; null when unreadable. */
	messages: MessageRow[] | null;
	/** Minutes left in the guard unlock; null = locked. */
	lockMinutesLeft: number | null;
}

function safe<T>(build: () => T): T | null {
	try {
		return build();
	} catch {
		// One unreadable source must never take the page down.
		return null;
	}
}

function publishedRows(cfg: Config, host: string): PublishedPageRow[] {
	return publishedPages(cfg.pages.dir, new Date()).map(p => ({ ...p, url: `http://${host}:${cfg.pages.port}/${urlValue(p.name)}` }));
}

function lockMinutesLeft(cfg: Config): number | null {
	try {
		const end = statSync(cfg.paths.unlock).mtimeMs + cfg.guards.unlock_minutes * 60_000;
		const left = Math.round((end - Date.now()) / 60_000);
		return left > 0 ? left : null;
	} catch {
		return null;
	}
}

export function buildPageData(cfg: Config, source: RunSource, tab: string, build: ResultsBuild = noopResultsBuild, pagesHost = "tailnet"): PageData {
	// P4: one GET /view per team, read once and handed to the queue rows' holder and the team
	// cards, so a render makes no second request per team.
	const views = safe(() => teamViews(cfg));
	return {
		questions: safe(() => questionRows(cfg)),
		agents: safe(() => agentRows(cfg, source)),
		queue: safe(() => queueRows(cfg, views ?? undefined)),
		ci: safe(() => ciRows(cfg)),
		incidents: safe(() => incidentRows(cfg)),
		scores: safe(() => scoresData(cfg)),
		machine: safe(() => machineRow(cfg)),
		knowledge: safe(() => knowledgeManifest(cfg)),
		pages: safe(() => publishedRows(cfg, pagesHost)),
		stats: safe(() => nowStats(cfg, source, nowSec())),
		teams: views === null ? null : safe(() => teamSections(cfg, views)),
		results: tab === "results" ? safe(() => resultsView(nowSec(), build, cfg.paths)) : undefined,
		messages: safe(() => recentOwnerMessages(nowSec(), cfg.paths)),
		lockMinutesLeft: lockMinutesLeft(cfg),
	};
}
