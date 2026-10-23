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
import { PACKAGE_ROOT, packageJsonPath, packageVersion } from "./package-root.ts";
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

/**
 * Runs the harness until a run ends without a fresh relaunch request; returns the last run's code.
 * The launcher keeps the version it loaded. When the package on disk has another version (or either
 * is unreadable) by the time a run leaves a request, that request goes to a fresh launcher started
 * from the package on disk: the handoff is then built with the installed code, not the old code.
 */
export async function runMainLauncher(args: string[], cfg: Config, opts: LaunchOptions = {}): Promise<number> {
	applyQueueEnv(cfg);
	const harness = opts.harness ?? OMP_BIN;
	const carried = carriedArgs(args);
	const loaded = packageVersion(packageJsonPath());
	// Set only in a fresh launcher the previous one started: its first step is the request that run left.
	const handedOver = process.env.NEURASTREAM_RELAUNCH_SINCE;
	delete process.env.NEURASTREAM_RELAUNCH_SINCE;
	let runArgs = args;
	const since = handedOver === undefined ? Number.NaN : Number(handedOver);
	if (Number.isFinite(since)) {
		const req = readRequest(since, cfg);
		if (req !== null) {
			rmSync(relaunchPath(), { force: true });
			const message = await nextMessage(req, cfg);
			if (message === null) return 1;
			runArgs = [...carried, message];
		}
	}
	for (;;) {
		rmSync(relaunchPath(), { force: true });
		const started = Date.now();
		const code = await runChild(harness, runArgs, { ...process.env, NEURASTREAM_MAIN_LAUNCHER: "1" });
		const req = readRequest(started, cfg);
		if (req === null) return code;
		const installed = packageVersion(packageJsonPath());
		const changed = loaded === null || installed === null || loaded !== installed;
		if (changed && noteReadable(req.notePath)) {
			adapterLog(cfg, `rollover: relaunch handed to a fresh launcher (${loaded ?? "unknown"} → ${installed ?? "unknown"})`);
			return runChild(process.execPath, [join(PACKAGE_ROOT, "src", "cli", "main.ts"), "main", ...carried], {
				...process.env,
				NEURASTREAM_RELAUNCH_SINCE: String(started),
			});
		}
		rmSync(relaunchPath(), { force: true });
		const message = await nextMessage(req, cfg);
		if (message === null) return code;
		runArgs = [...carried, message];
	}
}

/** Runs a command with inherited stdio; resolves to its exit code (127 when it cannot start). */
function runChild(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const child = spawn(cmd, args, { stdio: "inherit", env });
	child.on("error", err => {
		console.error(`neurastream main: cannot start ${cmd}: ${err.message}`);
		resolve(127);
	});
	child.on("close", code => resolve(code ?? 1));
	return promise;
}

/**
 * The request the last run left behind, only if it was written during that run (mtime at or after
 * `since`). Not consumed: the caller removes it once it has decided to use it. A request without the
 * required fields is removed and logged; an unreadable one is logged and left in place.
 */
function readRequest(since: number, cfg: Config): RelaunchRequest | null {
	const path = relaunchPath();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	if (mtimeMs < since) return null;
	let raw: Partial<RelaunchRequest>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaunchRequest>;
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch request ignored, unreadable ${path}: ${String(err)}`);
		return null;
	}
	if (typeof raw.previousSessionFile !== "string" || typeof raw.notePath !== "string") {
		rmSync(path, { force: true });
		adapterLog(cfg, `rollover: relaunch request ignored, missing fields in ${path}`);
		return null;
	}
	return { previousSessionFile: raw.previousSessionFile, notePath: raw.notePath, draft: raw.draft ?? "" };
}

/** Whether the handoff note can be read now: a launcher cannot relaunch without it. */
function noteReadable(path: string): boolean {
	try {
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
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
	const draft = req.draft.trim() === "" ? "" : `\nOwner's messages during the rollover (and any unsent draft): ${req.draft}`;
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
