// P2 (plan 20261027_1430): the watcher — watchOnce folds failed/stale heartbeats, failed user
// units and the gated detectors into watch-source incidents, and closes a watch incident again
// when its problem recovers (dismissIncident). The clock, the unit lister and the detector
// gather are injected; tests touch only a temp paths.queue_state — no real home, network,
// service manager or detector inputs.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { Run, RunSource } from "../src/core/adapter.ts";
import { beat, type Heartbeat } from "../src/core/heartbeat.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { addIncident, openIncidents } from "../src/core/incidents.ts";
import { nowSec } from "../src/core/clock.ts";
import { releaseVerdicts, watchDoctorLine, watchHealth, watchOnce, watchUnitPaths, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";
import type { CommandRunner } from "../src/core/mr-sweep.ts";
import type { ReleaseTag } from "../src/core/results.ts";
import { appendMetric, readMetricEvents } from "../src/core/metrics.ts";

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

// INCIDENT I-20261031-255: the first backfill records at most MERGED_LIST (20) merged MRs per run,
// even when the forge answers with more.
test("ci: the first backfill records at most 20 merged MRs per run", () => {
	const cfg = tempCfg("ci-m3-cap");
	healthy(cfg);
	cfg.metrics.ci_pipelines_cmd = "ci-count {mr}";
	const merged = Array.from({ length: 25 }, (_, i) => ({ iid: i + 1 }));
	const answers = { ...gitlab([glRun(1, "main", "aaa", "success", 0.1)], [], merged), "sh -c": "[{},{}]" };
	watchOnce(cfg, ciDeps(T, answers));
	expect(readMetricEvents(cfg).filter(e => e.type === "ci")).toHaveLength(20);
});

// INCIDENT I-20261031-256: a CI error on one merged MR skips that MR only, the rest still record,
// and the skip is logged once per MR, not on every run.
test("ci: a CI error on one merged MR skips it, records the rest, and logs the skip once", () => {
	const cfg = tempCfg("ci-m3-skip");
	healthy(cfg);
	cfg.metrics.ci_pipelines_cmd = "ci-count {mr}";
	const base = forgeCli({ ...gitlab([glRun(1, "main", "aaa", "success", 0.1)], [], [{ iid: 5 }, { iid: 6 }]), "sh -c": "[{},{}]" });
	const runner: CommandRunner = (args, opts) => (args.some(a => a.endsWith("'5'")) ? { code: 1, stdout: "", stderr: "boom" } : base(args, opts));
	const d = { ...deps(T), runner, plans: () => [CI_PLAN] };
	watchOnce(cfg, d);
	watchOnce(cfg, { ...d, now: () => T + 900 });
	expect(readMetricEvents(cfg).filter(e => e.type === "ci").map(e => e.mr)).toEqual(["6"]);
	expect(readFileSync(cfg.paths.guard_log, "utf8").split("\n").filter(l => l.includes("ci command for !5"))).toHaveLength(1);
});

// INCIDENT I-20261031-257: the watcher's M3 run also records the repo's product numbers, as `metrics ci` does.
test("ci: the watcher's M3 run also records the repo's product numbers", () => {
	const cfg = tempCfg("ci-products");
	healthy(cfg);
	const repo = mkdtempSync(join(tmpdir(), "watch-repo-"));
	DIRS.push(repo);
	cfg.metrics.ci_pipelines_cmd = "ci-count {mr}";
	cfg.metrics.product_cmds = { [repo]: { seven: "printf '7'" } };
	const forge = { ...gitlab([glRun(1, "main", "aaa", "success", 0.1)], [], [{ iid: 5 }]), "sh -c": "[{},{}]" };
	const answers = Object.fromEntries(Object.entries(forge).map(([k, v]) => [k.replaceAll("/work/app", repo), v]));
	watchOnce(cfg, { ...deps(T), runner: forgeCli(answers), plans: () => [{ ...CI_PLAN, repo }] });
	expect(readMetricEvents(cfg).filter(e => e.type === "product").map(e => [e.name, e.value])).toEqual([["seven", 7]]);
});

// INCIDENT I-20261031-258: a ci-red-mr held back by a staffed plan is still red, so it is not
// dismissed as recovered.
test("ci: a ci-red-mr held back by a staffed plan stays open, not dismissed as recovered", () => {
	const cfg = tempCfg("ci-mr-held");
	healthy(cfg);
	expect(watchOnce(cfg, ciDeps(T, STALE_RED)).opened.map(i => i.kind)).toEqual(["ci-red-mr"]);
	const r = watchOnce(cfg, ciDeps(T + 900, STALE_RED, [CI_PLAN.file]));
	expect(r.closed).toHaveLength(0);
	expect(openIncidents(cfg).map(i => i.kind)).toContain("ci-red-mr");
});

// ---- P11: the release verdict — is the new version better or worse? ----
// Two tags two hours apart: v1.0.0's after-window is [VT, VT+2h), its before-window
// [VT-2h, VT), closed from VT+2h+60 on. v1.1.0's own window is never closed in these tests.

const VT = 2_000_000;
const VTAGS: ReleaseTag[] = [{ name: "v1.0.0", ts: VT }, { name: "v1.1.0", ts: VT + 7200 }];
const VNOW = VT + 7260;

let runNo = 0;
function mainRun(calls: number, at: number, texts: [string, string][] = []): Run {
	runNo++;
	return {
		id: `vm${runNo}`, kind: "main", model: "test", calls, tokens: 0, cacheRead: 0, cost: 0,
		inputTokens: 0, prefillTokens: 0, status: "done", statusDetail: "", startedAt: null,
		lastWriteAt: at, endedAt: null,
		messages: texts.map(([role, text]) => ({ role, cost: 0, text, ts: null })),
		scoreModel: "", scoreCost: 0, scoreHours: 0, scoreRunning: false, scoreSurvived: false, scoreEnd: "",
	};
}
const vsrc = (runs: Run[]): RunSource => ({ listRuns: () => runs, mainSession: () => null });

/** Appends `<ISO> BLOCK <reason>` lines to the guard log readBlocks parses. */
function guardBlocks(cfg: Config, at: number, n: number, reason = "stop refused: read tools only"): void {
	const iso = new Date(at * 1000).toISOString();
	const old = existsSync(cfg.paths.guard_log) ? readFileSync(cfg.paths.guard_log, "utf8") : "";
	writeFileSync(cfg.paths.guard_log, old + Array.from({ length: n }, () => `${iso} BLOCK ${reason}`).join("\n") + "\n");
}

function watchIncident(cfg: Config, fingerprint: string, at: number, kind = "unit-failed"): void {
	addIncident(cfg, { source: "watch", kind, summary: `test ${fingerprint}`, fingerprint }, at);
}

test("verdict: blocks double after a tag → WORSE and one incident", () => {
	const cfg = tempCfg("verdict-blocks");
	guardBlocks(cfg, VT - 3600, 10);
	guardBlocks(cfg, VT + 3600, 20);
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["WORSE"]);
	expect(posts).toHaveLength(1);
	expect(posts[0]).toContain("v1.0.0: WORSE");
	const open = openIncidents(cfg);
	expect(open).toHaveLength(1);
	expect(open[0]!.summary).toContain("release v1.0.0 worse:");
	expect(open[0]!.summary).toContain("2.5→5");
});

