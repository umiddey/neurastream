import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// The port under test is the checkout these tests ship in (worktree-safe: never a hardcoded path).
const REPO = dirname(dirname(import.meta.path));
const ROOTS: string[] = [];
const LABEL = "rg0181 CP witnessed leg1 candidate rc1";

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

function home(): string {
	const h = mkdtempSync(join(tmpdir(), "neurastream-validate-"));
	ROOTS.push(h);
	mkdirSync(join(h, "Work"), { recursive: true });
	return h;
}

function run(h: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "agent-score", ...args], {
		env: { ...process.env, HOME: h },
		cwd: h,
		encoding: "utf8",
	});
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function events(h: string): Record<string, unknown>[] {
	const p = join(h, ".local/state/agent-score/events.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(l => l.trim())
		.map(l => JSON.parse(l) as Record<string, unknown>);
}

function writePlan(h: string): string {
	const plan = join(h, "plan.md");
	writeFileSync(plan, "- [x] P1 tests first (red, then green) — difficulty: 3 — verify: `bun test`\n- [ ] P2 docs — difficulty: 1 — verify: `grep`\n");
	return plan;
}

/** Evidence: `## CP` matches the prefix rule, `## CPX` is the boundary decoy, `## Empty (P9)` has no body. */
function writeEvidence(h: string, name: string, body: string): string {
	const ev = join(h, name);
	writeFileSync(ev, `# Report\n\n## CP (P5, throwaway testbed copy)\n${body}\n\n## CPX other\n\ndecoy\n\n## Empty (P9)\n## Next\n`);
	return ev;
}

function writeHeavyLog(h: string, lines: string[]): void {
	// the scrub moved the heavy-log default under ~/.local/state/neurastream
	mkdirSync(dirname(join(h, ".local/state/neurastream/heavy-run.log")), { recursive: true });
	writeFileSync(join(h, ".local/state/neurastream/heavy-run.log"), `${lines.join("\n")}\n`);
}

/** A sub-run named WorkerV so validate can record (a worker type with no run is refused). */
function plantWorker(h: string): void {
	const dir = join(h, ".omp/agent/sessions/proj");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "WorkerV.jsonl"),
		`${JSON.stringify({ message: { role: "assistant", provider: "zai", model: "glm", usage: { totalTokens: 1, cacheRead: 0, cost: { total: 0.01 } }, stopReason: "end_turn", content: [{ type: "text", text: "done" }] } })}\n`,
	);
}

const HEAVY = [
	"2026-10-20 18:59:00 START WorkerV | " + LABEL,
	`2026-10-20 19:00:00 END   WorkerV | ${LABEL} | exit 0`,
	"2026-10-20 19:05:00 END   OtherAgent | rg0181 PM witnessed leg1 | exit 1",
];

test("validate refuses an unticked phase and records nothing", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL} green\n`);
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P2", "--evidence", ev, "--section", "## CP"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toBe(`refused: P2 not ticked in ${plan}\n`);
	expect(events(h)).toEqual([]);
});

test("validate refuses a missing plan and a missing evidence file", () => {
	const h = home();
	const plan = writePlan(h);
	const r = run(h, ["validate", "WorkerV", "--plan", join(h, "nope.md"), "--phase", "P1", "--evidence", join(h, "x.md"), "--section", "## CP"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toBe(`plan not found: ${join(h, "nope.md")}\n`);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL} green\n`);
	const r2 = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", join(h, "gone.md"), "--section", "## CP"]);
	expect(r2.code).toBe(1);
	expect(r2.stderr).toContain("refused:");
	expect(events(h)).toEqual([]);
});

test("validate heading prefix must end at end-of-line, space or ( — not mid-word", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL} green\n`);
	// `## CPX` exists in the file but `## CP` must not match it.
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## CPX"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("refused:");
	expect(events(h)).toEqual([]);
});

