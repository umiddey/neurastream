// The claim store behind "several Mains, one queue, never the same plan twice"
// (plan 20261027_1300 P1): one JSON file per plan under <queue_state>/claims/, named by the
// sha256 of the plan path. Every read-modify-write runs while holding the store's flock
// (src/core/file-lock.ts) and releases it in finally, so racing processes serialize; the
// kernel frees the lock when a holder dies. Claim files are written to a temp file in the
// same directory and renameSync over the target, so a reader never sees a half-written claim.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { lock } from "./file-lock.ts";

/** A plan one Main is working on. */
export interface Claim {
	/** The plan path the claim is for. */
	plan: string;
	/** The Main id holding it. */
	main: string;
	host: string;
	pid: number;
	/** Unix seconds when the claim was taken (unchanged by heartbeats and re-claims). */
	since: number;
	/** Unix seconds of the last heartbeat or claim. */
	beat: number;
}

/** The plan answer when another Main holds a live claim. */
export interface Held {
	heldBy: Claim;
}

export interface ClaimStore {
	claim(plan: string, main: string): Claim | Held;
	/** The live claim for a plan, or null when it is free (absent, unreadable or expired). Read-only: no claim is taken. */
	holder(plan: string): Claim | null;
	heartbeat(plan: string, main: string): boolean;
	release(plan: string, main: string): void;
	list(): Claim[];
}

// Claim files are only ever written by temp+rename under the lock, so an unreadable one
// means outside tampering; treating it as absent lets the next claim replace it.
function readClaim(path: string): Claim | null {
	if (!existsSync(path)) return null;
	try {
		const c = JSON.parse(readFileSync(path, "utf8")) as Claim;
		if (typeof c.main !== "string" || typeof c.beat !== "number" || typeof c.since !== "number") return null;
		return c;
	} catch {
		return null;
	}
}

function writeClaim(path: string, claim: Claim): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(claim));
	renameSync(tmp, path);
}

/**
 * The local file claim store. `ttlMin` is `queue.claim_ttl_min` — required, every caller passes
 * the configured value (P1 review I-20261031-189): a claim whose `beat` is that many minutes old
 * is free for takeover. The clock is injected in unix seconds (src/core/clock.ts convention) so
 * tests never use real time.
 */
export function fileClaimStore(stateDir: string, clock: () => number, ttlMin: number): ClaimStore {
	const dir = join(stateDir, "claims");
	const lockPath = join(dir, ".lock");

	function run<T>(fn: () => T): T {
		mkdirSync(dir, { recursive: true });
		const held = lock(lockPath);
		try {
			return fn();
		} finally {
			held.release();
		}
	}

	function fileFor(plan: string): string {
		return join(dir, `${createHash("sha256").update(plan).digest("hex")}.json`);
	}

	function expired(c: Claim, now: number): boolean {
		return now - c.beat >= ttlMin * 60;
	}

	return {
		claim(plan, main) {
			return run(() => {
				const path = fileFor(plan);
				const now = clock();
				const cur = readClaim(path);
				if (cur && cur.main === main) {
					// The same main again: idempotent — `since` unchanged, `beat` refreshed.
					const next = { ...cur, beat: now };
					writeClaim(path, next);
					return next;
				}
				if (cur && !expired(cur, now)) return { heldBy: cur };
				const fresh: Claim = { plan, main, host: hostname(), pid: process.pid, since: now, beat: now };
				writeClaim(path, fresh);
				return fresh;
			});
		},
		heartbeat(plan, main) {
			return run(() => {
				const path = fileFor(plan);
				const cur = readClaim(path);
				if (!cur || cur.main !== main) return false;
				writeClaim(path, { ...cur, beat: clock() });
				return true;
			});
		},
		holder(plan) {
			return run(() => {
				const cur = readClaim(fileFor(plan));
				return cur && !expired(cur, clock()) ? cur : null;
			});
		},
		release(plan, main) {
			run(() => {
				const path = fileFor(plan);
				const cur = readClaim(path);
				if (cur && cur.main === main) rmSync(path);
			});
		},
		list() {
			return run(() => {
				// A crashed writer leaves <claim>.<pid>.tmp behind; the next list sweeps it (the lock
				// guarantees no live writer is mid-rename).
				for (const f of readdirSync(dir)) if (f.endsWith(".tmp")) rmSync(join(dir, f), { force: true });
				return readdirSync(dir)
					.filter(f => f.endsWith(".json"))
					.map(f => readClaim(join(dir, f)))
					.filter((c): c is Claim => c !== null);
			});
		},
	};
}
