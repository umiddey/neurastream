import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusy, tryLock, withFileLock, writeAtomicSync } from "../src/core/file-lock.ts";

const FILE_LOCK = join(import.meta.dir, "..", "src", "core", "file-lock.ts");

// A full `bun test` must leave nothing under os.tmpdir() (plan 20261029_1530 P3).
const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

// Import file-lock as if on the other platform: that libc cannot load on this host. A load at import
// time throws before anything runs; a lazy load throws only on first lock use, naming the library tried.
test("file-lock loads libc lazily and names the library it tried when that fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-lock-"));
  DIRS.push(dir);
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

test("release() is idempotent and never closes a reused file descriptor", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-lock-idemp-"));
  DIRS.push(dir);
  const lockPath = join(dir, "x.lock");
  const held = tryLock(lockPath);
  expect(held).not.toBeNull();
  held!.release();
  // Immediately open another file so the OS may reuse the just-closed fd number.
  const probe = openSync(join(dir, "probe.txt"), "w+");
  try {
    expect(() => held!.release()).not.toThrow();
    // If the second release() had double-closed the fd, fstatSync(probe) would throw EBADF.
    expect(fstatSync(probe).isFile()).toBe(true);
  } finally {
    closeSync(probe);
  }
});

test("writeAtomicSync applies mode before rename and leaves no temp file; withFileLock releases on throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-lock-atomic-"));
  DIRS.push(dir);
  const target = join(dir, "ro.txt");
  writeAtomicSync(target, "v1\n", 0o444);
  expect(readFileSync(target, "utf8")).toBe("v1\n");
  expect(statSync(target).mode & 0o777).toBe(0o444);
  // Overwriting a 0444 file atomically succeeds without loosening the existing file.
  writeAtomicSync(target, "v2\n", 0o444);
  expect(readFileSync(target, "utf8")).toBe("v2\n");
  expect(statSync(target).mode & 0o777).toBe(0o444);
  expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);

  const lockPath = join(dir, "err.lock");
  expect(() =>
    withFileLock(lockPath, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(isBusy(lockPath)).toBe(false);
});
