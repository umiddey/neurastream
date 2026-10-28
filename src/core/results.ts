// Feature results (plan 20261025_2148 P2): a feature is a plan plus every later plan whose
// ## Goal names its file stem; finished chains are priced from the runs' message costs. Plan
// discovery reuses the queue's walkers (no new path config); all functions here are pure over
// their arguments — the CLI passes the run source, the window and the self repo.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Run } from "./adapter.ts";
import type { Config } from "./config.ts";
import type { Ev } from "./metrics.ts";
import { applyQueueEnv } from "./queue/env.ts";
import { gitTop, parsePlan } from "./queue/lib.ts";
import { repoRoots, walkMd } from "./queue-finished.ts";

const HOUR = 3600;
const DAY = 86400;
const STEM = /^\d{8}_\d{4}_/;

export interface PlanNode {
	stem: string;
	file: string;
	repo: string;
	/** Earlier stems this plan's Goal names that exist. */
	parents: string[];
	archived: boolean;
	closed: boolean;
	/** Newest dated Progress entry, unix seconds; null when none parses. */
	closedAt: number | null;
}

export interface Chain {
	stem: string;
	kind: "product" | "neurastream";
	repo: string;
	stems: string[];
	fixPlans: number;
	closed: boolean;
	closedAt: number | null;
}

/** One dated Progress entry: `- 2026-10-26 12:00 CEST Main: ...`; time and zone are optional and a bare stamp is local time. */
const DATED = /^- (\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?(?: \(?(CEST|CET)\)?)?/gm;
const ZONE_OFFSET: Record<string, number> = { CEST: 120, CET: 60 };

/** Newest dated Progress entry as unix seconds; null when the text has none. */
export function closeTime(text: string): number | null {
	let best: number | null = null;
	for (const m of text.matchAll(DATED)) {
		const [, Y, M, D, h = "0", min = "0", zone] = m as RegExpExecArray & string[];
		const utc = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(min)) / 1000;
		const ts = zone ? utc - ZONE_OFFSET[zone]! * 60 : new Date(Number(Y), Number(M) - 1, Number(D), Number(h), Number(min)).getTime() / 1000;
		if (best === null || ts > best) best = ts;
	}
	return best;
}

/** Every dated plan under docs/plans/** of each repo the queue knows (work_roots plus one level of children). A git worktree carries a copy of docs/plans and gitTop maps it to the main checkout, so one node per (canonical repo, stem) survives: an archived or closed copy beats an open one, else the newest mtime wins. */
export function loadPlans(cfg: Config): PlanNode[] {
	applyQueueEnv(cfg);
	const best = new Map<string, { node: PlanNode; mtime: number }>();
	for (const repo of repoRoots(cfg.paths.work_roots)) {
		const files: string[] = [];
		walkMd(path.join(repo, "docs/plans"), files);
		for (const file of files) {
			const base = path.basename(file);
			// Progress archives (<stem>-progress.md) and unstamped lists (CANCELLED.md) are not plans.
			if (!STEM.test(base) || base.endsWith("-progress.md")) continue;
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			let mtime = 0;
			try {
				mtime = statSync(file).mtimeMs;
			} catch {}
			const archived = file.split(path.sep).includes("archive");
			const status = parsePlan(repo, file, text).status;
			const node: PlanNode = {
				stem: base.slice(0, -3),
				file,
				repo: gitTop(file)?.repo ?? repo,
				parents: [],
				archived,
				closed: archived || status === "complete" || status === "cancelled",
				closedAt: closeTime(text),
			};
			const key = `${node.repo}/${node.stem}`;
			const cur = best.get(key);
			if (!cur || (node.closed !== cur.node.closed ? node.closed : mtime > cur.mtime)) best.set(key, { node, mtime });
		}
	}
	const nodes = [...best.values()].map(b => b.node);
	const stems = new Set(nodes.map(n => n.stem));
	for (const n of nodes) {
		let text = "";
		try {
			text = readFileSync(n.file, "utf8");
		} catch {
			continue;
		}
		const goal = parsePlan(n.repo, n.file, text).goal.join("\n");
		n.parents = [...stems].filter(s => s !== n.stem && goal.includes(s));
	}
	return nodes;
}

