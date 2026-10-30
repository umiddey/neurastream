// Renders the owner page to a file with the real renderer and no server, from a fixture state
// (plan 20261025_0100_owner_ui_redesign P19): every tab has data — 2 asks (one already answered,
// each with Do / Stuck until then / Why you), 12 queued plans across 3 repos each with its own
// file, a Summary line, and a status chip covering every queue state, 3 agents incl. 1 that died
// before its first reply (model from the spawning agent's frontmatter, never "?"), a scores table,
// an incident, low disk, and spend across the last 10 hours. `--tab <now|queue|agents|spend>`
// picks the tab (default now). The output is meant for screenshots and review; it is not a test
// and touches nothing outside <out.html>.
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
		waitingAsk:
			"I need a decision: should the gate hard-fail HTTP calls that go through an undeclared wrapper (like an authFetch we cannot trace), or keep warning for one more release?",
		waitingBlocked: "The PM red-list run is blocked behind this answer, and three plans queue behind that run.",
		waitingWhy: "Main cannot decide the release policy.",
		unblocks: [],
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
		waitingAsk: "Say whether I should raise the cap to 150, or split their scopes into smaller slices?",
		waitingBlocked: "The queue is holding 6 plans behind them and the night budget is burning.",
		waitingWhy: "Main cannot raise the cap or rescope the batch without you.",
		unblocks: ["PM batch: split the two capped scopes"],
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
	// Died before its first reply: the transcript has no provider/model line, so P17 reads the
	// parent task's agent frontmatter (NsUnlockNoticeSol → sol → openai-codex/gpt-6.1-sol) and
	// the page prints the short name. Never "?".
	{ id: "NsUnlockNoticeSol", model: "gpt-6.1-sol", detail: "DIED: never replied", minutes: 51, status: "died" },
	{ id: "scores-sweep", model: "deepseek-v3", detail: "WAITING on owner answer", minutes: 3, status: "waiting" },
];

