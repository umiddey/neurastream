// Results (plan 20261025_2148 P1+P2): message timestamps through the omp mapper, then the
// feature ledger — plans found with the queue's walkers, chains via Goal stems, Main message
// cost bucketed per hour and split over the plans that hour names. Fixtures only; the live
// setup is never read.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import type { Run, RunMessage } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { chains, closeTime, featuresReport, loadPlans, releasesReport } from "../src/core/results.ts";
import { gatherTags } from "../src/cli/metrics.ts";
import { appendMetric, type Ev } from "../src/core/metrics.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-results-"));
const HOME = join(TMP, "home");
const REPO = join(TMP, "proj");
const NSREPO = join(TMP, "nsrepo");
const PLANS = join(REPO, "docs/plans");
const ARCHIVE = join(PLANS, "archive");
const SESSIONS = join(TMP, "sessions");
const PROJ = join(SESSIONS, "-proj");
const AGENT = join(HOME, "agent");

// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); the sandbox
// must win, so the saved vars are restored at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(ARCHIVE, { recursive: true });
mkdirSync(NSREPO, { recursive: true });
mkdirSync(join(NSREPO, "docs/plans"), { recursive: true });
mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
mkdirSync(AGENT, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(
	join(HOME, ".config/neurastream/config.yml"),
	`paths:
  home: "${HOME}"
  work_roots: ["${TMP}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${join(HOME, "state")}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
adapter:
  name: omp
  sessions: "${SESSIONS}"
  pins: "${join(AGENT, "pins")}"
  extensions: "${join(AGENT, "ext")}"
`,
);
const CFG: Config = loadConfig({ home: HOME, env: {} });

function planText(title: string, goal: string[], status: "open" | "complete" | "cancelled", progress: string[]): string {
	return [
		`# ${title}`,
		"Summary: short summary",
		"",
		"## Goal",
		...goal.map(g => `- ${g}`),
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		"- [x] P1 done — verify: `true`",
		"",
		"## Done check",
		"`true`",
		"",
		"## Progress",
		`Status: ${status}`,
		...progress,
		"",
	].join("\n");
}

const ALPHA = "20261025_0900_alpha";
const FIX = "20261026_1112_fix_alpha";
const GAMMA = "20261027_1213_gamma";
const NS2 = "20261024_1414_ns2";
const OLD = "20261020_0800_old";
const NS = "20261022_1010_ns";

writeFileSync(join(PLANS, `${ALPHA}.md`), planText("Alpha", ["build the alpha widget"], "complete", ["- 2026-10-26 12:00 CEST Main: alpha shipped. Findings: none"]));
writeFileSync(join(PLANS, `${FIX}.md`), planText("Fix alpha", [`fix ${ALPHA}: the widget leaked`], "open", ["- 2026-10-27 12:00 CET Main: fix in review. Findings: none"]));
writeFileSync(join(PLANS, `${GAMMA}.md`), planText("Gamma", ["gamma without links"], "open", ["- still going"]));
writeFileSync(join(ARCHIVE, `${OLD}.md`), planText("Old", ["long done"], "complete", ["- 2026-10-21 09:00 CEST Main: old done. Findings: none"]));
// Progress archives and files without a plan stamp are not plans.
writeFileSync(join(ARCHIVE, "20261019_1200_old-progress.md"), "# Progress archive\n\n- 2026-10-19 08:00 X: noise\n");
writeFileSync(join(PLANS, "CANCELLED.md"), "# Cancelled\n");
writeFileSync(join(NSREPO, "docs/plans", `${NS}.md`), planText("Ns", ["engine work"], "complete", ["- 2026-10-20 10:00 CEST Main: ns done. Findings: none"]));

// --- P1: the omp mapper stamps messages ---

const T0 = Date.UTC(2026, 9, 27, 10, 0) / 1000;
function userLine(ts: string, text: string): string {
	return JSON.stringify({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
}
function assistantLine(ts: string, text: string, cost: number): string {
	return JSON.stringify({
		type: "message",
		timestamp: ts,
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text }],
			usage: { totalTokens: 10, input: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		},
	});
}

test("P1: two messages an hour apart carry two ts values", () => {
	mkdirSync(SESSIONS, { recursive: true });
	writeFileSync(
		join(PROJ, "20261028_1000_main.jsonl"),
		[userLine("2026-10-27T10:00:00", "start please"), assistantLine("2026-10-27T11:00:00", "done", 0.01)].join("\n") + "\n",
	);
	const runs = ompRunSource(SESSIONS, CFG).listRuns(T0 - 60);
	expect(runs).toHaveLength(1);
	const [a, b] = runs[0]!.messages;
	expect(a!.ts).toBe(new Date(2026, 9, 27, 10, 0).getTime() / 1000);
	expect(b!.ts! - a!.ts!).toBe(3600);
});

test("P1: a sub run carries its first user message with ts", () => {
	writeFileSync(join(PROJ, "NsProbe1.jsonl"), userLine("2026-10-27T10:05:00", "please run the checks") + "\n");
	const run = ompRunSource(SESSIONS, CFG).listRuns(0).find(r => r.id === "NsProbe1");
	expect(run?.messages).toHaveLength(1);
	expect(run?.messages[0]?.role).toBe("user");
	expect(run?.messages[0]?.ts).not.toBeNull();
});

// --- P2: close times ---

test("closeTime reads the newest dated Progress entry; CEST/CET are zone offsets, a bare stamp is local", () => {
	const body = (lines: string[]) => `## Progress\nStatus: complete\n${lines.join("\n")}\n`;
	expect(closeTime(body(["- 2026-10-25 09:00 X: b", "- 2026-10-26 12:00 CEST X: a"]))).toBe(Date.UTC(2026, 9, 26, 12) / 1000 - 7200);
	expect(closeTime(body(["- 2026-10-27 12:00 CET X: a"]))).toBe(Date.UTC(2026, 9, 26 + 1, 12) / 1000 - 3600);
	expect(closeTime(body(["- 2026-10-26 10:00 X: a"]))).toBe(new Date(2026, 9, 26, 10, 0).getTime() / 1000);
	expect(closeTime(body(["- 2026-10-26 X: a"]))).toBe(new Date(2026, 9, 26).getTime() / 1000);
	expect(closeTime("## Progress\nStatus: open\n- no dates here\n")).toBeNull();
});

// --- P2: chains and the ledger ---

test("plans are discovered in docs/plans and archive; progress archives and unstamped files are not plans", () => {
	const stems = loadPlans(CFG).map(p => p.stem).sort();
	expect(stems).toEqual([ALPHA, FIX, GAMMA, NS, OLD].sort());
});

test("a two-plan chain closes only when its fix closes", () => {
	const plans = loadPlans(CFG);
	const cs = chains(plans, null);
	expect(cs.map(c => c.stem).sort()).toEqual([ALPHA, GAMMA, OLD, NS].sort());
	const alpha = cs.find(c => c.stem === ALPHA)!;
	expect(alpha.stems).toEqual([ALPHA, FIX]);
	expect(alpha.fixPlans).toBe(1);
	expect(alpha.closed).toBe(false);
	writeFileSync(join(PLANS, `${FIX}.md`), planText("Fix alpha", [`fix ${ALPHA}: the widget leaked`], "complete", ["- 2026-10-27 12:00 CET Main: fix shipped. Findings: none"]));
	const after = chains(loadPlans(CFG), null).find(c => c.stem === ALPHA)!;
	expect(after.closed).toBe(true);
	expect(after.closedAt).toBe(Date.UTC(2026, 9, 27, 12) / 1000 - 3600);
});

test("chain kind follows the self repo", () => {
	const cs = chains(loadPlans(CFG), NSREPO);
	expect(cs.find(c => c.stem === NS)!.kind).toBe("neurastream");
	expect(cs.find(c => c.stem === ALPHA)!.kind).toBe("product");
});

function msg(role: string, cost: number, ts: number | null, text: string): RunMessage {
	return { role, cost, text, ts };
}
function fakeRun(id: string, kind: Run["kind"], cost: number, messages: RunMessage[]): Run {
	return {
		id,
		kind,
		model: "m",
		calls: 1,
		tokens: 1,
		cacheRead: 0,
		cost,
		inputTokens: 0,
		prefillTokens: 0,
		status: "done",
		statusDetail: "",
		startedAt: null,
		lastWriteAt: NOW - 60,
		endedAt: null,
		messages,
		scoreModel: "m",
		scoreCost: 0,
		scoreHours: 0,
		scoreRunning: false,
		scoreSurvived: false,
		scoreEnd: "",
	} as Run;
}

const NOW = Date.UTC(2026, 9, 30, 12) / 1000;
const DAYS = 7;
const DAY = 86400;
const H1 = Date.UTC(2026, 9, 26, 8, 10) / 1000;
const H2 = Date.UTC(2026, 9, 26, 9, 10) / 1000;
const H3 = Date.UTC(2026, 9, 26, 15, 10) / 1000;

const RUNS: Run[] = [
	fakeRun("20261026-main", "main", 8, [
		msg("user", 0, H1, `plan ${ALPHA} and ${FIX} together`),
		msg("assistant", 2, H1 + 1200, "ok"),
		msg("assistant", 3, H2, "no plan named here"),
		msg("assistant", 3, H3, `${ALPHA} again`),
		msg("assistant", 5, null, `${ALPHA} without a stamp counts nowhere`),
	]),
	fakeRun("NsFixAlpha1", "sub", 4, [msg("user", 0, H1 + 60, `fix ${FIX} now`)]),
	fakeRun("NsBare1", "sub", 1, [msg("user", 0, H1 + 60, "nothing named")]),
	fakeRun("NsGamma1", "sub", 2, [msg("user", 0, H1 + 60, `work ${GAMMA}`)]),
];

test("feature rows and the per-kind summary price finished chains", () => {
	const report = featuresReport(RUNS, loadPlans(CFG), NSREPO, NOW - DAYS * DAY, NOW);
	// The Main hour naming two plans splits 50/50: alpha and fix get 1 each of the 2.
	// The hour naming none is overhead, as is the sub naming none.
	const row = report.rows.find(r => r.stem === ALPHA)!;
	expect(report.rows).toHaveLength(1);
	expect(row.kind).toBe("product");
	expect(row.plans).toBe(2);
	expect(row.fixPlans).toBe(1);
	expect(row.total).toBeCloseTo(1 + 1 + 3 + 4); // alpha 1+3, fix 1+4
	expect(row.first).toBeCloseTo(4);
	expect(row.closedAt).toBe(Date.UTC(2026, 9, 27, 12) / 1000 - 3600);
	const product = report.summaries.find(s => s.kind === "product")!;
	expect(product.finished).toBe(1);
	expect(product.perDay).toBeCloseTo(1 / DAYS);
	expect(product.perFeature).toBeCloseTo(9);
	expect(product.firstPass).toBeCloseTo(4);
	// Main $ in window = 2+3+3 = 8; overhead = 3 (bare hour) + 1 (bare sub) = 4 → 50%.
	expect(product.overheadPct).toBeCloseTo(50);
	expect(product.openChains).toBe(1);
	expect(product.openSunk).toBeCloseTo(2);
	const ns = report.summaries.find(s => s.kind === "neurastream")!;
	expect(ns.finished).toBe(0);
	expect(ns.perFeature).toBeNull();
	// The old archived chain closed outside the window: no row, no $.
	expect(report.rows.find(r => r.stem === OLD)).toBeUndefined();
});

// --- the real-CLI tests: every fixture hangs off BASE (P4 step 0) ---

// The spawned CLI windows on the wall clock, so calendar-pinned fixtures leave the window as
// the days pass (the 2026-10-30 fixtures died on 2026-11-01). These two tests build every
// timestamp — session lines, plan Progress dates, ci/product rows, even the session files'
// mtimes, which listRuns pre-filters on — relative to BASE, the current second, and pin the
// child to the same second through NEURASTREAM_NOW (src/core/clock.ts's test seam). A scratch
// copy with BASE shifted +30 days must still pass, which proves the pair is day-independent.
const BASE = Math.floor(Date.now() / 1000);
const HOUR = 3600;
/** Local `YYYY-MM-DD HH:MM`, the stamp closeTime parses (bare = local time). */
const stamp = (ts: number): string => {
	const d = new Date(ts * 1000);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const iso = (ts: number): string => new Date(ts * 1000).toISOString();
/** The CLI's run source skips session files whose mtime is older than the window, so fixture files carry BASE-relative mtimes. */
function backdate(path: string, ts: number): void {
	utimesSync(path, ts, ts);
}
function cliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("QUEUE_")) delete env[k];
	env.HOME = HOME;
	env.NEURASTREAM_NOW = String(BASE);
	return env;
}

