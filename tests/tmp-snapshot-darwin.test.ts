import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMPLATE = join(import.meta.dir, "..", "templates", "tmp-snapshot.sh");

// macOS ships no ionice and its date has no -I: the snapshot must still exit 0 with empty stderr.
// A stub rsync first on PATH stands in for the real copy.
test.skipIf(process.platform !== "darwin")("tmp-snapshot runs on macOS: exit 0, empty stderr, ISO stamp with colon offset", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmp-snap-darwin-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rsync"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "rsync"), 0o755);
  const snap = join(dir, "snap");
  const r = spawnSync("bash", [TEMPLATE], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: join(dir, "home"), SNAP_DEST: snap },
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(readFileSync(join(snap, "LAST_SNAPSHOT"), "utf8").trim()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
});
