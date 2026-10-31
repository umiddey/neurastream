import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMPLATE = join(import.meta.dir, "..", "templates", "machine-guard.sh");

// A full `bun test` must leave nothing under os.tmpdir() (plan 20261029_1530 P3).
const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")("machine-guard snapshot runs on macOS with empty stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-darwin-"));
  DIRS.push(dir);
  const heavy = join(dir, "heavy-run");
  writeFileSync(heavy, "#!/usr/bin/env bash\necho 'idle'\n");
  chmodSync(heavy, 0o755);
  const owner = join(dir, "owner");
  writeFileSync(owner, "");
  mkdirSync(join(dir, "home"));
  const r = spawnSync("bash", [TEMPLATE], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(dir, "home"),
      CORES: "10",
      DISK_PATH: join(dir, "home"),
      HEAVY_RUN: heavy,
      HEAVY_LOCK: join(dir, "lock"),
      HEAVY_OWNER: owner,
      HEAVY_IDLE_STATE: join(dir, "idle-state"),
      HEAVY_STATUS: process.execPath,
      HEAVY_MAIN: join(import.meta.dir, "..", "src", "cli", "main.ts"),
    },
  });
  expect(r.stderr).toBe("");
  expect(r.stdout).toMatch(/load=\d+\.\d+ \d+\.\d+ \d+\.\d+ cores=10 avail=\d+MB swapfree=\d+MB home_free=\d+G/);
});

test.skipIf(process.platform !== "darwin")("machine-guard heavy-lock line runs heavy-run status through main.ts, with no HEAVY_RUN path", () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-darwin-heavy-"));
  DIRS.push(dir);
  const owner = join(dir, "owner");
  writeFileSync(owner, "");
  mkdirSync(join(dir, "home"));
  const r = spawnSync("bash", [TEMPLATE], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(dir, "home"),
      CORES: "10",
      DISK_PATH: join(dir, "home"),
      HEAVY_LOCK: join(dir, "lock"),
      HEAVY_OWNER: owner,
      HEAVY_IDLE_STATE: join(dir, "idle-state"),
      HEAVY_STATUS: process.execPath,
      HEAVY_MAIN: join(import.meta.dir, "..", "src", "cli", "main.ts"),
    },
  });
  expect(r.stdout + r.stderr).not.toMatch(/heavy-run\.sh|No such file/);
  expect(r.stdout).toMatch(/heavy-lock: /);
});
