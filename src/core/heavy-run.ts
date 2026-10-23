import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { type HeldLock, isBusy, lock, tryLock } from "./file-lock.ts";

// The original cats the owner file with 2>/dev/null: missing/unreadable is just an empty name.
function ownerName(owner: string): string {
	try {
		return readFileSync(owner, "utf8").trimEnd();
	} catch {
		return "";
	}
}

// Takes the lock, waiting if another heavy-run holds it. null when the wait fails.
function acquire(lockPath: string, owner: string): HeldLock | null {
	const held = tryLock(lockPath);
	if (held) return held;
	process.stderr.write(`[heavy-run] waiting — busy: ${ownerName(owner)}\n`);
	try {
		return lock(lockPath);
	} catch {
		return null;
	}
}

export function heavyRun(args: string[], cfg: Config): number {
	const lockPath = cfg.paths.heavy_lock;
	const owner = cfg.paths.heavy_owner;
	const log = cfg.paths.heavy_log;
	if (args[0] === "--status") {
		if (isBusy(lockPath)) console.log(`busy: ${ownerName(owner)}`);
		else console.log("free");
		return 0;
	}
	if (args.length < 4 || args[2] !== "--") {
		process.stderr.write(`usage: heavy-run <who> <what> -- <command...>\n`);
		return 2;
	}
	const who = args[0]!;
	const what = args[1]!;
	const cmdArgs = args.slice(3);
	const held = acquire(lockPath, owner);
	if (!held) return 1;
	try {
		const stamp = spawnSync("date", ["+%F %T"], { encoding: "utf8" }).stdout?.trim() ?? "";
		writeFileSync(owner, `${who} | ${what} | since ${stamp} | pid ${process.pid}\n`);
		appendFileSync(log, `${stamp} START ${who} | ${what}\n`);
		const r = spawnSync(cmdArgs[0]!, cmdArgs.slice(1), { stdio: "inherit" });
		const rc = r.status ?? 1;
		const end = spawnSync("date", ["+%F %T"], { encoding: "utf8" }).stdout?.trim() ?? "";
		appendFileSync(log, `${end} END   ${who} | ${what} | exit ${rc}\n`);
		writeFileSync(owner, "");
		return rc;
	} finally {
		held.release();
	}
}
