// Claim extractor (src/core/trace-claims.ts, plan 20261024_0300 P2): pure text in, claims out.
// Covers every claim kind the P3 verifier checks: test result counts, exit codes, commit SHAs,
// heavy-run labels, changed paths; plus evidence masking of long token-like runs and the
// 160-char evidence cap so a claim can never carry a secret forward.

import { describe, expect, test } from "bun:test";
import { extractClaims, maskEvidence } from "../src/core/trace-claims.ts";

describe("test result lines", () => {
	test("passed and failed counts with evidence", () => {
		const cs = extractClaims("Suite green (530 passed, 0 failed).");
		expect(cs).toContainEqual({ kind: "tests-passed", count: 530, evidence: "Suite green (530 passed, 0 failed)." });
		expect(cs).toContainEqual(expect.objectContaining({ kind: "tests-failed", count: 0 }));
	});

	test("short 'N pass' / 'N fail' spellings count too", () => {
		const cs = extractClaims("full suite 368 pass / 0 fail");
		expect(cs).toContainEqual(expect.objectContaining({ kind: "tests-passed", count: 368 }));
		expect(cs).toContainEqual(expect.objectContaining({ kind: "tests-failed", count: 0 }));
		expect(cs.every((c) => c.count !== undefined)).toBe(true);
	});
});

describe("exit codes", () => {
	test("exit 0, exit code 2, exit: 1", () => {
		const cs = extractClaims("heavy command exit 0\nother exit code 2\nthird exit: 1");
		expect(cs.filter((c) => c.kind === "exit").map((c) => c.count)).toEqual([0, 2, 1]);
	});
});

describe("commit SHAs", () => {
	test("short and full SHAs claimed, digit-only runs are not", () => {
		const full = "0123456789abcdef0123456789abcdef01234567";
		const cs = extractClaims(`Commit abc12d4 on the branch; full ${full}; job 1234567 ran.`);
		const shas = cs.filter((c) => c.kind === "sha").map((c) => c.value);
		expect(shas).toContain("abc12d4");
		expect(shas).toContain(full);
		expect(shas).not.toContain("1234567");
	});
});

describe("heavy-run labels", () => {
	test("quoted label after the agent name", () => {
		const line = `bash /home/x/heavy-run.sh NsFoo "traces p1p2" -- bun test`;
		const cs = extractClaims(line);
		expect(cs).toContainEqual(expect.objectContaining({ kind: "heavy-label", value: "traces p1p2" }));
	});
});

describe("changed paths", () => {
	test("paths on change-verb lines, not branch names", () => {
		const cs = extractClaims("Commit deadbee2 on feat/demo; changed src/demo.ts and tests/demo.test.ts");
		const paths = cs.filter((c) => c.kind === "changed-path").map((c) => c.value);
		expect(paths).toContain("src/demo.ts");
		expect(paths).toContain("tests/demo.test.ts");
		expect(paths).not.toContain("feat/demo");
	});

	test("mentions without a change verb are not claimed as changed", () => {
		expect(extractClaims("read src/core/adapter.ts before starting").filter((c) => c.kind === "changed-path")).toEqual([]);
	});
});

describe("dedupe and evidence safety", () => {
	test("same claim twice collapses to one", () => {
		const cs = extractClaims("12 passed\nlater 12 passed again");
		expect(cs.filter((c) => c.kind === "tests-passed")).toHaveLength(1);
	});

	test("long token-like runs are masked in evidence", () => {
		const secret = "abcdefghijklmnopqrstuvwxyz123456";
		const cs = extractClaims(`12 passed, token ${secret} stays out`);
		const ev = cs.map((c) => c.evidence).join("\n");
		expect(ev).not.toContain(secret);
		expect(ev).toContain("[masked]");
	});

	test("evidence is capped at 160 chars", () => {
		const long = `${"word ".repeat(40)}12 passed`;
		const cs = extractClaims(long);
		expect(cs.every((c) => c.evidence.length <= 160)).toBe(true);
		expect(cs.some((c) => c.kind === "tests-passed")).toBe(true);
	});
});

test("maskEvidence masks and caps on its own", () => {
	expect(maskEvidence(`key ${"A".repeat(30)} end`)).toBe("key [masked] end");
	expect(maskEvidence("word ".repeat(40))).toHaveLength(160);
});

test("empty text: no claims", () => {
	expect(extractClaims("")).toEqual([]);
});
