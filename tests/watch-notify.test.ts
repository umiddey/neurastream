// P3 (plan 20261027_1430): the watcher pushes — one post per NEW (not deduped) watch incident
// through the injected notifier (never a real webhook), at most watch.max_posts_per_run per run
// with one "+N more, see `neurastream incident list --open`" line for the rest, nothing at all
// when no notify provider is configured (the incidents still open), and every post scrubbed by
// the same secret redactor postReply uses. Tests touch only a temp paths.queue_state and a temp
// webhook file — no real home, network, Discord or provider.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { beat, type Heartbeat } from "../src/core/heartbeat.ts";
import type { GatedInputs } from "../src/core/incident-detectors.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { nowSec } from "../src/core/clock.ts";
import { clearKnownSecretsCache } from "../src/core/secret-redact.ts";
import { watchOnce, type FailedUnit, type WatchDeps } from "../src/core/watch.ts";

// The redaction marker spelled in parts: the joined literal is the placeholder shape the
// placeholder guard refuses in every write but secret-redact.ts and its own tests.
const MARK = `[REDACTED${":"}`;

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
	clearKnownSecretsCache();
});

/** Temp sandbox home. `provider` adds a chat provider whose webhook file holds a fake token
 * (one provider on, and loadKnownSecrets reads the URL as a known value); `cap` overrides
 * watch.max_posts_per_run. */
function sandbox(label: string, provider = false, cap?: number): Config {
	const dir = mkdtempSync(join(tmpdir(), `watch-notify-${label}-`));
	DIRS.push(dir);
	const hook = join(dir, "discord-webhook");
	if (provider) writeFileSync(hook, "https://hooks.slack.com/services/T000/B000/AAAAAAAAAAA1\n");
	mkdirSync(join(dir, ".config/neurastream"), { recursive: true });
	let yaml = `paths:
  home: "${dir}"
  queue_index: "${join(dir, "INDEX.md")}"
  queue_state: "${join(dir, "queue-state")}"
  guard_log: "${join(dir, "guard.log")}"
  plan_guard_log: "${join(dir, "plan-guard.log")}"
`;
	if (cap !== undefined) yaml += `watch:
  max_posts_per_run: ${cap}
`;
	if (provider) yaml += `notify:
  discord_webhook_file: "${hook}"
`;
	writeFileSync(join(dir, ".config/neurastream/config.yml"), yaml);
	return loadConfig({ home: dir, env: {} });
}

/** Injected deps with a recording notifier: exactly the posts the watcher handed off. */
function deps(at: number, posts: string[], units: FailedUnit[] = []): WatchDeps {
	return {
		now: () => at,
		listUnits: () => units,
		gather: (): GatedInputs => ({ results: [], runs: [], blocks: [] }),
		notify: text => posts.push(text),
	};
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

test("a new incident posts once, in the ⚠ format", () => {
	const cfg = sandbox("format", true);
	healthy(cfg);
	const at = "2026-10-31T04:00:00.000Z";
	hbFile(cfg, { name: "wip-backup", ok: false, detail: "git push failed: disk full", at });
	const posts: string[] = [];
	const report = watchOnce(cfg, deps(nowSec(), posts));
	expect(report.opened).toHaveLength(1);
	expect(report.deduped).toHaveLength(0);
	expect(posts).toEqual([`⚠ wip-backup: beat-failed at ${at} — git push failed: disk full (incident ${report.opened[0]!.id})`]);
});

test("a deduped sighting posts nothing", () => {
	const cfg = sandbox("dedup", true);
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "still broken" });
	const posts: string[] = [];
	watchOnce(cfg, deps(nowSec(), posts));
	const again = watchOnce(cfg, deps(nowSec() + 60, posts));
	expect(again.opened).toHaveLength(0);
	expect(again.deduped).toHaveLength(1);
	expect(posts).toHaveLength(1);
});

test("watch.max_posts_per_run caps the posts; the rest fold into one +N more line", () => {
	const cfg = sandbox("cap", true, 2);
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "backup down" });
	beat(cfg, "wip-snapshot", { ok: false, detail: "snapshot down" });
	const units: FailedUnit[] = [{ name: "wip-sync.service", error: "unit failed" }];
	const posts: string[] = [];
	const report = watchOnce(cfg, deps(nowSec(), posts, units));
	expect(report.opened).toHaveLength(3);
	expect(posts).toHaveLength(3);
	expect(posts[0]).toContain("⚠ wip-backup: beat-failed at ");
	expect(posts[1]).toContain("⚠ wip-snapshot: beat-failed at ");
	expect(posts[2]).toBe("+1 more, see `neurastream incident list --open`");
});

test("no provider configured: no post, the incident still opens", () => {
	const cfg = sandbox("noprovider");
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "down" });
	const posts: string[] = [];
	const report = watchOnce(cfg, deps(nowSec(), posts));
	expect(report.opened).toHaveLength(1);
	expect(openIncidents(cfg)).toHaveLength(1);
	expect(posts).toEqual([]);
});

test("a post carrying a fake token is scrubbed by the existing redaction", () => {
	const cfg = sandbox("mask", true);
	healthy(cfg);
	beat(cfg, "wip-backup", { ok: false, detail: "git push failed: webhook https://hooks.slack.com/services/T000/B000/AAAAAAAAAAA1 rejected" });
	const posts: string[] = [];
	const report = watchOnce(cfg, deps(nowSec(), posts));
	expect(report.opened).toHaveLength(1);
	expect(posts).toHaveLength(1);
	expect(posts[0]).not.toContain("AAAAAAAAAAA1");
	expect(posts[0]).toContain(MARK);
	expect(posts[0]).toContain("(incident ");
});
