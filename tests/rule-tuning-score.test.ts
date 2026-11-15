// Kind scoring (plan 20261110_1746 P3). Pure inputs; the report line is checked through a
// temp queue state, never the real home.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSource } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { addIncident, incidentsFile } from "../src/core/incidents.ts";
import type { IncidentView } from "../src/core/incidents.ts";
import { buildReport } from "../src/core/report.ts";
import { scoreKinds, type Tuning } from "../src/core/rule-tuning.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const W = { from: 1_000, to: 2_000 };
const TUNING: Tuning = {
	enabled: true,
	min_fires: 20,
	max_useful: 0.1,
	window_days: 7,
	probation_days: 7,
	guards: false,
	keep_off: [],
};

function view(id: string, kind: string, ts: number, resolution: IncidentView["resolution"] = null): IncidentView {
	return { id, fingerprint: id, source: "realtime", kind, summary: id, evidence: "", ts, count: 1, lastSeen: ts, resolution, proposal: null };
}

function tally(ts: number, kind: string, level: "tell" | "off"): string {
	return `${new Date(ts * 1000).toISOString()} [main] rule ${kind} ${level}: ${kind} fired`;
}

test("fires are opened incidents plus tell and off lines in the window", () => {
	const incidents = [
		view("a", "tool-crash", 1100, { type: "plan", id: "a", plan: "p" }),
		view("b", "tool-crash", 1200, { type: "fixed", id: "b", plan: "p", ts: 1300 }),
		view("c", "tool-crash", 1400, { type: "dismiss", id: "c", why: "no" }),
		view("old", "tool-crash", 500, { type: "fixed", id: "old", plan: "p", ts: 600 }),
		view("other", "daily-regression", 1100, { type: "plan", id: "other", plan: "p" }),
	];
	const logText = [
		tally(1500, "tool-crash", "tell"),
		tally(1600, "tool-crash", "off"),
		tally(900, "tool-crash", "tell"),
		tally(1700, "unit-failed", "off"),
	].join("\n");
	const rows = scoreKinds(incidents, logText, W, TUNING, []);
	const crash = rows.find((r) => r.kind === "tool-crash");
	expect(crash).toEqual({ kind: "tool-crash", fires: 5, planned: 1, fixed: 1, dismissed: 1, usefulShare: 2 / 5 });
	const unit = rows.find((r) => r.kind === "unit-failed");
	expect(unit).toMatchObject({ fires: 1, planned: 0, fixed: 0, dismissed: 0, usefulShare: 0 });
	expect(rows.some((r) => r.kind === "daily-regression")).toBe(false);
	expect(rows.find((r) => r.kind === "block-loop")).toMatchObject({ fires: 0, usefulShare: 0 });
});

test("the report per-kind line prints fixed", () => {
	const home = mkdtempSync(join(tmpdir(), "ns-rule-score-"));
	DIRS.push(home);
	const queueState = join(home, "queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:\n  home: "${home}"\n  queue_state: "${queueState}"\n  guard_log: "${join(home, "g.log")}"\n  score_state: "${join(home, "score")}"\n`,
	);
	const cfg: Config = loadConfig({ home, env: {} });
	const now = 1_760_000_000;
	const opened = addIncident(cfg, { source: "realtime", kind: "tool-crash", summary: "crashed" }, now - 10);
	appendFileSync(incidentsFile(cfg), `${JSON.stringify({ type: "fixed", id: opened.incident.id, plan: join(home, "fix.md"), ts: now - 5 })}\n`);
	const source: RunSource = { listRuns: () => [], mainSession: () => null };
	const text = buildReport(cfg, source, 7, now).text;
	expect(text).toContain("Dismiss rate by kind (opened, planned, fixed, dismissed):");
	expect(text).toContain("- tool-crash: 1, 0, 1, 0 (0% dismissed)");
});
