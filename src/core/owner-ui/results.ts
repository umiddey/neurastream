// Results tab (plan 20261025_2148 P4): $ per finished feature, releases before vs after, cache read, and SVG/table rendering.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunSource } from "../adapter.ts";
import { nowSec, strftime } from "../clock.ts";
import type { Config } from "../config.ts";
import { readMetricEvents } from "../metrics.ts";
import { gitTop, type QueuePaths } from "../queue/lib.ts";
import { featuresReport, gatherTags, loadPlans, releasesReport, type FeaturesReport, type ReleaseRow, type ReleaseSideStats, type ReleasesReport } from "../results.ts";
import { esc, na } from "./auth.ts";

export interface ResultsData {
	/** The ledger over the last `metrics.report_days` days — only the empty state reads it. */
	features: FeaturesReport;
	/** Per release, the N-day before/after windows: the chart's series and the table's rows. */
	releases: ReleasesReport;
}

/** The tab as the page sees it: the last saved numbers (if any), when they were saved, and whether a build runs now. */
export interface ResultsView {
	data: ResultsData | null;
	at: number | null;
	building: boolean;
}

/** Saved numbers older than this start a fresh background build. */
const RESULTS_MAX_AGE_SEC = 3600;
/** A build that failed or got killed is retried no sooner than this. */
const RESULTS_RETRY_SEC = 600;

export function resultsCachePath(paths: Pick<QueuePaths, "queue_state">): string {
	return `${paths.queue_state}/results-cache.json`;
}

/**
 * The tab's numbers from the P2/P3 functions. A release's before window reaches back months, so
 * one build parses GBs of sessions for over a minute: it runs only in the separate process
 * src/cli/results-build.ts, never in the server, which it froze (I-20261030-121).
 */
export function computeResults(cfg: Config, source: RunSource, now: number): ResultsData {
	const days = 7;
	const selfRepo = gitTop(import.meta.dir)?.repo ?? null;
	const tags = gatherTags(selfRepo);
	const events = readMetricEvents(cfg);
	const oldest = Math.min(now, ...tags.map(t => t.ts), ...events.filter(e => e.type === "ci").map(e => Number(e.ts)));
	const runs = source.listRuns(oldest - days * 86400);
	const plans = loadPlans(cfg);
	return {
		features: featuresReport(runs, plans, selfRepo, now - cfg.metrics.report_days * 86400, now),
		releases: releasesReport(runs, plans, selfRepo, days, now, tags, events),
	};
}

/** Starts one background build; calls `done` when it exits, whatever the outcome. */
export type ResultsBuild = (done: () => void) => void;

export const noopResultsBuild: ResultsBuild = done => {
	done();
};

let buildRunning = false;
let lastBuildStart = 0;

/** Reads the saved numbers and, when they are missing or stale, starts one build in the background. */
export function resultsView(now: number, build: ResultsBuild, paths: Pick<QueuePaths, "queue_state">): ResultsView {
	let saved: { at: number; data: ResultsData } | null = null;
	try {
		saved = JSON.parse(readFileSync(resultsCachePath(paths), "utf8"));
	} catch {
		// No build has finished yet.
	}
	if ((!saved || now - saved.at >= RESULTS_MAX_AGE_SEC) && !buildRunning && now - lastBuildStart >= RESULTS_RETRY_SEC) {
		buildRunning = true;
		lastBuildStart = now;
		build(() => {
			buildRunning = false;
		});
	}
	return { data: saved?.data ?? null, at: saved?.at ?? null, building: buildRunning };
}

/** One y axis choice: where the number sits on a release side and which way is better. */
interface YMetric {
	key: string;
	label: string;
	axis: string;
	/** null = no known direction (product numbers): the table's arrow carries no color. */
	better: "lower" | "higher" | null;
	fmt(v: number): string;
	get(side: ReleaseSideStats): number | null;
}

const LEDGER_METRICS: YMetric[] = [
	{ key: "usd", label: "$/feat", axis: "$ per feature", better: "lower", fmt: v => `$${v.toFixed(2)}`, get: s => s.perFeature },
	{ key: "perday", label: "/day", axis: "features per day", better: "higher", fmt: v => v.toFixed(2), get: s => s.featuresPerDay },
	{ key: "calls", label: "calls", axis: "main calls per feature", better: "lower", fmt: v => v.toFixed(1), get: s => s.callsPerFeature },
	{ key: "tok", label: "tok", axis: "tokens per call", better: "lower", fmt: v => v.toFixed(0), get: s => s.tokensPerCall },
	{ key: "fix", label: "fix", axis: "fix plans per feature", better: "lower", fmt: v => v.toFixed(2), get: s => s.fixPlansPerFeature },
];