test("verdict: a downgrade version-change event alone → WORSE", () => {
	const cfg = tempCfg("verdict-downgrade");
	appendMetric(cfg, { type: "version-change", from: "1.0.1", to: "1.0.0", ts: VT + 3600 });
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["WORSE"]);
	expect(posts[0]).toContain("downgrade");
	expect(openIncidents(cfg)).toHaveLength(1);
});

test("verdict: Main's owner questions triple, corrections flat → WORSE", () => {
	const cfg = tempCfg("verdict-questions");
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, {
		now: VNOW, tags: VTAGS,
		source: vsrc([
			mainRun(400, VT - 3600, Array.from({ length: 2 }, () => ["assistant", "shall I proceed?"] as [string, string])),
			mainRun(400, VT + 3600, Array.from({ length: 6 }, () => ["assistant", "shall I proceed?"] as [string, string])),
		]),
		notify: t => posts.push(t),
	});
	expect(out.map(v => v.verdict)).toEqual(["WORSE"]);
});

test("verdict: a busy night at the same rate per 100 calls is not WORSE", () => {
	const cfg = tempCfg("verdict-busy");
	guardBlocks(cfg, VT - 3600, 10);
	guardBlocks(cfg, VT + 3600, 20);
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600), mainRun(400, VT + 4000)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["MIXED"]);
});

