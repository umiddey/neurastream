import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { nowSec } from "./clock.ts";
import { gitRaw, type CmdResult } from "./proc.ts";

/** What one wip run ended with; main-start reads it from `<alert_state>/wip-last.json`. */
export interface WipRunRec {
	kind: "snapshot" | "backup";
	at: number;
	ok: boolean;
	failed: string[];
	refused: string | null;
	/** Refs the run left behind on purpose (hook opt-in, secret, too big); the backup reports it. */
	skipped?: number;
	/** The failure state main-start already announced: one state posts once. */
	notified?: string;
}

/** One record per kind, so the snapshot's and the backup's freshness are read independently. */
export interface WipLast {
	snapshot?: WipRunRec;
	backup?: WipRunRec;
}

function wipLastFile(cfg: Config): string {
	return join(cfg.paths.alert_state, "wip-last.json");
}

export function readWipLast(cfg: Config): WipLast {
	try {
		const parsed: unknown = JSON.parse(readFileSync(wipLastFile(cfg), "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as WipLast) : {};
	} catch {
		return {};
	}
}

export function writeWipLast(cfg: Config, last: WipLast): void {
	const file = wipLastFile(cfg);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(last)}\n`);
}

/** `FAILED: <path>: <step>: <first stderr line>` — one recorded failure; the run keeps going. */
export function failureLine(path: string, step: string, detail: string): string {
	return `FAILED: ${path}: ${step}: ${detail.trim().split("\n")[0] ?? ""}`;
}

/** git for one path; a non-zero exit is recorded in `failed` and the caller moves on to the next one. */
export function gitOrFail(failed: string[], path: string, args: string[], env?: NodeJS.ProcessEnv): CmdResult | null {
	const r = gitRaw(path, args, env);
	if (r.code === 0) return r;
	failed.push(failureLine(path, `git ${args.join(" ")}`, r.stderr));
	return null;
}

/** realpath or a recorded failure: a repo that cannot be resolved is skipped, never fatal. */
export function realpathOrFail(failed: string[], path: string): string | null {
	try {
		return realpathSync(path);
	} catch (e) {
		failed.push(failureLine(path, "realpath", e instanceof Error ? e.message : String(e)));
		return null;
	}
}

/** Write how the run ended; returns true when it was clean, which is the exit code the runners use. */
export function recordWipRun(
	cfg: Config,
	kind: WipRunRec["kind"],
	failed: string[],
	refused: string | null = null,
	skipped = 0,
): boolean {
	const ok = failed.length === 0 && refused === null;
	const last = readWipLast(cfg);
	// The announced state survives a re-run: the same failure twice stays one state and one post.
	last[kind] = { kind, at: nowSec(), ok, failed, refused, skipped, notified: last[kind]?.notified };
	writeWipLast(cfg, last);
	return ok;
}
