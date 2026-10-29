// Live recheck: a `WAITING on owner:` line may carry `— still true if: `<cmd>``, the command that
// proves the hold is still real. Exit 0 keeps the owner card up; any other exit code hides it and
// opens a "stale-hold" incident naming the plan and the command; a timeout or a spawn error is
// "unknown" (the card stays, no incident) — a check that cannot run never counts as proof.
// Results are cached per (plan file mtime, command, HEAD) for queue.waiting_check_ttl_sec, so the
// same cheap command costs one spawn per real change, not one per turn. The runner is injected:
// tests never run a plan's command.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowSec } from "./clock.ts";
import type { Config } from "./config.ts";
import { addIncident } from "./incidents.ts";
import * as q from "./queue/lib.ts";

export type HoldState = "holds" | "stale" | "unknown";

export interface HoldResult {
	/** The plan file that carries the hold. */
	plan: string;
	state: HoldState;
	/** The command's exit code; null when it did not finish (timeout, spawn error). */
	code: number | null;
	/** Milliseconds the command took; the original measurement for a cached result. */
	ms: number;
}

/** Runs one check command in a directory. `code` null means it did not finish. */
export type HoldRunner = (cmd: string, cwd: string) => { code: number | null };

interface CacheRec {
	key: string;
	state: HoldState;
	code: number | null;
	ms: number;
	at: number;
}

/** bash -lc with the configured timeout: only whether the command still passes matters, not its output. */
export function spawnHoldRunner(timeoutSec: number): HoldRunner {
	return (cmd, cwd) => {
		const res = spawnSync("bash", ["-lc", cmd], { cwd, timeout: timeoutSec * 1000, stdio: "ignore" });
		return { code: typeof res.status === "number" ? res.status : null };
	};
}

function gitHead(dir: string): string {
	const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
	return res.status === 0 ? res.stdout.trim() : "";
}

function readCache(file: string): Record<string, CacheRec> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CacheRec>) : {};
	} catch {
		return {};
	}
}

/**
 * Runs the `still true if` command of every open, waiting plan that has one. `now` is epoch seconds
 * (the TTL and the incident stamps are seconds); a plan whose cached key still matches and is inside
 * queue.waiting_check_ttl_sec is returned without running the command.
 */
export function recheckHolds(cfg: Config, plans: q.Plan[], run: HoldRunner, now = nowSec()): HoldResult[] {
	const file = join(cfg.paths.queue_state, "waiting-check.json");
	const cache = readCache(file);
	const ttl = cfg.queue.waiting_check_ttl_sec;
	const out: HoldResult[] = [];
	for (const p of plans) {
		const cmd = p.waitingCheck;
		if (!p.waiting || p.status !== "open" || !cmd) continue;
		const cwd = p.worktree && existsSync(p.worktree) ? p.worktree : p.repo;
		let mtime = 0;
		try {
			mtime = statSync(p.file).mtimeMs;
		} catch {}
		const key = q.sha(`${mtime}\n${cmd}\n${gitHead(cwd)}`);
		const hit = cache[p.file];
		let rec = hit && hit.key === key && now - hit.at < ttl ? hit : undefined;
		if (!rec) {
			const started = Date.now();
			const code = run(cmd, cwd).code;
			const state: HoldState = code === 0 ? "holds" : code === null ? "unknown" : "stale";
			rec = { key, state, code, ms: Date.now() - started, at: now };
		}
		cache[p.file] = rec;
		if (rec.state === "stale") {
			addIncident(
				cfg,
				{
					source: "realtime",
					kind: "stale-hold",
					summary: `stale hold: ${p.file} — \`${cmd}\` exited ${rec.code}`,
					evidence: `WAITING on owner: ${p.waitingAsk ?? ""} — still true if: \`${cmd}\` (exit ${rec.code}) ran in ${cwd}`,
					fingerprint: q.sha(`stale-hold|${p.file}|${cmd}`),
				},
				now,
			);
		}
		out.push({ plan: p.file, state: rec.state, code: rec.code, ms: rec.ms });
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(cache)}\n`);
	return out;
}
