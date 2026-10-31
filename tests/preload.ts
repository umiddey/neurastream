// Plan 20261031_0911 P3: tests never see the real queue. The spawner's live session exports
// QUEUE_* paths (QUEUE_INDEX is the real INDEX.md) and loadConfig applies env over any sandbox
// config, so one test run wiped the real index. bun's [test] preload is the only hook that runs
// before every test module, so it is the one place to fix this for all test files at once.
//
// bun loads test files lazily (module tops may run between other files' tests), so env carries NO
// queue paths at any module load: this module deletes every inherited QUEUE_* var, beforeEach
// points the seven config-mapped path vars (the QUEUE_* block of config.ts's ENV_MAP, which is
// module-private) at one throwaway dir for the duration of each test, and afterEach strips them
// again. index-guard (e) builds on exactly that: its module-load capture of QUEUE_INDEX is
// undefined and its sandboxed loadConfig resolves the index under PRELOAD_TMP.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PRELOAD_TMP = mkdtempSync(join(tmpdir(), "ns-test-queue-"));

const inherited = Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_"));
for (const [k] of inherited) delete process.env[k];

const sandboxPaths: Array<[string, string]> = [
	["QUEUE_AGENT", join(PRELOAD_TMP, "agent")],
	["QUEUE_INDEX", join(PRELOAD_TMP, "INDEX.md")],
	["QUEUE_BLOCKERS", join(PRELOAD_TMP, "blockers")],
	["QUEUE_STATE", join(PRELOAD_TMP, "state")],
	["QUEUE_SUBAGENTS", join(PRELOAD_TMP, "subagents.md")],
	["QUEUE_CANCELLED", join(PRELOAD_TMP, "CANCELLED.md")],
	["QUEUE_UNLOCK", join(PRELOAD_TMP, ".guard-unlock")],
];

beforeEach(() => {
	for (const [k, v] of sandboxPaths) process.env[k] = v;
});

afterEach(() => {
	for (const [k] of sandboxPaths) delete process.env[k];
});

afterAll(() => {
	for (const [k, v] of inherited) process.env[k] = v;
	rmSync(PRELOAD_TMP, { recursive: true, force: true });
});
