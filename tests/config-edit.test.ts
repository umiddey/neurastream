// The generic config editor (plan 20261028_2356 P1): setConfigKeys edits dotted keys of config.yml
// line by line and keeps every other line byte-for-byte; checkEdited proves an edit still loads
// before anything is written, through a scratch dir it removes again. Temp dirs only.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/core/config.ts";
import { checkEdited, setConfigKeys } from "../src/core/config-edit.ts";

const TMP = mkdtempSync(join(tmpdir(), "config-edit-"));
const HOME = join(TMP, "home");
mkdirSync(HOME, { recursive: true });

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

test("null text creates the section with the key", () => {
	expect(setConfigKeys(null, { "ui.enabled": "true" })).toBe("ui:\n  enabled: true\n");
});

test("an existing key is replaced; comments, order and every other line survive byte-for-byte", () => {
	const before = [
		"# my config",
		"paths:",
		'  home: "~"   # keep me',
		"",
		"ui:",
		"  enabled: false  # toggled",
		"  port: 7788",
		"harness: omp",
		"",
	].join("\n");
	const after = setConfigKeys(before, { "ui.enabled": "true" });
	expect(after).toBe(before.replace("  enabled: false  # toggled", "  enabled: true  # toggled"));
});

test("a missing nested key is added at the block's indent", () => {
	expect(setConfigKeys("ui:\n  port: 7788\n", { "ui.owner_login": "a@b.c" })).toBe("ui:\n  port: 7788\n  owner_login: a@b.c\n");
});

test("a missing section is appended at the end of the file", () => {
	expect(setConfigKeys("harness: omp\n", { "ui.enabled": "true" })).toBe("harness: omp\nui:\n  enabled: true\n");
});

test("a deep key changes only its own line, not a same-named key in another block", () => {
	const before = "incidents:\n  daily_floor:\n    m1: 1\n  other:\n    m1: 2\n";
	expect(setConfigKeys(before, { "incidents.daily_floor.m1": "5" })).toBe(
		"incidents:\n  daily_floor:\n    m1: 5\n  other:\n    m1: 2\n",
	);
});

test("a top-level scalar such as harness is replaced in place", () => {
	expect(setConfigKeys("ui:\n  enabled: true\nharness: omp\n", { harness: "claude" })).toBe(
		"ui:\n  enabled: true\nharness: claude\n",
	);
});

test("a value with a newline is refused, so no extra key can be injected", () => {
	expect(() => setConfigKeys("ui:\n  port: 7788\n", { "ui.owner_login": "a@b.c\nevil: 1" })).toThrow(ConfigError);
	expect(() => setConfigKeys("ui:\n  port: 7788\n", { "ui.owner_login": "a\rb" })).toThrow(ConfigError);
});

test("checkEdited accepts a loadable config and leaves no scratch dir behind", () => {
	const before = readdirSync(tmpdir()).filter(name => name.startsWith("neurastream-check-"));
	const errors: string[] = [];
	expect(checkEdited("ui:\n  enabled: true\n", HOME, line => errors.push(line))).toBe(true);
	expect(errors).toEqual([]);
	const after = readdirSync(tmpdir()).filter(name => name.startsWith("neurastream-check-"));
	expect(after).toEqual(before);
});

test("checkEdited refuses a config that does not load and reports why", () => {
	const errors: string[] = [];
	expect(checkEdited("ui: [\n", HOME, line => errors.push(line))).toBe(false);
	expect(errors.length).toBe(1);
});

test("checkEdited never writes through a planted symlink at the old predictable scratch path", () => {
	const victim = join(TMP, "victim.txt");
	writeFileSync(victim, "keep me");
	const planted = join(tmpdir(), `neurastream-ui-on-check-${process.pid}.yml`);
	rmSync(planted, { force: true });
	symlinkSync(victim, planted);
	try {
		expect(checkEdited("ui:\n  enabled: true\n", HOME, () => {})).toBe(true);
		expect(readFileSync(victim, "utf8")).toBe("keep me");
	} finally {
		rmSync(planted, { force: true });
	}
	expect(existsSync(victim)).toBe(true);
});