test("validate refuses an empty section body", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL} green\n`);
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## Empty (P9)"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("refused:");
	expect(events(h)).toEqual([]);
});

test("validate refuses a section that cites no heavy-run label of that agent", () => {
	const h = home();
	const plan = writePlan(h);
	writeHeavyLog(h, HEAVY);
	// Body text but no label of WorkerV.
	const ev = writeEvidence(h, "report.md", "all checks passed, nothing cited\n");
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## CP"]);
	expect(r.code).toBe(1);
	expect(r.stderr).toBe("refused: section cites no heavy-run label run by WorkerV\n");
	// The log has no END line for this agent at all.
	const ev2 = writeEvidence(h, "report2.md", `ran ${LABEL} green\n`);
	const r2 = run(h, ["validate", "Nobody", "--plan", plan, "--phase", "P1", "--evidence", ev2, "--section", "## CP"]);
	expect(r2.code).toBe(1);
	expect(r2.stderr).toBe("refused: section cites no heavy-run label run by Nobody\n");
	expect(events(h)).toEqual([]);
});

test("validate records the phase weight and the cited labels", () => {
	const h = home();
	plantWorker(h);
	const plan = writePlan(h);
	writeHeavyLog(h, HEAVY);
	const ev = writeEvidence(h, "report.md", `ran "${LABEL}" under heavy-run; exit 0, all green\n`);
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## CP", "--note", "checked no commits"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("recorded:");
	const evs = events(h);
	expect(evs.length).toBe(1);
	const e = evs[0]!;
	expect(e.type).toBe("validate");
	expect(e.agent).toBe("WorkerV");
	expect(e.plan).toBe(plan);
	expect(e.phase).toBe("P1");
	expect(e.weight).toBe(3);
	expect(e.weight_src).toBe("plan");
	expect(e.evidence).toBe(ev);
	expect(e.section).toBe("## CP");
	expect(e.labels).toEqual([LABEL]);
	expect(e.note).toBe("checked no commits");
	expect(e.rework).toBe(false);
});

test("validate --weight overrides the plan difficulty and --rework is recorded", () => {
	const h = home();
	const plan = writePlan(h);
	plantWorker(h);
	writeHeavyLog(h, HEAVY);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL}\n`);
	const r = run(h, ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## CP", "--weight", "8", "--rework"]);
	expect(r.code).toBe(0);
	const e = events(h)[0]!;
	expect(e.weight).toBe(8);
	expect(e.weight_src).toBe("flag");
	expect(e.rework).toBe(true);
});

test("validate refuses an already scored agent+plan+phase (validate and accept)", () => {
	const h = home();
	const plan = writePlan(h);
	plantWorker(h);
	writeHeavyLog(h, HEAVY);
	const ev = writeEvidence(h, "report.md", `ran ${LABEL}\n`);
	const args = ["validate", "WorkerV", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## CP"];
	expect(run(h, args).code).toBe(0);
	const r = run(h, args);
	expect(r.code).toBe(1);
	expect(r.stderr).toBe("refused: already scored\n");
	expect(events(h).length).toBe(1);
	// An earlier accept for the same agent+plan+phase blocks too.
	const h2 = home();
	const plan2 = writePlan(h2);
	writeHeavyLog(h2, HEAVY);
	const ev2 = writeEvidence(h2, "report.md", `ran ${LABEL}\n`);
	const dir = join(h2, ".local/state/agent-score");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "events.jsonl"),
		`${JSON.stringify({ type: "accept", agent: "WorkerV", plan: plan2, phase: "P1", weight: 3, weight_src: "plan", repo: "/x", branch: "main", commits: ["a"], rework: false, note: "", ts: Date.now() / 1000 })}\n`,
	);
	const r2 = run(h2, ["validate", "WorkerV", "--plan", plan2, "--phase", "P1", "--evidence", ev2, "--section", "## CP"]);
	expect(r2.code).toBe(1);
	expect(r2.stderr).toBe("refused: already scored\n");
});

test("board counts validate next to diagnose: Accepted (diag/val) cell N (d/v)", () => {
	const h = home();
	const dir = join(h, ".local/state/agent-score");
	mkdirSync(dir, { recursive: true });
	const ts = Date.now() / 1000;
	const line = (o: Record<string, unknown>): string => JSON.stringify({ ts, ...o });
	writeFileSync(
		join(dir, "events.jsonl"),
		[
			line({ type: "accept", agent: "WorkerA", plan: "p.md", phase: "P1", weight: 2, weight_src: "plan", repo: "/x", branch: "main", commits: ["a"], rework: false, note: "" }),
			line({ type: "diagnose", agent: "WorkerA", plan: "p.md", phase: "P2", weight: 4, weight_src: "default", evidence: "e.txt", note: "" }),
			line({ type: "validate", agent: "WorkerV", plan: "p.md", phase: "P3", weight: 3, weight_src: "plan", evidence: "r.md", section: "## CP", labels: [LABEL], rework: false, note: "" }),
			line({ type: "penalty", agent: "WorkerV", kind: "false-claim", plan: "", note: "lied" }),
		].join("\n") + "\n",
	);
	const r = run(h, ["board", "--days", "3"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("Accepted (diag/val)");
	expect(r.stdout).toMatch(/\| 3 \(1\/1\) \|/);
	// One validate at weight 3 plus one false-claim penalty (5): net = 2+4+3-5 = 4.
	expect(r.stdout).toMatch(/\| 4 \|/);
});
