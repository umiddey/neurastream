import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelledFile, parsePlan, queueSummary } from "../src/core/queue/lib";

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
const REPO_MID = path.join(TMP, "repo-mid");
mkdirSync(path.join(REPO_MID, "docs/plans"), { recursive: true });
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: REPO_MID });
const FILE_A = path.join(REPO, "docs/plans/20261021_0100_a.md");
const FILE_MID = path.join(REPO_MID, "docs/plans/20261021_0101_mid.md");
const FILE_B = path.join(REPO, "docs/plans/20261021_0102_b.md");
writeFileSync(FILE_A, PLAN_A);
writeFileSync(FILE_MID, PLAN_B);
writeFileSync(FILE_B, PLAN_B);
writeFileSync(MAIN_INDEX, `${FILE_A}\n${FILE_MID}\n${FILE_B}\n`);

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
	expect(s).toContain("20261021_0102_b.md [open]");
});

test("queueSummary lists plans in index order as ranked lines, each carrying its repo (rank 1 = top line)", () => {
	const s = queueSummary(MAIN_INDEX);
	const lines = s.split("\n").filter(l => /^\s*\d+\. /.test(l));
	expect(lines.map(l => l.replace(/\s*\[[^\n]*$/, ""))).toEqual([
		`  1. ${FILE_A}`,
		`  2. ${FILE_MID}`,
		`  3. ${FILE_B}`,
	]);
	// The repo group is gone; every line still names its plan's repo.
	expect(lines[0]).toContain(path.basename(REPO));
	expect(lines[1]).toContain(path.basename(REPO_MID));
	expect(lines[2]).toContain(path.basename(REPO));
	expect(s).not.toContain(`- ${REPO}\n`);
});

test("queueSummary moves the per-repo cancelled counts to one footer line", () => {
	writeFileSync(cancelledFile(REPO), "- ban-x | 2026-10-25 | owner: no demo spam | words: spam\n");
	writeFileSync(
		cancelledFile(REPO_MID),
		"- ban-y | 2026-10-25 | owner: no demo spam | words: spam\n- ban-z | 2026-10-25 | owner: no demo spam | words: spam\n",
	);
	const s = queueSummary(MAIN_INDEX);
	expect(s).toContain("Cancelled rules: 3");
	expect(s).not.toMatch(/\(\d+ cancelled\)/);
});