test("metrics features prints the table through the real CLI on fixture data", () => {
	// ALPHA/FIX carry the chain's close time, so both plans get BASE-relative Progress dates
	// here (restored after — the fixed-date unit tests above read the same files).
	const alphaPath = join(PLANS, `${ALPHA}.md`);
	const fixPath = join(PLANS, `${FIX}.md`);
	const alphaKeep = readFileSync(alphaPath, "utf8");
	const fixKeep = readFileSync(fixPath, "utf8");
	writeFileSync(alphaPath, planText("Alpha", ["build the alpha widget"], "complete", [`- ${stamp(BASE - 3 * DAY)} Main: alpha shipped. Findings: none`]));
	writeFileSync(fixPath, planText("Fix alpha", [`fix ${ALPHA}: the widget leaked`], "complete", [`- ${stamp(BASE - 2 * DAY + HOUR)} Main: fix shipped. Findings: none`]));
	try {
		const main = join(PROJ, "20261026_0900_main.jsonl");
		writeFileSync(
			main,
			[
				userLine(iso(BASE - 3 * DAY), `plan ${ALPHA} and ${FIX} together`),
				assistantLine(iso(BASE - 3 * DAY + 600), "done", 2),
			].join("\n") + "\n",
		);
		backdate(main, BASE - 3 * DAY);
		// A sub naming alpha only: its whole cost goes to alpha's chain, outside the Main hour split.
		const sub = join(PROJ, "NsAlpha1.jsonl");
		writeFileSync(
			sub,
			[
				userLine(iso(BASE - 3 * DAY + 80 * 60), `continue ${ALPHA}: run the checks`),
				assistantLine(iso(BASE - 3 * DAY + 81 * 60), "checks done", 0.04),
			].join("\n") + "\n",
		);
		backdate(sub, BASE - 3 * DAY + 80 * 60);
		const r = spawnSync(process.execPath, ["src/cli/main.ts", "metrics", "features", "--days", "7"], {
			cwd: join(import.meta.dir, ".."),
			env: cliEnv(),
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Results: last 7 days");
		expect(r.stdout).toContain(ALPHA);
		expect(r.stdout).toContain("2.04"); // alpha 1 + fix 1 + sub 0.04
	} finally {
		writeFileSync(alphaPath, alphaKeep);
		writeFileSync(fixPath, fixKeep);
	}
});

// --- P3: releases ---

/** Runs git in `cwd`; tag dates are pinned through the committer/author date env (a lightweight tag dates as its commit). */
function git(args: string[], cwd: string, dates?: [string, string]): void {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (dates) {
		env.GIT_AUTHOR_DATE = dates[0];
		env.GIT_COMMITTER_DATE = dates[1];
	}
	spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

test("gatherTags lists the v* tags of a repo with their tag dates; none outside a git repo", () => {
	git(["init", "-q"], REPO);
	const who = ["-c", "user.email=t@t", "-c", "user.name=t"];
	git([...who, "commit", "-q", "--allow-empty", "-m", "one"], REPO, ["2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z"]);
	git(["tag", "v1.0.0"], REPO);
	git([...who, "commit", "-q", "--allow-empty", "-m", "two"], REPO, ["2026-10-20T12:00:00Z", "2026-10-20T12:00:00Z"]);
	git(["tag", "v1.1.0"], REPO);
	const tags = gatherTags(REPO);
	expect(tags.map(t => t.name)).toEqual(["v1.0.0", "v1.1.0"]);
	expect(tags[0]!.ts).toBe(Date.UTC(2026, 9, 15) / 1000);
	expect(tags[1]!.ts).toBe(Date.UTC(2026, 9, 20, 12) / 1000);
	expect(gatherTags(join(TMP, "no-repo-here"))).toEqual([]);
});

test("releases: a 10-day-old tag shows both sides, a 2-day-old tag is measuring, product values are picked per repo", () => {
	// A second neurastream chain closing inside v1.0.0's after window. Written here so the P2
	// tests above keep their exact fixture.
	writeFileSync(join(NSREPO, "docs/plans", `${NS2}.md`), planText("Ns2", ["engine work two"], "complete", ["- 2026-10-26 15:00 CEST Main: ns2 done. Findings: none"]));
	const cmsg = (cost: number, ts: number, text: string): RunMessage => ({ role: "assistant", cost, text, ts });
	const runs: Run[] = [
		// The cmsg runs carry only $: calls/tokens stay 0 so the tokens-per-call windows below
		// read from the relc runs alone.
		{ ...fakeRun("relm1", "main", 3, [cmsg(3, Date.UTC(2026, 9, 19, 9, 10) / 1000, `work on ${NS}`)]), calls: 0, tokens: 0 },
		{ ...fakeRun("relm2", "main", 5, [cmsg(5, Date.UTC(2026, 9, 26, 14, 10) / 1000, `work on ${NS2}`)]), calls: 0, tokens: 0 },
		{ ...fakeRun("relm3", "main", 2, [cmsg(2, Date.UTC(2026, 9, 26, 10, 10) / 1000, `work on ${ALPHA}`)]), calls: 0, tokens: 0 },
		{ ...fakeRun("relm4", "main", 4, [cmsg(4, Date.UTC(2026, 9, 20, 9, 10) / 1000, `work on ${OLD}`)]), calls: 0, tokens: 0 },
		{ ...fakeRun("relc1", "main", 0, []), calls: 10, tokens: 2000, lastWriteAt: NOW - 11 * DAY },
		{ ...fakeRun("relc2", "sub", 0, []), calls: 5, tokens: 500, lastWriteAt: NOW - 11 * DAY + 60 },
		{ ...fakeRun("relc3", "main", 0, []), calls: 4, tokens: 800, lastWriteAt: NOW - 9 * DAY },
	];
	const tags = [
		{ name: "v1.0.0", ts: NOW - 10 * DAY },
		{ name: "v1.1.0", ts: NOW - 2 * DAY },
	];
	const events: Ev[] = [
		{ type: "ci", mr: "77", repo: REPO, tries: 1, ts: NOW - 7.5 * DAY },
		{ type: "ci", mr: "88", repo: NSREPO, tries: 1, ts: NOW - 3 * DAY }, // a self merge is its tag, not a second release
		{ type: "product", repo: REPO, name: "dist_mb", value: 10, ts: NOW - 11 * DAY },
		{ type: "product", repo: REPO, name: "dist_mb", value: 12, ts: NOW - 4 * DAY },
		{ type: "product", repo: NSREPO, name: "dist_mb", value: 3, ts: NOW - 9 * DAY },
	];
	const report = releasesReport(runs, loadPlans(CFG), NSREPO, DAYS, NOW, tags, events);
	expect(report.rows.map(r => r.name)).toEqual(["v1.0.0", "proj#77", "v1.1.0"]);
	// v1.0.0, 10 days old: both windows are complete.
	const old = report.rows[0]!;
	expect(old.kind).toBe("neurastream");
	expect(old.measuring).toBe(false);
	expect(old.before.perFeature).toBeCloseTo(3);
	expect(old.before.featuresPerDay).toBeCloseTo(1 / DAYS);
	expect(old.before.callsPerFeature).toBeCloseTo(10);
	expect(old.before.tokensPerCall).toBeCloseTo(2500 / 15);
	expect(old.before.fixPlansPerFeature).toBeCloseTo(0);
	expect(old.after.perFeature).toBeCloseTo(5);
	expect(old.after.callsPerFeature).toBeCloseTo(4);
	expect(old.after.tokensPerCall).toBeCloseTo(200);
	// Product numbers are picked per repo: nsrepo recorded nothing before v1.0.0.
	expect(old.before.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: null },
		{ repo: REPO, name: "dist_mb", value: 10 },
	]);
	expect(old.after.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: 3 },
		{ repo: REPO, name: "dist_mb", value: 12 },
	]);
	// proj#77 is a product merge: priced from the product chains only.
	const merge = report.rows[1]!;
	expect(merge.kind).toBe("product");
	expect(merge.measuring).toBe(false);
	expect(merge.before.perFeature).toBeCloseTo(4);
	expect(merge.after.perFeature).toBeCloseTo(2);
	expect(merge.after.fixPlansPerFeature).toBeCloseTo(1); // alpha's chain carries its fix plan
	expect(merge.before.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: 3 },
		{ repo: REPO, name: "dist_mb", value: 10 },
	]);
	expect(merge.after.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: null },
		{ repo: REPO, name: "dist_mb", value: 12 },
	]);
	// v1.1.0, 2 days old: the after window is still measuring.
	const fresh = report.rows[2]!;
	expect(fresh.measuring).toBe(true);
	expect(fresh.before.perFeature).toBeCloseTo(5);
	expect(fresh.after.perFeature).toBeNull();
	expect(fresh.after.callsPerFeature).toBeNull();
	expect(fresh.after.tokensPerCall).toBeNull();
	expect(fresh.before.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: 3 },
		{ repo: REPO, name: "dist_mb", value: 12 },
	]);
	expect(fresh.after.products).toEqual([
		{ repo: NSREPO, name: "dist_mb", value: null },
		{ repo: REPO, name: "dist_mb", value: null },
	]);
});

