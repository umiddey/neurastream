// P2 (plan 20261027_1430): the watcher — watchOnce folds failed/stale heartbeats, failed user
// units and the gated detectors into watch-source incidents, and closes a watch incident again
// when its problem recovers (dismissIncident). The clock, the unit lister and the detector
// gather are injected; tests touch only a temp paths.queue_state — no real home, network,
// service manager or detector inputs.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { beat, type Heartbeat } from "../src/core/heartbeat.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { nowSec } from "../src/core/clock.ts";
import { watchOnce, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function tempCfg(label: string): Config {
	const dir = mkdtempSync(join(tmpdir(), `watch-${label}-`));
	DIRS.push(dir);
	return loadConfig({ home: dir, env: {} });
}

/** Injected deps: a frozen clock, no failed units, empty detector inputs. */
function deps(at: number, units: FailedUnit[] = [], gather: () => GatedInputs = () => ({ results: [], runs: [], blocks: [] })): WatchDeps {
	return { now: () => at, listUnits: () => units, gather };
}

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
	expect(report.closed[0]!.resolution?.type).toBe("dismiss");
	expect(report.closed[0]!.resolution?.why).toContain("recovered");
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