test("verdict: under 300 Main calls on either side → no verdict", () => {
	const cfg = tempCfg("verdict-min-calls");
	guardBlocks(cfg, VT - 3600, 10);
	guardBlocks(cfg, VT + 3600, 20);
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(100, VT - 3600), mainRun(100, VT + 3600)]), notify: t => posts.push(t) });
	expect(out).toHaveLength(0);
	expect(posts).toHaveLength(0);
	expect(readMetricEvents(cfg).filter(e => e.type === "release-verdict")).toHaveLength(0);
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("verdict: a metric with no before-events is new, not compared — not WORSE", () => {
	const cfg = tempCfg("verdict-new");
	guardBlocks(cfg, VT + 3600, 20); // no before blocks at all: the counter is new in the release
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["MIXED"]);
	expect(posts[0]).toContain("new, not compared");
	expect(openIncidents(cfg)).toHaveLength(0);
});

test("verdict: watch incidents double with nothing else changing → WORSE", () => {
	const cfg = tempCfg("verdict-m6");
	for (let i = 0; i < 2; i++) watchIncident(cfg, `watch:unit-failed:before${i}`, VT - 3600);
	for (let i = 0; i < 4; i++) watchIncident(cfg, `watch:unit-failed:after${i}`, VT + 3600);
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["WORSE"]);
	expect(posts[0]).toContain("silent");
});

test("verdict: merges per 100 calls halved, all else flat → WORSE", () => {
	const cfg = tempCfg("verdict-merges");
	for (let i = 0; i < 10; i++) appendMetric(cfg, { type: "ci", mr: `b${i}`, repo: "r", tries: 1, ts: VT - 3600 });
	for (let i = 0; i < 5; i++) appendMetric(cfg, { type: "ci", mr: `a${i}`, repo: "r", tries: 1, ts: VT + 3600 });
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["WORSE"]);
	expect(posts[0]).toContain("merges");
});

test("verdict: a watch:not-running incident open in a window → watcher off, no verdict", () => {
	const cfg = tempCfg("verdict-watcher-off");
	watchIncident(cfg, "watch:not-running", VT - 3600, "not-running");
	guardBlocks(cfg, VT - 3600, 10);
	guardBlocks(cfg, VT + 3600, 20);
	const posts: string[] = [];
	const out = releaseVerdicts(cfg, { now: VNOW, tags: VTAGS, source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), notify: t => posts.push(t) });
	expect(out.map(v => v.verdict)).toEqual(["watcher-off"]);
	expect(posts).toHaveLength(1);
	expect(openIncidents(cfg)).toHaveLength(1); // only the not-running one; no release incident
	expect(readMetricEvents(cfg).filter(e => e.type === "release-verdict")).toHaveLength(1);
});

test("verdict: a second watch run posts nothing", () => {
	const cfg = tempCfg("verdict-twice");
	healthy(cfg);
	guardBlocks(cfg, VT - 3600, 10);
	guardBlocks(cfg, VT + 3600, 20);
	const posts: string[] = [];
	const d = { ...deps(VNOW), source: vsrc([mainRun(400, VT - 3600), mainRun(400, VT + 3600)]), tags: VTAGS, notify: (t: string) => posts.push(t) };
	watchOnce(cfg, d);
	watchOnce(cfg, { ...d, now: () => VNOW + 60 });
	expect(posts).toHaveLength(1);
	expect(readMetricEvents(cfg).filter(e => e.type === "release-verdict")).toHaveLength(1);
});
