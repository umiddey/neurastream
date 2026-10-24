import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePlan, queueSummary } from "../src/core/queue/lib";

const TMP = mkdtempSync(path.join(tmpdir(), "queue-summary-"));
const REPO = path.join(TMP, "repo");
const MAIN_INDEX = path.join(TMP, "INDEX.md");
const HOLD = "hold the rollover fix until the owner says go, then ship it as one patch release with the notes";

const PLAN_A = `# Plan A

## Progress
Status: open
WAITING on owner: ${HOLD}
`;

const PLAN_B = `# Plan B

## Progress
Status: open
`;

mkdirSync(path.join(REPO, "docs/plans"), { recursive: true });
// The plan's repo is the main checkout holding the plan file: a real git repo, so repoRoot finds it.
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: REPO });
const FILE_A = path.join(REPO, "docs/plans/20261021_0100_a.md");
const FILE_B = path.join(REPO, "docs/plans/20261021_0101_b.md");
writeFileSync(FILE_A, PLAN_A);
writeFileSync(FILE_B, PLAN_B);
writeFileSync(MAIN_INDEX, `${FILE_A}\n${FILE_B}\n`);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

test("parsePlan returns the WAITING on owner line text, or null without one", () => {
	const a = parsePlan(REPO, "a.md", PLAN_A);
	expect(a.waiting).toBe(true);
	expect(a.waitingLine).toBe(HOLD);
	expect(parsePlan(REPO, "b.md", PLAN_B).waitingLine).toBeNull();
});

test("queueSummary shows the owner hold text cut to 80 characters, not just the flag", () => {
	const s = queueSummary(MAIN_INDEX);
	expect(s).toContain(`20261021_0100_a.md [open, WAITING on owner: ${HOLD.slice(0, 80)}]`);
	expect(s).not.toContain(HOLD.slice(0, 81));
	expect(s).toContain("20261021_0101_b.md [open]");
});

test("queueSummary groups the plans of one repo under that repo", () => {
	const s = queueSummary(MAIN_INDEX);
	expect(s).toContain(`- ${REPO}`);
	expect(s.indexOf(`- ${REPO}`)).toBeLessThan(s.indexOf("20261021_0100_a.md"));
	expect(s.indexOf("20261021_0100_a.md")).toBeLessThan(s.indexOf("20261021_0101_b.md"));
});
