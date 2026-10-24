import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = dirname(dirname(import.meta.path));
const ROOTS: string[] = [];

afterAll(() => {
	for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

function home(): string {
	const h = mkdtempSync(join(tmpdir(), "neurastream-score-args-"));
	ROOTS.push(h);
	mkdirSync(join(h, "Work"), { recursive: true });
	return h;
}

function run(h: string, args: string[]): { code: number; stdout: string; stderr: string } {
	const cleanEnv = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_") && !k.startsWith("NEURASTREAM_")),
	);
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "agent-score", ...args], {
		env: { ...cleanEnv, HOME: h },
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
	writeFileSync(plan, "- [x] P1 task — difficulty: 2 — verify: `true`\n");
	return plan;
}

test("accept refuses missing positional agent (--agent flag) with exit 2, usage, and empty events", () => {
	const h = home();
	const plan = writePlan(h);
	const r = run(h, ["accept", "--agent", "WorkerA", "--plan", plan, "--phase", "P1", "--commits", "head"]);
	expect(r.code).toBe(2);
	expect(r.stderr).toContain("usage: agent-score accept <Agent>");
	expect(events(h)).toEqual([]);
});

test("diagnose refuses missing positional agent (--agent flag) with exit 2, usage, and empty events", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = join(h, "ev.md");
	writeFileSync(ev, "evidence\n");
	const r = run(h, ["diagnose", "--agent", "WorkerA", "--plan", plan, "--phase", "P1", "--evidence", ev]);
	expect(r.code).toBe(2);
	expect(r.stderr).toContain("usage: agent-score diagnose <Agent>");
	expect(events(h)).toEqual([]);
});

test("penalty refuses missing positional agent (--agent flag) with exit 2, usage, and empty events", () => {
	const h = home();
	const r = run(h, ["penalty", "--agent", "WorkerA", "--kind", "rule-break", "--note", "broke rule"]);
	expect(r.code).toBe(2);
	expect(r.stderr).toContain("usage: agent-score penalty <Agent>");
	expect(events(h)).toEqual([]);
});

test("validate refuses missing positional agent (--agent flag) with exit 2, usage, and empty events", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = join(h, "ev.md");
	writeFileSync(ev, "# Report\n## P1\nlog\n");
	const r = run(h, ["validate", "--agent", "WorkerA", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## P1"]);
	expect(r.code).toBe(2);
	expect(r.stderr).toContain("usage: agent-score validate <Agent>");
	expect(events(h)).toEqual([]);
});

test("refuses missing positional agent (no args) with exit 2, usage, and empty events", () => {
	const h = home();
	for (const cmd of ["accept", "diagnose", "penalty", "validate"]) {
		const r = run(h, [cmd]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(`usage: agent-score ${cmd} <Agent>`);
		expect(events(h)).toEqual([]);
	}
});

test("refuses unknown flag with exit 2, usage, and empty events", () => {
	const h = home();
	const plan = writePlan(h);
	const ev = join(h, "ev.md");
	writeFileSync(ev, "# Report\n## P1\nlog\n");

	const rAccept = run(h, ["accept", "WorkerA", "--plan", plan, "--phase", "P1", "--commits", "head", "--bogus-flag"]);
	expect(rAccept.code).toBe(2);
	expect(rAccept.stderr).toContain("usage: agent-score accept <Agent>");
	expect(events(h)).toEqual([]);

	const rDiag = run(h, ["diagnose", "WorkerA", "--plan", plan, "--phase", "P1", "--evidence", ev, "--unknown"]);
	expect(rDiag.code).toBe(2);
	expect(rDiag.stderr).toContain("usage: agent-score diagnose <Agent>");
	expect(events(h)).toEqual([]);

	const rPen = run(h, ["penalty", "WorkerA", "--kind", "rule-break", "--note", "broke rule", "--foo"]);
	expect(rPen.code).toBe(2);
	expect(rPen.stderr).toContain("usage: agent-score penalty <Agent>");
	expect(events(h)).toEqual([]);

	const rVal = run(h, ["validate", "WorkerA", "--plan", plan, "--phase", "P1", "--evidence", ev, "--section", "## P1", "--bar"]);
	expect(rVal.code).toBe(2);
	expect(rVal.stderr).toContain("usage: agent-score validate <Agent>");
	expect(events(h)).toEqual([]);
});
