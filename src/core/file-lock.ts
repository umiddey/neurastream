import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";

// flock(2) through libc, so the package needs no util-linux `flock` binary (macOS does not ship one).
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

// errno is thread-local; __error (Darwin) and __errno_location (glibc) return its address.
const errnoFn = process.platform === "darwin" ? "__error" : "__errno_location";
const LIBC_NAME = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

/** The libc symbols this module calls. */
export interface LibcSymbols {
  flock(fd: number, op: number): number;
  [symbol: string]: unknown;
}

export interface Libc {
  symbols: LibcSymbols;
}

// libc opens on first lock use, not at import: a failed load throws from the lock call, naming the
// library tried, instead of breaking every importer of this module.
let libcHandle: Libc | undefined;
function libc(): Libc {
  if (libcHandle) return libcHandle;
  try {
    libcHandle = dlopen(LIBC_NAME, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      [errnoFn]: { args: [], returns: FFIType.ptr },
    });
    return libcHandle;
  } catch (e) {
    throw new Error(`file-lock: cannot load ${LIBC_NAME}: ${(e as Error).message}`);
  }
}

function errno(lib: Libc): number {
  const ptr = (lib.symbols[errnoFn] as () => Pointer)();
  return read.i32(ptr, 0);
}

export interface HeldLock {
  release(): void;
}

function acquire(path: string, op: number): HeldLock | null {
  const lib = libc();
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  for (;;) {
    if (lib.symbols.flock(fd, op) === 0) break;
    const err = errno(lib);
    if (err === EINTR) continue;
    closeSync(fd);
    if (err === EWOULDBLOCK && (op & LOCK_NB) !== 0) return null;
    throw new Error(`flock(${path}) failed: errno ${err}`);
  }
  return {
    release() {
      lib.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

/** Non-blocking exclusive lock; null when another holder has it. */
export function tryLock(path: string): HeldLock | null {
  return acquire(path, LOCK_EX | LOCK_NB);
}

/** Blocking exclusive lock; waits for the holder to release. */
export function lock(path: string): HeldLock {
  const held = acquire(path, LOCK_EX);
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
