// Results (plan 20261025_2148 P1+P2): message timestamps through the omp mapper, then the
// feature ledger — plans found with the queue's walkers, chains via Goal stems, Main message
// cost bucketed per hour and split over the plans that hour names. Fixtures only; the live
// setup is never read.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import type { Run, RunMessage } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { chains, closeTime, featuresReport, loadPlans } from "../src/core/results.ts";

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
	const report = featuresReport(RUNS, loadPlans(CFG), NSREPO, DAYS, NOW);
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

test("metrics features prints the table through the real CLI on fixture data", () => {
	writeFileSync(
		join(PROJ, "20261026_0900_main.jsonl"),
		[
			userLine("2026-10-26T08:10:00Z", `plan ${ALPHA} and ${FIX} together`),
			assistantLine("2026-10-26T08:20:00Z", "done", 2),
		].join("\n") + "\n",
	);
	// A sub naming alpha only: its whole cost goes to alpha's chain, outside the Main hour split.
	writeFileSync(
		join(PROJ, "NsAlpha1.jsonl"),
		[
			userLine("2026-10-26T09:30:00Z", `continue ${ALPHA}: run the checks`),
			assistantLine("2026-10-26T09:31:00Z", "checks done", 0.04),
		].join("\n") + "\n",
	);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("QUEUE_")) delete env[k];
	env.HOME = HOME;
	const r = spawnSync(process.execPath, ["src/cli/main.ts", "metrics", "features", "--days", "7"], {
		cwd: join(import.meta.dir, ".."),
		env,
		encoding: "utf8",
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("Results: last 7 days");
	expect(r.stdout).toContain(ALPHA);
	expect(r.stdout).toContain("2.04"); // alpha 1 + fix 1 + sub 0.04
});
