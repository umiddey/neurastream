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

const AUTONOMY_OK = '  tier: opinionated\n  strict_edit_limit: 2\n  go_minutes: 10\n  go_phrase: "go push"\n';

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
	expect(chatGo("go push", cfg, "interactive").applied).toBe(false);
	expect(existsSync(goFile())).toBe(false);
	expect(tierLogLines()).toEqual([]);
});

// --- chatGo / takeGo ---

// I-20261025-201: the approve phrase is config autonomy.go_phrase (default "go push"); a bare
// "go" is the owner's everyday word, so it approves nothing.

test("a bare go is an ordinary message: nothing applied, no autonomy-go file", () => {
	expect(chatGo("go", cfg, "interactive").applied).toBe(false);
	expect(chatGo("  GO  ", cfg, "interactive").applied).toBe(false);
	expect(existsSync(goFile())).toBe(false);
	expect(takeGo(cfg)).toBe(false);
	expect(tierLogLines()).toEqual([]);
});

test("the approve phrase touches the file; takeGo consumes it exactly once", () => {
	const r = chatGo("go push", cfg, "interactive");
	expect(r).toEqual({ applied: true, minutes: 10 });
	expect(existsSync(goFile())).toBe(true);
	expect(takeGo(cfg)).toBe(true);
	expect(existsSync(goFile())).toBe(false);
	expect(takeGo(cfg)).toBe(false);
	expect(tierLogLines()[0]).toContain("GO chat source=interactive minutes=10");
});

test("matching is the whole trimmed message, case-insensitive, inner spaces collapsed", () => {
	expect(chatGo(" Go  Push ", cfg, "interactive").applied).toBe(true);
	rmSync(goFile(), { force: true });
	expect(chatGo("go\t push", cfg, "interactive").applied).toBe(true);
	rmSync(goFile(), { force: true });
	expect(chatGo("go push now", cfg, "interactive").applied).toBe(false);
	expect(chatGo("go  pushes", cfg, "interactive").applied).toBe(false);
	expect(existsSync(goFile())).toBe(false);
});

test("a custom go_phrase replaces the default: ship it works, go push does not", () => {
	cfg = load('  tier: opinionated\n  strict_edit_limit: 2\n  go_minutes: 10\n  go_phrase: "ship it"\n');
	applyQueueEnv(cfg);
	clearTier();
	expect(chatGo("Ship it", cfg, "interactive").applied).toBe(true);
	expect(tierLogLines()[0]).toContain("GO chat source=interactive minutes=10");
	rmSync(goFile(), { force: true });
	expect(chatGo("go push", cfg, "interactive").applied).toBe(false);
	expect(chatGo("go", cfg, "interactive").applied).toBe(false);
	expect(existsSync(goFile())).toBe(false);
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
		'  tier: strict\n  strict_edit_limit: 2\n  go_minutes: 10\n  go_phrase: ""\n',
	]) {
		root = mkdtempSync(join(tmpdir(), "neurastream-autonomy-bad-"));
		roots.push(root);
		agentDir = join(root, "agent");
		repo = join(root, "repo");
		expect(() => load(autonomy)).toThrow(ConfigError);
	}
});

// --- P2: the guards follow the tier (src/core/guards.ts) ---

import { checkInject, checkTool, priorityProblem } from "../src/core/guards.ts";
import type { ToolEvent } from "../src/core/adapter.ts";
import type { Plan } from "../src/core/queue/lib.ts";

const NOW = 1760000000;

function mainEvent(tool: string, input: Record<string, unknown>): ToolEvent {
	return { tool, input, cwd: repo, agent: "main", agentId: "main", calls: 0, paths: [], writes: [], command: String(input?.command ?? "") };
}

/** A change Main is allowed to make (a scratch file in the repo), counted by the edit window. */
function editCall(n: number): ToolEvent {
	const f = join(repo, `scratch-${n}.ts`);
	writeFileSync(f, "export const a = 1;\n");
	return mainEvent("write", { path: f, content: "export const a = 2;\n" });
}

function planAt(file: string, status: "open" | "complete" = "open"): Plan {
	return {
		repo,
		file,
		text: "# toy\n\n## Phases\n- [ ] P1 do the thing\n",
		status,
		blockers: [],
		doneCheck: null,
		worktree: null,
		branch: null,
		appliesTo: [],
		waiting: false,
		waitingLine: null,
		waitingAsk: null,
		waitingBlocked: null,
		waitingWhy: null,
		waitingCheck: null,
		waitsOn: [],
		priorityId: null,
		title: file,
		goal: [],
		summary: null,
		phases: { done: 0, total: 1 },
		started: false,
		errors: [],
	};
}

const HIGH = () => join(repo, "docs/plans/20261020_0100_high.md");
const LOW = () => join(repo, "docs/plans/20261020_0102_low.md");

