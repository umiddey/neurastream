// Autonomy tiers (I-20261025-177): the core tier file, the owner's chat commands
// (guards.chat_unlock, the same flag and trust rules as chatUnlock) and the one-shot `go`.
// Everything runs in-process against a sandbox HOME (applyQueueEnv points the queue library at
// it; the caller's QUEUE_* env is restored afterAll).

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";
import { chatGo, chatTier, currentTier, goFile, takeGo, tierFile } from "../src/core/autonomy.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";

const roots: string[] = [];
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let agentDir: string;
let repo: string;
let cfg: Config;

const AUTONOMY_OK = "  tier: opinionated\n  strict_edit_limit: 2\n  go_minutes: 10\n";

function load(autonomy = AUTONOMY_OK, chatUnlock = true): Config {
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(
		join(root, ".config/neurastream/config.yml"),
		`paths:
  home: "${root}"
  agent_dir: "${agentDir}"
  queue_index: "${agentDir}/INDEX.md"
  blockers: "${agentDir}/blockers"
  queue_state: "${root}/state"
  subagents: "${agentDir}/subagents.md"
  cancelled: "${agentDir}/CANCELLED.md"
  unlock: "${agentDir}/.guard-unlock"
  guard_log: "${root}/guard.log"
  plan_guard_log: "${root}/plan-guard.log"
  work_roots: ["${repo}"]
guards:
  chat_unlock: ${chatUnlock}
autonomy:
${autonomy}`,
	);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	env.HOME = root;
	return loadConfig({ home: root, env });
}

function readTier(): string {
	return readFileSync(tierFile(), "utf8");
}

function tierLogLines(): string[] {
	try {
		return readFileSync(cfg.paths.plan_guard_log, "utf8").split("\n").filter(l => / TIER | GO /.test(l));
	} catch {
		return [];
	}
}

function setTier(tier: "strict" | "opinionated" | "full"): void {
	mkdirSync(join(root, "state"), { recursive: true });
	writeFileSync(tierFile(), `${tier}\n`);
}

function clearTier(): void {
	rmSync(tierFile(), { force: true });
	rmSync(goFile(), { force: true });
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-autonomy-"));
	roots.push(root);
	agentDir = join(root, "agent");
	repo = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "state"), { recursive: true });
	mkdirSync(repo, { recursive: true });
	cfg = load();
	applyQueueEnv(cfg);
	clearTier();
});

// --- currentTier ---

test("no tier file: the config value is in force", () => {
	expect(currentTier(cfg)).toBe("opinionated");
	expect(existsSync(tierFile())).toBe(false);
});

test("the tier file wins when it names one of the three; junk falls back to the config", () => {
	setTier("full");
	expect(currentTier(cfg)).toBe("full");
	writeFileSync(tierFile(), "banana");
	expect(currentTier(cfg)).toBe("opinionated");
});

// --- chatTier ---

test("tier full sets the file, logs TIER with the source, and the tier follows", () => {
	const r = chatTier("tier full", cfg, "interactive");
	expect(r).toEqual({ applied: true, tier: "full" });
	expect(readTier()).toBe("full\n");
	const lines = tierLogLines();
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain("TIER full chat source=interactive");
	expect(currentTier(cfg)).toBe("full");
});

test("TIER Strict: matching is trimmed and case-insensitive", () => {
	const r = chatTier("  TIER Strict  ", cfg, "interactive");
	expect(r).toEqual({ applied: true, tier: "strict" });
	expect(readTier()).toBe("strict\n");
	expect(currentTier(cfg)).toBe("strict");
});

test("anything but the whole-message command changes nothing and logs nothing", () => {
	for (const text of ["tier nope", "please tier full", "tier", "tier full now", "full"]) {
		expect(chatTier(text, cfg, "interactive").applied).toBe(false);
	}
	expect(existsSync(tierFile())).toBe(false);
	expect(tierLogLines()).toEqual([]);
});

test("guards.chat_unlock off: even a real command changes nothing", () => {
	cfg = load(AUTONOMY_OK, false);
	applyQueueEnv(cfg);
	expect(chatTier("tier full", cfg, "interactive").applied).toBe(false);
	expect(existsSync(tierFile())).toBe(false);
	expect(chatGo("go", cfg, "interactive").applied).toBe(false);
	expect(existsSync(goFile())).toBe(false);
	expect(tierLogLines()).toEqual([]);
});

// --- chatGo / takeGo ---

test("go touches the file; takeGo consumes it exactly once", () => {
	const r = chatGo("go", cfg, "interactive");
	expect(r).toEqual({ applied: true, minutes: 10 });
	expect(existsSync(goFile())).toBe(true);
	expect(takeGo(cfg)).toBe(true);
	expect(existsSync(goFile())).toBe(false);
	expect(takeGo(cfg)).toBe(false);
	expect(tierLogLines()[0]).toContain("GO chat source=interactive minutes=10");
});

test("only the whole message counts: go ahead does nothing,  GO  does", () => {
	expect(chatGo("go ahead", cfg, "interactive").applied).toBe(false);
	expect(chatGo("  GO  ", cfg, "interactive").applied).toBe(true);
});

test("a stale go is refused and removed", () => {
	writeFileSync(goFile(), "");
	// Backdate the mtime past go_minutes.
	const past = (Date.now() - 11 * 60_000) / 1000; // utimesSync takes seconds
	utimesSync(goFile(), past, past);
	expect(takeGo(cfg)).toBe(false);
	expect(existsSync(goFile())).toBe(false);
});

test("takeGo with no file at all is false", () => {
	expect(takeGo(cfg)).toBe(false);
});

// --- config checks ---

test("bad autonomy config values are ConfigErrors", () => {
	for (const autonomy of [
		"  tier: nope\n  strict_edit_limit: 2\n  go_minutes: 10\n",
		"  tier: strict\n  strict_edit_limit: 0\n  go_minutes: 10\n",
		"  tier: strict\n  strict_edit_limit: 2.5\n  go_minutes: 10\n",
		"  tier: strict\n  strict_edit_limit: 2\n  go_minutes: 0\n",
	]) {
		root = mkdtempSync(join(tmpdir(), "neurastream-autonomy-bad-"));
		roots.push(root);
		agentDir = join(root, "agent");
		repo = join(root, "repo");
		expect(() => load(autonomy)).toThrow(ConfigError);
	}
});
