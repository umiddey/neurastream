// queue-close writes one short entry to FINISHED.md (beside the main index) when it archives a
// complete plan. Cancelled plans stay on CANCELLED.md only. A second close of the same plan
// does not add a second entry. Everything lives under a temp dir.

import { afterAll, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	expect(queueClose([COMPLETE], cfg)).toBe(0);
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
	// queueClose leaves the index 0444 (plan 20261031_0911 P2); reseed fresh instead of writing over it.
	rmSync(INDEX);
	writeFileSync(INDEX, `${COMPLETE}\n${CANCELLED}\n`);
	expect(queueClose([COMPLETE], cfg)).toBe(0);
	expect(headings(readFileSync(FINISHED, "utf8"))).toHaveLength(1);

	expect(queueClose([CANCELLED], cfg)).toBe(0);
	const after = readFileSync(FINISHED, "utf8");
	expect(headings(after)).toHaveLength(1);
	expect(after).not.toContain("Dropped plan");
	expect(after).not.toContain("20261020_1300_drop.md");
	const cancelledList = readFileSync(join(TOY, "docs/plans/CANCELLED.md"), "utf8");
	expect(cancelledList).toContain("20261020_1300_drop.md");
});

// --- P5e-b: --help must print the usage and exit 0 (it used to die "--help is not listed") ---

function childEnv(home: string): NodeJS.ProcessEnv {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home };
	for (const k of Object.keys(env)) if (k.startsWith("QUEUE_")) delete env[k];
	return env;
}

function gitRun(...args: string[]): SpawnSyncReturns<string> {
	return spawnSync("git", args, { encoding: "utf8" });
}

const CLI = join(import.meta.dir, "..", "src/cli/main.ts");

test("queue-close --help prints the usage and exits 0", () => {
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:\n  home: "${HOME}"\n  work_roots: ["${TOY}"]\n  agent_dir: "${AGENT}"\n  queue_index: "${INDEX}"\n  blockers: "${join(AGENT, "blockers")}"\n  queue_state: "${QUEUE_STATE}"\n  subagents: "${join(AGENT, "notes/subagents.md")}"\n  cancelled: "${join(AGENT, "CANCELLED.md")}"\n  unlock: "${join(AGENT, ".guard-unlock")}"\n  guard_log: "${join(HOME, "main-guard.log")}"\n  plan_guard_log: "${join(HOME, "plan-guard.log")}"\n`,
	);
	const r = spawnSync("bun", [CLI, "queue-close", "--help"], { env: childEnv(HOME), encoding: "utf8" });
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("usage: queue-close");
});

// --- P5e-f: the upstream default branch can be gone (renamed, pruned); the close falls back to
// the local base ref, then the local main branch, instead of refusing ---

test("queue-close still closes when the upstream default branch is gone: it falls back to the local base", () => {
	const U = mkdtempSync(join(tmpdir(), "ns-qclose-upstream-"));
	try {
		const UHOME = join(U, "home");
		const UAGENT = join(UHOME, "agent");
		const USTATE = join(UHOME, "state");
		const UIX = join(UAGENT, "INDEX.md");
		const REMOTE = join(U, "remote.git");
		const SEED = join(U, "seed");
		const UCLONE = join(UHOME, "projects/toy");
		for (const d of [join(UAGENT, "blockers"), join(UHOME, ".config/neurastream"), USTATE]) mkdirSync(d, { recursive: true });
		// The plan template names the no-push blocker; the parser requires it to be an executable file.
		const blocker = join(UAGENT, "blockers/no-push");
		writeFileSync(blocker, "#!/bin/sh\nexit 0\n");
		chmodSync(blocker, 0o755);
		writeFileSync(
			join(UHOME, ".config/neurastream/config.yml"),
			`paths:\n  home: "${UHOME}"\n  work_roots: ["${UCLONE}"]\n  agent_dir: "${UAGENT}"\n  queue_index: "${UIX}"\n  blockers: "${join(UAGENT, "blockers")}"\n  queue_state: "${USTATE}"\n  subagents: "${join(UAGENT, "notes/subagents.md")}"\n  cancelled: "${join(UAGENT, "CANCELLED.md")}"\n  unlock: "${join(UAGENT, ".guard-unlock")}"\n  guard_log: "${join(UHOME, "main-guard.log")}"\n  plan_guard_log: "${join(UHOME, "plan-guard.log")}"\n`,
		);
		gitRun("init", "-q", "-b", "main", SEED);
		writeFileSync(join(SEED, "f.txt"), "x\n");
		gitRun("-C", SEED, "add", "f.txt");
		gitRun("-C", SEED, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
		// The remote is a bare clone (never a push): no host git hook can interfere, and the remote
		// starts with main exactly as the source left it. The bare clone carries origin→seed in its
		// config; cut it, or the hop-follow walks to seed and the fetch there succeeds, never
		// exercising the fallback.
		gitRun("clone", "-q", "--bare", SEED, REMOTE);
		gitRun("-C", REMOTE, "remote", "remove", "origin");
		gitRun("clone", "-q", REMOTE, UCLONE);
		// The clone already made its local copy of origin/main; now the upstream branch disappears.
		gitRun("-C", REMOTE, "branch", "-D", "main");
		const UPLAN = join(UCLONE, "docs/plans/20261020_1500_upstream.md");
		mkdirSync(join(UCLONE, "docs/plans"), { recursive: true });
		writeFileSync(UPLAN, plan("Upstream plan", "complete", []));
		writeFileSync(UIX, `${UPLAN}\n`);
		const r = spawnSync("bun", [CLI, "queue-close", UPLAN], { env: childEnv(UHOME), encoding: "utf8" });
		// The fallback must be loud (a stale local base hides the fetch error from the landing
		// check) but never refuse the close.
		expect(r.stderr).toContain("warning:");
		expect(r.stderr).toContain("stale local base");
		expect(r.stderr).not.toContain("REFUSED");
		expect(r.status).toBe(0);
		const month = new Date().toISOString().slice(0, 7).replace("-", "");
		expect(existsSync(join(UCLONE, "docs/plans/archive", month, "20261020_1500_upstream.md"))).toBe(true);
	} finally {
		rmSync(U, { recursive: true, force: true });
	}
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	for (const [k, v] of Object.entries(queueEnvBefore)) if (v !== undefined) process.env[k] = v;
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});
