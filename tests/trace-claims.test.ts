// Claim extractor (src/core/trace-claims.ts, plan 20261024_0300 P2): pure text in, claims out.
// Covers every claim kind the P3 verifier checks: test result counts, exit codes, commit SHAs,
// heavy-run labels, changed paths; plus evidence masking of long token-like runs and the
// 160-char evidence cap so a claim can never carry a secret forward.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TraceEvent } from "../src/core/adapter.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import { parseTraceFile } from "../src/adapters/omp/traces.ts";
import { claimUnbacked, runDetectors } from "../src/core/incident-detectors.ts";
import { claimsFromEvents, extractClaims, maskEvidence, verifyClaims } from "../src/core/trace-claims.ts";
import type { Claim } from "../src/core/trace-claims.ts";

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

// ---- P3 verifier: claims checked against the same run's tool activity ----

const REPO = dirname(dirname(import.meta.path));
const FIX = join(REPO, "tests", "fixtures", "traces");
const redEvents = parseTraceFile(join(FIX, "claims-red.jsonl"), "claims-red");
const redClaims = claimsFromEvents(redEvents);
const greenEvents = parseTraceFile(join(FIX, "claims-green.jsonl"), "claims-green");
const greenClaims = claimsFromEvents(greenEvents);

const TMP_ROOTS: string[] = [];
afterAll(() => {
	for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_760_000_000;
let n = 0;
function cfg(): Config {
	const root = mkdtempSync(join(tmpdir(), "ns-claims-"));
	TMP_ROOTS.push(root);
	const home = join(root, `home-${++n}`);
	const queueState = join(home, ".local/state/queue");
	mkdirSync(join(home, ".config/neurastream"), { recursive: true });
	mkdirSync(queueState, { recursive: true });
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  queue_state: "${queueState}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
`,
	);
	return loadConfig({ home, env: {} });
}

test("red fixture: the fake '13 passed' and 'exit 0' claims have no tool output behind them", () => {
	expect(redEvents.length).toBeGreaterThan(0);
	expect(redClaims).toContainEqual(expect.objectContaining({ kind: "tests-passed", count: 13 }));
	const unbacked = verifyClaims(redClaims, redEvents).filter((v) => !v.backed);
	expect(unbacked.map((v) => v.claim.kind).sort()).toEqual(["exit", "tests-passed"]);
});

test("red fixture: unbacked claims become claim-unbacked findings via the detector", () => {
	const findings = claimUnbacked(redClaims, redEvents);
	expect(findings).toHaveLength(2);
	expect(findings.every((f) => f.kind === "claim-unbacked")).toBe(true);
	expect(findings.some((f) => f.summary.includes("tests-passed 13"))).toBe(true);
	expect(findings.every((f) => (f.evidence ?? "").length <= 160)).toBe(true);
	expect(findings.every((f) => typeof f.fingerprint === "string" && f.fingerprint.length > 0)).toBe(true);
});

test("green fixture: every claim is backed by the run's own tool activity", () => {
	expect(greenClaims.length).toBeGreaterThanOrEqual(5);
	expect(verifyClaims(greenClaims, greenEvents).every((v) => v.backed)).toBe(true);
	expect(claimUnbacked(greenClaims, greenEvents)).toEqual([]);
});

test("runDetectors folds claim-unbacked when given claims and events", () => {
	const views = runDetectors(cfg(), { claims: redClaims, events: redEvents }, NOW);
	expect(views.filter((v) => v.kind === "claim-unbacked")).toHaveLength(2);
});

function callEv(tool: string, args: Record<string, unknown>): TraceEvent {
	return { kind: "toolCall", ts: 1, runId: "r", tool, args };
}

function resultEv(text: string): TraceEvent {
	return { kind: "toolResult", ts: 2, runId: "r", tool: "bash", isError: false, text };
}

test("counts and exit codes are backed by any toolResult line showing them", () => {
	const evs = [callEv("bash", { command: "bun test" }), resultEv("530 passed, 0 failed"), resultEv("heavy job exit 0")];
	const cs: Claim[] = [
		{ kind: "tests-passed", count: 530, evidence: "x" },
		{ kind: "tests-failed", count: 0, evidence: "x" },
		{ kind: "exit", count: 0, evidence: "x" },
		{ kind: "tests-passed", count: 13, evidence: "x" },
	];
	expect(verifyClaims(cs, evs).map((v) => v.backed)).toEqual([true, true, true, false]);
});

test("a sha is backed only by the output of a git command the run actually ran", () => {
	const claim: Claim = { kind: "sha", value: "abc12d4", evidence: "x" };
	const noGit = [callEv("bash", { command: "bun test" }), resultEv("landed abc12d4")];
	const withGit = [callEv("bash", { command: "git log --oneline" }), resultEv("abc12d4 demo commit")];
	expect(verifyClaims([claim], noGit)[0]!.backed).toBe(false);
	expect(verifyClaims([claim], withGit)[0]!.backed).toBe(true);
});

test("a changed path is backed only by an edit/write call carrying it", () => {
	const claim: Claim = { kind: "changed-path", value: "src/a.ts", evidence: "x" };
	expect(verifyClaims([claim], [callEv("bash", { command: "touch src/a.ts" })])[0]!.backed).toBe(false);
	expect(verifyClaims([claim], [callEv("edit", { path: "src/a.ts" })])[0]!.backed).toBe(true);
	expect(verifyClaims([claim], [callEv("write", { file_path: "src/a.ts" })])[0]!.backed).toBe(true);
});

test("a heavy-run label is backed only by a heavy-run call quoting it", () => {
	const claim: Claim = { kind: "heavy-label", value: "traces p3", evidence: "x" };
	const other = [callEv("bash", { command: 'heavy-run.sh NsX "other label" -- bun test' })];
	const same = [callEv("bash", { command: 'heavy-run.sh NsX "traces p3" -- bun test' })];
	expect(verifyClaims([claim], other)[0]!.backed).toBe(false);
	expect(verifyClaims([claim], same)[0]!.backed).toBe(true);
});

test("claimsFromEvents reads only the last assistant text (the final report)", () => {
	const evs: TraceEvent[] = [
		{ kind: "assistantText", ts: 1, runId: "r", text: "early: 99 passed" },
		resultEv("2 pass, 0 fail"),
		{ kind: "assistantText", ts: 3, runId: "r", text: "Done: 2 passed." },
	];
	const cs = claimsFromEvents(evs);
	expect(cs).toContainEqual(expect.objectContaining({ kind: "tests-passed", count: 2 }));
	expect(cs.some((c) => c.count === 99)).toBe(false);
});

test("claimsFromEvents on a run without assistant text: no claims", () => {
	expect(claimsFromEvents([resultEv("2 pass")])).toEqual([]);
});


