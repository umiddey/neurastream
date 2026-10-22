// agent-ledger: a helper whose last assistant message is a final answer (stopReason stop/end_turn
// plus text, no yield toolResult) is done, not RUNNING. omp delivers such a run as status
// "completed": there is nothing left to wait for, yet the ledger kept it RUNNING and flagged it
// OVER-BUDGET past the call cap, which blocked every spawn at agent-ledger --cap. A helper still
// working (last assistant toolUse) stays RUNNING and keeps OVER-BUDGET; a MAIN session keeps
// today's rule.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompRunSource } from "../src/adapters/omp/sessions.ts";
import { loadConfig } from "../src/core/config.ts";
import type { Run } from "../src/core/adapter.ts";

const TMP = mkdtempSync(join(tmpdir(), "ledger-final-text-"));
// Inherited QUEUE_* (the caller's live session, or an in-process adapter in an earlier test
// file) beats the sandbox config in loadConfig below; save and delete them before it runs;
// afterAll restores them.
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
afterAll(() => {
	for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
	rmSync(TMP, { recursive: true, force: true });
});

// A throwaway home, as in tests/rollover-omp.test.ts: the live config must not be read here.
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];
const cfg = loadConfig({ home: join(TMP, "home") });
const SESSIONS = join(TMP, "sessions");
const PROJECT = join(SESSIONS, "-projects");
mkdirSync(PROJECT, { recursive: true });

// Session lines in the shape the omp adapter parses (tests/ledger-window.test.ts).
const at = (i: number): string =>
	`2026-10-22T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
const USAGE = { totalTokens: 10, input: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
const TOOL_USE = [{ type: "toolUse", id: "t1", name: "bash", input: { command: "bun test" } }];
const FINAL_TEXT = [{ type: "text", text: "All four checks pass; the report follows." }];

function assistant(stopReason: string, content: unknown[], i: number): string {
	return JSON.stringify({ type: "message", timestamp: at(i), message: { role: "assistant", stopReason, content, usage: { ...USAGE } } });
}

/** 119 working turns plus `last`: 120 billed calls, over the 100-call helper budget. */
function helperLines(last: string): string[] {
	const lines: string[] = [];
	for (let i = 0; i < 119; i++) lines.push(assistant("toolUse", TOOL_USE, i));
	lines.push(last);
	return lines;
}

function writeSession(name: string, lines: string[]): void {
	writeFileSync(join(PROJECT, name), `${lines.join("\n")}\n`);
}

function runById(id: string): Run | undefined {
	return ompRunSource(SESSIONS, cfg).listRuns(0).find((r) => r.id === id);
}

test("a helper whose last message is a final answer is done, without OVER-BUDGET", () => {
	writeSession("FinalTextDone.jsonl", helperLines(assistant("stop", FINAL_TEXT, 120)));
	const run = runById("FinalTextDone");
	expect(run).toBeDefined();
	expect(run!.status).toBe("done");
	expect(run!.statusDetail).toBe("done");
	expect(run!.statusDetail).not.toContain("OVER-BUDGET");
});

test("a helper whose last message is toolUse stays RUNNING and OVER-BUDGET", () => {
	writeSession("StillWorking.jsonl", helperLines(assistant("toolUse", TOOL_USE, 120)));
	const run = runById("StillWorking");
	expect(run).toBeDefined();
	expect(run!.status).toBe("running");
	expect(run!.statusDetail.startsWith("RUNNING")).toBe(true);
	expect(run!.statusDetail).toContain(`OVER-BUDGET(120>${cfg.guards.sub_max_calls} calls)`);
});

test("a helper steered on after its final answer is RUNNING again", () => {
	writeSession("SteeredAfterFinal.jsonl", [
		assistant("stop", FINAL_TEXT, 0),
		JSON.stringify({ type: "message", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "one more thing" }] } }),
		assistant("toolUse", TOOL_USE, 2),
	]);
	const run = runById("SteeredAfterFinal");
	expect(run).toBeDefined();
	expect(run!.status).toBe("running");
	expect(run!.statusDetail.startsWith("RUNNING")).toBe(true);
	expect(run!.statusDetail).not.toContain("OVER-BUDGET");
});

test("a MAIN session ending in a final answer keeps today's rule", () => {
	writeSession("2026-10-22T10-00-00-000Z-final-text-main.jsonl", helperLines(assistant("stop", FINAL_TEXT, 120)));
	const main = runById("MAIN 10-00-00");
	expect(main).toBeDefined();
	expect(main!.id.startsWith("MAIN")).toBe(true);
	expect(main!.status).toBe("running");
	expect(main!.statusDetail.startsWith("RUNNING")).toBe(true);
});
