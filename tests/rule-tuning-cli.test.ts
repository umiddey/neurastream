// Rules printer (plan 20261110_1746 P4b): `neurastream rules`. Temp home only.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesLines, runRules } from "../src/cli/rules.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { writeLevels } from "../src/core/rule-levels.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function home(): { dir: string; c: Config } {
	const dir = mkdtempSync(join(tmpdir(), "rule-tuning-cli-"));
	DIRS.push(dir);
	return { dir, c: loadConfig({ home: dir, env: {} }) };
}

test("every rule is printed once, with its level", () => {
	const { c } = home();
	writeLevels(c, {
		rules: {
			"block-loop": { level: "tell", prev: "block", date: "2026-11-01" },
			"custom-kind": { level: "off", prev: "tell", date: "2026-11-02" },
		},
	});
	const lines = rulesLines(c);
	for (const id of ["block-loop", "custom-kind", "owner-correction", "release-regression"]) {
		expect(lines.filter(l => l.split(/\s+/)[0] === id)).toHaveLength(1);
	}
	expect(lines.find(l => l.startsWith("block-loop"))).toContain("tell");
	expect(lines.find(l => l.startsWith("custom-kind"))).toContain("off");
});

test("held_until is shown only on the rules that have it", () => {
	const { c } = home();
	writeLevels(c, {
		rules: { "block-loop": { level: "tell", prev: "block", date: "2026-11-01", held_until: 1_760_604_800 } },
	});
	const lines = rulesLines(c);
	expect(lines.find(l => l.startsWith("block-loop"))).toContain("held_until=1760604800");
	expect(lines.find(l => l.startsWith("owner-correction"))).not.toContain("held_until");
});

test("a corrupt levels file reads as block, and the run logs exactly one guard line", () => {
	const { dir, c } = home();
	mkdirSync(c.paths.queue_state, { recursive: true });
	writeFileSync(join(c.paths.queue_state, "rule-levels.json"), "{");
	expect(rulesLines(c).find(l => l.startsWith("block-loop"))).toContain("block");
	// runRules reads process.env; another file's applyQueueEnv may have left MAIN_GUARD_LOG/QUEUE_STATE set.
	const saved = { MAIN_GUARD_LOG: process.env.MAIN_GUARD_LOG, QUEUE_STATE: process.env.QUEUE_STATE };
	process.env.MAIN_GUARD_LOG = c.paths.guard_log;
	process.env.QUEUE_STATE = c.paths.queue_state;
	try {
		expect(runRules([], { home: dir })).toBe(0);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	const logged = readFileSync(c.paths.guard_log, "utf8").split("\n").filter(l => l.includes("rule-levels"));
	expect(logged).toHaveLength(1);
});

test("arguments are refused with the usage exit code", () => {
	const { dir } = home();
	expect(runRules(["bogus"], { home: dir })).toBe(2);
});
