// P2 (plan 20261027_1430): the watcher — watchOnce folds failed/stale heartbeats, failed user
// units and the gated detectors into watch-source incidents, and closes a watch incident again
// when its problem recovers (dismissIncident). The clock, the unit lister and the detector
// gather are injected; tests touch only a temp paths.queue_state — no real home, network,
// service manager or detector inputs.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { beat, type Heartbeat } from "../src/core/heartbeat.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { nowSec } from "../src/core/clock.ts";
import { watchDoctorLine, watchHealth, watchOnce, watchUnitPaths, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import { readMetricEvents } from "../src/core/metrics.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempCfg(label: string): Config {
	const dir = mkdtempSync(join(tmpdir(), `watch-${label}-`));
	DIRS.push(dir);
	return loadConfig({ home: dir, env: {} });
}

/** Injected deps: a frozen clock, no failed units, empty detector inputs, a notifier that
 * swallows the posts (P2 tests assert the incident store, not the chat). */
function deps(at: number, units: FailedUnit[] = [], gather: () => GatedInputs = () => ({ results: [], runs: [], blocks: [] })): WatchDeps {
	return { now: () => at, listUnits: () => units, gather, notify: () => {}, runner: noForge, plans: () => [], staffed: () => [] };
}
/** No forge answers: the CI check finds nothing in the non-CI tests. */
const noForge: CommandRunner = () => ({ code: 1, stdout: "", stderr: "no forge in this test" });

/** The jobs the default watch.expect lists: all fresh, so nothing is stale. */
function healthy(cfg: Config): void {
	for (const name of Object.keys(cfg.watch.expect)) beat(cfg, name, { ok: true });
}

