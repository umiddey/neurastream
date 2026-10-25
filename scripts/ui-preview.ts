// Renders the owner page to a file with the real renderer and no server, from a fixture state
// (plan 20261025_0100_owner_ui_redesign P8): every tab has data — 2 asks (one already answered),
// 12 queued plans across 3 repos, 3 agents incl. 1 died, a scores table, an incident, low disk,
// and spend across the last 10 hours. `--tab <now|queue|agents|spend>` picks the tab (default
// now). The output is meant for screenshots and review; it is not a test and touches nothing
// outside <out.html>.
// Usage: bun scripts/ui-preview.ts <out.html> [--tab <name>]

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { nowSec } from "../src/core/clock.ts";
import { renderPage, type AgentRow, type CiRow, type IncidentRow, type NowStats, type PageData, type QueueRow, type QuestionRow } from "../src/core/owner-ui.ts";

const out = process.argv[2];
if (!out) {
	console.error("usage: bun scripts/ui-preview.ts <out.html> [--tab <name>]");
	process.exit(2);
}
const tabAt = process.argv.indexOf("--tab");
const tab = tabAt > -1 ? (process.argv[tabAt + 1] ?? "") : "";

const questions: QuestionRow[] = [
	{
		plan: "/srv/code/alpha/docs/plans/20261025_0115_release_gate.md",
		title: "Release gate: fail every unresolved wrapper call in 0.16?",
		repo: "alpha",
		waitingLine:
			"I need a decision: should the gate hard-fail HTTP calls that go through an undeclared wrapper (like an authFetch we cannot trace), or keep warning for one more release? The PM red-list run is blocked behind this answer, and three plans queue behind that run.",
		goal: [
			"Catch wrapper-wrapped HTTP calls that today escape the gate",
			"Fail loudly instead of reporting HTTP_CALL_UNRESOLVED into a void",
			"Keep the red-list keys (synapse, task orders, units) coverable in the same run",
			"Land in 0.16 with the adapter contract unchanged",
		],
		waitingMin: 187,
		answered: { answer: "yes", at: nowSec() - 20 * 60 },
	},
	{
		plan: "/srv/code/beta/docs/plans/20261024_1900_pm_batch.md",
		title: "PM batch runner drops slow subagents at the call cap",
		repo: "beta",
		waitingLine:
			"Two batch agents hit their 100-call cap mid-investigation and handed back half-done. Say whether I should raise the cap to 150, or split their scopes into smaller slices — the queue is holding 6 plans behind them and the night budget is burning.",
		goal: [
			"Stop losing subagent work at the cap boundary",
			"Keep the 90-call warning as the early signal",
			"Make the batch report pair every key with its probe log",
		],
		waitingMin: 41,
		answered: null,
	},
];

const agents: AgentRow[] = [
	{ id: "main-7f3a2c", model: "glm-5.3-flash", detail: "Reviewing the PM red-list diff", minutes: 34, status: "running" },
	{ id: "pr01-keys-12a", model: "grok-4-fast", detail: "Batch probe crashed on the webhook fixtures", minutes: 51, status: "died" },
	{ id: "scores-sweep", model: "deepseek-v3", detail: "WAITING on owner answer", minutes: 3, status: "waiting" },
];

const queue: QueueRow[] = [
	["alpha", "Gateforge 0.16 release checklist", false],
	["alpha", "Adapter contract: second harness without core changes", false],
	["alpha", "Golden tests for the guard CLI JSON surface", false],
	["alpha", "Digest-pin the trusted policy files (deferred W4)", false],
	["beta", "PM batch: split the two capped scopes", true],
	["beta", "Batch report: probe-log pairing per key", false],
	["beta", "Night budget ledger for the experiment", false],
	["beta", "Webhook retry policy for notify failures", false],
	["gamma", "Queue reorder inbox message polish", false],
	["gamma", "INDEX.md atomic writer hardening", false],
	["gamma", "Owner page screenshot review at 390×844", false],
	["gamma", "Trim progress entries older than 7 days", false],
].map(([repo, title, waiting]) => ({
	repo: repo as string,
	file: `/srv/code/${repo}/docs/plans/fixture.md`,
	title: title as string,
	status: "open",
	waiting: waiting as boolean,
}));

// Spend and runs across the last 10 hours; the 14 older buckets stay empty. The totals add up:
// $39.50 over 45 runs, split Main $27.30 / agents $12.20, and byModel carries the same sums.
const spendByHour = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.8, 2.4, 3.1, 2.2, 4.6, 5.1, 3.8, 4.9, 6.2, 5.4];
const runsByHour = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 4, 3, 5, 6, 4, 6, 7, 5];
const stats: NowStats = {
	spend24: 39.5,
	mainSpend: 27.3,
	agentSpend: 12.2,
	runs24: 45,
	running: 2,
	died: 1,
	spendByHour,
	runsByHour,
	byModel: [
		{ model: "glm-5.3-flash", spend: 21.4, runs: 24 },
		{ model: "grok-4-fast", spend: 12.8, runs: 13 },
		{ model: "deepseek-v3", spend: 5.3, runs: 8 },
	],
	openPlans: queue.length,
};

const ts = nowSec();
const ci: CiRow[] = [
	{ mr: "!142", tries: 3, ts: ts - 5400 },
	{ mr: "!139", tries: 1, ts: ts - 86_400 },
	{ mr: "!137", tries: 2, ts: ts - 172_800 },
];

const incidents: IncidentRow[] = [{ id: "I-20261025-01", kind: "usage-limit", summary: "glm usage limit hit at 02:00; resets 08:03 local", count: 2 }];

const data: PageData = {
	questions,
	agents,
	queue,
	ci,
	incidents,
	scores: {
		header: ["agent", "score", "runs", "survived"],
		rows: [
			["glm-5.3-flash", "4.4", "9", "8"],
			["grok-4-fast", "4.1", "6", "5"],
			["deepseek-v3", "3.2", "7", "4"],
		],
		text: ["Scores roll on a 7-day window; penalties are subtracted from the raw mean."],
	},
	machine: { freeGb: 6.2, diskMin: 20, load: 1.84, loadMax: 16, cores: 16 },
	stats,
	lockMinutesLeft: 12,
};

const base = loadConfig({ home: join(tmpdir(), "neurastream-ui-preview") });
const cfg = { ...base, guards: { ...base.guards, chat_unlock: true } };
const html = renderPage(cfg, data, new URLSearchParams(tab ? `tab=${tab}` : ""), "preview-fixed-nonce");
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes, tab=${tab || "now"}, ${questions.length} waiting, ${queue.length} queued, ${stats.runs24} runs/$${stats.spend24.toFixed(2)} in 24 h)`);
