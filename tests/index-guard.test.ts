// P1 red tests (cases a-e) of plan 20261031_0911_forced_close_index_guard: the queue index can
// only grow. A removal without a close/cancel reason throws and leaves the file unchanged (a),
// the same set in a new order writes (b), every write leaves the file 0444 so even a plain
// writeFileSync throws EACCES (c), checkTool guards the index path like a guard file with the
// owner unlock as the only exception (d), and a QUEUE_INDEX exported before the run never leaks
// past the test preload: a sandboxed loadConfig gets a queue_index under its sandbox home (e).
// Each case fails on origin/main: writeIndex, the index protection and tests/preload.ts do not
// exist yet.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEvent } from "../src/core/adapter.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { checkTool } from "../src/core/guards.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { refreshQueuePaths } from "../src/core/queue/lib.ts";

// Captured before any test runs: the sentinel this run was started with (heavy-run env), so the
// preload case can prove the sentinel never survives into a sandboxed loadConfig.
const RUN_QUEUE_INDEX = process.env.QUEUE_INDEX;

const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));

const TMP = mkdtempSync(join(tmpdir(), "ns-idx-guard-"));

interface Sandbox {
	cfg: Config;
	home: string;
	agent: string;
	toy: string;
	index: string;
	state: string;
	blockers: string;
}

function seed(): Sandbox {
	const home = mkdtempSync(join(TMP, "case-"));
	const agent = join(home, ".omp/agent");
	const toy = join(home, "projects/toy");
	const state = join(home, ".local/state/queue");
	const blockers = join(agent, "blockers");
	for (const d of [blockers, join(toy, "docs/plans"), join(home, ".config/neurastream"), state]) mkdirSync(d, { recursive: true });
	writeFileSync(join(blockers, "no-push"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(blockers, "no-push"), 0o755);
	writeFileSync(
		join(home, ".config/neurastream/config.yml"),
		`paths:
  home: "${home}"
  work_roots: ["${toy}"]
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${blockers}"
  queue_state: "${state}"
  subagents: "${join(agent, "notes/subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(home, "main-guard.log")}"
  plan_guard_log: "${join(home, "plan-guard.log")}"
`,
	);
	return { cfg: loadConfig({ home, env: {} }), home, agent, toy, index: join(agent, "INDEX.md"), state, blockers };
}

afterAll(() => {
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_") && !(k in queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	refreshQueuePaths();
	rmSync(TMP, { recursive: true, force: true });
});

type WriteIndex = (lines: string[], why?: { removed?: "close" | "cancel" | "migrate" }) => void;

// Dynamic import on purpose (test exercising a module-loading boundary): src/core/queue/lib.ts
// does not export writeIndex yet — plan P2 adds it — so a static import would crash this whole
// file at load instead of failing each case with the missing behaviour as the reason.
async function writeIndex(): Promise<WriteIndex> {
	const mod = (await import("../src/core/queue/lib.ts")) as { writeIndex?: WriteIndex };
	if (typeof mod.writeIndex !== "function")
		throw new Error(`writeIndex does not exist in src/core/queue/lib.ts yet (plan P2): got ${String(mod.writeIndex)}`);
	return mod.writeIndex;
}

test("(e) QUEUE_INDEX set before the run never leaks: loadConfig({ home }) gets a queue_index under the sandbox home", () => {
	const s = seed();
	// The preload deleted every inherited QUEUE_* var before this module loaded, so the index
	// resolves from the sandbox config, not from the sentinel this run was started with. Without
	// the preload the sentinel would win over the config file (loadConfig applies env over it).
	const cfg = loadConfig({ home: s.home });
	expect(cfg.paths.queue_index.startsWith(s.home)).toBe(true);
	expect(cfg.paths.queue_index).not.toBe(RUN_QUEUE_INDEX);
});

test("(a) writeIndex refuses to remove a plan without a close/cancel reason and leaves the file unchanged", async () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	const a = join(s.toy, "docs/plans/20261020_1200_a.md");
	const b = join(s.toy, "docs/plans/20261020_1300_b.md");
	writeFileSync(s.index, `${a}\n${b}\n`);
	const w = await writeIndex();
	const before = readFileSync(s.index, "utf8");
	expect(() => w([a])).toThrow();
	expect(readFileSync(s.index, "utf8")).toBe(before);
});

test("(b) writeIndex writes the same set in a new order", async () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	const a = join(s.toy, "docs/plans/20261020_1200_a.md");
	const b = join(s.toy, "docs/plans/20261020_1300_b.md");
	writeFileSync(s.index, `${a}\n${b}\n`);
	const w = await writeIndex();
	w([b, a]);
	expect(readFileSync(s.index, "utf8")).toBe(`${b}\n${a}\n`);
});

test("(c) after any writeIndex the file is 0444 and a plain writeFileSync throws EACCES", async () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	const a = join(s.toy, "docs/plans/20261020_1200_a.md");
	const b = join(s.toy, "docs/plans/20261020_1300_b.md");
	writeFileSync(s.index, `${a}\n${b}\n`);
	const w = await writeIndex();
	w([b, a]);
	expect(statSync(s.index).mode & 0o777).toBe(0o444);
	expect(() => writeFileSync(s.index, "x")).toThrow(/EACCES/);
	expect(readFileSync(s.index, "utf8")).toBe(`${b}\n${a}\n`);
});

function toolEvent(s: Sandbox, tool: string, input: Record<string, unknown>, writes: string[]): ToolEvent {
	return { tool, input, cwd: s.toy, agent: "main", agentId: "main", calls: 1, paths: writes, writes, command: "" };
}

test("(d) checkTool refuses Main's write/edit/bash on the index path; the owner unlock allows it", () => {
	const s = seed();
	applyQueueEnv(s.cfg);
	const a = join(s.toy, "docs/plans/20261020_1200_a.md");
	const b = join(s.toy, "docs/plans/20261020_1300_b.md");
	writeFileSync(s.index, `${a}\n${b}\n`);
	const calls: [string, Record<string, unknown>][] = [
		["write", { file_path: s.index, content: "hijacked" }],
		["edit", { file_path: s.index, old_string: a, new_string: "gone" }],
		["bash", { command: `echo hijacked > ${s.index}` }],
	];
	for (const [tool, input] of calls) {
		const d = checkTool(toolEvent(s, tool, input, [s.index]), s.cfg);
		expect(d.allow).toBe(false);
	}
	// The owner's unlock is the one exception, exactly like for the other guard files.
	writeFileSync(s.cfg.paths.unlock, "");
	const ok = checkTool(toolEvent(s, "write", { file_path: s.index, content: "hijacked" }, [s.index]), s.cfg);
	expect(ok.allow).toBe(true);
});