/** Connected chains: B joins A when B's Goal names A's stem; the root is the oldest member. */
export function chains(plans: PlanNode[], selfRepo: string | null): Chain[] {
	const up = new Map<string, string>();
	const find = (s: string): string => {
		let root = s;
		while (up.get(root) !== root) root = up.get(root)!;
		return root;
	};
	for (const p of plans) up.set(p.stem, p.stem);
	const known = new Set(plans.map(p => p.stem));
	for (const p of plans) for (const parent of p.parents) if (known.has(parent)) up.set(p.stem, parent);
	const members = new Map<string, PlanNode[]>();
	for (const p of plans) {
		const root = find(p.stem);
		members.set(root, [...(members.get(root) ?? []), p]);
	}
	const out: Chain[] = [];
	for (const group of members.values()) {
		group.sort((a, b) => (a.stem < b.stem ? -1 : 1));
		const closed = group.every(p => p.closed);
		const closedAt = group.reduce<number | null>((best, p) => (p.closedAt !== null && (best === null || p.closedAt > best) ? p.closedAt : best), null);
		out.push({
			stem: group[0]!.stem,
			kind: selfRepo !== null && group[0]!.repo === selfRepo ? "neurastream" : "product",
			repo: group[0]!.repo,
			stems: group.map(p => p.stem),
			fixPlans: group.length - 1,
			closed,
			closedAt,
		});
	}
	return out;
}

export interface Attribution {
	byPlan: Map<string, number>;
	overhead: number;
	/** Every bucketed Main $ in the window: the denominator of overhead %. */
	mainTotal: number;
}

/** Stems named in a text, in order of first mention. */
function namedStems(text: string, stems: string[]): string[] {
	const hits: [string, number][] = [];
	for (const s of stems) {
		const at = text.indexOf(s);
		if (at >= 0) hits.push([s, at]);
	}
	return hits.sort((a, b) => a[1] - b[1]).map(([s]) => s);
}

/**
 * Main message cost is bucketed per hour; an hour's cost splits evenly over the plan stems that
 * hour's messages name (none → overhead). A sub run's whole cost goes to the stem in its first
 * user message (none → overhead). A message without ts is not bucketable and counts nowhere.
 */
export function attributeCosts(runs: Run[], stems: string[], from: number, to: number): Attribution {
	const byPlan = new Map<string, number>();
	const inWindow = (t: number) => t >= from && t < to;
	const hours = new Map<number, { cost: number; text: string }>();
	let overhead = 0;
	let mainTotal = 0;
	for (const run of runs) {
		if (run.kind === "main") {
			for (const m of run.messages) {
				if (m.ts === null || !inWindow(m.ts)) continue;
				const bucket = Math.floor(m.ts / HOUR) * HOUR;
				const h = hours.get(bucket) ?? { cost: 0, text: "" };
				h.cost += m.cost;
				h.text += `\n${m.text}`;
				hours.set(bucket, h);
				mainTotal += m.cost;
			}
			continue;
		}
		const first = run.messages.find(m => m.role === "user");
		if (!first) continue;
		if (!inWindow(first.ts ?? run.lastWriteAt)) continue;
		const named = namedStems(first.text, stems)[0];
		if (named) byPlan.set(named, (byPlan.get(named) ?? 0) + run.cost);
		else overhead += run.cost;
	}
	for (const h of hours.values()) {
		const named = namedStems(h.text, stems);
		if (!named.length) overhead += h.cost;
		else for (const s of named) byPlan.set(s, (byPlan.get(s) ?? 0) + h.cost / named.length);
	}
	return { byPlan, overhead, mainTotal };
}

