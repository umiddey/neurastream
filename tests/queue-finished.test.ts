// queue-finished --backfill writes one short entry per complete archived plan and skips cancelled
// ones. A second run adds nothing. A word prints matching entries. Everything lives under a temp dir.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { queueFinished } from "../src/core/queue-finished.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-qfinished-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, "agent");
const ROOT = join(HOME, "projects");
const TOY = join(ROOT, "toy");
const ARCHIVE = join(TOY, "docs/plans/archive/202610");
const INDEX = join(AGENT, "INDEX.md");
const FINISHED = join(AGENT, "FINISHED.md");
const OLD = join(ARCHIVE, "20261018_1200_old.md");
const NEW = join(ARCHIVE, "20261022_1200_new.md");
const DROP = join(ARCHIVE, "20261020_1200_drop.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

function seed(): Config {
	mkdirSync(ARCHIVE, { recursive: true });
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	mkdirSync(AGENT, { recursive: true });
	writeFileSync(INDEX, "");
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${ROOT}"]
  agent_dir: "${AGENT}"
  queue_index: "${INDEX}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${join(HOME, "state")}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	spawnSync("git", ["-C", TOY, "init", "-q"]);
	return loadConfig({ home: HOME, env: {} });
}

function plan(title: string, status: "complete" | "cancelled"): string {
	return [
		`# ${title}`,
		"Summary: short summary of the work",
		"",
		"## Goal",
		"- first goal line",
		"",
		"## Forbidden",
		"- never push",
		"",
		"## Blockers",
		"- no-push",
		"",
		"## Phases",
		"- [x] P1 done — verify: `true`",
		"",
		"## Done check",
		"`true`",
		"",
		"## Progress",
		`Status: ${status}`,
		"- shipped the fix.",
		...(status === "cancelled" ? ['- Cancelled by owner: 2026-10-27 "stop this work now"'] : []),
		"",
	].join("\n");
}

function headings(text: string): string[] {
	return text.split("\n").filter(l => l.startsWith("## "));
}

function bodyUnder(text: string, planPath: string): string[] {
	const entry = text.split(/^(?=## )/m).find(p => p.includes(`Plan: ${planPath}`));
	expect(entry).toBeTruthy();
	return entry!.split("\n").slice(1).filter(l => l.trim() && !l.startsWith("## "));
}

function logged(run: () => number): { code: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => {
		out.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		err.push(a.map(String).join(" "));
	};
	try {
		return { code: run(), out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

test("backfill writes two complete entries and a second run adds none", () => {
	const cfg = seed();
	writeFileSync(OLD, plan("Older plan", "complete"));
	writeFileSync(NEW, plan("Newer plan", "complete"));
	writeFileSync(DROP, plan("Dropped plan", "cancelled"));

	const first = logged(() => queueFinished(["--backfill"], cfg));
	expect(first.code).toBe(0);
	expect(first.out).toContain("added 2");
	const text = readFileSync(FINISHED, "utf8");
	const heads = headings(text);
	expect(heads).toHaveLength(2);
	expect(heads[0]).toBe("## 2026-10-22 · toy · Newer plan");
	expect(heads[1]).toContain("· toy · Older plan");
	expect(text).not.toContain("Dropped plan");
	expect(text).not.toContain("20261020_1200_drop.md");
	for (const file of [NEW, OLD]) {
		const body = bodyUnder(text, file);
		expect(body.length).toBeLessThanOrEqual(4);
		expect(body).toContain(`Plan: ${file}`);
		expect(body).toContain("Summary: short summary of the work");
		expect(body).toContain("Result: shipped the fix.");
	}

	const before = readFileSync(FINISHED, "utf8");
	const second = logged(() => queueFinished(["--backfill"], cfg));
	expect(second.code).toBe(0);
	expect(second.out).toContain("added 0");
	expect(readFileSync(FINISHED, "utf8")).toBe(before);

	const hit = logged(() => queueFinished(["newer"], cfg));
	expect(hit.code).toBe(0);
	expect(hit.out).toContain("Newer plan");
	expect(hit.out).not.toContain("Older plan");
	const miss = logged(() => queueFinished(["missing-word"], cfg));
	expect(miss.code).toBe(1);
	expect(miss.err).toContain("no entry matches");
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
