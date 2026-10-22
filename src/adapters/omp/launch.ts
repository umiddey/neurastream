// `neurastream main [args…]`: runs the harness in a loop. Under this launcher (env
// NEURASTREAM_MAIN_LAUNCHER=1) a session that is over the rollover size and idle writes
// relaunch.json just before it exits; the launcher then starts a fresh harness with the owner's
// flags (carriedArgs) and the handoff as its message. Plain `omp` never gets the flag, so it never relaunches.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../../core/config.ts";
import { mainStartText } from "../../core/main-start.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import * as q from "../../core/queue/lib.ts";
import { buildHandoff, holdsBlock, relaunchPath } from "../../core/rollover.ts";
import { adapterLog } from "./index.ts";
import { defaultCompletedResults, defaultRunSource } from "./sessions.ts";

/** The harness the launcher runs. Tests pass another path through LaunchOptions. */
export const OMP_BIN = "omp";

/** Flags that take the next argument as their value (omp 18.11.1 --help shows them as `--flag=<value>`). */
export const VALUE_FLAGS: Record<string, true> = {
	"--model": true, "--smol": true, "--slow": true, "--plan": true, "--goal": true, "--prewalk-into": true,
	"--plan-yolo-into": true, "--provider": true, "--api-key": true, "--system-prompt": true,
	"--system-prompt-template": true, "--append-system-prompt": true, "--profile": true, "--alias": true,
	"--cwd": true, "--mode": true, "--config": true, "--add-dir": true, "--restore": true, "--session-dir": true,
	"--models": true, "--tools": true, "--thinking": true, "--service-tier": true, "--hook": true, "-e": true,
	"--extension": true, "--skills": true, "--export": true, "--max-time": true, "--approval-mode": true,
	"--plugin-dir": true,
};

/** Session-picking and one-shot flags: a relaunch never carries them, with their value if they take one. */
const DROPPED_FLAGS: Record<string, true> = {
	"-r": true, "--resume": true, "--restore": true, "-c": true, "--continue": true, "--goal": true,
	"--from-claude": true, "--from-codex": true, "--export": true, "--alias": true, "-p": true, "--print": true,
};

/** Whether `flag` takes `next` as its value: VALUE_FLAGS always do; `-r` only when `next` is not a flag. */
function takesValue(flag: string, next: string | undefined): boolean {
	if (next === undefined) return false;
	if (VALUE_FLAGS[flag] === true) return true;
	return (flag === "-r" || flag === "--resume") && !next.startsWith("-");
}

/**
 * The owner's flags for a relaunch, from the first run's args. Positional arguments (the first
 * message) and session-picking or one-shot flags, with their values, are dropped; every other flag
 * keeps its value. Everything after a bare `--` is positional.
 */
export function carriedArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		if (!arg.startsWith("-")) continue;
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const valued = eq === -1 && takesValue(flag, args[i + 1]);
		if (DROPPED_FLAGS[flag] !== true) {
			out.push(arg);
			if (valued) out.push(args[i + 1] ?? "");
		}
		if (valued) i++;
	}
	return out;
}

/** Handoffs up to this many bytes go in the first message; larger ones go to a file. */
const MAX_INLINE_HANDOFF = 100_000;

const OWNER_AWAY =
	"Owner away (automatic rollover). Continue the work in the note and the queue; the owner reads results later.";

export interface LaunchOptions {
	harness?: string;
}

interface RelaunchRequest {
	previousSessionFile: string;
	notePath: string;
	draft: string;
}

/** Runs the harness until a run ends without a fresh relaunch request; returns the last run's code. */
export async function runMainLauncher(args: string[], cfg: Config, opts: LaunchOptions = {}): Promise<number> {
	applyQueueEnv(cfg);
	const harness = opts.harness ?? OMP_BIN;
	const carried = carriedArgs(args);
	let runArgs = args;
	for (;;) {
		rmSync(relaunchPath(), { force: true });
		const started = Date.now();
		const code = await runChild(harness, runArgs);
		const req = takeRequest(started, cfg);
		if (req === null) return code;
		const message = await nextMessage(req, cfg);
		if (message === null) return code;
		runArgs = [...carried, message];
	}
}

function runChild(harness: string, args: string[]): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const child = spawn(harness, args, {
		stdio: "inherit",
		env: { ...process.env, NEURASTREAM_MAIN_LAUNCHER: "1" },
	});
	child.on("error", err => {
		console.error(`neurastream main: cannot start ${harness}: ${err.message}`);
		resolve(127);
	});
	child.on("close", code => resolve(code ?? 1));
	return promise;
}

/** The request the last run left behind, only if it was written during that run; consumed on read. */
function takeRequest(since: number, cfg: Config): RelaunchRequest | null {
	const path = relaunchPath();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	if (mtimeMs < since) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaunchRequest>;
		rmSync(path, { force: true });
		if (typeof raw.previousSessionFile !== "string" || typeof raw.notePath !== "string") {
			adapterLog(cfg, `rollover: relaunch request ignored, missing fields in ${path}`);
			return null;
		}
		return { previousSessionFile: raw.previousSessionFile, notePath: raw.notePath, draft: raw.draft ?? "" };
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch request ignored, unreadable ${path}: ${String(err)}`);
		return null;
	}
}

/** The next run's message: the handoff inline, or the pointer to a file that holds it. */
async function nextMessage(req: RelaunchRequest, cfg: Config): Promise<string | null> {
	let note: string;
	try {
		note = readFileSync(req.notePath, "utf8");
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch stopped, note unreadable ${req.notePath}: ${String(err)}`);
		return null;
	}
	const generated = [
		await mainStartText([], cfg, { inheritStdin: false }, { source: defaultRunSource(cfg), results: defaultCompletedResults(cfg) }),
		holdsBlock(q.ownerHolds()),
	].join("\n");
	const draft = req.draft.trim() === "" ? "" : `\nOwner's unsent draft: ${req.draft}`;
	const handoff = buildHandoff({
		generated,
		note,
		previousSessionFile: req.previousSessionFile,
		ownerMessage: `${OWNER_AWAY}${draft}`,
	});
	const bytes = Buffer.byteLength(handoff);
	if (bytes <= MAX_INLINE_HANDOFF) {
		adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff inline (${bytes} bytes)`);
		return handoff;
	}
	const file = join(dirname(req.notePath), `${basename(req.notePath, ".md")}.handoff.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, handoff);
	adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff in ${file} (${bytes} bytes)`);
	return `Read ${file} first: it is the handoff from your previous session (too long for one message).`;
}
