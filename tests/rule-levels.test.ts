// Rule levels file (src/core/rule-levels.ts, plan 20261110_1746 P1). Temp dir through cfg paths
// only: never the real home.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { atomicWrite, levelFor, PINNED, readLevels, writeLevels, type RuleLevels } from "../src/core/rule-levels.ts";

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function cfg(): Config {
	const home = mkdtempSync(join(tmpdir(), "ns-rule-levels-"));
	DIRS.push(home);
	const queueState = join(home, "queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	const guardLog = join(home, "guard.log");
	writeFileSync(guardLog, "sentinel\n");
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:\n  home: "${home}"\n  queue_state: "${queueState}"\n  guard_log: "${guardLog}"\n`,
	);
	return loadConfig({ home, env: {} });
}

function levelsFile(c: Config): string {
	return join(c.paths.queue_state, "rule-levels.json");
}

test("a missing file reads as empty rules and every level is block", () => {
	const c = cfg();
	expect(existsSync(levelsFile(c))).toBe(false);
	const levels = readLevels(c);
	expect(levels).toEqual({ rules: {} });
	expect(levels.corrupt).toBeUndefined();
	expect(levelFor(levels, "tool-crash")).toBe("block");
	expect(levelFor(levels, "unit-failed")).toBe("block");
});

test("pinned kinds always read as block, even when the file says off", () => {
	expect([...PINNED]).toEqual(["release-regression", "beat-failed", "beat-stale"]);
	const c = cfg();
	writeLevels(c, {
		rules: {
			"beat-failed": { level: "off", date: "2026-11-15" },
			"beat-stale": { level: "tell", date: "2026-11-15" },
			"release-regression": { level: "off", date: "2026-11-15" },
			"tool-crash": { level: "tell", date: "2026-11-15" },
		},
	});
	const levels = readLevels(c);
	expect(levelFor(levels, "beat-failed")).toBe("block");
	expect(levelFor(levels, "beat-stale")).toBe("block");
	expect(levelFor(levels, "release-regression")).toBe("block");
	expect(levelFor(levels, "tool-crash")).toBe("tell");
});

test("round-trip keeps held_until, probation, checked, date and the tuner bar", () => {
	const c = cfg();
	const written: RuleLevels = {
		date: "2026-11-14",
		checked: "2026-11-15",
		rules: {
			"tool-crash": { level: "tell", prev: "block", date: "2026-11-14", probation: true, held_until: 1_800_000_000 },
		},
		tuner: { bar: 40 },
	};
	writeLevels(c, written);
	expect(readLevels(c)).toEqual(written);
});

test("a corrupt file reads as block with corrupt set, and neither read logs", () => {
	const c = cfg();
	writeFileSync(levelsFile(c), "{ not json");
	const before = readFileSync(c.paths.guard_log, "utf8");
	const first = readLevels(c);
	const second = readLevels(c);
	expect(first).toEqual({ rules: {}, corrupt: true });
	expect(second).toEqual({ rules: {}, corrupt: true });
	expect(levelFor(first, "tool-crash")).toBe("block");
	expect(levelFor(second, "unit-failed")).toBe("block");
	expect(readFileSync(c.paths.guard_log, "utf8")).toBe(before);
	// the bad file is left alone: a later step must not treat it as empty
	expect(readFileSync(levelsFile(c), "utf8")).toBe("{ not json");
});

test("an inherited constructor or __proto__ is block, never the prototype value", () => {
	const levels = readLevels(cfg());
	expect(levelFor(levels, "constructor")).toBe("block");
	expect(levelFor(levels, "__proto__")).toBe("block");
	const inherited = { rules: Object.create({ constructor: { level: "off", date: "2026-11-15" } }) } as RuleLevels;
	expect(levelFor(inherited, "constructor")).toBe("block");
});

test("writeLevels drops the in-memory corrupt flag and atomicWrite leaves no tmp file", () => {
	const c = cfg();
	writeLevels(c, { rules: {}, corrupt: true });
	const text = readFileSync(levelsFile(c), "utf8");
	expect(text).not.toContain("corrupt");
	expect(readLevels(c).corrupt).toBeUndefined();
	const path = join(c.paths.queue_state, "note.json");
	atomicWrite(path, "{\"ok\":true}\n");
	expect(readFileSync(path, "utf8")).toBe("{\"ok\":true}\n");
	expect(readdirSync(c.paths.queue_state).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
