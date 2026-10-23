import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE_LOCK = join(import.meta.dir, "..", "src", "core", "file-lock.ts");

// Import file-lock as if on the other platform: that libc cannot load on this host. A load at import
// time throws before anything runs; a lazy load throws only on first lock use, naming the library tried.
test("file-lock loads libc lazily and names the library it tried when that fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-lock-"));
  const other = process.platform === "darwin" ? "linux" : "darwin";
  const lib = other === "darwin" ? "libc.dylib" : "libc.so.6";
  const script = `
Object.defineProperty(process, "platform", { value: ${JSON.stringify(other)} });
import(${JSON.stringify(FILE_LOCK)}).then((m) => {
  try { m.tryLock(${JSON.stringify(join(dir, "x.lock"))}); console.log("NO-THROW"); }
  catch (e) { console.log("THREW " + e.message); }
});
`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("THREW");
  expect(r.stdout).toContain(lib);
});
