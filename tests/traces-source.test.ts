// Trace reader (src/adapters/omp/traces.ts, plan 20261024_0300 P1): fixtures are synthetic JSONL
// in the documented session shape (one main + one subagent run); the test copies them into a
// sandbox sessions root under real-looking file names so run-id derivation (MAIN <HH-MM-SS> for
// dated depth-1 files, bare stem for depth-2 subagent files) is exercised end to end.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ompTraceSource } from "../src/adapters/omp/traces.ts";

const REPO = dirname(dirname(import.meta.path));
const FIX = join(REPO, "tests", "fixtures", "traces");
const TMP = mkdtempSync(join(tmpdir(), "ns-traces-"));
const ROOT = join(TMP, "sessions");
// Real layout: sessions/<project>/<main>.jsonl and sessions/<project>/<session-dir>/<sub>.jsonl.
const PROJ = join(ROOT, "fix-project");
const SUBDIR = join(PROJ, "2026-10-24T10-04-00-000Z_fix-parent");

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(SUBDIR, { recursive: true });
writeFileSync(
	join(PROJ, "2026-10-24T10-00-00-000Z_fix-main.jsonl"),
	readFileSync(join(FIX, "main-session.jsonl"), "utf8"),
);
writeFileSync(join(SUBDIR, "fix-subagent.jsonl"), readFileSync(join(FIX, "sub-session.jsonl"), "utf8"));

const src = ompTraceSource(ROOT);

test("main run: events in file order with parsed payloads", () => {
	const ev = src.events("MAIN 10-00-00");
	expect(ev.map((e) => e.kind)).toEqual(["modelChange", "assistantText", "toolCall", "toolResult", "usage"]);
	const mc = ev[0]!;
	expect(mc.model).toBe("test-model");
	expect(mc.provider).toBe("test-provider");
	expect(typeof mc.ts).toBe("number");
	const at = ev[1]!;
	expect(at.text).toBe("running the suite now");
	expect(at.model).toBe("test-model");
	expect(at.usage?.totalTokens).toBe(170);
	expect(at.usage?.cost).toBeCloseTo(0.001);
	const tc = ev[2]!;
	expect(tc.tool).toBe("bash");
	expect(tc.args).toEqual({ command: "bun test" });
	expect(tc.callId).toBe("tc-1");
	const tr = ev[3]!;
	expect(tr.tool).toBe("bash");
	expect(tr.callId).toBe("tc-1");
	expect(tr.isError).toBe(false);
	expect(tr.text).toBe("12 pass, 0 fail");
	const us = ev[4]!;
	expect(us.usage?.totalTokens).toBe(15);
	expect(us.usage?.input).toBe(10);
	expect(us.usage?.cost).toBeCloseTo(0.0001);
});

test("subagent run one level deeper: found by stem, isError flag carried", () => {
	const ev = src.events("fix-subagent");
	expect(ev.map((e) => e.kind)).toEqual(["toolCall", "toolResult", "assistantText"]);
	expect(ev[0]!.tool).toBe("edit");
	expect(ev[0]!.args).toEqual({ path: "src/demo.ts" });
	expect(ev[1]!.isError).toBe(true);
	expect(ev[1]!.text).toBe("edit refused");
	expect(ev[2]!.text).toContain("12 passed");
});

test("unknown run id: empty list, no throw", () => {
	expect(src.events("nope-never")).toEqual([]);
});
