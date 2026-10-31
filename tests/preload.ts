// Plan 20261031_0911 P3: tests never see the real queue. The spawner's live session exports
// QUEUE_* paths (QUEUE_INDEX is the real INDEX.md) and loadConfig applies env over any sandbox
// config (config.ts ENV_MAP), so one test run wiped the real index. bun's [test] preload is the
// only hook that runs before every test module, so it is the one place to fix this for all test
// files at once: every inherited QUEUE_* var is deleted before the first test module loads and
// restored when the run ends. Nothing is pointed at a shared sandbox dir: env overrides a test's
// own config file, so per-test pointing rewrote the paths of every suite that builds its config
// with loadConfig({ home }) and of every spawned child, and funnelled their writes into one
// shared dir (PR #51 CI). Tests that need queue paths set their own — exactly as they did before
// the preload existed (chat-unlock, auto-close, rollover-omp, notify-post, …).
import { afterAll } from "bun:test";

const inherited = Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_"));
for (const [k] of inherited) delete process.env[k];

afterAll(() => {
	for (const [k, v] of inherited) process.env[k] = v;
});
