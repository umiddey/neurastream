// Live recheck: a `WAITING on owner:` line's own `— still true if: `<cmd>`` decides whether the hold
// is still real. The runner is always injected here: these tests never run a plan's command.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { readIncidents } from "../src/core/incidents.ts";
import { parsePlan, type Plan } from "../src/core/queue/lib.ts";
import { recheckHolds } from "../src/core/waiting-check.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-waitcheck-"));
const HOME = join(TMP, "home");
const REPO = join(TMP, "repo");
const PLANS = join(REPO, "docs/plans");
mkdirSync(PLANS, { recursive: true });
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: REPO });
// Template paths are "~"-based, so a sandbox home keeps every file (incidents.jsonl included) inside TMP.
const cfg: Config = loadConfig({ home: HOME, env: {} });
const TTL = cfg.queue.waiting_check_ttl_sec;
const NOW = 1_800_000_000;

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function plan(name: string, check: string | null): Plan {
	const line = check === null ? "hold until the owner says go" : `hold until the owner says go — still true if: \`${check}\``;
	const file = join(PLANS, name);
	writeFileSync(file, `# Toy\n\n## Progress\nStatus: open\nWAITING on owner: ${line}\n`);
	return parsePlan(REPO, file, `# Toy\n\n## Progress\nStatus: open\nWAITING on owner: ${line}\n`);
}

function recorder(code: number | null): { calls: { cmd: string; cwd: string }[]; run: (cmd: string, cwd: string) => { code: number | null } } {
	const calls: { cmd: string; cwd: string }[] = [];
	return {
		calls,
		run: (cmd, cwd) => {
			calls.push({ cmd, cwd });
			return { code };
		},
	};
}

/** Open stale-hold incidents naming this plan (the store is shared by every test). */
function staleIncidents(file: string) {
	return readIncidents(cfg).filter(i => i.kind === "stale-hold" && !i.resolution && i.summary.includes(file));
}

test("exit 0 holds: the card stays and no incident opens", () => {
	const p = plan("20261027_0001_ok.md", "gateforge obligations --blocking");
	const r = recorder(0);
	const out = recheckHolds(cfg, [p], r.run, NOW);
	expect(out).toHaveLength(1);
	expect(out[0]).toMatchObject({ plan: p.file, state: "holds", code: 0 });
	expect(out[0]!.ms).toBeGreaterThanOrEqual(0);
	expect(r.calls).toEqual([{ cmd: "gateforge obligations --blocking", cwd: REPO }]);
	expect(staleIncidents(p.file)).toHaveLength(0);
});

test("exit 1 is stale: one stale-hold incident naming the plan and the command, deduped on a second sighting", () => {
	const p = plan("20261027_0002_stale.md", "bun test tests/gone.test.ts");
	const r = recorder(1);
	const first = recheckHolds(cfg, [p], r.run, NOW);
	expect(first[0]).toMatchObject({ plan: p.file, state: "stale", code: 1 });
	const open = staleIncidents(p.file);
	expect(open).toHaveLength(1);
	expect(open[0]!.summary).toContain(p.file);
	expect(open[0]!.summary).toContain("bun test tests/gone.test.ts");
	expect(open[0]!.count).toBe(1);

	// After the TTL the command runs again and the same open incident is updated, not duplicated.
	const again = recheckHolds(cfg, [p], r.run, NOW + TTL + 1);
	expect(again[0]!.state).toBe("stale");
	expect(staleIncidents(p.file)).toHaveLength(1);
	expect(staleIncidents(p.file)[0]!.count).toBe(2);
});

test("a timeout is unknown: the card stays and no incident opens", () => {
	const p = plan("20261027_0003_slow.md", "sleep 600");
	const r = recorder(null);
	const out = recheckHolds(cfg, [p], r.run, NOW);
	expect(out[0]).toMatchObject({ plan: p.file, state: "unknown", code: null });
	expect(staleIncidents(p.file)).toHaveLength(0);
});

test("a cached result skips the runner inside the TTL, and a changed plan file or an expired TTL runs it again", () => {
	const p = plan("20261027_0004_cached.md", "bun test");
	const r = recorder(0);
	recheckHolds(cfg, [p], r.run, NOW);
	expect(r.calls).toHaveLength(1);
	const hit = recheckHolds(cfg, [p], r.run, NOW + TTL - 1);
	expect(r.calls).toHaveLength(1);
	expect(hit[0]).toMatchObject({ plan: p.file, state: "holds", code: 0 });

	// A new plan-file mtime is a new input: the command runs again even inside the TTL.
	utimesSync(p.file, new Date("2026-10-29T10:00:00Z"), new Date("2026-10-29T10:00:00Z"));
	recheckHolds(cfg, [p], r.run, NOW + TTL - 1);
	expect(r.calls).toHaveLength(2);

	recheckHolds(cfg, [p], r.run, NOW + 2 * TTL + 1);
	expect(r.calls).toHaveLength(3);
});

test("a plan without a check, or not open and waiting, is not run at all", () => {
	const noCheck = plan("20261027_0005_plain.md", null);
	const r = recorder(0);
	expect(recheckHolds(cfg, [noCheck], r.run, NOW)).toEqual([]);
	expect(r.calls).toHaveLength(0);
});
