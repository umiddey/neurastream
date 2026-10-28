import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWrite, type WriteCheckConfig, type WriteCheckResult } from "../src/core/write-check.ts";

const FAKE = join(import.meta.dir, "fixtures/write-check/fake-linter.ts");
const TAIL = "The file was restored to its state before this edit; fix it and edit again — do not add suppression comments.";

function wc(over: Partial<WriteCheckConfig> = {}): WriteCheckConfig {
	return {
		enabled: true,
		applies_to: "all",
		timeout_ms: 5000,
		suppress: "noqa|@ts-ignore|eslint-disable",
		linters: [{ ext: [".ts"], argv: [process.execPath, FAKE, "{file}"], pattern: "^.+?:\\d+:\\d+: (?<rule>\\S+) " }],
		...over,
	};
}

// The adapter calls checkWrite after the edit landed, so `after` is written to disk first.
function run(before: string | null, after: string | null, over: Partial<WriteCheckConfig> = {}, name = "a.ts"): WriteCheckResult {
	const file = join(mkdtempSync(join(tmpdir(), "neurastream-wc-")), name);
	if (after !== null) writeFileSync(file, after);
	return checkWrite(file, before, after, wc(over));
}

describe("checkWrite", () => {
	test("refuses an edit that adds a lint finding", () => {
		const r = run("const a = 1\n", "const a = 1 // lint:E101\n");
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason).toContain("E101 (+1)");
		expect(r.reason.endsWith(TAIL)).toBe(true);
	});

	test("allows an edit that keeps the finding count", () => {
		expect(run("x // lint:E101\n", "y // lint:E101\n")).toEqual({ allow: true });
	});

	test("refuses a new suppression comment", () => {
		const r = run("const a = 1\n", "const a = 1 // @ts-ignore\n");
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason).toContain("suppression (+1)");
	});

	test("allows an old suppression comment that stays", () => {
		expect(run("// @ts-ignore\nconst a = 1\n", "// @ts-ignore\nconst a = 2\n")).toEqual({ allow: true });
	});

	test("allows with a note when the linter binary is missing", () => {
		const r = run("a\n", "lint:E1\n", { linters: [{ ext: [".ts"], argv: ["no-such-linter-xyz", "{file}"], pattern: "^(?<rule>x)" }] });
		expect(r.allow).toBe(true);
		if (!r.allow) return;
		expect(r.note).toContain("no-such-linter-xyz");
	});

	test("allows with a note when the linter times out", () => {
		const r = run("a\n", "hang-lint\n", { timeout_ms: 300 });
		expect(r.allow).toBe(true);
		if (!r.allow) return;
		expect(r.note).toBeDefined();
	});

	test("allows a deleted file", () => {
		expect(run("lint:E1\n", null)).toEqual({ allow: true });
	});

	test("allows a file with no linter for its extension", () => {
		expect(run("a\n", "lint:E1\n", {}, "a.md")).toEqual({ allow: true });
	});

	test("refuses a new file with a finding", () => {
		expect(run(null, "lint:E1\n").allow).toBe(false);
	});

	test("caps the reason at 2000 characters and keeps the tail", () => {
		const many = Array.from({ length: 300 }, (_, i) => `lint:R${i}`).join("\n") + "\n";
		const r = run("\n", many);
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason.length).toBeLessThanOrEqual(2000);
		expect(r.reason.endsWith(TAIL)).toBe(true);
	});

	test("leaves no scratch file behind", () => {
		const d = mkdtempSync(join(tmpdir(), "neurastream-wc-"));
		const file = join(d, "a.ts");
		writeFileSync(file, "lint:E1\nlint:E2 lint:E3\n");
		checkWrite(file, "lint:E1\nlint:E2\n", "lint:E1\nlint:E2 lint:E3\n", wc());
		expect(readdirSync(d)).toEqual(["a.ts"]);
	});
});