function hbFile(cfg: Config, hb: Heartbeat): void {
	const dir = join(cfg.paths.queue_state, "heartbeats");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${hb.name}.json`), JSON.stringify(hb));
}

test("a failed beat opens exactly one watch incident", () => {
	const cfg = tempCfg("failed");
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "git push failed: disk full" });
	const report = watchOnce(cfg, deps(nowSec()));
	expect(report.opened).toHaveLength(1);
	expect(report.opened[0]!.source).toBe("watch");
	expect(report.opened[0]!.kind).toBe("beat-failed");
	expect(report.opened[0]!.summary).toContain("wip-backup");
	expect(report.opened[0]!.summary).toContain("git push failed: disk full");
	expect(openIncidents(cfg)).toHaveLength(1);
});

test("the same failure on the next run dedupes: no new incident", () => {
	const cfg = tempCfg("dedup");
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "still broken" });
	watchOnce(cfg, deps(nowSec()));
	const again = watchOnce(cfg, deps(nowSec() + 60));
	expect(again.opened).toHaveLength(0);
	expect(again.deduped).toHaveLength(1);
	expect(again.deduped[0]!.count).toBe(2);
	expect(openIncidents(cfg)).toHaveLength(1);
});

test("recovery closes the open incident via dismissIncident", () => {
	const cfg = tempCfg("recover");
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "down" });
	watchOnce(cfg, deps(nowSec()));
	beat(cfg, "wip-backup", { ok: true });
	const report = watchOnce(cfg, deps(nowSec() + 60));
	expect(report.closed).toHaveLength(1);
	const res = report.closed[0]!.resolution;
	expect(res?.type).toBe("dismiss");
	expect(res && "why" in res ? res.why : "").toContain("recovered");
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("a failure after recovery opens a new incident, not a sighting", () => {
	const cfg = tempCfg("again");
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "down" });
	watchOnce(cfg, deps(nowSec()));
	beat(cfg, "wip-backup", { ok: true });
	watchOnce(cfg, deps(nowSec() + 60));
	beat(cfg, "wip-backup", { ok: false, detail: "down again" });
	const report = watchOnce(cfg, deps(nowSec() + 120));
	expect(report.opened).toHaveLength(1);
	expect(report.deduped).toHaveLength(0);
	expect(openIncidents(cfg)).toHaveLength(1);
	expect(openIncidents(cfg)[0]!.count).toBe(1);
});

test("a beat older than watch.expect[name] hours is stale", () => {
	const cfg = tempCfg("stale");
	healthy(cfg);
	const report = watchOnce(cfg, deps(nowSec() + 3 * 3600));
	expect(report.opened).toHaveLength(1);
	expect(report.opened[0]!.kind).toBe("beat-stale");
	expect(report.opened[0]!.summary).toContain("wip-snapshot");
});

test("a job with no heartbeat ever is stale only when listed in watch.expect", () => {
	const cfg = tempCfg("never");
	healthy(cfg);
	// metrics-report must never have beaten: drop the beat healthy() wrote for it. Only +1h so
	// the fresh wip-snapshot beat (real clock, expect 2h) stays healthy at this clock.
	rmSync(join(cfg.paths.queue_state, "heartbeats", "metrics-report.json"));
	// ui beats but is not listed in expect: a long-old heartbeat is not an incident.
	hbFile(cfg, { name: "ui", ok: true, detail: "", at: new Date((nowSec() - 30 * 86400) * 1000).toISOString() });
	const report = watchOnce(cfg, deps(nowSec() + 3600));
	expect(report.opened).toHaveLength(1);
	expect(report.opened[0]!.kind).toBe("beat-stale");
	expect(report.opened[0]!.summary).toContain("metrics-report");
});

test("a failed unit inside the watch.units globs opens one incident with the last error line", () => {
	const cfg = tempCfg("units");
	healthy(cfg);
	const units: FailedUnit[] = [
		{ name: "wip-backup.service", error: "Job for wip-backup.service failed: exit 1" },
		{ name: "docker.service", error: "unrelated unit must be filtered out" },
	];
	const report = watchOnce(cfg, deps(nowSec(), units));
	expect(report.opened).toHaveLength(1);
	expect(report.opened[0]!.kind).toBe("unit-failed");
	expect(report.opened[0]!.summary).toContain("wip-backup.service");
	expect(report.opened[0]!.summary).toContain("exit 1");
});

test("an ok:false heartbeat reports as failed, not also stale", () => {
	const cfg = tempCfg("precedence");
	healthy(cfg);
	hbFile(cfg, { name: "wip-snapshot", ok: false, detail: "crashed", at: new Date((nowSec() - 8 * 3600) * 1000).toISOString() });
	const report = watchOnce(cfg, deps(nowSec()));
	expect(report.opened).toHaveLength(1);
	expect(report.opened[0]!.kind).toBe("beat-failed");
});

test("a healthy system opens nothing", () => {
	const cfg = tempCfg("healthy");
	healthy(cfg);
	const report = watchOnce(cfg, deps(nowSec()));
	expect(report.opened).toHaveLength(0);
	expect(report.deduped).toHaveLength(0);
	expect(report.closed).toHaveLength(0);
	expect(report.detectors).toHaveLength(0);
	expect(openIncidents(cfg)).toHaveLength(0);
});

// P4 (plan 20261027_1430): the doctor line. Not installed and never beaten: `watch: off, last run
// never`. Installed with the watch heartbeat 5 min old: `watch: on, last run 5 min ago`.
test("watchDoctorLine prints on/off and the minutes since the last watch run", () => {
	const cfg = tempCfg("doctor");
	const now = Date.parse("2026-10-31T10:00:00Z");
	expect(watchDoctorLine(watchHealth(cfg, now, "linux"))).toBe("watch: off, last run never");
	for (const p of watchUnitPaths(cfg.paths.home, "linux")) {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, "# stub unit\n");
	}
	const hb = join(cfg.paths.queue_state, "heartbeats");
	mkdirSync(hb, { recursive: true });
	writeFileSync(join(hb, "watch.json"), JSON.stringify({ name: "watch", ok: true, detail: "", at: new Date(now - 5 * 60000).toISOString() }));
	expect(watchDoctorLine(watchHealth(cfg, now, "linux"))).toBe("watch: on, last run 5 min ago");
});

// P6b (plan 20261027_1430): CI in the loop. The forge CLI and git are a fake CommandRunner keyed
// by argv prefix: no network, no real repo. Times hang off the real clock because healthy()
// stamps its heartbeats with it.
const T = nowSec();
const ago = (hours: number): string => new Date((T - hours * 3600) * 1000).toISOString();
const CI_PLAN = { file: "20261027_1430_x.md", repo: "/work/app", text: "MR !7 is the next step" };

function forgeCli(answers: Record<string, string>): CommandRunner {
	return args => {
		const key = Object.keys(answers).find(k => args.join(" ").startsWith(k));
		return key === undefined ? { code: 1, stdout: "", stderr: `no fake for ${args.join(" ")}` } : { code: 0, stdout: answers[key]!, stderr: "" };
	};
}
function ciDeps(at: number, answers: Record<string, string>, staffed: string[] = []): WatchDeps {
	return { ...deps(at), runner: forgeCli(answers), plans: () => [CI_PLAN], staffed: () => staffed };
}
/** One GitLab pipeline row as `glab api projects/:id/pipelines` prints it. */
function glRun(id: number, ref: string, sha: string, status: string, hoursAgo: number): object {
	return { id, ref, sha, status, created_at: ago(hoursAgo) };
}
function gitlab(pipelines: object[], mrs: object[] = [], merged: object[] = []): Record<string, string> {
	return {
		"git -C /work/app remote get-url origin": "git@gitlab.example.com:g/app.git\n",
		"git -C /work/app symbolic-ref": "origin/main\n",
		"glab api projects/:id/pipelines": JSON.stringify(pipelines),
		"glab mr list -F json": JSON.stringify(mrs),
		"glab mr list --merged": JSON.stringify(merged),
	};
}
const STALE_RED = gitlab(
	[glRun(3, "feat/x", "ccc", "failed", 3), glRun(2, "feat/x", "bbb", "failed", 4), glRun(1, "main", "aaa", "success", 5)],
	[{ iid: 7, source_branch: "feat/x" }],
);

