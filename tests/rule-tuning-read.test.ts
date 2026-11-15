// Detector read side (plan 20261110_1746 P2): tell and off never open an incident. Temp dir
// through cfg paths only.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { beat } from "../src/core/heartbeat.ts";
import { runDetectors, runDetectorsGated } from "../src/core/incident-detectors.ts";
import { addIncident, readIncidents } from "../src/core/incidents.ts";
import { readEvents } from "../src/core/agent-score.ts";
import { levelFor, readLevels, writeLevels } from "../src/core/rule-levels.ts";
import { watchOnce, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_760_000_000;
const CRASH = { command: "neurastream doctor", output: "internal error\nat neurastream (x.ts:1:1)" };

function cfg(): Config {
	const home = mkdtempSync(join(tmpdir(), "ns-rule-read-"));
	DIRS.push(home);
	const queueState = join(home, "queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:\n  home: "${home}"\n  queue_state: "${queueState}"\n  guard_log: "${join(home, "guard.log")}"\n  plan_guard_log: "${join(home, "plan.log")}"\n  score_state: "${join(home, "score")}"\n`,
	);
	return loadConfig({ home, env: {} });
}

function logText(c: Config): string {
	return readFileSync(c.paths.guard_log, "utf8");
}

function healthy(c: Config): void {
	for (const name of Object.keys(c.watch.expect)) beat(c, name, { ok: true });
}

function deps(at: number, units: FailedUnit[] = []): WatchDeps {
	return {
		now: () => at,
		listUnits: () => units,
		gather: () => ({ results: [], runs: [], blocks: [] }),
		notify: () => {},
		runner: () => ({ code: 1, stdout: "", stderr: "no forge in this test" }),
		plans: () => [],
		staffed: () => [],
	};
}

const finding = {
	agent: "PmEvidenceGlm",
	repo: "gateforge",
	target: "/x/pkg/resolve.js",
	plan: "/tmp/ns-rule-read-plan.md",
	summary: "PmEvidenceGlm read another repo and reported Findings: none",
	evidence: "read resolve.js",
};

test("tell logs one line and opens no incident, including on a second fire", () => {
	const c = cfg();
	writeLevels(c, { rules: { "tool-crash": { level: "tell", date: "2026-11-15" } } });
	expect(runDetectors(c, { bash: CRASH }, NOW)).toEqual([]);
	expect(runDetectors(c, { bash: CRASH }, NOW + 60)).toEqual([]);
	expect(readIncidents(c)).toEqual([]);
	const lines = logText(c).split("\n").filter((line) => line.includes("rule tool-crash tell:"));
	expect(lines).toHaveLength(2);
	expect(logText(c)).not.toContain("incident ");
});

test("off logs the tally line and opens no incident", () => {
	const c = cfg();
	writeLevels(c, { rules: { "tool-crash": { level: "off", date: "2026-11-15" } } });
	expect(runDetectors(c, { bash: CRASH }, NOW)).toEqual([]);
	expect(readIncidents(c)).toEqual([]);
	expect(logText(c)).toContain("rule tool-crash off:");
	expect(logText(c)).not.toContain("incident ");
});

test("block is unchanged, and a corrupt file still opens the incident", () => {
	const blocked = cfg();
	writeLevels(blocked, { rules: { "tool-crash": { level: "block", date: "2026-11-15" } } });
	expect(runDetectors(blocked, { bash: CRASH }, NOW).map((i) => i.kind)).toEqual(["tool-crash"]);

	const broken = cfg();
	writeFileSync(join(broken.paths.queue_state, "rule-levels.json"), "{");
	expect(readLevels(broken).corrupt).toBe(true);
	expect(runDetectors(broken, { bash: CRASH }, NOW).map((i) => i.kind)).toEqual(["tool-crash"]);
});

test("a rule id constructor reads as block, never an inherited value", () => {
	const c = cfg();
	expect(levelFor(readLevels(c), "constructor")).toBe("block");
	expect(levelFor(readLevels(c), "__proto__")).toBe("block");
});

test("the gated path and the traces fold honour tell: no incident and no penalty", () => {
	const c = cfg();
	writeLevels(c, {
		rules: {
			"tool-crash": { level: "tell", date: "2026-11-15" },
			"unreported-finding": { level: "off", date: "2026-11-15" },
		},
	});
	expect(runDetectorsGated(c, { bash: CRASH }, () => ({ results: [], runs: [], blocks: [] }), NOW)).toEqual([]);
	expect(runDetectors(c, { unreported: [finding] }, NOW)).toEqual([]);
	expect(readIncidents(c)).toEqual([]);
	expect(readEvents(c).filter((e) => e.type === "penalty")).toEqual([]);
	expect(logText(c)).toContain("rule tool-crash tell:");
	expect(logText(c)).toContain("rule unreported-finding off:");
});

test("the watch fold tells a tunable kind and still blocks a pinned kind", () => {
	const told = cfg();
	healthy(told);
	writeLevels(told, { rules: { "unit-failed": { level: "tell", date: "2026-11-15" } } });
	const units: FailedUnit[] = [{ name: "wip-backup.service", error: "exit 1" }];
	const report = watchOnce(told, deps(NOW, units));
	expect(report.opened).toEqual([]);
	expect(readIncidents(told)).toEqual([]);
	expect(logText(told)).toContain("rule unit-failed tell:");

	const pinned = cfg();
	healthy(pinned);
	writeLevels(pinned, { rules: { "beat-failed": { level: "off", date: "2026-11-15" } } });
	beat(pinned, "wip-backup", { ok: false, detail: "disk full" });
	const opened = watchOnce(pinned, deps(NOW));
	expect(opened.opened.map((i) => i.kind)).toEqual(["beat-failed"]);
});

test("a non-tunable kind still opens through addIncident when its level says off", () => {
	const c = cfg();
	writeLevels(c, { rules: { "daily-regression": { level: "off", date: "2026-11-15" } } });
	const { incident } = addIncident(c, { source: "daily", kind: "daily-regression", summary: "M5 rose" }, NOW);
	expect(incident.kind).toBe("daily-regression");
	expect(readIncidents(c)).toHaveLength(1);
});
