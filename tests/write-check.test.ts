import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.ts";
import { checkWrite, deferSteer, type WriteCheckConfig, type WriteCheckResult } from "../src/core/write-check.ts";

test("the template's suppress regex needs a comment marker (I-20261028-113)", () => {
	// Probes are assembled from pieces: this file must not hold text the suppress regex counts.
	const { suppress } = loadConfig({ file: "/tmp/neurastream-home-wc/missing.yml", home: "/tmp/neurastream-home-wc", env: {} }).write_check;
	const rx = new RegExp(suppress);
	expect(rx.test(`x = 1  # ${"no"}${"qa"}: E501`)).toBe(true);
	expect(rx.test(`// ${"@ts-"}${"ignore"}`)).toBe(true);
	expect(rx.test(`const s = "${"no"}${"qa"}"`)).toBe(false);
});

test("template linter patterns capture the finding message (I-20261028-150)", () => {
	const { linters } = loadConfig({ file: "/tmp/neurastream-home-wc/missing.yml", home: "/tmp/neurastream-home-wc", env: {} }).write_check;
	for (const l of linters) expect(l.pattern).toContain("(?<message>");
});

test("the template ships the deferred rules (I-20261028-166)", () => {
	const { defer_rules } = loadConfig({ file: "/tmp/neurastream-home-wc/missing.yml", home: "/tmp/neurastream-home-wc", env: {} }).write_check;
	expect(defer_rules).toEqual(["no-unused-vars", "F401", "F841"]);
});

const FAKE = join(import.meta.dir, "fixtures/write-check/fake-linter.ts");
const TAIL = "The file was restored to its state before this edit; fix it and edit again — do not add suppression comments.";

function wc(over: Partial<WriteCheckConfig> = {}): WriteCheckConfig {
	return {
		enabled: true,
		applies_to: "all",
		timeout_ms: 5000,
		suppress: "noqa|@ts-ignore|eslint-disable",
		defer_rules: [],
		linters: [{ ext: [".ts"], argv: [process.execPath, FAKE, "{file}"], pattern: "^.+?:\\d+:\\d+: (?<rule>\\S+) (?<message>.+)$" }],
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

	test("allows an edit that only shifts old warnings and adds none (I-20261028-150)", () => {
		const before = "const a = 1 // lint:E101: first debt\nconst b = 2 // lint:E101: second debt\n";
		const after = `// a new comment above\n${before}`;
		expect(run(before, after)).toEqual({ allow: true });
	});

	test("names only the new finding when the rule already had debt (I-20261028-150)", () => {
		const r = run(
			"const a = 1 // lint:E101: old debt\n",
			"const a = 1 // lint:E101: old debt\nconst b = 2 // lint:E101: new debt\n",
		);
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason).toContain("new debt");
		expect(r.reason).not.toContain("old debt");
	});

	test("an edit adding a finding under a deferred rule is allowed with a note naming it (I-20261028-166)", () => {
		const r = run("const a = 1\n", "const a = 1\nlint:F401: unused helper\n", { defer_rules: ["F401"] });
		expect(r.allow).toBe(true);
		if (!r.allow) return;
		expect(r.note).toContain("F401");
		expect(r.note).toContain("unused helper");
	});

	test("a deferred finding does not hide a real one from the refusal (I-20261028-166)", () => {
		const r = run("const a = 1\n", "lint:E101 real\nlint:F401 unused\n", { defer_rules: ["F401"] });
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason).toContain("E101");
		expect(r.reason).not.toContain("F401");
	});

	test("an empty defer_rules list refuses as before (I-20261028-166)", () => {
		expect(run("a\n", "lint:F401 unused\n", { defer_rules: [] }).allow).toBe(false);
	});

	test("a pattern without a message group keeps counting per rule", () => {
		const r = run("x\n", "a // lint:E101\nb // lint:E101\n", {
			linters: [{ ext: [".ts"], argv: [process.execPath, FAKE, "{file}"], pattern: "^.+?:\\d+:\\d+: (?<rule>\\S+) " }],
		});
		expect(r.allow).toBe(false);
		if (r.allow) return;
		expect(r.reason).toContain("E101 (+2)");
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

describe("deferSteer", () => {
	test("lists deferred findings still present at turn end (I-20261028-166)", () => {
		const d = mkdtempSync(join(tmpdir(), "neurastream-wc-"));
		const file = join(d, "a.ts");
		const before = "const a = 1\n";
		const after = "const a = 1\nlint:F401: unused helper\n";
		writeFileSync(file, after);
		const s = deferSteer(file, before, after, wc({ defer_rules: ["F401"] }));
		expect(s).toContain("F401");
		expect(s).toContain("unused helper");
		expect(s).toContain("a.ts");
	});

	test("a finding fixed later in the turn steers nothing (I-20261028-166)", () => {
		const d = mkdtempSync(join(tmpdir(), "neurastream-wc-"));
		const file = join(d, "a.ts");
		const before = "const a = 1\n";
		const fixed = "const a = 1\nhelper used\n";
		writeFileSync(file, fixed);
		expect(deferSteer(file, before, fixed, wc({ defer_rules: ["F401"] }))).toBeNull();
	});

	test("deferred debt the file already had steers nothing (I-20261028-166)", () => {
		const d = mkdtempSync(join(tmpdir(), "neurastream-wc-"));
		const file = join(d, "a.ts");
		const text = "lint:F401 old debt\n";
		writeFileSync(file, text);
		expect(deferSteer(file, text, text, wc({ defer_rules: ["F401"] }))).toBeNull();
	});

	test("a deleted file, an empty defer_rules list or a failed linter steers nothing", () => {
		const d = mkdtempSync(join(tmpdir(), "neurastream-wc-"));
		const file = join(d, "a.ts");
		writeFileSync(file, "lint:F401 x\n");
		expect(deferSteer(file, "a\n", null, wc({ defer_rules: ["F401"] }))).toBeNull();
		expect(deferSteer(file, "a\n", "lint:F401 x\n", wc({ defer_rules: [] }))).toBeNull();
		expect(
			deferSteer(
				file,
				"a\n",
				"lint:F401 x\n",
				wc({ defer_rules: ["F401"], linters: [{ ext: [".ts"], argv: ["no-such-linter-xyz", "{file}"], pattern: "^(?<rule>x)" }] }),
			),
		).toBeNull();
	});
});