/** One metric per recorded product number, keyed `p:<name>` (repo-qualified when names clash). */
function productMetrics(releases: ReleasesReport): YMetric[] {
	const pairs = new Map<string, { repo: string; name: string }>();
	for (const row of releases.rows) for (const p of [...row.before.products, ...row.after.products]) pairs.set(`${p.repo}|${p.name}`, p);
	const clashes: Record<string, number> = {};
	for (const { name } of pairs.values()) clashes[name] = (clashes[name] ?? 0) + 1;
	return [...pairs.values()]
		.sort((a, b) => (a.name + a.repo).localeCompare(b.name + b.repo))
		.map(({ repo, name }) => {
			const clash = (clashes[name] ?? 0) > 1;
			return {
				key: clash ? `p:${basename(repo)}:${name}` : `p:${name}`,
				label: clash ? `${basename(repo)}/${name}` : name,
				axis: `${name} (product number)`,
				better: null,
				fmt: (v: number) => String(Math.round(v * 100) / 100),
				get: (s: ReleaseSideStats): number | null => s.products.find(p => p.repo === repo && p.name === name)?.value ?? null,
			};
		});
}

const RESULT_KINDS = ["product", "neurastream"] as const;
const KIND_COLOR: Record<(typeof RESULT_KINDS)[number], string> = { product: "var(--acc)", neurastream: "var(--teal)" };
const CHART_W = 390;
const CHART_H = 200;
const CHART_L = 48;
const CHART_R = 8;
const CHART_T = 10;
const CHART_B = 20;

interface ChartPoint {
	px: number;
	py: number;
	label: string;
	value: number;
}
interface ChartSeries {
	label: string;
	color: string;
	points: ChartPoint[];
}

/** The tab's controls: plain links, so the page's existing fetch/pushState swap handles them with no new script. */
function resultsControls(all: YMetric[], y: YMetric, x: "time" | "feature"): string {
	const yLinks = all
		.map(m => `<a href="/?tab=results&amp;y=${m.key}&amp;x=${x}"${m.key === y.key ? ` class="on"` : ""}>${esc(m.label)}</a>`)
		.join("");
	const xLinks = (["time", "feature"] as const)
		.map(v => `<a href="/?tab=results&amp;y=${y.key}&amp;x=${v}"${v === x ? ` class="on"` : ""}>${v === "time" ? "time" : "feature"}</a>`)
		.join("");
	return `<div class="rlinks"><span>y</span>${yLinks}</div><div class="rlinks"><span>x</span>${xLinks}</div>`;
}

/**
 * Hand-written inline SVG under the page's CSP: one polyline per series (product vs neurastream
 * for a ledger metric, one per product number), points carrying <title> tooltips, releases as
 * dashed verticals on the time axis, theme colors via the page's CSS variables.
 */
function resultsChart(releases: ReleasesReport, y: YMetric, x: "time" | "feature"): string {
	const rows = releases.rows;
	const mid = CHART_L + (CHART_W - CHART_L - CHART_R) / 2;
	const t0 = rows[0]!.ts;
	const t1 = rows[rows.length - 1]!.ts;
	const pxOf = (i: number, ts: number): number =>
		x === "feature" ? (rows.length < 2 ? mid : CHART_L + (i / (rows.length - 1)) * (CHART_W - CHART_L - CHART_R))
			: t1 === t0 ? mid : CHART_L + ((ts - t0) / (t1 - t0)) * (CHART_W - CHART_L - CHART_R);
	const tip = (row: ReleaseRow, v: number): string => `${row.name} · ${y.fmt(v)} · ${strftime(row.ts, "%m-%d %H:%M")}`;
	const point = (row: ReleaseRow, i: number, v: number): ChartPoint => ({ px: pxOf(i, row.ts), py: 0, label: tip(row, v), value: v });
	const series: ChartSeries[] = LEDGER_METRICS.includes(y)
		? RESULT_KINDS.map(kind => ({
				label: kind,
				color: KIND_COLOR[kind],
				points: rows.flatMap((row, i) => {
					if (row.kind !== kind) return [];
					const v = y.get(row.after);
					return v === null ? [] : [point(row, i, v)];
				}),
			}))
		: [
				{
					label: y.label,
					color: "var(--warn)",
					points: rows.flatMap((row, i) => {
						const v = y.get(row.after);
						return v === null ? [] : [point(row, i, v)];
					}),
				},
			];
	const yMax = Math.max(...series.flatMap(s => s.points.map(p => p.value)), 1e-9);
	const pyOf = (v: number): number => CHART_T + (1 - v / yMax) * (CHART_H - CHART_T - CHART_B);
	const parts: string[] = [];
	for (const v of [0, yMax / 2, yMax]) {
		parts.push(`<line x1="${CHART_L}" x2="${CHART_W - CHART_R}" y1="${pyOf(v).toFixed(1)}" y2="${pyOf(v).toFixed(1)}" stroke="var(--bd)"/>`);
		parts.push(`<text x="${CHART_L - 5}" y="${(pyOf(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--mut)">${esc(y.fmt(v))}</text>`);
	}
	if (x === "time") {
		for (const row of rows) {
			const px = pxOf(0, row.ts).toFixed(1);
			parts.push(
				`<line x1="${px}" x2="${px}" y1="${CHART_T}" y2="${CHART_H - CHART_B}" stroke="var(--bd)" stroke-dasharray="3 3"><title>${esc(`${row.name} · ${strftime(row.ts, "%m-%d %H:%M")}`)}</title></line>`,
			);
		}
		parts.push(`<text x="${CHART_L}" y="${CHART_H - 6}" font-size="10" fill="var(--mut)">${esc(strftime(t0, "%m-%d"))}</text>`);
		parts.push(`<text x="${CHART_W - CHART_R}" y="${CHART_H - 6}" text-anchor="end" font-size="10" fill="var(--mut)">${esc(strftime(t1, "%m-%d"))}</text>`);
	}
	for (const s of series) {
		if (s.points.length > 1) {
			const pts = s.points.map(p => `${p.px.toFixed(1)},${pyOf(p.value).toFixed(1)}`).join(" ");
			parts.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
		}
		for (const p of s.points) {
			parts.push(`<circle cx="${p.px.toFixed(1)}" cy="${pyOf(p.value).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(p.label)}</title></circle>`);
		}
	}
	const legend = series.map(s => `<span style="color:${s.color}">— ${esc(s.label)}</span>`).join("");
	return `<p class="rlegend">${legend}</p><svg class="rchart" role="img" aria-label="${esc(`${y.axis} by ${x === "time" ? "day" : "release"}`)}" viewBox="0 0 ${CHART_W} ${CHART_H}">${parts.join("")}</svg>`;
}

