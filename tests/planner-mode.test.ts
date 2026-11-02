// Planner mode (plan 20261102_1515 P1): the owner's `planner main|delegated` switch — the
// state file beside the tier file, the config default, and the `config set` door. Everything
// runs in-process against a sandbox HOME (applyQueueEnv points the queue library at it; the
// caller's QUEUE_* env is restored afterAll).

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigKeys } from "../src/cli/config-set.ts";
import { chatPlanner, currentPlanner, plannerFile } from "../src/core/autonomy.ts";
import { configFile, loadConfig, type Config } from "../src/core/config.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";

const roots: string[] = [];
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let cfg: Config;

const UNLOCKED = (planner: "main" | "delegated" = "main"): string =>
	`paths:
  home: "${root}"
  queue_state: "${root}/state"
  plan_guard_log: "${root}/plan-guard.log"
guards:
  chat_unlock: true
autonomy:
  planner: ${planner}
`;

function load(text: string): Config {
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(configFile(root), text);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	env.HOME = root;
	return loadConfig({ home: root, env });
}

function writePlannerFile(word: string): void {
	mkdirSync(join(root, "state"), { recursive: true });
	writeFileSync(plannerFile(), `${word}\n`);
}

function clearPlannerFile(): void {
	rmSync(plannerFile(), { force: true });
}

function plannerLogLines(): string[] {
	try {
		return readFileSync(cfg.paths.plan_guard_log, "utf8").split("\n").filter((l) => / PLANNER /.test(l));
	} catch {
		return [];
	}
}

// Runs fn with console.log/error captured; the real console is restored even when fn throws.
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
	console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
	try {
		const code = await fn();
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-planner-"));
	roots.push(root);
	clearPlannerFile();
	cfg = load(UNLOCKED());
	applyQueueEnv(cfg);
	clearPlannerFile();
});

// --- currentPlanner ---

test("no planner file: the config default main is in force", () => {
	expect(cfg.autonomy.planner).toBe("main");
	expect(currentPlanner(cfg)).toBe("main");
	expect(existsSync(plannerFile())).toBe(false);
});

// --- chatPlanner: a non-owner source changes nothing ---

test("chat unlock off: the switch refuses and writes nothing", () => {
	const locked = load(UNLOCKED().replace("chat_unlock: true", "chat_unlock: false"));
	applyQueueEnv(locked);
	expect(chatPlanner("planner delegated", locked, "interactive")).toEqual({ applied: false });
	expect(existsSync(plannerFile())).toBe(false);
});

test("anything that is not the whole-message `planner <mode>` command is ignored", () => {
	for (const text of ["planner", "planner sideways", "please planner delegated", "planner delegated now", "delegated", ""]) {
		expect(chatPlanner(text, cfg, "interactive")).toEqual({ applied: false });
	}
	expect(existsSync(plannerFile())).toBe(false);
	expect(plannerLogLines()).toEqual([]);
});

// --- chatPlanner: the owner path ---

test("planner delegated writes the file, logs PLANNER with the source, and currentPlanner reads it back", () => {
	const r = chatPlanner("planner delegated", cfg, "interactive");
	expect(r).toEqual({ applied: true, planner: "delegated" });
	expect(readFileSync(plannerFile(), "utf8")).toBe("delegated\n");
	expect(currentPlanner(cfg)).toBe("delegated");
	expect(plannerLogLines().join("\n")).toContain(" PLANNER delegated chat source=interactive");
});

test("matching is trimmed and case-insensitive", () => {
	expect(chatPlanner("  PLANNER Delegated  ", cfg, "interactive")).toEqual({ applied: true, planner: "delegated" });
	expect(currentPlanner(cfg)).toBe("delegated");
});

test("planner main returns to the default", () => {
	writePlannerFile("delegated");
	expect(chatPlanner("planner main", cfg, "interactive")).toEqual({ applied: true, planner: "main" });
	expect(readFileSync(plannerFile(), "utf8")).toBe("main\n");
	expect(currentPlanner(cfg)).toBe("main");
});

test("junk in the file falls back to the config value", () => {
	writePlannerFile("banana");
	expect(currentPlanner(cfg)).toBe("main");
});

// --- config set door ---

test("config set autonomy.planner round-trips: set, get, effective mode, back to main", async () => {
	expect(currentPlanner(cfg)).toBe("main");
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "delegated"], root))).code).toBe(0);
	const got = await capture(() => runConfigKeys(["get", "autonomy.planner"], root));
	expect(got.code).toBe(0);
	expect(got.out).toBe("delegated");
	// No state file: the effective mode follows the config door.
	const delegated = load(UNLOCKED("delegated"));
	applyQueueEnv(delegated);
	expect(delegated.autonomy.planner).toBe("delegated");
	expect(currentPlanner(delegated)).toBe("delegated");
	// The owner's chat switch wins over the config default.
	writePlannerFile("main");
	expect(currentPlanner(delegated)).toBe("main");
	clearPlannerFile();
	expect((await capture(() => runConfigKeys(["set", "autonomy.planner", "main"], root))).code).toBe(0);
	expect((await capture(() => runConfigKeys(["get", "autonomy.planner"], root))).out).toBe("main");
});

test("a bad planner value is refused by config set and the file is untouched", async () => {
	const before = readFileSync(configFile(root), "utf8");
	const set = await capture(() => runConfigKeys(["set", "autonomy.planner", "sideways"], root));
	expect(set.code).toBe(1);
	expect(readFileSync(configFile(root), "utf8")).toBe(before);
	expect(currentPlanner(cfg)).toBe("main");
});
