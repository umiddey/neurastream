import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMPLATE = join(import.meta.dir, "..", "templates", "machine-guard.sh");

test.skipIf(process.platform !== "darwin")("machine-guard snapshot runs on macOS with empty stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-darwin-"));
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