export interface ChainRow {
	stem: string;
	kind: "product" | "neurastream";
	plans: number;
	fixPlans: number;
	total: number;
	first: number;
	closedAt: number;
}

export interface KindSummary {
	kind: "product" | "neurastream";
	finished: number;
	perDay: number;
	perFeature: number | null;
	firstPass: number | null;
	overheadPct: number | null;
	openChains: number;
	openSunk: number;
}

export interface FeaturesReport {
	days: number;
	from: number;
	to: number;
	rows: ChainRow[];
	summaries: KindSummary[];
}

const KINDS = ["product", "neurastream"] as const;

/** One row per finished chain closed in [from, to), plus a per-kind summary. A closed chain with no dated Progress entry has no place in a window and is left out. */
export function featuresReport(runs: Run[], plans: PlanNode[], selfRepo: string | null, from: number, to: number): FeaturesReport {
	const days = (to - from) / DAY;
	const all = chains(plans, selfRepo);
	const att = attributeCosts(runs, all.flatMap(c => c.stems), from, to);
	const chainCost = (c: Chain) => c.stems.reduce((sum, s) => sum + (att.byPlan.get(s) ?? 0), 0);
	const rows: ChainRow[] = all
		.filter(c => c.closed && c.closedAt !== null && c.closedAt >= from && c.closedAt < to)
		.map(c => ({
			stem: c.stem,
			kind: c.kind,
			plans: c.stems.length,
			fixPlans: c.fixPlans,
			total: chainCost(c),
			first: att.byPlan.get(c.stem) ?? 0,
			closedAt: c.closedAt!,
		}))
		.sort((a, b) => a.closedAt - b.closedAt);
	const summaries = KINDS.map(kind => {
		const mine = rows.filter(r => r.kind === kind);
		const finished = mine.length;
		const total = mine.reduce((s, r) => s + r.total, 0);
		const first = mine.reduce((s, r) => s + r.first, 0);
		const open = all.filter(c => !c.closed && c.kind === kind && chainCost(c) > 0);
		return {
			kind,
			finished,
			perDay: finished / days,
			perFeature: finished > 0 ? total / finished : null,
			firstPass: finished > 0 ? first / finished : null,
			overheadPct: att.mainTotal > 0 ? (att.overhead / att.mainTotal) * 100 : null,
			openChains: open.length,
			openSunk: open.reduce((s, c) => s + chainCost(c), 0),
		};
	});
	return { days, from, to, rows, summaries };
}

// ---- P3: releases ----

export interface ReleaseTag {
	name: string;
	ts: number;
}