/** One row per release, the `metrics releases` table: before→after cells with ▲/▼, green when the change is for the better. */
function resultsTable(releases: ReleasesReport, all: YMetric[]): string {
	const cell = (row: ReleaseRow, m: YMetric): string => {
		const before = m.get(row.before);
		const after = m.get(row.after);
		if (before === null || after === null) return `<td class="mutcell">–</td>`;
		const arrow = after > before ? "▲" : after < before ? "▼" : "·";
		const cls = m.better !== null && after !== before ? ((m.better === "lower") === (after < before) ? ` class="good"` : ` class="badv"`) : "";
		return `<td>${esc(m.fmt(before))}→${esc(m.fmt(after))}<span${cls}>${arrow}</span></td>`;
	};
	const head = `<tr><th>release</th>${all.map(m => `<th>${esc(m.label)}</th>`).join("")}</tr>`;
	const body = releases.rows
		.map(row =>
			`<tr><td>${esc(row.name)} <span class="note">${strftime(row.ts, "%m-%d")}</span>${row.measuring ? ` <span class="chip c-ready">measuring</span>` : ""}</td>${all.map(m => cell(row, m)).join("")}</tr>`,
		)
		.join("");
	return `<div class="tscroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

const RESULTS_CAVEAT = "Fixes inside the same plan are not split out; plans that do not cite an earlier stem are not linked. Product numbers carry no better/worse color.";

export function resultsTabHtml(view: ResultsView | null | undefined, params: URLSearchParams): string {
	const d = view?.data;
	if (!d) {
		if (view?.building) return `<h1>Results</h1><div class="card"><p class="empty">Working out the numbers from your past sessions — the first time takes a few minutes. This page refreshes by itself.</p></div>`;
		return `<h1>Results</h1>${na("Results")}`;
	}
	if (!d.releases.rows.length) {
		const empty = d.features.rows.length ? "No releases recorded yet" : "No finished features yet";
		return `<h1>Results</h1><div class="card"><p class="empty">${empty}</p></div><p class="sub">${RESULTS_CAVEAT}</p>`;
	}
	const x = params.get("x") === "feature" ? "feature" : "time";
	const all = [...LEDGER_METRICS, ...productMetrics(d.releases)];
	// An unknown y falls back to $/feature.
	const y = all.find(m => m.key === params.get("y")) ?? all[0]!;
	return `<h1>Results</h1>
<p class="sub">What features cost and whether releases made it better or worse. Updated ${Math.max(0, Math.round((nowSec() - (view.at ?? nowSec())) / 60))} min ago${view.building ? " · updating now" : ""}.</p>
<div class="card">
${resultsControls(all, y, x)}
${resultsChart(d.releases, y, x)}
</div>
<h2>Releases <small>${d.releases.days} days before → after</small></h2>
<div class="card">
${resultsTable(d.releases, all)}
</div>
<p class="sub">${RESULTS_CAVEAT}</p>`;
}
