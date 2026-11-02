import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { nowSec, strftime } from "../src/core/clock.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { wipAlerts } from "../src/core/wip-alerts.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3600;

function sandbox(name: string): Config {
	const home = mkdtempSync(join(tmpdir(), name));
	DIRS.push(home);
	const cfg = loadConfig({ home, env: {} });
	cfg.paths.alert_state = join(home, "alerts");
	cfg.paths.queue_state = join(home, "queue");
	cfg.wip.backup_url = "git@github.com:owner/backup.git";
	mkdirSync(cfg.paths.alert_state, { recursive: true });
	return cfg;
}

function writeLast(cfg: Config, last: unknown): void {
	writeFileSync(join(cfg.paths.alert_state, "wip-last.json"), JSON.stringify(last));
}

function readLast(cfg: Config): { snapshot?: { notified?: string }; backup?: { notified?: string } } {
	return JSON.parse(readFileSync(join(cfg.paths.alert_state, "wip-last.json"), "utf8")) as {
		snapshot?: { notified?: string };
		backup?: { notified?: string };
	};
}

test("a failed snapshot prints its first failure, opens one incident and posts once", () => {
	const cfg = sandbox("wip-alerts-failed-");
	const at = nowSec() - 60;
	const failure = "FAILED: /home/u/Work/demo: git status --porcelain: boom";
	writeLast(cfg, { snapshot: { kind: "snapshot", at, ok: false, failed: [failure], refused: null } });

	const posts: string[] = [];
	const lines = wipAlerts(cfg, { notify: (t) => posts.push(t), now: nowSec() });
	expect(lines).toEqual([`wip: snapshot failed at ${strftime(at, "%Y-%m-%d %H:%M")}: ${failure}`]);
	expect(posts).toEqual(lines);
	const open = openIncidents(cfg).filter((i) => i.kind === "wip-snapshot-failed");
	expect(open).toHaveLength(1);
	expect(open[0]!.fingerprint).toBe(`wip-snapshot-failed:${failure}`);
	expect(readLast(cfg).snapshot?.notified).toBe(`wip-snapshot-failed:${failure}`);

	// the same state on the next main start: still one incident, and no second post
	const again: string[] = [];
	expect(wipAlerts(cfg, { notify: (t) => again.push(t), now: nowSec() })).toHaveLength(1);
	expect(again).toEqual([]);
	const open2 = openIncidents(cfg).filter((i) => i.kind === "wip-snapshot-failed");
	expect(open2).toHaveLength(1);
	expect(open2[0]!.count).toBe(2);
});

test("a refused backup prints the reason and posts how to fix it", () => {
	const cfg = sandbox("wip-alerts-refused-");
	const reason = "git@github.com:owner/backup.git is public";
	writeLast(cfg, {
		backup: { kind: "backup", at: nowSec() - 60, ok: false, failed: [], refused: reason },
	});

	const posts: string[] = [];
	const lines = wipAlerts(cfg, { notify: (t) => posts.push(t), now: nowSec() });
	expect(lines).toEqual([`wip: backup refused: ${reason}`]);
	expect(posts).toEqual([`Backup stopped: ${reason}. Make it private; nothing was uploaded.`]);
	const open = openIncidents(cfg).filter((i) => i.kind === "wip-backup-refused");
	expect(open).toHaveLength(1);
	expect(open[0]!.fingerprint).toBe(`wip-backup-refused:${cfg.wip.backup_url}`);
});

test("a stale snapshot and a stale backup print their hours, and a fresh pair prints nothing", () => {
	const cfg = sandbox("wip-alerts-stale-");
	writeLast(cfg, {
		snapshot: { kind: "snapshot", at: nowSec() - 4 * HOUR, ok: true, failed: [], refused: null },
		backup: { kind: "backup", at: nowSec() - 31 * HOUR, ok: true, failed: [], refused: null },
	});
	const posts: string[] = [];
	const lines = wipAlerts(cfg, { notify: (t) => posts.push(t), now: nowSec() });
	expect(lines).toEqual(["wip: no snapshot for 4 h", "wip: no backup for 31 h"]);
	expect(posts).toEqual(lines);
	expect(openIncidents(cfg).filter((i) => i.kind === "wip-stale")).toHaveLength(2);

	const fresh = sandbox("wip-alerts-healthy-");
	writeLast(fresh, {
		snapshot: { kind: "snapshot", at: nowSec() - 600, ok: true, failed: [], refused: null },
		backup: { kind: "backup", at: nowSec() - HOUR, ok: true, failed: [], refused: null },
	});
	const none: string[] = [];
	expect(wipAlerts(fresh, { notify: (t) => none.push(t), now: nowSec() })).toEqual([]);
	expect(none).toEqual([]);
	expect(openIncidents(fresh)).toEqual([]);
});

test("a recovered run clears the announced state, so the next failure posts again", () => {
	const cfg = sandbox("wip-alerts-recover-");
	const at = nowSec() - 60;
	writeLast(cfg, {
		snapshot: { kind: "snapshot", at, ok: false, failed: ["FAILED: /x: git add -u: boom"], refused: null },
	});
	wipAlerts(cfg, { notify: () => {}, now: nowSec() });
	writeLast(cfg, {
		snapshot: { kind: "snapshot", at: nowSec(), ok: true, failed: [], refused: null, notified: "wip-snapshot-failed:FAILED: /x: git add -u: boom" },
	});
	expect(wipAlerts(cfg, { notify: () => {}, now: nowSec() })).toEqual([]);
	expect(readLast(cfg).snapshot?.notified).toBe("");
});