test("tier strict caps Main's changes at autonomy.strict_edit_limit and names the tier", () => {
	setTier("strict");
	for (let i = 1; i <= 2; i++) expect(checkTool(editCall(i), cfg).allow).toBe(true);
	const d = checkTool(editCall(3), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("tier strict");
	expect(d.reason).toContain("autonomy.strict_edit_limit 2");
});

test("tier opinionated keeps today's cap of guards.main_edit_limit", () => {
	setTier("opinionated");
	for (let i = 1; i <= 5; i++) expect(checkTool(editCall(i), cfg).allow).toBe(true);
	const d = checkTool(editCall(6), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("tier opinionated");
	expect(d.reason).toContain("owner limit 5");
});

test("tier full has no edit cap and no warning inject", () => {
	setTier("full");
	for (let i = 1; i <= 8; i++) {
		const d = checkTool(editCall(i), cfg);
		expect(d.allow).toBe(true);
		expect(d.inject).toBeUndefined();
	}
});

test("checkInject names the tier instead of the bare edit-limit line", () => {
	setTier("strict");
	const d = checkInject({ agent: "main", inject: "what is next" }, cfg);
	expect(d.inject).toContain("autonomy: strict —");
	expect(d.inject).toContain('"go push"');
	expect(d.inject).not.toContain("Main may change project files at most");
	setTier("full");
	const f = checkInject({ agent: "main", inject: "what is next" }, cfg);
	expect(f.inject).toContain("autonomy: full —");
	expect(f.inject).toContain("no edit cap");
});

// --- P2: the strict landing gate ---

const PUSH = "git push origin feat/toy";

test("tier strict refuses Main's push/merge without the approve phrase", () => {
	setTier("strict");
	const d = checkTool(mainEvent("bash", { command: PUSH }), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toBe('main-guard: tier strict — type "go push" to approve one push/merge');
	const m = checkTool(mainEvent("bash", { command: "glab mr merge 141" }), cfg);
	expect(m.allow).toBe(false);
	const h = checkTool(mainEvent("bash", { command: "gh pr merge 12 --squash" }), cfg);
	expect(h.allow).toBe(false);
});

test("tier strict sees the push through sh -c, sudo, env and chains", () => {
	setTier("strict");
	for (const command of [`sh -c '${PUSH}'`, "sudo git push origin main", `bun run typecheck && ${PUSH}`, "env GIT=1 git push"]) {
		expect(checkTool(mainEvent("bash", { command }), cfg).allow).toBe(false);
	}
});

test("a standing go lets exactly one landing through", () => {
	setTier("strict");
	expect(chatGo("go push", cfg, "interactive").applied).toBe(true);
	expect(checkTool(mainEvent("bash", { command: PUSH }), cfg).allow).toBe(true);
	const second = checkTool(mainEvent("bash", { command: PUSH }), cfg);
	expect(second.allow).toBe(false);
	expect(second.reason).toContain('type "go push"');
});

test("a message that is not the whole phrase approves nothing", () => {
	setTier("strict");
	expect(chatGo("please go", cfg, "interactive").applied).toBe(false);
	expect(chatGo("go push later", cfg, "interactive").applied).toBe(false);
	expect(checkTool(mainEvent("bash", { command: PUSH }), cfg).allow).toBe(false);
});

test("opinionated and full keep today's push allowance", () => {
	setTier("opinionated");
	expect(checkTool(mainEvent("bash", { command: PUSH }), cfg).allow).toBe(true);
	setTier("full");
	expect(checkTool(mainEvent("bash", { command: PUSH }), cfg).allow).toBe(true);
});

test("full never loosens the owner-only moves: protected write and ui start stay refused", () => {
	setTier("full");
	const d = checkTool(mainEvent("write", { path: join(agentDir, ".guard-unlock"), content: "" }), cfg);
	expect(d.allow).toBe(false);
	expect(d.reason).toContain("protected guard file");
	const ui = checkTool(mainEvent("bash", { command: "systemctl --user restart neurastream-ui" }), cfg);
	expect(ui.allow).toBe(false);
	expect(ui.reason).toContain("starting the owner page");
});

// --- P2: the priority gate in full ---

test("priority skip with a Main reason passes only in tier full", () => {
	const plans = [planAt(HIGH()), planAt(LOW())];
	const brief = `Priority skip: ${HIGH()} — Main: "the traces series is blocked on the owner"`;
	// strict and opinionated: refused exactly as today
	setTier("strict");
	const s = priorityProblem(plans, [LOW()], [], brief, [], NOW, cfg);
	expect(s?.problem).toContain("a skip needs the owner's words");
	setTier("opinionated");
	expect(priorityProblem(plans, [LOW()], [], brief, [], NOW, cfg)?.problem).toContain("a skip needs the owner's words");
	// full: Main's own >= 4-word reason goes through
	setTier("full");
	expect(priorityProblem(plans, [LOW()], [], brief, [], NOW, cfg)).toEqual({
		skips: [{ plan: HIGH(), why: 'Main: "the traces series is blocked on the owner"' }],
	});
	// a short reason is not a reason
	const short = `Priority skip: ${HIGH()} — Main: "do it"`;
	expect(priorityProblem(plans, [LOW()], [], short, [], NOW, cfg)?.problem).toContain("a skip needs the owner's words");
	// the owner's recorded words still work in full
	const said = [{ at: NOW, text: "the traces series gets first prio today" }];
	const ownerBrief = `Priority skip: ${HIGH()} — owner: "traces series gets first"`;
	expect(priorityProblem(plans, [LOW()], [], ownerBrief, said, NOW, cfg)).toEqual({
		skips: [{ plan: HIGH(), why: 'owner: "traces series gets first"' }],
	});
});