test("metrics releases prints one row per release with before and after through the real CLI", () => {
	// All BASE-relative, like the features CLI test: #77 sits 4 days back, before the fixture
	// work (3 days back) and before alpha's and ns2's closes (2 days back), so both land in its
	// after window and the after side is still measuring.
	const alphaPath = join(PLANS, `${ALPHA}.md`);
	const fixPath = join(PLANS, `${FIX}.md`);
	const ns2Path = join(NSREPO, "docs/plans", `${NS2}.md`);
	const alphaKeep = readFileSync(alphaPath, "utf8");
	const fixKeep = readFileSync(fixPath, "utf8");
	const ns2Keep = readFileSync(ns2Path, "utf8");
	writeFileSync(alphaPath, planText("Alpha", ["build the alpha widget"], "complete", [`- ${stamp(BASE - 3 * DAY)} Main: alpha shipped. Findings: none`]));
	writeFileSync(fixPath, planText("Fix alpha", [`fix ${ALPHA}: the widget leaked`], "complete", [`- ${stamp(BASE - 2 * DAY + HOUR)} Main: fix shipped. Findings: none`]));
	writeFileSync(ns2Path, planText("Ns2", ["engine work two"], "complete", [`- ${stamp(BASE - 2 * DAY)} Main: ns2 done. Findings: none`]));
	try {
		appendMetric(CFG, { type: "ci", mr: "77", repo: REPO, tries: 1, ts: BASE - 4 * DAY });
		appendMetric(CFG, { type: "product", repo: REPO, name: "dist_mb", value: 10, ts: BASE - 5 * DAY });
		appendMetric(CFG, { type: "product", repo: REPO, name: "dist_mb", value: 12, ts: BASE - 1 * DAY });
		const r = spawnSync(process.execPath, ["src/cli/main.ts", "metrics", "releases", "--days", "7"], {
			cwd: join(import.meta.dir, ".."),
			env: cliEnv(),
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Releases:");
		expect(r.stdout).toContain("proj#77");
		expect(r.stdout).toContain("measuring");
		expect(r.stdout).toContain("dist_mb 10→12");
		expect(r.stdout).toContain("1.02"); // after #77: (alpha 2.04 + ns2 0.00) / 2 finished product chains
		// One row per release: the self repo's v* tags plus the one product merge.
		const vtags = spawnSync("git", ["for-each-ref", "refs/tags/v*", "--format=%(refname:short)"], {
			cwd: join(import.meta.dir, ".."),
			encoding: "utf8",
		}).stdout.split("\n").filter(Boolean).length;
		expect(r.stdout.split("\n").filter(l => l.includes("→")).length).toBe(vtags + 1);
	} finally {
		writeFileSync(alphaPath, alphaKeep);
		writeFileSync(fixPath, fixKeep);
		writeFileSync(ns2Path, ns2Keep);
	}
});
