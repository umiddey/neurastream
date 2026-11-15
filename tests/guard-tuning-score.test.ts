// Guard scoring red tests (plan 20261110_1746_rule_tuning, P9a): per guard id, fires are the
// BLOCK lines in the window that carry the id; usefulShare is (fires - bypassed) / fires, where a
// bypass is a block-then-bypass incident in the window that names the id. Pinned ids are never
// scored. Everything runs in a temp dir through cfg paths.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { addIncident } from "../src/core/incidents.ts";
import { writeLevels } from "../src/core/rule-levels.ts";
import { scoreGuards } from "../src/core/rule-tuning.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400;
const NOW = 1_760_000_000;
const ID = "tool.relative-plan";

function cfg(): Config {
	const dir = mkdtempSync(join(tmpdir(), "guard-score-"));
	DIRS.push(dir);
	mkdirSync(join(dir, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(dir, ".config/neurastream/config.yml"),
		`paths:
  home: "${dir}"
  queue_index: "${join(dir, "INDEX.md")}"
  queue_state: "${join(dir, "queue-state")}"
  guard_log: "${join(dir, "guard.log")}"
  plan_guard_log: "${join(dir, "plan-guard.log")}"
tuning:
  enabled: true
  min_fires: 3
  max_useful: 0.1
  window_days: 7
  probation_days: 7
  guards: true
  keep_off: []
`,
	);
	return loadConfig({ home: dir, env: {} });
}

/** `n` BLOCK lines one second apart from `at`; `rule` null writes a line with no id. */
function blocks(c: Config, rule: string | null, n: number, at: number): void {
	const tail = rule === null ? "" : ` rule=${rule}`;
	const lines = Array.from(
		{ length: n },
		(_, i) => `${new Date((at + i) * 1000).toISOString()} BLOCK refused: x${tail}`,
	);
	appendFileSync(c.paths.guard_log, `${lines.join("\n")}\n`);
}

/** `n` block-then-bypass incidents opened at `at`, naming `rule` when given. */
function bypass(c: Config, n: number, at: number, rule: string | undefined): void {
	for (let i = 0; i < n; i++) {
		addIncident(
			c,
			{ source: "realtime", kind: "block-then-bypass", summary: `bypass ${i}`, fingerprint: `bp:${at}:${i}`, rule },
			at,
		);
	}
}

test("fires count the in-window BLOCK lines that carry the id", () => {
	const c = cfg();
	blocks(c, ID, 4, NOW - DAY);
	blocks(c, ID, 2, NOW - 10 * DAY);
	blocks(c, null, 3, NOW - DAY);
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 4, usefulShare: 1 });
});

test("a bypassed refusal lowers the useful share: (fires - bypassed) / fires", () => {
	const c = cfg();
	blocks(c, ID, 4, NOW - DAY);
	bypass(c, 1, NOW - DAY, ID);
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 4, usefulShare: 0.75 });
});

test("a block-then-bypass incident that names no id, or another id, does not count against this id", () => {
	const c = cfg();
	blocks(c, ID, 4, NOW - DAY);
	bypass(c, 2, NOW - DAY, undefined);
	bypass(c, 1, NOW - DAY, "tool.other");
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 4, usefulShare: 1 });
});

test("a bypass outside the window does not count", () => {
	const c = cfg();
	blocks(c, ID, 3, NOW - DAY);
	bypass(c, 2, NOW - 10 * DAY, ID);
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 3, usefulShare: 1 });
});

test("every refusal bypassed gives a useful share of 0", () => {
	const c = cfg();
	blocks(c, ID, 3, NOW - DAY);
	bypass(c, 3, NOW - DAY, ID);
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 3, usefulShare: 0 });
});

test("a pinned id is never scored", () => {
	const c = cfg();
	blocks(c, "tool.protected", 5, NOW - DAY);
	expect(scoreGuards(c, NOW).find((s) => s.kind === "tool.protected")).toBeUndefined();
});

test("a rule with a level and no refusals in the window is scored at zero fires", () => {
	const c = cfg();
	const date = new Date((NOW - 10 * DAY) * 1000).toISOString().slice(0, 10);
	writeLevels(c, { rules: { [ID]: { level: "off", prev: "tell", date } } });
	expect(scoreGuards(c, NOW).find((s) => s.kind === ID)).toMatchObject({ fires: 0, usefulShare: 0 });
});
