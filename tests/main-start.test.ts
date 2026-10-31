// P4 (plan 20261027_1430): the main-start preflight reports the watch timer. With the watch
// installed and its "watch" heartbeat fresh it prints `watch: last run N min ago`; with the
// heartbeat older than 3 × watch.interval_min (or missing) it prints `watch: NOT RUNNING since
// <time>` and opens one watch incident. Sandbox HOME only; stub bins stand in for the helpers.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { openIncidents } from "../src/core/incidents.ts";
import { mainStartText } from "../src/core/main-start.ts";
import { watchUnitPaths } from "../src/core/watch.ts";

const DIRS: string[] = [];
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }); });

function stubBins(home: string): void {
	const bindir = join(home, ".local/bin");
	mkdirSync(bindir, { recursive: true });
	const stubs: Record<string, string> = {
		"machine-guard": "#!/bin/sh\necho MG_STUB_LINE\n",
		"agent-ledger": "#!/bin/sh\nexit 0\n",
		"main-health": "#!/bin/sh\nexit 0\n",
		"queue-check": "#!/bin/sh\nexit 0\n",
	};
	for (const [name, body] of Object.entries(stubs)) {
		writeFileSync(join(bindir, name), body);
		chmodSync(join(bindir, name), 0o755);
	}
}

/** A sandbox home with the stub bins and, when `installed`, the watch units on this platform. */
function sandbox(label: string, installed: boolean): { home: string; cfg: Config } {
	const home = mkdtempSync(join(tmpdir(), `mainstart-${label}-`));
	DIRS.push(home);
	stubBins(home);
	if (installed) {
		for (const p of watchUnitPaths(home)) {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, "# stub unit\n");
		}
	}
	return { home, cfg: loadConfig({ home, env: {} }) };
}

/** Writes the "watch" heartbeat with an explicit timestamp. */
function watchBeat(cfg: Config, at: string): void {
	const dir = join(cfg.paths.queue_state, "heartbeats");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "watch.json"), JSON.stringify({ name: "watch", ok: true, detail: "", at }));
}

test("a stale watch heartbeat prints NOT RUNNING and opens one watch incident", async () => {
	const { cfg } = sandbox("stale", true);
	// Default interval is 15 min, so 3 × 15 = 45 min; a 2 h old beat is stale.
	const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
	watchBeat(cfg, stale);
	const lines = (await mainStartText([], cfg, { inheritStdin: false })).split("\n");
	expect(lines).toContain(`watch: NOT RUNNING since ${stale}`);
	const open = openIncidents(cfg).filter(i => i.fingerprint === "watch:not-running");
	expect(open).toHaveLength(1);
	expect(open[0]!.source).toBe("watch");
});

test("a fresh watch heartbeat prints the healthy last-run line and no incident", async () => {
	const { cfg } = sandbox("fresh", true);
	watchBeat(cfg, new Date().toISOString());
	const lines = (await mainStartText([], cfg, { inheritStdin: false })).split("\n");
	expect(lines).toContain("watch: last run 0 min ago");
	expect(lines.some(l => l.includes("NOT RUNNING"))).toBe(false);
	expect(openIncidents(cfg).some(i => i.fingerprint === "watch:not-running")).toBe(false);
});

test("with no watch installed the preflight says nothing about the watch", async () => {
	const { cfg } = sandbox("off", false);
	const text = await mainStartText([], cfg, { inheritStdin: false });
	// The doctor section runs `neurastream doctor`, which always prints its own watch line; only the
	// main-start health lines (last run / NOT RUNNING) must be absent when nothing is installed.
	expect(text).not.toMatch(/^watch: (last run|NOT RUNNING)/m);
});
