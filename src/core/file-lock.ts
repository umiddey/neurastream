import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

// flock(2) through libc, so the package needs no util-linux `flock` binary (macOS does not ship one).
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export interface HeldLock {
  release(): void;
}

function acquire(path: string, op: number, retryOnFail: boolean): HeldLock | null {
  const fd = openSync(path, "a");
  // A failed non-blocking flock means another holder has the lock. A blocking flock only fails on
  // EINTR here (fd is ours), so it is simply retried.
  for (;;) {
    if (libc.symbols.flock(fd, op) === 0) break;
    if (!retryOnFail) {
      closeSync(fd);
      return null;
    }
  }
  return {
    release() {
      libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

/** Non-blocking exclusive lock; null when another holder has it. */
export function tryLock(path: string): HeldLock | null {
  return acquire(path, LOCK_EX | LOCK_NB, false);
}

/** Blocking exclusive lock; waits for the holder to release. */
export function lock(path: string): HeldLock {
  const held = acquire(path, LOCK_EX, true);
  if (!held) throw new Error(`could not lock ${path}`);
  return held;
}

/** True when another open file description holds the lock right now. */
export function isBusy(path: string): boolean {
  const held = tryLock(path);
  if (!held) return true;
  held.release();
  return false;
}
