// queue-close writes one short entry to FINISHED.md (beside the main index) when it archives a
// complete plan. Cancelled plans stay on CANCELLED.md only. A second close of the same plan
// does not add a second entry. Everything lives under a temp dir.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileClaimStore } from "../src/core/claims.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";
import { queueClose } from "../src/core/queue-close.ts";

const TMP = mkdtempSync(join(tmpdir(), "ns-qclose-finished-"));
const HOME = join(TMP, "home");
const AGENT = join(HOME, "agent");
const TOY = join(HOME, "projects/toy");
const QUEUE_STATE = join(HOME, "state");
const INDEX = join(AGENT, "INDEX.md");
const FINISHED = join(AGENT, "FINISHED.md");
const COMPLETE = join(TOY, "docs/plans/20261020_1200_done.md");
const CANCELLED = join(TOY, "docs/plans/20261020_1300_drop.md");

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

function seed(): Config {
	for (const d of [join(AGENT, "blockers"), join(TOY, "docs/plans"), join(HOME, ".config/neurastream"), QUEUE_STATE]) {
		mkdirSync(d, { recursive: true });
	}
	const blocker = join(AGENT, "blockers/no-push");
	writeFileSync(blocker, "#!/bin/sh\nexit 0\n");
	chmodSync(blocker, 0o755);
	writeFileSync(INDEX, `${COMPLETE}\n${CANCELLED}\n`);
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${INDEX}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${QUEUE_STATE}"
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

function plan(title: string, status: "complete" | "cancelled", extra: string[]): string {
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
		"- first note.",
		"- shipped the fix.",
		...extra,
		"",
	].join("\n");
}

function headings(text: string): string[] {
	return text.split("\n").filter(l => l.startsWith("## "));
}

function bodyUnder(text: string, planPath: string): string[] {
	const parts = text.split(/^(?=## )/m);
	const entry = parts.find(p => p.includes(`Plan: ${planPath}`));
	expect(entry).toBeTruthy();
	return entry!.split("\n").slice(1).filter(l => l.trim() && !l.startsWith("## "));
}

test("a complete close writes one short entry; a cancel writes none; a second close does not duplicate", () => {
	const cfg = seed();
	writeFileSync(COMPLETE, plan("Done plan", "complete", []));
	writeFileSync(CANCELLED, plan("Dropped plan", "cancelled", ['Cancelled by owner: 2026-10-27 "stop this work now"']));

	// Multi-main P3: a close frees the closer's own claim; another Main's claim survives it
	// (release is holder-keyed). The id here is "main": NEURASTREAM_MAIN_ID is unset.
	const savedId = process.env.NEURASTREAM_MAIN_ID;
	process.env.NEURASTREAM_MAIN_ID = "main";
	const claims = fileClaimStore(QUEUE_STATE, () => 0, 30);
	claims.claim(COMPLETE, "main");
	expect(queueClose([COMPLETE], cfg)).toBe(0);
	expect(claims.list()).toEqual([]);
	const month = new Date().toISOString().slice(0, 7).replace("-", "");
	const archived = join(TOY, "docs/plans/archive", month, "20261020_1200_done.md");
	const text = readFileSync(FINISHED, "utf8");
	const body = bodyUnder(text, archived);
	expect(body.length).toBeLessThanOrEqual(4);
	expect(body).toContain(`Plan: ${archived}`);
	expect(body).toContain("Summary: short summary of the work");
	expect(body).toContain("Result: shipped the fix.");
	expect(headings(text)).toHaveLength(1);
	expect(headings(text)[0]).toContain("· toy · Done plan");

	copyFileSync(archived, COMPLETE);
	rmSync(archived);
	writeFileSync(INDEX, `${COMPLETE}\n${CANCELLED}\n`);
	expect(queueClose([COMPLETE], cfg)).toBe(0);
	expect(headings(readFileSync(FINISHED, "utf8"))).toHaveLength(1);

	claims.claim(CANCELLED, "other");
	expect(queueClose([CANCELLED], cfg)).toBe(0);
	const after = readFileSync(FINISHED, "utf8");
	expect(headings(after)).toHaveLength(1);
	expect(after).not.toContain("Dropped plan");
	expect(after).not.toContain("20261020_1300_drop.md");
	expect(claims.list().map(c => c.main)).toEqual(["other"]);
	if (savedId === undefined) delete process.env.NEURASTREAM_MAIN_ID;
	else process.env.NEURASTREAM_MAIN_ID = savedId;
	const cancelledList = readFileSync(join(TOY, "docs/plans/CANCELLED.md"), "utf8");
	expect(cancelledList).toContain("20261020_1300_drop.md");
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
