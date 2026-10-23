import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rekeySpawns } from "../src/core/guards.ts";
import * as q from "../src/core/queue/lib.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nsar-progress-trim-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const entry = (n: number) => `- run ${n}: step ${n} done\n  verified: command ${n} exit 0`;
const all9 = Array.from({ length: 9 }, (_, i) => entry(i + 1));

/** A plan as Main keeps it: phases above, Progress with a Status line and the worker entries newest-first. */
function planText(entries: string[]): string {
	return [
		"# Plan: trim fixture",
		"",
		"## Phases",
		"- [x] P1 done",
		"- [ ] P2 open",
		"",
		"## Progress",
		"Status: open",
		"<!-- The implementer may only append dated entries here. -->",
		"",
		...entries,
		"",
		"## Background",
		"- context",
		"",
	].join("\n");
}

const POINTER = "- Older Progress entries: archive/20261023_1200_trim-progress.md";

describe("trimProgressBody (pure)", () => {
	test("9 entries + keep 6 → 6 kept with the pointer as the last line, 3 moved in file order", () => {
		const body = q.progressBody(planText(all9));
		const res = q.trimProgressBody(body, 6, POINTER);
		expect(res).toBeDefined();
		if (!res) return;
		expect(res.count).toBe(3);
		for (let n = 1; n <= 6; n++) expect(res.body).toContain(`run ${n}:`);
		expect(res.body).not.toContain("run 7:");
		expect(res.body.trimEnd().endsWith(POINTER)).toBe(true);
		expect(res.moved.indexOf("run 7:")).toBeLessThan(res.moved.indexOf("run 8:"));
		expect(res.moved.indexOf("run 8:")).toBeLessThan(res.moved.indexOf("run 9:"));
		expect(res.moved).toContain("verified: command 9 exit 0");
	});

	test("the Status line and the HTML comment stay untouched", () => {
		const body = q.progressBody(planText(all9));
		const res = q.trimProgressBody(body, 6, POINTER);
		expect(res?.body.startsWith("Status: open\n<!-- The implementer may only append dated entries here. -->")).toBe(true);
	});

	test("fewer entries than keep → no change", () => {
		const body = q.progressBody(planText(all9.slice(0, 6)));
		expect(q.trimProgressBody(body, 6, POINTER)).toBeUndefined();
	});
});

describe("trimPlanProgress (IO)", () => {
	test("moves the older entries to the archive, leaves a pointer, keeps phases, Status and Background", () => {
		const dir = join(ROOT, "plans");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "20261023_1200_trim.md");
		writeFileSync(file, planText(all9));
		const res = q.trimPlanProgress(file, 6);
		expect(res?.count).toBe(3);
		const plan = readFileSync(file, "utf8");
		expect(plan).toContain("- Older Progress entries: archive/20261023_1200_trim-progress.md");
		expect(plan).not.toContain("run 7:");
		expect(plan).toContain("## Phases\n- [x] P1 done\n- [ ] P2 open");
		expect(plan).toContain("Status: open");
		expect(plan).toContain("## Background\n- context");
		const archive = readFileSync(join(dir, "archive", "20261023_1200_trim-progress.md"), "utf8");
		expect(archive.startsWith("# Progress archive: 20261023_1200_trim.md")).toBe(true);
		expect(archive.indexOf("run 7:")).toBeLessThan(archive.indexOf("run 8:"));
		expect(archive.indexOf("run 8:")).toBeLessThan(archive.indexOf("run 9:"));
	});

	test("a second trim puts the new batch above the old batch in the archive, and keeps one pointer", () => {
		const dir = join(ROOT, "second");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "20261023_1200_trim.md");
		writeFileSync(file, planText(all9));
		q.trimPlanProgress(file, 6);
		// Main writes four newer entries at the top of Progress.
		const newer = [10, 11, 12, 13].map(entry).join("\n");
		writeFileSync(file, readFileSync(file, "utf8").replace("- run 1:", `${newer}\n- run 1:`));
		const res = q.trimPlanProgress(file, 6);
		expect(res?.count).toBe(4);
		const plan = readFileSync(file, "utf8");
		expect(plan.split("- Older Progress entries:").length - 1).toBe(1);
		expect(plan).toContain("run 10:");
		expect(plan).not.toContain("run 3:");
		const archive = readFileSync(join(dir, "archive", "20261023_1200_trim-progress.md"), "utf8");
		expect(archive.split("# Progress archive:").length - 1).toBe(1);
		expect(archive.indexOf("run 3:")).toBeLessThan(archive.indexOf("run 7:"));
		expect(archive.indexOf("run 6:")).toBeLessThan(archive.indexOf("run 7:"));
	});

	test("fewer than keep → no change and no archive file", () => {
		const dir = join(ROOT, "short");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "20261023_1200_short.md");
		writeFileSync(file, planText(all9.slice(0, 6)));
		const before = readFileSync(file, "utf8");
		expect(q.trimPlanProgress(file, 6)).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(join(dir, "archive"))).toBe(false);
	});
});

describe("spawn hash re-key (guards)", () => {
	const before = q.progressBody(planText(all9));
	const after = q.trimProgressBody(before, 6, POINTER)?.body ?? "";

	test("re-keyed when the stored hash matched the body before the trim", () => {
		const spawns: Record<string, string> = { "/p/plan.md": q.sha(before) };
		expect(rekeySpawns(spawns, "/p/plan.md", before, after)).toBe(true);
		expect(spawns["/p/plan.md"]).toBe(q.sha(after));
	});

	test("left alone when the stored hash did not match", () => {
		const spawns: Record<string, string> = { "/p/plan.md": q.sha("some other body") };
		expect(rekeySpawns(spawns, "/p/plan.md", before, after)).toBe(false);
		expect(spawns["/p/plan.md"]).toBe(q.sha("some other body"));
	});

	test("left alone when the plan was never spawned on", () => {
		const spawns: Record<string, string> = {};
		expect(rekeySpawns(spawns, "/p/plan.md", before, after)).toBe(false);
		expect(spawns).toEqual({});
	});
});