// Each card has its own file (a shared fixture.md made a reorder check unable to tell cards
// apart). Summaries are the plan's `Summary:` line. States cover every chip queueState emits:
// waits you, waits on <plan>, not started · 0/N, phase K of N, all N done · checking.
const queue: QueueRow[] = [
	{
		repo: "alpha",
		file: "/srv/code/alpha/docs/plans/20261025_0115_release_gate.md",
		title: "Gateforge 0.16 release checklist",
		status: "open",
		waiting: true,
		summary: "Ship the 0.16 gate so an unresolved wrapper call fails the release instead of vanishing into a warning the red-list run never sees.",
		state: "waits you",
	},
	{
		repo: "alpha",
		file: "/srv/code/alpha/docs/plans/20261024_0900_adapter_contract.md",
		title: "Adapter contract: second harness without core changes",
		status: "open",
		waiting: false,
		summary: "A second harness plugs in behind the registry without a core edit.",
		state: "not started · 0/4",
	},
	{
		repo: "alpha",
		file: "/srv/code/alpha/docs/plans/20261023_1400_golden_guard_cli.md",
		title: "Golden tests for the guard CLI JSON surface",
		status: "open",
		waiting: false,
		summary: "Pin the guard CLI JSON so a field rename fails the golden before it ships.",
		state: "phase 2 of 5",
	},
	{
		repo: "alpha",
		file: "/srv/code/alpha/docs/plans/20261022_1800_digest_pin_w4.md",
		title: "Digest-pin the trusted policy files (deferred W4)",
		status: "open",
		waiting: false,
		summary: "Trusted policy files get a digest pin once the deferred W4 trust change is ready to land.",
		state: "all 3 done · checking",
	},
	{
		repo: "beta",
		file: "/srv/code/beta/docs/plans/20261024_1900_pm_batch.md",
		title: "PM batch: split the two capped scopes",
		status: "open",
		waiting: false,
		summary: "Split the two batch scopes that died at the call cap so the night run finishes both probes.",
		state: "waits on Gateforge 0.16 release checklist",
	},
	{
		repo: "beta",
		file: "/srv/code/beta/docs/plans/20261024_1600_probe_log_pairing.md",
		title: "Batch report: probe-log pairing per key",
		status: "open",
		waiting: false,
		summary: "Each red-list key in the batch report pairs with the probe log that produced it.",
		state: "not started · 0/1",
	},
	{
		repo: "beta",
		file: "/srv/code/beta/docs/plans/20261023_2200_night_budget.md",
		title: "Night budget ledger for the experiment",
		status: "open",
		waiting: false,
		summary: "The night experiment gets a ledger of what each run spent, so a blown budget is visible before morning.",
		state: "phase 3 of 5",
	},
	{
		repo: "beta",
		file: "/srv/code/beta/docs/plans/20261022_1100_webhook_retry.md",
		title: "Webhook retry policy for notify failures",
		status: "open",
		waiting: false,
		summary: "A failed notify webhook retries once after the requested delay instead of dropping the owner's ping.",
		state: "all 5 done · checking",
	},
	{
		repo: "gamma",
		file: "/srv/code/gamma/docs/plans/20261025_1200_reorder_inbox.md",
		title: "Queue reorder inbox message polish",
		status: "open",
		waiting: true,
		summary: "The reorder message Main reads names the plan and the new rank in one plain sentence.",
		state: "waits you",
	},
	{
		repo: "gamma",
		file: "/srv/code/gamma/docs/plans/20261024_0800_index_writer.md",
		title: "INDEX.md atomic writer hardening",
		status: "open",
		waiting: false,
		summary: "INDEX.md is rewritten through a temp file and a rename, so a crash mid-write cannot tear the queue in half.",
		state: "waits on PM batch: split the two capped scopes",
	},
	{
		repo: "gamma",
		file: "/srv/code/gamma/docs/plans/20261023_1000_screenshot_review.md",
		title: "Owner page screenshot review at 390×844",
		status: "open",
		waiting: false,
		summary: "Every phone tab is checked at 390 by 844 against the approved mockup before the release tag.",
		state: "phase 1 of 2",
	},
	{
		repo: "gamma",
		file: "/srv/code/gamma/docs/plans/20261021_0700_trim_progress.md",
		title: "Trim progress entries older than 7 days",
		status: "open",
		waiting: false,
		summary: "Progress entries past the keep count move to the plan archive so the live file stays short enough to read.",
		state: "not started · 0/6",
	},
];

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

/** The fixture page state, exported for scripts/ui-demo.ts (the one-file, every-tab presentation copy). */
export function fixtureData(): PageData {
	return {
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
		knowledge: [
			{ repo: "neurastream", topic: "architecture", title: "How the pieces fit", updated: new Date((ts - 86_400) * 1000).toISOString() },
		],
		pages: [
			{ name: "architecture", repo: "neurastream", published: new Date((ts - 43_200) * 1000).toISOString(), url: "https://ukd.tailc0aee7.ts.net:7788/architecture.html" },
		],
		messages: [{ id: "1792953589-a1b2c3", ts: ts - 7200, text: "Please check this photo from the site visit.", images: ["1.jpg"] }],
		lockMinutesLeft: 12,
	};
}

/** A throwaway-home config so neither script touches the real one; chat_unlock on for the demo lock pill. */
export function fixtureConfig() {
	const base = loadConfig({ home: join(tmpdir(), "neurastream-ui-preview") });
	return { ...base, guards: { ...base.guards, chat_unlock: true } };
}

if (import.meta.main) {
	const cfg = fixtureConfig();
	const html = renderPage(cfg, fixtureData(), new URLSearchParams(tab ? `tab=${tab}` : ""), "preview-fixed-nonce");
	mkdirSync(dirname(resolve(out)), { recursive: true });
	writeFileSync(out, html);
	console.log(`wrote ${out} (${html.length} bytes, tab=${tab || "now"}, ${questions.length} waiting, ${queue.length} queued, ${stats.runs24} runs/$${stats.spend24.toFixed(2)} in 24 h)`);
}
