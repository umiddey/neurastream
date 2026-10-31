import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** Maximum detail characters stored per heartbeat. */
const MAX_DETAIL = 200;

/** On-disk heartbeat: last known state of one scheduled job. */
export interface Heartbeat {
	/** Job name (also the file stem). */
	name: string;
	ok: boolean;
	detail: string;
	/** ISO timestamp of when beat() wrote this record. */
	at: string;
}

/** Input to beat(): ok plus an optional human-readable detail (already <200 chars or cut). */
export interface JobResult {
	ok: boolean;
	detail?: string;
}

/** <queue_state>/heartbeats/ — one JSON file per job name. */
function heartbeatsDir(cfg: Config): string {
	return join(cfg.paths.queue_state, "heartbeats");
}

/** Write one heartbeat for *name*. Never throws: a heartbeat write failure must never
 * fail the job that owns the heartbeat. */
export function beat(cfg: Config, name: string, result: JobResult): void {
	const detail = (result.detail ?? "").slice(0, MAX_DETAIL);
	const hb: Heartbeat = { name, ok: result.ok, detail, at: new Date().toISOString() };
	try {
		mkdirSync(heartbeatsDir(cfg), { recursive: true });
		writeFileSync(join(heartbeatsDir(cfg), `${name}.json`), JSON.stringify(hb));
	} catch {
		// intentionally silent — heartbeat write must never crash the job
	}
}

/** Read every heartbeat JSON file, keyed by job name. Returns {} if the dir is unwritable/absent. */
export function readBeats(cfg: Config): Record<string, Heartbeat> {
	const dir = heartbeatsDir(cfg);
	try {
		const out: Record<string, Heartbeat> = {};
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			try {
				out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), "utf8")) as Heartbeat;
			} catch {
				// skip unreadable / corrupt files
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Extract the first line of an unknown thrown value — used as the heartbeat detail on crash. */
export function errorLine(e: unknown): string {
	if (e instanceof Error) return e.message.split("\n")[0];
	return String(e).split("\n")[0];
}

/** Wrap a synchronous job so it beats AFTER the job — ok = (exit code === 0) — and
 *  ok:false (first error line) on a crash, then re-throws so the process exit
 *  behaviour is unchanged. No beat on entry: a job that hangs reads as stale, not ok. */
export function withHeartbeat(cfg: Config, name: string, job: () => number): number {
	try {
		const code = job();
		beat(cfg, name, { ok: code === 0 });
		return code;
	} catch (e) {
		beat(cfg, name, { ok: false, detail: errorLine(e) });
		throw e;
	}
}