test("ci: a failed pipeline on the default branch opens one ci-red-main incident", () => {
	const cfg = tempCfg("ci-main");
	healthy(cfg);
	const answers = gitlab([glRun(2, "main", "bbb", "failed", 0.1)]);
	const first = watchOnce(cfg, ciDeps(T, answers));
	expect(first.opened.map(i => i.kind)).toEqual(["ci-red-main"]);
	const again = watchOnce(cfg, ciDeps(T + 900, answers));
	expect(again.opened).toHaveLength(0);
	expect(again.deduped).toHaveLength(1);
});

test("ci: GitHub runs feed the same default-branch check", () => {
	const cfg = tempCfg("ci-gh");
	healthy(cfg);
	const answers = {
		"git -C /work/app remote get-url origin": "git@github.com:g/app.git\n",
		"git -C /work/app symbolic-ref": "origin/main\n",
		"gh run list": JSON.stringify([{ databaseId: 9, headBranch: "main", headSha: "zzz", conclusion: "failure", status: "completed", createdAt: ago(0.1) }]),
	};
	expect(watchOnce(cfg, ciDeps(T, answers)).opened.map(i => i.kind)).toEqual(["ci-red-main"]);
});

test("ci: an open MR whose pipeline has failed longer than watch.ci_red_hours opens ci-red-mr", () => {
	const cfg = tempCfg("ci-mr");
	healthy(cfg);
	const r = watchOnce(cfg, ciDeps(T, STALE_RED));
	expect(r.opened.map(i => i.kind)).toEqual(["ci-red-mr"]);
	expect(r.opened[0]!.summary).toContain("!7");
});

test("ci: a red MR inside watch.ci_red_hours opens nothing", () => {
	const cfg = tempCfg("ci-mr-fresh");
	healthy(cfg);
	const fresh = gitlab([glRun(2, "feat/x", "bbb", "failed", 0.5)], [{ iid: 7, source_branch: "feat/x" }]);
	expect(watchOnce(cfg, ciDeps(T, fresh)).opened).toHaveLength(0);
});

test("ci: a stale red MR named by a plan with a running agent opens nothing", () => {
	const cfg = tempCfg("ci-mr-staffed");
	healthy(cfg);
	expect(watchOnce(cfg, ciDeps(T, STALE_RED, [CI_PLAN.file])).opened).toHaveLength(0);
});

test("ci: a green pipeline on the MR closes ci-red-mr", () => {
	const cfg = tempCfg("ci-mr-green");
	healthy(cfg);
	watchOnce(cfg, ciDeps(T, STALE_RED));
	const green = gitlab([glRun(4, "feat/x", "ddd", "success", 0.1)], [{ iid: 7, source_branch: "feat/x" }]);
	const r = watchOnce(cfg, ciDeps(T + 60, green));
	expect(r.closed.map(i => i.kind)).toEqual(["ci-red-mr"]);
});

test("ci: each merged MR records one M3 ci metric, once", () => {
	const cfg = tempCfg("ci-m3");
	healthy(cfg);
	cfg.metrics.ci_pipelines_cmd = "ci-count {mr}";
	const answers = { ...gitlab([glRun(1, "main", "aaa", "success", 0.1)], [], [{ iid: 5 }, { iid: 6 }]), "sh -c": "[{},{}]" };
	watchOnce(cfg, ciDeps(T, answers));
	watchOnce(cfg, ciDeps(T + 900, answers));
	const ci = readMetricEvents(cfg).filter(e => e.type === "ci");
	expect(ci.map(e => [e.mr, e.tries])).toEqual([["5", 2], ["6", 2]]);
});

test("ci: a commit that failed and then passed records one ci-flaky metric", () => {
	const cfg = tempCfg("ci-flaky");
	healthy(cfg);
	const answers = gitlab([glRun(2, "main", "sha1", "success", 0.2), glRun(1, "main", "sha1", "failed", 0.5)]);
	watchOnce(cfg, ciDeps(T, answers));
	watchOnce(cfg, ciDeps(T + 900, answers));
	expect(readMetricEvents(cfg).filter(e => e.type === "ci-flaky").map(e => e.sha)).toEqual(["sha1"]);
});
