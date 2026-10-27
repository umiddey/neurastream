// Project rules through the omp adapter (plan 20261027_1530 P2-P3). A subagent's first turn carries
// the AGENTS.md of the repo its plan is worked in, plus the owner's burden rule read from the
// template. Main's queue inject gains a repo's AGENTS.md the first time the session touches that
// repo, and again only when the file changes — never every prompt.
//
// The adapter is driven in-process over a fake host, with the queue pointed at a sandbox home.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpAdapter, type ExtensionHost } from "../src/adapters/omp/index.ts";
import { burdenRule } from "../src/core/repo-rules.ts";
import { loadConfig, type Config } from "../src/core/config.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const TMP = mkdtempSync(join(tmpdir(), "omp-adapter-"));
const HOME = join(TMP, "home");
const REPO = join(TMP, "repo");
const AGENTS = join(REPO, "AGENTS.md");
const PLAN = join(REPO, "docs/plans/20261027_toy.md");
const INDEX = join(HOME, ".config/neurastream/INDEX.md");
const STATE = join(HOME, ".local/state/queue");
const SESSION_FILE = join(TMP, "session.jsonl");

// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); the sandbox must
// win, so loadConfig sees no overrides and the saved vars are put back at the end.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

const CFG: Config = loadConfig({ home: HOME, env: {} });
const RULE = burdenRule();

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

const PLAN_TEXT = `# Toy plan

Worktree: -
Branch: feat/toy

## Goal
- Toy.

## Progress
Status: open
`;

/** A fresh sandbox: an empty queue, one open plan in a real git repo, and that repo's rules. */
function fresh(rules = "# repo rules\n\n- No push.\n"): void {
	rmSync(REPO, { recursive: true, force: true });
	rmSync(join(HOME, ".config"), { recursive: true, force: true });
	rmSync(STATE, { recursive: true, force: true });
	mkdirSync(join(REPO, "docs/plans"), { recursive: true });
	mkdirSync(join(HOME, ".config/neurastream"), { recursive: true });
	writeFileSync(PLAN, PLAN_TEXT);
	writeFileSync(INDEX, `${PLAN}\n`);
	if (rules !== "") writeFileSync(AGENTS, rules);
	writeFileSync(SESSION_FILE, "");
	const r = spawnSync("git", ["init", "-q"], { cwd: REPO });
	if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
}

interface Msg {
	customType: string;
	content: string;
}

/** The handler's return as a message, read one checked field at a time (the boundary is untyped). */
function messageOf(x: unknown): Msg {
	const out: Msg = { customType: "", content: "" };
	if (!x || typeof x !== "object" || !("message" in x)) return out;
	const message = x.message;
	if (!message || typeof message !== "object") return out;
	if ("customType" in message && typeof message.customType === "string") out.customType = message.customType;
	if ("content" in message && typeof message.content === "string") out.content = message.content;
	return out;
}

function adapter(): { emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> } {
	const handlers = new Map<string, Handler[]>();
	const host: ExtensionHost = {
		on(event, cb) {
			handlers.set(event, [...(handlers.get(event) ?? []), cb]);
		},
		registerCommand() {},
		sendUserMessage() {},
		sendMessage() {},
	};
	createOmpAdapter(host, CFG);
	return {
		async emit(event, payload, ctx) {
			const out: unknown[] = [];
			for (const cb of handlers.get(event) ?? []) {
				const r = await cb(payload, ctx);
				if (r !== undefined) out.push(r);
			}
			return out;
		},
	};
}

function subCtx(id: string): Record<string, unknown> {
	return { agent: { kind: "sub", id }, cwd: TMP };
}

function mainCtx(): Record<string, unknown> {
	return {
		agent: { kind: "main", id: "main" },
		cwd: TMP,
		sessionManager: { getSessionId: () => `omp-adapter-${process.pid}`, getSessionFile: () => SESSION_FILE },
	};
}

// --- P2: subagents ---

test("sub with a plan brief: the repo AGENTS.md and the burden rule, then nothing on the next turn", async () => {
	fresh();
	const { emit } = adapter();
	const prompt = `Plan: ${PLAN}\n\nDo P1.`;
	const out = await emit("before_agent_start", { prompt }, subCtx("w1"));
	expect(out.length).toBe(1);
	const msg = messageOf(out[0]);
	expect(msg.content).toBe(`Repo rules (${AGENTS}):\n# repo rules\n\n- No push.\n\n\n${RULE}`);
	// Same brief, same session: the text is already in its context.
	expect(await emit("before_agent_start", { prompt }, subCtx("w1"))).toEqual([]);
});

test("sub without a plan: only the owner's burden rule from the template", async () => {
	fresh();
	const { emit } = adapter();
	const out = await emit("before_agent_start", { prompt: "do the thing" }, subCtx("w2"));
	expect(out.length).toBe(1);
	expect(messageOf(out[0]).content).toBe(RULE);
	expect(RULE).toContain("- Code is a burden:");
});

test("Main: the queue inject is unchanged while no repo is touched", async () => {
	fresh();
	const { emit } = adapter();
	const out = await emit("before_agent_start", { prompt: "hi" }, mainCtx());
	expect(out.length).toBe(1);
	const msg = messageOf(out[0]);
	expect(msg.customType).toBe("main-guard.queue");
	expect(msg.content).toContain("INDEX.md");
	expect(msg.content).not.toContain("Repo rules (");
});