/** The self repo's `v*` tags with their tag dates; a non-git repo or a git failure lists none. Lives here (not cli/) because the owner page's Results tab reads it too. */
export function gatherTags(repo: string | null): ReleaseTag[] {
	if (!repo) return [];
	const proc = Bun.spawnSync(["git", "-C", repo, "for-each-ref", "refs/tags/v*", "--format=%(refname:short) %(creatordate:unix)"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) return [];
	const out: ReleaseTag[] = [];
	for (const line of proc.stdout.toString().split("\n")) {
		const m = line.match(/^(\S+) (\d+)$/);
		if (m) out.push({ name: m[1]!, ts: Number(m[2]) });
	}
	return out;
}

export interface ProductValue {
	repo: string;
	name: string;
	/** null = this side has no recorded value for the number yet. */
	value: number | null;
}

export interface ReleaseSideStats {
	perFeature: number | null;
	featuresPerDay: number | null;
	/** Main calls in the window per finished feature of the release's kind. */
	callsPerFeature: number | null;
	/** Tokens per call over every run written in the window. */
	tokensPerCall: number | null;
	fixPlansPerFeature: number | null;
	products: ProductValue[];
}

export interface ReleaseRow {
	name: string;
	kind: "product" | "neurastream";
	repo: string;
	ts: number;
	/** True until `days` have passed since the release: the after side is still filling. */
	measuring: boolean;
	before: ReleaseSideStats;
	after: ReleaseSideStats;
}

export interface ReleasesReport {
	days: number;
	rows: ReleaseRow[];
}

/** The ledger metrics for one side of a release's window [from, to), same source as `metrics features`. */
function releaseSide(kind: Chain["kind"], runs: Run[], plans: PlanNode[], selfRepo: string | null, from: number, to: number): Omit<ReleaseSideStats, "products"> {
	const rep = featuresReport(runs, plans, selfRepo, from, to);
	const mine = rep.rows.filter(r => r.kind === kind);
	let mainCalls = 0;
	let tokens = 0;
	let calls = 0;
	for (const r of runs) {
		if (r.lastWriteAt < from || r.lastWriteAt >= to) continue;
		if (r.kind === "main") mainCalls += r.calls;
		tokens += r.tokens;
		calls += r.calls;
	}
	return {
		perFeature: rep.summaries.find(s => s.kind === kind)!.perFeature,
		featuresPerDay: rep.summaries.find(s => s.kind === kind)!.perDay,
		callsPerFeature: mine.length > 0 ? mainCalls / mine.length : null,
		tokensPerCall: calls > 0 ? tokens / calls : null,
		fixPlansPerFeature: mine.length > 0 ? mine.reduce((sum, r) => sum + r.fixPlans, 0) / mine.length : null,
	};
}

interface ProductRow {
	repo: string;
	name: string;
	value: number;
	ts: number;
}

/**
 * One row per release: the same N-day ledger metrics before vs after it. A release is a `v*` tag
 * of the self repo (kind neurastream) or a `metrics ci` merge of another repo (kind product); a
 * ci merge of the self repo is not a release — its tag already is. Each product number recorded
 * in metrics.jsonl shows its last value before vs its first value after the release.
 */
export function releasesReport(runs: Run[], plans: PlanNode[], selfRepo: string | null, days: number, now: number, tags: ReleaseTag[], events: Ev[]): ReleasesReport {
	const span = days * DAY;
	const products: ProductRow[] = [];
	const merges: { repo: string; mr: string; ts: number }[] = [];
	for (const e of events) {
		if (e.type === "product" && typeof e.repo === "string" && typeof e.name === "string" && typeof e.value === "number" && typeof e.ts === "number") {
			products.push({ repo: e.repo, name: e.name, value: e.value, ts: e.ts });
		} else if (e.type === "ci" && typeof e.repo === "string" && typeof e.ts === "number" && e.repo !== selfRepo) {
			merges.push({ repo: e.repo, mr: String(e.mr), ts: e.ts });
		}
	}
	const keys = [...new Set(products.map(p => `${p.repo}|${p.name}`))].sort();
	const releases = [
		...tags.map(t => ({ name: t.name, kind: "neurastream" as const, repo: selfRepo ?? "", ts: t.ts })),
		...merges.map(m => ({ name: `${path.basename(m.repo)}#${m.mr}`, kind: "product" as const, repo: m.repo, ts: m.ts })),
	].sort((a, b) => a.ts - b.ts);
	const rows = releases.map((r) => {
		const productValues = (before: boolean): ProductValue[] =>
			keys.map((k) => {
				const [repo, name] = k.split("|") as [string, string];
				const mine = products.filter(p => p.repo === repo && p.name === name).sort((a, b) => a.ts - b.ts);
				const hit = before ? (mine.filter(p => p.ts < r.ts).at(-1) ?? null) : (mine.find(p => p.ts >= r.ts) ?? null);
				return { repo, name, value: hit?.value ?? null };
			});
		const before = releaseSide(r.kind, runs, plans, selfRepo, r.ts - span, r.ts);
		const after = releaseSide(r.kind, runs, plans, selfRepo, r.ts, r.ts + span);
		return {
			name: r.name,
			kind: r.kind,
			repo: r.repo,
			ts: r.ts,
			measuring: r.ts + span > now,
			before: { ...before, products: productValues(true) },
			after: { ...after, products: productValues(false) },
		};
	});
	return { days, rows };
}
